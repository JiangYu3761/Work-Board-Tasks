import Cocoa
import WebKit

struct ProjectConfiguration: Decodable {
    let projectPath: String
    let nodePath: String
    let name: String
    let revision: String?
    let version: String?
}

struct UpdateState: Decodable {
    let currentVersion: String?
    let currentRevision: String?
    let latestVersion: String?
    let latestRevision: String?
    let lastCheckedAt: String?
    let phase: String?
    let message: String?
    let updateAvailable: Bool?
    let restartRequired: Bool?
    let error: String?
}

// The installer invokes this mode only after building and signing the app.
func pinToDock(_ appPath: String) throws {
    guard let defaults = UserDefaults(suiteName: "com.apple.dock") else {
        throw NSError(domain: "North", code: 1, userInfo: [NSLocalizedDescriptionKey: "无法读取 Dock 设置"])
    }
    let appURL = URL(fileURLWithPath: appPath).standardizedFileURL
    let existing = defaults.object(forKey: "persistent-apps")
    guard existing == nil || existing is [[String: Any]] else {
        throw NSError(domain: "North", code: 4, userInfo: [NSLocalizedDescriptionKey: "现有 Dock 设置无法读取，请手动拖入应用"])
    }
    var tiles = existing as? [[String: Any]] ?? []
    let present = tiles.contains { tile in
        guard let data = tile["tile-data"] as? [String: Any],
              let file = data["file-data"] as? [String: Any],
              let text = file["_CFURLString"] as? String,
              let url = URL(string: text) else { return false }
        return url.standardizedFileURL.path == appURL.path
    }
    if present { return }
    tiles.append(["tile-type": "file-tile", "tile-data": [
        "file-data": ["_CFURLString": appURL.absoluteString, "_CFURLStringType": 15],
        "file-label": appURL.deletingPathExtension().lastPathComponent,
        "bundle-identifier": Bundle.main.bundleIdentifier ?? "cn.jiangyu.north"
    ]])
    defaults.set(tiles, forKey: "persistent-apps")
    guard defaults.synchronize() else {
        throw NSError(domain: "North", code: 2, userInfo: [NSLocalizedDescriptionKey: "无法保存 Dock 设置"])
    }
}

