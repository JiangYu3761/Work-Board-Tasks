import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir, mkdtemp, writeFile, readFile, rm, cp, access, stat} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {createUpdater, backupDatabase, restoreDatabase} from '../scripts/desktop/updater.mjs';
import {launchProject, stopProject, activeCodeDirectory} from '../scripts/desktop/backend.mjs';
import {connection} from '../lib/db.mjs';

const exec = promisify(execFile), require = createRequire(import.meta.url), pg = require('pg');
const exists = file => access(file).then(() => true, () => false);
async function git(directory, ...args) { return (await exec('git', ['-C', directory, ...args])).stdout.trim(); }
async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
function fixtureServer(version, failing = false) {
  return [
    "import http from 'node:http';",
    "import {createHash} from 'node:crypto';",
    "const identity=createHash('sha256').update(process.env.NORTH_PROJECT_ROOT||process.cwd()).digest('hex');",
    "const server=http.createServer((req,res)=>{res.setHeader('X-North-Project',identity);res.setHeader('Content-Type','application/json');",
    failing ? "if(req.url==='/api/dashboard'){res.writeHead(500);res.end('{}');return;}" : "",
    "res.end(JSON.stringify({ok:true,database:'postgresql',version:" + JSON.stringify(version) + "}));});",
    "server.listen(Number(process.env.PORT),'127.0.0.1');",
    "process.on('SIGTERM',()=>server.close(()=>process.exit(0)));",
  ].join('\n');
}
async function addVersion(upstream, version, {failing = false, unsafe = false, legacy = false} = {}) {
  await mkdir(path.join(upstream, 'scripts/desktop'), {recursive: true});
  const pkg = {name: 'north-personal-radar', version, type: 'module'};
  await writeFile(path.join(upstream, 'package.json'), JSON.stringify(pkg));
  await writeFile(path.join(upstream, 'package-lock.json'), JSON.stringify({name: pkg.name, version, lockfileVersion: 3, packages: {'': {name: pkg.name, version}}}));
  await writeFile(path.join(upstream, 'server.mjs'), fixtureServer(version, failing));
  for (const file of ['updater.mjs', 'backend.mjs', 'install.mjs', 'North.swift']) {
    await writeFile(path.join(upstream, 'scripts/desktop', file), '// Test fixture: native compilation is replaced on Linux.\n');
  }
  if (legacy) await rm(path.join(upstream, 'scripts/desktop/updater.mjs'));
  if (unsafe) {
    await mkdir(path.join(upstream, '.runtime'), {recursive: true});
    await writeFile(path.join(upstream, '.runtime/poison.txt'), 'must not install');
  }
  await git(upstream, 'add', '.');
  await git(upstream, 'commit', '--quiet', '-m', version + (failing ? ' broken' : ''));
  return git(upstream, 'rev-parse', 'HEAD');
}
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'north update 中文-'));
  const upstream = path.join(directory, 'upstream'), project = path.join(directory, 'my project');
  const app = path.join(directory, 'Applications/北向.app');
  await mkdir(upstream);
  await exec('git', ['init', '--quiet', '--initial-branch=main', upstream]);
  await git(upstream, 'config', 'user.email', 'desktop-test@example.invalid');
  await git(upstream, 'config', 'user.name', 'Desktop Update Test');
  const initial = await addVersion(upstream, '1.0.0');
  await exec('git', ['clone', '--quiet', upstream, project]);
  const port = await freePort();
  await writeFile(path.join(project, '.env'), 'PORT=' + port + '\nPGHOST=desktop-test.invalid\n');
  await writeFile(path.join(project, 'settings.env'), 'LOCAL_SETTING=preserved\n');
  await writeFile(path.join(project, 'my-notes.txt'), 'local changes stay here');
  await mkdir(path.join(project, '.runtime'), {recursive: true});
  await writeFile(path.join(project, '.runtime/evidence.txt'), 'retained evidence');
  await writeFile(path.join(project, '.runtime/database.txt'), 'original database');
  await mkdir(path.join(app, 'Contents/Resources'), {recursive: true});
  await mkdir(path.join(app, 'Contents/MacOS'));
  await writeFile(path.join(app, 'Contents/Resources/project.json'), JSON.stringify({projectPath: project, name: '北向'}));
  await writeFile(path.join(app, 'Contents/MacOS/North'), 'original native app');
  const options = {
    projectDir: project, repository: upstream, appPath: app, baselineRevision: initial,
    backup: async ({destination}) => { await cp(path.join(project, '.runtime/database.txt'), destination); return {file: destination}; },
    restore: async ({snapshot}) => { await cp(snapshot.file, path.join(project, '.runtime/database.txt')); },
    buildApplication: async ({output, candidate}) => {
      await mkdir(path.join(output, 'Contents/MacOS'), {recursive: true});
      await mkdir(path.join(output, 'Contents/Resources'), {recursive: true});
      await writeFile(path.join(output, 'Contents/MacOS/North'), 'native fixture ' + candidate.revision);
      await writeFile(path.join(output, 'Contents/Resources/project.json'), JSON.stringify({projectPath: project, name: '北向'}));
    },
  };
  t.after(async () => {
    await stopProject(project).catch(() => {});
    await rm(directory, {recursive: true, force: true});
  });
  return {directory, upstream, project, app, initial, port, options, updater: createUpdater(options)};
}

