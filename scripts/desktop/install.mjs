import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {mkdir, mkdtemp, readFile, writeFile, cp, rename, rm, realpath, access} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {projectIdentity, activeCodeDirectory as activeSource} from './backend.mjs';
import {sourceVersion} from './updater.mjs';

const source = path.dirname(fileURLToPath(import.meta.url));
const exists = async file => access(file).then(() => true, () => false);
const xml = value => String(value).replace(/[<>&"']/g, c => ({'<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;'}[c]));

export function infoPlist(name, identifier, version = '1.0.0') {
  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    '<plist version="1.0"><dict>' +
    '<key>CFBundleExecutable</key><string>North</string>' +
    '<key>CFBundleIdentifier</key><string>' + xml(identifier) + '</string>' +
    '<key>CFBundleName</key><string>' + xml(name) + '</string>' +
    '<key>CFBundleDisplayName</key><string>' + xml(name) + '</string>' +
    '<key>CFBundlePackageType</key><string>APPL</string>' +
    '<key>CFBundleShortVersionString</key><string>' + xml(version.split(/[-+]/)[0]) + '</string>' +
    '<key>CFBundleVersion</key><string>' + xml(version.split(/[-+]/)[0]) + '</string>' +
    '<key>CFBundleIconFile</key><string>North.icns</string>' +
    '<key>LSMinimumSystemVersion</key><string>12.0</string>' +
    '<key>NSPrincipalClass</key><string>NSApplication</string>' +
    '<key>NSHighResolutionCapable</key><true/>' +
    '<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/>' +
    '<key>NSAllowsArbitraryLoadsInWebContent</key><true/></dict>' +
    '</dict></plist>\n';
}

export async function createIcon(projectDir, output) {
  const require = createRequire(path.join(projectDir, 'package.json'));
  const sharp = require('sharp'), svg = await readFile(path.join(projectDir, 'public/favicon.svg'));
  const chunks = [];
  for (const [kind, size] of [['icp4', 16], ['icp5', 32], ['icp6', 64], ['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024]]) {
    const png = await sharp(svg, {density: Math.max(72, size * 72 / 64)}).resize(size, size).png().toBuffer();
    const header = Buffer.alloc(8);
    header.write(kind); header.writeUInt32BE(png.length + 8, 4);
    chunks.push(header, png);
  }
  const header = Buffer.alloc(8);
  header.write('icns'); header.writeUInt32BE(8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0), 4);
  await writeFile(output, Buffer.concat([header, ...chunks]));
}

export async function buildBundle({projectDir, sourceDir = projectDir, name = '北向', revision, output}) {
  if (process.platform !== 'darwin') throw new Error('此安装器用于 macOS 12 或以上版本，请在 Mac 上双击“安装北向到Dock.command”。');
  if (!name.trim() || /[\/:\0\r\n]/.test(name) || name === '.' || name === '..') throw new Error('应用名称不能包含路径分隔符。');
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('需要 Node.js 22 或以上版本。');
  const project = await realpath(projectDir), code = await realpath(sourceDir);
  if (!await exists(path.join(code, 'node_modules/pg/package.json')) || !await exists(path.join(code, 'node_modules/sharp/package.json'))) {
    throw new Error('请先在项目目录运行 npm ci，再重新运行安装器。');
  }
  try { execFileSync('/usr/bin/xcrun', ['--find', 'swiftc'], {stdio: 'pipe'}); }
  catch { throw new Error('首次构建需要 Xcode 命令行工具：请运行 xcode-select --install，安装完成后再试。'); }
  const version = await sourceVersion(code);
  const contents = path.join(output, 'Contents'), resources = path.join(contents, 'Resources');
  const executable = path.join(contents, 'MacOS/North');
  await mkdir(path.dirname(executable), {recursive: true});
  await mkdir(resources, {recursive: true});
  await writeFile(path.join(contents, 'Info.plist'), infoPlist(name, 'cn.jiangyu.north.p' + projectIdentity(project).slice(0, 16), version.version));
  await writeFile(path.join(resources, 'project.json'), JSON.stringify({projectPath: project, nodePath: process.execPath, name, revision: revision || version.revision, version: version.version}), {mode: 0o600});
  for (const helper of ['backend.mjs', 'updater.mjs']) {
    await cp(path.join(code, 'scripts/desktop', helper), path.join(resources, helper));
  }
  await createIcon(code, path.join(resources, 'North.icns'));
  console.log('正在构建独立应用窗口…');
  execFileSync('/usr/bin/xcrun', ['swiftc', '-swift-version', '5', '-O', '-framework', 'Cocoa', '-framework', 'WebKit', path.join(code, 'scripts/desktop/North.swift'), '-o', executable], {
    stdio: 'inherit', env: {...process.env, MACOSX_DEPLOYMENT_TARGET: '12.0'},
  });
  execFileSync('/usr/bin/plutil', ['-lint', path.join(contents, 'Info.plist')], {stdio: 'inherit'});
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', output], {stdio: 'inherit'});
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', output], {stdio: 'inherit'});
  return output;
}

export async function install({projectDir, name = '北向', open = true}) {
  if (process.platform !== 'darwin') throw new Error('此安装器用于 macOS 12 或以上版本，请在 Mac 上双击“安装北向到Dock.command”。');
  const project = await realpath(projectDir);
  if (!name.trim() || /[\/:\0\r\n]/.test(name) || name === '.' || name === '..') throw new Error('应用名称不能包含路径分隔符。');
  const applications = path.join(os.homedir(), 'Applications');
  const target = path.join(applications, name + '.app');
  if (await exists(target)) {
    let previous;
    try { previous = JSON.parse(await readFile(path.join(target, 'Contents/Resources/project.json'), 'utf8')); } catch {}
    if (previous?.projectPath !== project) throw new Error('该位置已有另一份应用。请用 --name 指定其他名称，现有应用未改动。');
  }
  await mkdir(applications, {recursive: true});
  const staging = await mkdtemp(path.join(applications, '.north-install-'));
  const bundle = path.join(staging, name + '.app');
  const backup = path.join(staging, 'previous.app');
  let backedUp = false, installed = false, cleanup = true;
  try {
    await buildBundle({projectDir: project, sourceDir: await activeSource(project), name, output: bundle});
    if (await exists(target)) { await rename(target, backup); backedUp = true; }
    await rename(bundle, target);
    installed = true;
    console.log('已安装：' + target);
    try {
      execFileSync(path.join(target, 'Contents/MacOS/North'), ['--pin-to-dock', target], {stdio: 'inherit'});
      // Refresh Dock so the preserved tiles and the new application appear together.
      try { execFileSync('/usr/bin/killall', ['Dock'], {stdio: 'ignore'}); } catch {}
      console.log('已加入 Dock；以后点击北向图标即可打开独立窗口。');
    } catch {
      console.log('自动固定 Dock 未完成；可将“' + target + '”拖到 Dock 固定，应用已安装。');
    }
    if (open) execFileSync('/usr/bin/open', [target], {stdio: 'inherit'});
    return target;
  } catch (error) {
    if (!installed && backedUp) {
      try { await rename(backup, target); }
      catch {
        cleanup = false;
        throw new Error('安装中断，旧应用已保存在 ' + backup + '，请从这里恢复；项目数据未改动。');
      }
    }
    throw error;
  } finally {
    if (cleanup) await rm(staging, {recursive: true, force: true});
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const {values} = parseArgs({options: {project: {type: 'string'}, name: {type: 'string'}, 'no-open': {type: 'boolean'}, source: {type: 'string'}, revision: {type: 'string'}, 'build-only': {type: 'string'}}});
    const project = values.project || path.resolve(source, '../..');
    if (values['build-only']) await buildBundle({projectDir: project, sourceDir: values.source || project, name: values.name || '北向', revision: values.revision, output: values['build-only']});
    else await install({projectDir: project, name: values.name || '北向', open: !values['no-open']});
  } catch (error) { console.error('安装未完成：' + error.message); process.exitCode = 1; }
}