final class NorthApp: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate, NSToolbarDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var configuration: ProjectConfiguration!
    var baseURL: URL?
    var launcher: Process?
    var updateWindow: NSWindow?
    var updateVersionLabel: NSTextField?
    var updateCheckedLabel: NSTextField?
    var updateMessageLabel: NSTextField?
    var autoCheckControl: NSButton?
    var autoInstallControl: NSButton?
    var checkUpdateControl: NSButton?
    var installUpdateControl: NSButton?
    var updateSpinner: NSProgressIndicator?
    var updateProcess: Process?
    var statusProcess: Process?
    var updateTimer: Timer?
    var updatePollTimer: Timer?
    var activityMonitor: Any?
    var lastInteraction = Date()
    var lastAutomaticCheck = Date.distantPast
    var pendingAutomaticInstall = false
    var updateState: UpdateState?

    func applicationDidFinishLaunching(_ notification: Notification) {
        do {
            guard let file = Bundle.main.url(forResource: "project", withExtension: "json") else {
                throw NSError(domain: "North", code: 3, userInfo: [NSLocalizedDescriptionKey: "应用配置缺失，请重新安装。"])
            }
            configuration = try JSONDecoder().decode(ProjectConfiguration.self, from: Data(contentsOf: file))
        } catch {
            let alert = NSAlert()
            alert.messageText = "无法打开北向"
            alert.informativeText = error.localizedDescription
            alert.runModal()
            NSApp.terminate(nil)
            return
        }
        installMenu()
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 860),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = configuration.name + " NORTH"
        window.minSize = NSSize(width: 800, height: 600)
        window.isReleasedWhenClosed = false
        window.setFrameAutosaveName("NorthMainWindow")
        window.center()
        let toolbar = NSToolbar(identifier: "NorthToolbar")
        toolbar.delegate = self
        toolbar.displayMode = .iconAndLabel
        window.toolbar = toolbar
        let settings = WKWebViewConfiguration()
        settings.websiteDataStore = .default()
        webView = WKWebView(frame: .zero, configuration: settings)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        startProject()
        configureUpdates()
    }

    func installMenu() {
        let menu = NSMenu()
        let appItem = NSMenuItem()
        let appMenu = NSMenu(title: configuration.name)
        appMenu.addItem(withTitle: "关于" + configuration.name, action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        let updateItem = appMenu.addItem(withTitle: "软件更新…", action: #selector(showUpdates(_:)), keyEquivalent: ",")
        updateItem.target = self
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "隐藏" + configuration.name, action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "退出" + configuration.name, action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        menu.addItem(appItem)
        for (title, items) in [
            ("文件", [("打开工作台", "showWindow:", "n"), ("关闭窗口", "performClose:", "w")]),
            ("编辑", [("撤销", "undo:", "z"), ("剪切", "cut:", "x"), ("复制", "copy:", "c"), ("粘贴", "paste:", "v"), ("全选", "selectAll:", "a")]),
            ("显示", [("刷新", "reloadPage:", "r"), ("后退", "goBack:", "["), ("前进", "goForward:", "]"), ("查看启动日志", "showLog:", "")])
        ] {
            let item = NSMenuItem()
            let submenu = NSMenu(title: title)
            for (label, selector, key) in items {
                let entry = submenu.addItem(withTitle: label, action: NSSelectorFromString(selector), keyEquivalent: key)
                if ["showWindow:", "reloadPage:", "goBack:", "goForward:", "showLog:"].contains(selector) { entry.target = self }
            }
            item.submenu = submenu
            menu.addItem(item)
        }
        NSApp.mainMenu = menu
    }

    func toolbarAllowedItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] { [.flexibleSpace, NSToolbarItem.Identifier("NorthUpdates")] }
    func toolbarDefaultItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] { toolbarAllowedItemIdentifiers(toolbar) }
    func toolbar(_ toolbar: NSToolbar, itemForItemIdentifier identifier: NSToolbarItem.Identifier, willBeInsertedIntoToolbar flag: Bool) -> NSToolbarItem? {
        guard identifier.rawValue == "NorthUpdates" else { return nil }
        let item = NSToolbarItem(itemIdentifier: identifier)
        item.label = "软件更新"
        item.view = NSButton(title: "软件更新", target: self, action: #selector(showUpdates(_:)))
        return item
    }

    func configureUpdates() {
        UserDefaults.standard.register(defaults: ["NorthAutoCheck": true, "NorthAutoInstall": true])
        activityMonitor = NSEvent.addLocalMonitorForEvents(matching: [.keyDown, .leftMouseDown, .scrollWheel]) { [weak self] event in
            self?.lastInteraction = Date()
            return event
        }
        updateTimer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in self?.updateTick() }
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in self?.updateTick() }
    }

    func updateTick() {
        guard launcher == nil, updateProcess == nil, baseURL != nil else { return }
        if pendingAutomaticInstall && UserDefaults.standard.bool(forKey: "NorthAutoInstall") && Date().timeIntervalSince(lastInteraction) >= 60 {
            webView.evaluateJavaScript("Boolean(document.querySelector('dialog[open], input:focus, textarea:focus, select:focus'))") { [weak self] value, error in
                guard let self = self, error == nil, (value as? Bool) == false, self.updateProcess == nil,
                      self.pendingAutomaticInstall, UserDefaults.standard.bool(forKey: "NorthAutoInstall") else { return }
                self.pendingAutomaticInstall = false
                self.performUpdate("install")
            }
        } else if UserDefaults.standard.bool(forKey: "NorthAutoCheck") && Date().timeIntervalSince(lastAutomaticCheck) >= 3600 {
            lastAutomaticCheck = Date()
            performUpdate("check")
        }
    }

    @objc func showUpdates(_ sender: Any?) {
        if updateWindow == nil {
            let panel = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 540, height: 500), styleMask: [.titled, .closable], backing: .buffered, defer: false)
            panel.title = "软件更新"
            panel.isReleasedWhenClosed = false
            panel.center()
            let stack = NSStackView()
            stack.orientation = .vertical
            stack.alignment = .leading
            stack.spacing = 16
            let heading = NSTextField(labelWithString: "让北向保持最新")
            heading.font = .boldSystemFont(ofSize: 21)
            stack.addArrangedSubview(heading)
            let version = NSTextField(labelWithString: "正在读取当前版本…")
            let checked = NSTextField(labelWithString: "上次检查：尚未检查")
            checked.textColor = .secondaryLabelColor
            updateVersionLabel = version
            updateCheckedLabel = checked
            stack.addArrangedSubview(version)
            stack.addArrangedSubview(checked)
            let automatic = NSButton(checkboxWithTitle: "自动检查更新（打开应用后，每小时一次）", target: self, action: #selector(updatePreferences(_:)))
            let install = NSButton(checkboxWithTitle: "发现更新后自动安装（空闲时进行）", target: self, action: #selector(updatePreferences(_:)))
            automatic.state = UserDefaults.standard.bool(forKey: "NorthAutoCheck") ? .on : .off
            install.state = UserDefaults.standard.bool(forKey: "NorthAutoInstall") ? .on : .off
            autoCheckControl = automatic
            autoInstallControl = install
            stack.addArrangedSubview(automatic)
            stack.addArrangedSubview(install)
            let message = NSTextField(wrappingLabelWithString: "更新来自本项目 GitHub 仓库；本地配置和数据会保留。")
            message.preferredMaxLayoutWidth = 470
            updateMessageLabel = message
            stack.addArrangedSubview(message)
            let row = NSStackView()
            row.spacing = 12
            let check = NSButton(title: "立即检查", target: self, action: #selector(checkUpdates(_:)))
            let apply = NSButton(title: "立即安装", target: self, action: #selector(installUpdate(_:)))
            apply.isEnabled = false
            checkUpdateControl = check
            installUpdateControl = apply
            let spinner = NSProgressIndicator()
            spinner.style = .spinning
            spinner.isDisplayedWhenStopped = false
            updateSpinner = spinner
            row.addArrangedSubview(check)
            row.addArrangedSubview(apply)
            row.addArrangedSubview(spinner)
            stack.addArrangedSubview(row)
            stack.addArrangedSubview(NSButton(title: "查看更新日志", target: self, action: #selector(showUpdateLog(_:))))
            stack.translatesAutoresizingMaskIntoConstraints = false
            panel.contentView!.addSubview(stack)
            NSLayoutConstraint.activate([
                stack.leadingAnchor.constraint(equalTo: panel.contentView!.leadingAnchor, constant: 30),
                stack.trailingAnchor.constraint(equalTo: panel.contentView!.trailingAnchor, constant: -30),
                stack.topAnchor.constraint(equalTo: panel.contentView!.topAnchor, constant: 25)
            ])
            updateWindow = panel
        }
        updateWindow?.makeKeyAndOrderFront(sender)
        renderUpdateState()
        refreshUpdateStatus()
    }

    @objc func updatePreferences(_ sender: Any?) {
        UserDefaults.standard.set(autoCheckControl?.state == .on, forKey: "NorthAutoCheck")
        UserDefaults.standard.set(autoInstallControl?.state == .on, forKey: "NorthAutoInstall")
        if autoInstallControl?.state == .on && updateState?.updateAvailable == true { pendingAutomaticInstall = true }
    }
    @objc func checkUpdates(_ sender: Any?) { lastAutomaticCheck = Date(); performUpdate("check") }
    @objc func installUpdate(_ sender: Any?) { pendingAutomaticInstall = false; performUpdate("install") }
    @objc func showUpdateLog(_ sender: Any?) {
        let log = URL(fileURLWithPath: configuration.projectPath).appendingPathComponent(".runtime/desktop/updates/update.log")
        if FileManager.default.fileExists(atPath: log.path) { NSWorkspace.shared.open(log) }
        else { NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: configuration.projectPath) }
    }

    func updaterProcess(_ action: String, completion: @escaping (UpdateState?, String?) -> Void) throws -> Process {
        let process = Process(), output = Pipe(), errors = Pipe()
        guard let helper = Bundle.main.url(forResource: "updater", withExtension: "mjs") else {
            throw NSError(domain: "North", code: 5, userInfo: [NSLocalizedDescriptionKey: "更新组件缺失，请重新运行安装器。"])
        }
        process.executableURL = URL(fileURLWithPath: configuration.nodePath)
        process.arguments = [helper.path, "--project", configuration.projectPath, "--app", Bundle.main.bundlePath,
                             "--baseline", configuration.revision ?? "local", "--action", action]
        process.currentDirectoryURL = URL(fileURLWithPath: configuration.projectPath)
        process.standardOutput = output
        process.standardError = errors
        process.terminationHandler = { finished in
            let data = output.fileHandleForReading.readDataToEndOfFile()
            let errorData = errors.fileHandleForReading.readDataToEndOfFile()
            let result = try? JSONDecoder().decode(UpdateState.self, from: data)
            let failure = try? JSONDecoder().decode(UpdateState.self, from: errorData)
            DispatchQueue.main.async { completion(result, finished.terminationStatus == 0 ? nil : (failure?.error ?? "更新操作未完成，请查看更新日志。")) }
        }
        try process.run()
        return process
    }

    func refreshUpdateStatus() {
        guard statusProcess == nil else { return }
        do {
            statusProcess = try updaterProcess("status") { [weak self] result, error in
                guard let self = self else { return }
                self.statusProcess = nil
                if let result = result { self.updateState = result }
                self.renderUpdateState()
            }
        } catch { updateMessageLabel?.stringValue = error.localizedDescription }
    }

    func performUpdate(_ action: String) {
        guard updateProcess == nil else { return }
        if action == "install" { showStatus("正在安装软件更新，完成后会自动重新打开…") }
        do {
            updateProcess = try updaterProcess(action) { [weak self] result, error in
                guard let self = self else { return }
                self.updateProcess = nil
                self.updatePollTimer?.invalidate()
                self.updatePollTimer = nil
                if let result = result { self.updateState = result }
                if let error = error {
                    self.pendingAutomaticInstall = false
                    self.refreshUpdateStatus()
                    self.updateMessageLabel?.stringValue = error
                    if action == "install" { self.window.contentView = self.webView; self.webView.reload() }
                } else if result?.restartRequired == true {
                    self.restartAfterUpdate()
                } else if action == "check" && result?.updateAvailable == true && UserDefaults.standard.bool(forKey: "NorthAutoInstall") {
                    self.pendingAutomaticInstall = true
                }
                self.renderUpdateState()
            }
            updatePollTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in self?.refreshUpdateStatus() }
            renderUpdateState()
        } catch {
            updateProcess = nil
            updateMessageLabel?.stringValue = error.localizedDescription
            if action == "install" { window.contentView = webView }
        }
    }

    func renderUpdateState() {
        let current = updateState?.currentVersion ?? configuration.version ?? "1.0.0"
        let revision = updateState?.currentRevision ?? configuration.revision ?? "local"
        updateVersionLabel?.stringValue = "当前版本：" + current + (revision.count == 40 ? " · " + String(revision.prefix(7)) : "")
        if let text = updateState?.lastCheckedAt {
            let parser = ISO8601DateFormatter()
            parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let date = parser.date(from: text) {
                let formatter = DateFormatter()
                formatter.dateStyle = .medium
                formatter.timeStyle = .short
                updateCheckedLabel?.stringValue = "上次检查：" + formatter.string(from: date)
            }
        }
        if let message = updateState?.message { updateMessageLabel?.stringValue = message }
        checkUpdateControl?.isEnabled = updateProcess == nil
        installUpdateControl?.isEnabled = updateProcess == nil && updateState?.updateAvailable == true
        if updateProcess == nil { updateSpinner?.stopAnimation(nil) } else { updateSpinner?.startAnimation(nil) }
    }

    func restartAfterUpdate() {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        process.arguments = ["-n", Bundle.main.bundlePath]
        process.terminationHandler = { finished in
            DispatchQueue.main.async {
                if finished.terminationStatus == 0 { NSApp.terminate(nil) }
            }
        }
        do { try process.run() }
        catch { updateMessageLabel?.stringValue = "更新已安装，请退出后再次点击 Dock 图标打开。"; window.contentView = webView }
    }

    func showStatus(_ message: String, retry: Bool = false) {
        let view = NSView(frame: window.contentView?.bounds ?? .zero)
        let stack = NSStackView()
        stack.orientation = .vertical
        stack.spacing = 18
        if !retry {
            let spinner = NSProgressIndicator()
            spinner.style = .spinning
            spinner.startAnimation(nil)
            stack.addArrangedSubview(spinner)
        }
        let label = NSTextField(wrappingLabelWithString: message)
        label.alignment = .center
        label.font = .systemFont(ofSize: 16)
        label.preferredMaxLayoutWidth = 540
        stack.addArrangedSubview(label)
        if retry {
            stack.addArrangedSubview(NSButton(title: "重试", target: self, action: #selector(startProject)))
            stack.addArrangedSubview(NSButton(title: "查看启动日志", target: self, action: #selector(showLog(_:))))
        }
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            stack.widthAnchor.constraint(lessThanOrEqualToConstant: 560)
        ])
        window.contentView = view
    }

    @objc func startProject() {
        guard launcher == nil else { return }
        showStatus("正在打开" + configuration.name + "…")
        let process = Process()
        let output = Pipe(), errors = Pipe()
        process.executableURL = URL(fileURLWithPath: configuration.nodePath)
        process.arguments = [Bundle.main.url(forResource: "backend", withExtension: "mjs")!.path, "--project", configuration.projectPath]
        process.currentDirectoryURL = URL(fileURLWithPath: configuration.projectPath)
        process.standardOutput = output
        process.standardError = errors
        process.terminationHandler = { [weak self] finished in
            let data = output.fileHandleForReading.readDataToEndOfFile()
            let errorData = errors.fileHandleForReading.readDataToEndOfFile()
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.launcher = nil
                if finished.terminationStatus == 0,
                   let result = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                   let text = result["url"] as? String, let url = URL(string: text),
                   url.scheme == "http", url.host == "127.0.0.1" {
                    self.baseURL = url
                    self.window.contentView = self.webView
                    self.window.makeFirstResponder(self.webView)
                    self.webView.load(URLRequest(url: url))
                } else {
                    let result = (try? JSONSerialization.jsonObject(with: errorData)) as? [String: Any]
                    self.showStatus(result?["error"] as? String ?? "启动失败。请检查 Node.js、项目目录与数据库，或重新运行安装脚本。", retry: true)
                }
            }
        }
        do { launcher = process; try process.run() }
        catch { launcher = nil; showStatus("项目目录或 Node.js 不可用。请在项目目录重新运行“安装北向到Dock.command”。", retry: true) }
    }

    @objc func showWindow(_ sender: Any?) { window.makeKeyAndOrderFront(sender); NSApp.activate(ignoringOtherApps: true) }
    @objc func reloadPage(_ sender: Any?) { if baseURL == nil || window.contentView !== webView { startProject() } else { webView.reload() } }
    @objc func goBack(_ sender: Any?) { webView.goBack() }
    @objc func goForward(_ sender: Any?) { webView.goForward() }
    @objc func showLog(_ sender: Any?) {
        let log = URL(fileURLWithPath: configuration.projectPath).appendingPathComponent(".runtime/desktop/server.log")
        if FileManager.default.fileExists(atPath: log.path) { NSWorkspace.shared.open(log) }
        else { NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: configuration.projectPath) }
    }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { showWindow(nil); return true }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { return false }

    func internalURL(_ url: URL) -> Bool { url.scheme == baseURL?.scheme && url.host == baseURL?.host && url.port == baseURL?.port }
    func externalURL(_ url: URL) { if ["https", "http"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) } }
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        if internalURL(url) {
            if action.shouldPerformDownload { decisionHandler(.download) }
            else if action.targetFrame == nil { webView.load(action.request); decisionHandler(.cancel) }
            else { decisionHandler(.allow) }
        } else {
            if action.navigationType == .linkActivated || action.targetFrame == nil { externalURL(url) }
            decisionHandler(.cancel)
        }
    }
    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        decisionHandler(response.canShowMIMEType ? .allow : .download)
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code != NSURLErrorCancelled { showStatus("连接已中断，请重试以恢复工作台。", retry: true) }
    }
    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = URL(fileURLWithPath: suggestedFilename).lastPathComponent
        panel.canCreateDirectories = true
        panel.beginSheetModal(for: window) { result in completionHandler(result == .OK ? panel.url : nil) }
    }
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "确定")
        alert.addButton(withTitle: "取消")
        alert.beginSheetModal(for: window) { result in completionHandler(result == .alertFirstButtonReturn) }
    }
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.beginSheetModal(for: window) { _ in completionHandler() }
    }
}

if CommandLine.arguments.count == 3 && CommandLine.arguments[1] == "--pin-to-dock" {
    do { try pinToDock(CommandLine.arguments[2]) }
    catch { fputs(error.localizedDescription + "\n", stderr); exit(1) }
} else {
    let app = NSApplication.shared
    let delegate = NorthApp()
    app.setActivationPolicy(.regular)
    app.delegate = delegate
    app.run()
}