test('Update check reports the actual installed Git revision and an available newer version', async t => {
  const f = await fixture(t);
  const current = await f.updater.check();
  assert.equal(current.phase, 'current');
  assert.equal(current.updateAvailable, false);
  assert.equal(current.currentRevision, f.initial);
  const latest = await addVersion(f.upstream, '1.1.0');
  const result = await f.updater.check();
  assert.equal(result.phase, 'available');
  assert.equal(result.latestRevision, latest);
  assert.equal(result.latestVersion, '1.1.0');
  assert.ok(Date.parse(result.lastCheckedAt));
  assert.equal(await git(f.project, 'rev-parse', 'HEAD'), f.initial);
});

test('Automatic installation switches code and the app, restarts the backend, and preserves local data', async t => {
  const f = await fixture(t);
  await launchProject({projectDir: f.project});
  const latest = await addVersion(f.upstream, '1.1.0');
  const result = await f.updater.install();
  assert.equal(result.phase, 'installed');
  assert.equal(result.restartRequired, true);
  assert.equal(result.currentRevision, latest);
  const response = await fetch('http://127.0.0.1:' + f.port + '/api/dashboard');
  assert.equal((await response.json()).version, '1.1.0');
  assert.match(await readFile(path.join(f.app, 'Contents/MacOS/North'), 'utf8'), new RegExp(latest));
  assert.equal(await git(f.project, 'rev-parse', 'HEAD'), f.initial);
  assert.match(await readFile(path.join(f.project, 'server.mjs'), 'utf8'), /1.0.0/);
  assert.equal(await readFile(path.join(f.project, 'my-notes.txt'), 'utf8'), 'local changes stay here');
  assert.equal(await readFile(path.join(f.project, '.runtime/evidence.txt'), 'utf8'), 'retained evidence');
  assert.equal(await readFile(path.join(f.project, '.runtime/database.txt'), 'utf8'), 'original database');
  const active = await activeCodeDirectory(f.project);
  assert.equal(await readFile(path.join(active, 'settings.env'), 'utf8'), 'LOCAL_SETTING=preserved\n');
  assert.equal(await readFile(path.join(active, '.env'), 'utf8'), await readFile(path.join(f.project, '.env'), 'utf8'));
  assert.equal((await f.updater.install()).phase, 'current');
});

test('A broken update restores the old server, application and database snapshot', async t => {
  const f = await fixture(t);
  await launchProject({projectDir: f.project});
  const latest = await addVersion(f.upstream, '1.1.0', {failing: true});
  const options = {...f.options, lifecycle: {
    stop: stopProject,
    start: async input => {
      const active = await activeCodeDirectory(input.projectDir);
      if (active !== f.project) await writeFile(path.join(f.project, '.runtime/database.txt'), 'migration was attempted');
      return launchProject(input);
    },
  }};
  await assert.rejects(createUpdater(options).install(), /已保留或恢复原版本/);
  assert.equal(await activeCodeDirectory(f.project), f.project);
  assert.equal((await (await fetch('http://127.0.0.1:' + f.port + '/api/dashboard')).json()).version, '1.0.0');
  assert.equal(await readFile(path.join(f.app, 'Contents/MacOS/North'), 'utf8'), 'original native app');
  assert.equal(await readFile(path.join(f.project, '.runtime/database.txt'), 'utf8'), 'original database');
  assert.equal((await f.updater.status()).phase, 'failed');
  assert.equal(await exists(path.join(f.project, '.runtime/desktop/updates/database-before-' + latest + '.dump')), true);
});

