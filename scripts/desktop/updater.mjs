import {execFile} from 'node:child_process';
import {promisify, parseArgs} from 'node:util';
import {mkdir, readFile, writeFile, rename, rm, access, symlink, realpath, chmod} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {launchProject, stopProject, activeCodeDirectory, projectEnvironment} from './backend.mjs';

export const UPDATE_REPOSITORY = 'https://github.com/JiangYu3761/Work-Board-Tasks.git';
const exec = promisify(execFile);
const exists = file => access(file).then(() => true, () => false);
const readJSON = file => readFile(file, 'utf8').then(JSON.parse);
async function atomicJSON(file, value) {
  const temporary = file + '.' + randomUUID() + '.tmp';
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', {mode: 0o600});
  await rename(temporary, file);
}

export async function sourceVersion(directory) {
  const pkg = await readJSON(path.join(directory, 'package.json'));
  try {
    const top = (await exec('git', ['-C', directory, 'rev-parse', '--show-toplevel'], {timeout: 5000})).stdout.trim();
    if (await realpath(top) !== await realpath(directory)) throw new Error('Not the project Git root');
    const {stdout} = await exec('git', ['-C', directory, 'rev-parse', '--verify', 'HEAD'], {timeout: 5000});
    return {version: pkg.version, revision: stdout.trim()};
  } catch {
    const stamp = await readJSON(path.join(directory, 'scripts/desktop/version.json')).catch(() => ({}));
    return {version: pkg.version, revision: /^[a-f0-9]{40}$/.test(stamp.revision || '') ? stamp.revision : 'local'};
  }
}

async function executable(candidates) {
  for (const file of candidates.filter(Boolean)) {
    if (await exists(file)) return file;
  }
  return null;
}

async function databaseTools(env) {
  const directories = (env.PATH || '').split(path.delimiter).concat([
    '/Applications/Postgres.app/Contents/Versions/latest/bin', '/opt/homebrew/bin', '/usr/local/bin',
  ]);
  const dump = await executable(directories.map(directory => path.join(directory, 'pg_dump')));
  const restore = await executable(directories.map(directory => path.join(directory, 'pg_restore')));
  if (!dump || !restore) throw new Error('未找到 PostgreSQL 备份工具，请安装或打开 Postgres.app 后重试。');
  return {dump, restore};
}

export async function backupDatabase({projectDir, destination, run}) {
  const env = await projectEnvironment(projectDir);
  Object.assign(env, {PGHOST: env.PGHOST || '127.0.0.1', PGPORT: env.PGPORT || '5432', PGUSER: env.PGUSER || env.USER, PGDATABASE: env.PGDATABASE || 'personal_radar'});
  const tools = await databaseTools(env);
  await run(tools.dump, ['--format=custom', '--no-owner', '--no-acl', '--file', destination], {env});
  await chmod(destination, 0o600);
  return {file: destination};
}

export async function restoreDatabase({projectDir, snapshot, run}) {
  const env = await projectEnvironment(projectDir);
  Object.assign(env, {PGHOST: env.PGHOST || '127.0.0.1', PGPORT: env.PGPORT || '5432', PGUSER: env.PGUSER || env.USER, PGDATABASE: env.PGDATABASE || 'personal_radar'});
  const tools = await databaseTools(env);
  await run(tools.restore, ['--clean', '--if-exists', '--no-owner', '--no-acl', '--single-transaction', '--exit-on-error', '--dbname', env.PGDATABASE, snapshot.file], {env});
}

