import {spawn, execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {openSync, closeSync} from 'node:fs';
import {mkdir, readFile, writeFile, rm, realpath} from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs, parseEnv, promisify} from 'node:util';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const projectIdentity = directory => createHash('sha256').update(path.resolve(directory)).digest('hex');
const execute = promisify(execFile);

export async function projectEnvironment(directory, inheritedEnv = process.env) {
  let dotenv = {};
  try { dotenv = parseEnv(await readFile(path.join(directory, '.env'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return {...inheritedEnv, ...dotenv};
}

export async function activeCodeDirectory(directory) {
  let active;
  try { active = JSON.parse(await readFile(path.join(directory, '.runtime/desktop/updates/active.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return directory; throw error; }
  if (!/^[a-f0-9]{40}$/.test(active.revision || '')) throw new Error('当前版本记录无效，请查看更新日志。');
  const expected = path.join(directory, '.runtime/desktop/updates/versions', active.revision);
  if (path.resolve(active.codePath) !== expected || await realpath(expected) !== expected) throw new Error('当前版本目录无效，请查看更新日志。');
  return expected;
}

export async function stopProject(projectDir) {
  const directory = await realpath(projectDir), statePath = path.join(directory, '.runtime/desktop/server.json');
  let state;
  try { state = JSON.parse(await readFile(statePath, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  if (!Number.isInteger(state.pid) || state.pid < 2 || state.identity !== projectIdentity(directory)) throw new Error('无法确认后台服务归属，已保留现有服务。');
  let command;
  try { command = (await execute('/bin/ps', ['-p', String(state.pid), '-o', 'command='])).stdout; }
  catch { await rm(statePath, {force: true}); return false; }
  const server = path.join(state.codePath || directory, 'server.mjs');
  if (!command.includes(server)) throw new Error('后台进程已变化，已保留该进程。');
  process.kill(-state.pid, 'SIGTERM');
  for (let i = 0; i < 100; i++) {
    try {
      const result = await execute('/bin/ps', ['-p', String(state.pid), '-o', 'stat=']);
      if (result.stdout.trim().startsWith('Z')) break;
    } catch { break; }
    if (i === 99) throw new Error('后台服务正在完成任务，请稍后再次安装更新。');
    await sleep(200);
  }
  await rm(statePath, {force: true});
  return true;
}

async function portOpen(port, host = '127.0.0.1') {
  return new Promise(resolve => {
    const socket = net.connect({port, host});
    const done = value => { socket.destroy(); resolve(value); };
    socket.setTimeout(500, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

async function healthy(url, identity) {
  try {
    const response = await fetch(url + '/api/health', {signal: AbortSignal.timeout(1000), redirect: 'error'});
    if (!response.ok || response.headers.get('x-north-project') !== identity) return false;
    const body = await response.json();
    return body.ok === true && body.database === 'postgresql';
  } catch { return false; }
}

async function startPostgresApp(env) {
  const host = env.PGHOST || '127.0.0.1', port = Number(env.PGPORT || 5432);
  if (process.platform !== 'darwin' || !['127.0.0.1', 'localhost'].includes(host) || await portOpen(port, host)) return;
  await new Promise(resolve => {
    const child = spawn('/usr/bin/open', ['-g', '-a', 'Postgres'], {stdio: 'ignore'});
    child.once('error', resolve);
    child.once('exit', resolve);
  });
  for (let i = 0; i < 40; i++) {
    if (await portOpen(port, host)) return;
    await sleep(250);
  }
  throw new Error('请先在 Postgres.app 中启动数据库，再点“重试”。首次使用请按 README 初始化数据库。');
}

// Each project keeps its own lock, log and PID. No credentials leave its environment.
export async function launchProject({projectDir, nodePath = process.execPath, inheritedEnv = process.env, timeout = 30000}) {
  const directory = await realpath(projectDir);
  const codePath = await activeCodeDirectory(directory);
  await readFile(path.join(codePath, 'server.mjs'));
  const env = {...await projectEnvironment(directory, inheritedEnv), NORTH_PROJECT_ROOT: directory};
  const port = Number(env.PORT || 4317);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('.env 的 PORT 必须是 1 至 65535 之间的整数。');
  const url = 'http://127.0.0.1:' + port, identity = projectIdentity(directory);
  const ready = () => healthy(url, identity);
  if (await ready()) return {url, started: false};

  const state = path.join(directory, '.runtime', 'desktop'), lock = path.join(state, 'launch.lock');
  await mkdir(state, {recursive: true, mode: 0o700});
  const deadline = Date.now() + timeout;
  while (true) {
    try {
      await mkdir(lock, {mode: 0o700});
      await writeFile(path.join(lock, 'owner.json'), JSON.stringify({pid: process.pid}), {mode: 0o600});
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (await ready()) return {url, started: false};
      try {
        const owner = JSON.parse(await readFile(path.join(lock, 'owner.json'), 'utf8'));
        try { process.kill(owner.pid, 0); }
        catch (probe) { if (probe.code === 'ESRCH') await rm(lock, {recursive: true, force: true}); }
      } catch {}
      if (Date.now() >= deadline) throw new Error('另一个北向启动仍在进行，请稍后重试。');
      await sleep(150);
    }
  }

  let child;
  try {
    if (await ready()) return {url, started: false};
    if (await portOpen(port)) throw new Error('端口 ' + port + ' 已被其他服务或旧版北向占用。请先停止它，或修改本项目 .env 的 PORT 后重试。');
    await startPostgresApp(env);
    const log = path.join(state, 'server.log');
    const fd = openSync(log, 'a', 0o600);
    try {
      child = spawn(nodePath, ['--env-file-if-exists=.env', path.join(codePath, 'server.mjs')], {
        cwd: codePath, env, detached: true, stdio: ['ignore', fd, fd],
      });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    } finally { closeSync(fd); }
    child.unref();
    await writeFile(path.join(state, 'server.json'), JSON.stringify({pid: child.pid, identity, port, codePath}), {mode: 0o600});
    const serverDeadline = Date.now() + timeout;
    while (Date.now() < serverDeadline) {
      if (await ready()) return {url, pid: child.pid, started: true};
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('本地服务启动失败。请确认已运行 npm ci、npm run setup，数据库连接配置正确；详情见“查看启动日志”。');
      await sleep(200);
    }
    throw new Error('本地服务未能及时启动，请查看启动日志，检查 PostgreSQL 后重试。');
  } catch (error) {
    // Clean up only the process group this invocation created, including its workers.
    if (child?.pid) {
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
      await rm(path.join(state, 'server.json'), {force: true});
    }
    throw error;
  } finally {
    await rm(lock, {recursive: true, force: true});
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const {values} = parseArgs({options: {project: {type: 'string'}}});
    if (!values.project) throw new Error('缺少项目目录。请重新运行“安装北向到Dock.command”。');
    console.log(JSON.stringify(await launchProject({projectDir: values.project})));
  } catch (error) {
    const message = ['ENOENT', 'ENOTDIR'].includes(error.code) ? '项目目录或 Node.js 已移动。请在新目录重新运行“安装北向到Dock.command”。' : error.message;
    console.error(JSON.stringify({error: message}));
    process.exitCode = 1;
  }
}