test('Build failures do not stop or replace a working version', async t => {
  const f = await fixture(t);
  const running = await launchProject({projectDir: f.project});
  await addVersion(f.upstream, '1.1.0');
  const updater = createUpdater({...f.options, buildApplication: async () => { throw new Error('compiler unavailable'); }});
  await assert.rejects(updater.install(), /compiler unavailable/);
  const state = JSON.parse(await readFile(path.join(f.project, '.runtime/desktop/server.json'), 'utf8'));
  assert.equal(state.pid, running.pid);
  assert.equal(await activeCodeDirectory(f.project), f.project);
  assert.equal(await readFile(path.join(f.app, 'Contents/MacOS/North'), 'utf8'), 'original native app');
});

test('Updates cannot replace protected runtime files from an upstream archive', async t => {
  const f = await fixture(t);
  await addVersion(f.upstream, '1.1.0', {unsafe: true});
  await assert.rejects(f.updater.install(), /不支持的文件/);
  assert.equal(await readFile(path.join(f.project, '.runtime/evidence.txt'), 'utf8'), 'retained evidence');
  assert.equal(await activeCodeDirectory(f.project), f.project);
});

test('Network and repository failures remain visible without changing the current version', async t => {
  const f = await fixture(t);
  const broken = createUpdater({...f.options, repository: path.join(f.directory, 'missing.git')});
  await assert.rejects(broken.check(), /无法连接更新源/);
  const state = await broken.status();
  assert.equal(state.phase, 'failed');
  assert.equal(state.currentRevision, f.initial);
  assert.ok(Date.parse(state.lastCheckedAt));
  assert.equal(await activeCodeDirectory(f.project), f.project);
});

test('An unpublished desktop release and older versions are never silently installed', async t => {
  const f = await fixture(t);
  await addVersion(f.upstream, '1.1.0', {legacy: true});
  assert.equal((await f.updater.check()).phase, 'unpublished');
  await addVersion(f.upstream, '0.9.0');
  const state = await f.updater.check();
  assert.equal(state.updateAvailable, false);
  assert.equal(await activeCodeDirectory(f.project), f.project);
});

test('Concurrent automatic and manual checks do not run two update operations', async t => {
  const f = await fixture(t);
  const results = await Promise.allSettled([f.updater.check(), createUpdater(f.options).check()]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.match(results.find(result => result.status === 'rejected').reason.message, /已有更新任务/);
  assert.equal((await f.updater.status()).phase, 'current');
});

test('A dead update process does not leave subsequent checks permanently locked', async t => {
  const f = await fixture(t);
  const lock = path.join(f.project, '.runtime/desktop/updates/update.lock');
  await mkdir(lock, {recursive: true});
  await writeFile(path.join(lock, 'owner.json'), JSON.stringify({pid: 2147483647, operation: 'dead'}));
  assert.equal((await f.updater.check()).phase, 'current');
  assert.equal(await exists(lock), false);
});

test('PostgreSQL backup and rollback preserve actual table contents and schema', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'north-db-backup-'));
  const database = 'north_update_' + randomUUID().replaceAll('-', '');
  const admin = new pg.Client({...connection, database: 'postgres'});
  await admin.connect();
  let client;
  t.after(async () => {
    await client?.end().catch(() => {});
    await admin.query('DROP DATABASE IF EXISTS "' + database + '" WITH (FORCE)');
    await admin.end();
    await rm(directory, {recursive: true, force: true});
  });
  await admin.query('CREATE DATABASE "' + database + '"');
  client = new pg.Client({...connection, database});
  await client.connect();
  await client.query("CREATE TABLE preserved(id int PRIMARY KEY,note text);INSERT INTO preserved VALUES(1,'原始数据')");
  await writeFile(path.join(directory, '.env'), 'PGDATABASE=' + database + '\n');
  const run = (file, args, options) => exec(file, args, options);
  const snapshot = await backupDatabase({projectDir: directory, destination: path.join(directory, 'before.dump'), run});
  assert.ok((await stat(snapshot.file)).size > 0);
  assert.equal((await stat(snapshot.file)).mode & 0o777, 0o600);
  await client.query("ALTER TABLE preserved ADD COLUMN new_field text;UPDATE preserved SET note='changed';INSERT INTO preserved(id,note) VALUES(2,'new')");
  await restoreDatabase({projectDir: directory, snapshot, run});
  assert.deepEqual((await client.query('SELECT * FROM preserved ORDER BY id')).rows, [{id: 1, note: '原始数据'}]);
});