// All downloaded code goes into private version directories. The user's checkout,
// .env, node_modules, evidence and database stay in their original locations.
export function createUpdater({
  projectDir, repository = UPDATE_REPOSITORY, baselineRevision, appPath,
  lifecycle = {start: launchProject, stop: stopProject},
  backup = backupDatabase, restore = restoreDatabase, buildApplication,
} = {}) {
  const root = path.resolve(projectDir), state = path.join(root, '.runtime/desktop/updates');
  const cache = path.join(state, 'repository.git'), statusFile = path.join(state, 'status.json');
  const activeFile = path.join(state, 'active.json'), lock = path.join(state, 'update.lock');
  let operation = null;

  async function run(file, args, options = {}) {
    try {
      const result = await exec(file, args, {cwd: root, timeout: 240000, maxBuffer: 12 * 1024 * 1024,
        env: {...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never'}, ...options});
      if (result.stderr) await writeFile(path.join(state, 'update.log'), result.stderr, {flag: 'a', mode: 0o600});
      return result;
    } catch (error) {
      // Commands never contain credentials; keep detailed errors local.
      await writeFile(path.join(state, 'update.log'), new Date().toISOString() + ' ' + path.basename(file) + ': ' + (error.stderr || error.message) + '\n', {flag: 'a', mode: 0o600});
      throw new Error(path.basename(file) + ' 执行失败，请查看更新日志。');
    }
  }
  async function current() {
    const active = await readJSON(activeFile).catch(() => null);
    if (active) { await activeCodeDirectory(root); return active; }
    const version = await sourceVersion(root);
    return {...version, revision: baselineRevision || version.revision, codePath: root};
  }
  async function status() {
    await mkdir(state, {recursive: true, mode: 0o700});
    const installed = await current(), saved = await readJSON(statusFile).catch(() => ({}));
    return {...saved, currentVersion: installed.version, currentRevision: installed.revision, repository: UPDATE_REPOSITORY, branch: 'main'};
  }
  async function progress(phase, message, extra = {}) {
    const saved = await readJSON(statusFile).catch(() => ({}));
    await atomicJSON(statusFile, {...saved, phase, message, ...extra});
  }
  async function exclusive(task) {
    await mkdir(state, {recursive: true, mode: 0o700});
    try { await mkdir(lock, {mode: 0o700}); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = await readJSON(path.join(lock, 'owner.json')).catch(() => null);
      let dead = false;
      if (Number.isInteger(owner?.pid) && owner.pid > 1) {
        try { process.kill(owner.pid, 0); } catch (probe) { dead = probe.code === 'ESRCH'; }
      }
      if (!dead) throw new Error('已有更新任务正在进行。');
      await rm(lock, {recursive: true});
      return exclusive(task);
    }
    operation = randomUUID();
    await atomicJSON(path.join(lock, 'owner.json'), {pid: process.pid, operation});
    try { return await task(); }
    catch (error) {
      await progress('failed', error.message);
      throw error;
    } finally {
      const owner = await readJSON(path.join(lock, 'owner.json')).catch(() => null);
      if (owner?.operation === operation) await rm(lock, {recursive: true, force: true});
    }
  }

  async function checkInternal() {
    await progress('checking', '正在检查 GitHub 上的新版本…', {updateAvailable: false, lastCheckedAt: new Date().toISOString()});
    if (!await exists(cache)) await run('git', ['init', '--bare', cache]);
    try { await run('git', ['--git-dir', cache, 'fetch', '--quiet', '--depth=1', repository, 'refs/heads/main'], {timeout: 60000}); }
    catch { throw new Error('无法连接更新源，请检查网络及 GitHub 仓库访问权限。当前版本可继续使用。'); }
    const revision = (await run('git', ['--git-dir', cache, 'rev-parse', '--verify', 'FETCH_HEAD'])).stdout.trim();
    if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('更新源返回了无效版本，当前版本未改动。');
    await run('git', ['--git-dir', cache, 'fsck', '--full', '--no-reflogs']);
    const pkg = JSON.parse((await run('git', ['--git-dir', cache, 'show', revision + ':package.json'])).stdout);
    if (pkg.name !== 'north-personal-radar' || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(pkg.version || '')) throw new Error('更新包与北向项目不匹配。');
    const installed = await current(), checked = new Date().toISOString();
    const details = {latestRevision: revision, latestVersion: pkg.version, lastCheckedAt: checked};
    if (revision === installed.revision) {
      await progress('current', '已经是最新版本。', {...details, updateAvailable: false});
      return null;
    }
    const required = ['server.mjs', 'package-lock.json', 'scripts/desktop/updater.mjs', 'scripts/desktop/backend.mjs', 'scripts/desktop/install.mjs', 'scripts/desktop/North.swift'];
    const files = (await run('git', ['--git-dir', cache, 'ls-tree', '-r', '--name-only', revision])).stdout.split('\n');
    if (!required.every(file => files.includes(file))) {
      await progress('unpublished', '线上版本暂未包含桌面更新组件。待新版发布后可自动安装，当前版本保持不变。', {...details, updateAvailable: false});
      return null;
    }
    const latestMajor = pkg.version.split(/[-+]/)[0].split('.').map(Number), currentMajor = installed.version.split(/[-+]/)[0].split('.').map(Number);
    for (let i = 0; i < 3; i++) {
      if (latestMajor[i] > currentMajor[i]) break;
      if (latestMajor[i] < currentMajor[i]) {
        await progress('current', '更新源版本较旧，已保留当前版本。', {...details, updateAvailable: false});
        return null;
      }
    }
    const candidate = {revision, version: pkg.version};
    await progress('available', '发现新版本 ' + pkg.version + ' · ' + revision.slice(0, 7) + '，可安装。', {...details, updateAvailable: true});
    return candidate;
  }

  async function prepare(candidate) {
    const directory = path.join(state, 'versions', candidate.revision);
    const prepared = path.join(directory, '.north-prepared.json');
    if (await exists(prepared)) {
      const stamp = await readJSON(prepared);
      if (stamp.revision === candidate.revision && await exists(path.join(directory, 'node_modules'))) return directory;
    }
    await progress('downloading', '正在下载并校验更新…');
    const tree = (await run('git', ['--git-dir', cache, 'ls-tree', '-r', '-z', candidate.revision])).stdout.split('\0').filter(Boolean);
    for (const entry of tree) {
      const [metadata, file] = entry.split('\t');
      const parts = (file || '').split('/');
      if (!file || file.startsWith('/') || parts.some(p => ['..', '.git', '.runtime', '.state', 'node_modules'].includes(p)) ||
          ((parts[0] === '.env' || parts[0].startsWith('.env.')) && parts[0] !== '.env.example') ||
          file === 'settings.env' || !/^(100644|100755) blob /.test(metadata)) {
        throw new Error('更新包包含不支持的文件，已停止安装。');
      }
    }
    await rm(directory, {recursive: true, force: true});
    await mkdir(directory, {recursive: true, mode: 0o700});
    const archive = path.join(state, candidate.revision + '.tar');
    await run('git', ['--git-dir', cache, 'archive', '--format=tar', '--output', archive, candidate.revision]);
    try { await run('/usr/bin/tar', ['-xf', archive, '-C', directory]); }
    finally { await rm(archive, {force: true}); }
    await atomicJSON(path.join(directory, 'scripts/desktop/version.json'), candidate);
    await symlink(path.join(root, '.runtime'), path.join(directory, '.runtime'), 'dir');
    if (await exists(path.join(root, '.env'))) await symlink(path.join(root, '.env'), path.join(directory, '.env'));
    if (await exists(path.join(root, '.state'))) await symlink(path.join(root, '.state'), path.join(directory, '.state'), 'dir');
    if (await exists(path.join(root, 'settings.env'))) await symlink(path.join(root, 'settings.env'), path.join(directory, 'settings.env'));
    await progress('dependencies', '正在安装更新所需的依赖…');
    const npm = await executable([
      await realpath(path.join(path.dirname(process.execPath), 'npm')).catch(() => null),
      path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'),
      '/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js', '/usr/local/lib/node_modules/npm/bin/npm-cli.js',
    ]);
    if (!npm) throw new Error('未找到 npm，请重新安装 Node.js 22 或以上版本。');
    await run(process.execPath, [npm, 'ci', '--no-audit', '--no-fund', '--cache', path.join(state, 'npm-cache')], {cwd: directory});
    await mkdir(path.join(directory, 'node_modules'), {recursive: true});
    await atomicJSON(prepared, candidate);
    return directory;
  }

  async function installInternal() {
    const candidate = await checkInternal();
    if (!candidate) return status();
    const directory = await prepare(candidate);
    if (!appPath) throw new Error('请从北向桌面应用的“软件更新”发起安装。');
    const config = await readJSON(path.join(appPath, 'Contents/Resources/project.json'));
    if (await realpath(config.projectPath) !== root) throw new Error('当前应用与项目不匹配，已停止安装。');
    await progress('building', '正在准备新版应用…');
    const stagedApp = path.join(path.dirname(appPath), '.north-prepared-' + candidate.revision + '.app');
    await rm(stagedApp, {recursive: true, force: true});
    if (buildApplication) await buildApplication({directory, output: stagedApp, candidate, run});
    else {
      if (process.platform !== 'darwin') throw new Error('桌面应用更新需要在 Mac 上安装。');
      await run(process.execPath, [path.join(directory, 'scripts/desktop/install.mjs'), '--project', root, '--source', directory,
        '--name', config.name, '--revision', candidate.revision, '--build-only', stagedApp]);
    }
    if (!await exists(path.join(stagedApp, 'Contents/MacOS/North'))) throw new Error('新版应用校验未通过，当前版本未改动。');

    const previous = await current(), previousActive = await readJSON(activeFile).catch(() => null);
    const appBackup = path.join(path.dirname(appPath), '.north-previous-' + path.basename(appPath));
    const snapshotPath = path.join(state, 'database-before-' + candidate.revision + '.dump');
    let stopped = false, stopAttempted = false, activated = false, movedApp = false, snapshot = null;
    await progress('installing', '正在保存当前状态并安装更新…');
    try {
      stopAttempted = true;
      stopped = await lifecycle.stop(root);
      if (!stopped) {
        const env = await projectEnvironment(root), port = Number(env.PORT || 4317);
        try {
          await fetch('http://127.0.0.1:' + port + '/api/health', {signal: AbortSignal.timeout(1000)});
          throw new Error('当前服务由终端或其他启动器运行，请先关闭该服务后再安装更新。');
        } catch (error) { if (!error.cause) throw error; }
      }
      snapshot = await backup({projectDir: root, destination: snapshotPath, run});
      await atomicJSON(activeFile, {...candidate, codePath: directory, activatedAt: new Date().toISOString(), previousRevision: previous.revision});
      activated = true;
      await lifecycle.start({projectDir: root});
      await progress('verifying', '正在验证新版本…');
      const env = await projectEnvironment(root), base = 'http://127.0.0.1:' + Number(env.PORT || 4317);
      for (const route of ['/api/health', '/api/dashboard']) {
        const response = await fetch(base + route, {signal: AbortSignal.timeout(5000)});
        if (!response.ok) throw new Error('新版工作台验证失败。');
        await response.json();
      }
      await rm(appBackup, {recursive: true, force: true});
      await rename(appPath, appBackup);
      movedApp = true;
      await rename(stagedApp, appPath);
      await progress('installed', '更新已安装，即将重新打开应用。', {updateAvailable: false, installedAt: new Date().toISOString()});
      return {...await status(), restartRequired: true};
    } catch (error) {
      await progress('rollingBack', '更新未完成，正在恢复原版本…');
      try {
        if (activated) {
          await lifecycle.stop(root);
          if (snapshot) await restore({projectDir: root, snapshot, run});
          if (previousActive) await atomicJSON(activeFile, previousActive);
          else await rm(activeFile, {force: true});
        }
        if (movedApp) {
          if (await exists(appPath)) await rm(appPath, {recursive: true});
          await rename(appBackup, appPath);
        }
        if (stopAttempted) await lifecycle.start({projectDir: root});
      } catch {
        throw new Error('更新未完成，自动恢复也未完成。原应用及数据库备份已保留，请查看更新日志后恢复。');
      }
      throw new Error('更新未完成，已保留或恢复原版本：' + error.message);
    }
  }
  return {
    status,
    check: () => exclusive(async () => { await checkInternal(); return status(); }),
    install: () => exclusive(installInternal),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const {values} = parseArgs({options: {project: {type: 'string'}, app: {type: 'string'}, baseline: {type: 'string'}, action: {type: 'string'}}});
    if (!values.project) throw new Error('缺少项目目录。');
    const updater = createUpdater({projectDir: await realpath(values.project), appPath: values.app, baselineRevision: values.baseline});
    const action = values.action || 'status';
    if (!['status', 'check', 'install'].includes(action)) throw new Error('不支持此更新操作。');
    console.log(JSON.stringify(await updater[action]()));
  } catch (error) { console.error(JSON.stringify({error: error.message})); process.exitCode = 1; }
}
