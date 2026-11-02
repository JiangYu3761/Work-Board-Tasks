import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {mkdtemp, mkdir, writeFile, readFile, rm, access} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {launchProject} from '../scripts/desktop/backend.mjs';
import {createIcon, infoPlist, install} from '../scripts/desktop/install.mjs';
import {createRequire} from 'node:module';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const project = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url), sharp = require('sharp');
const fixtureServer = [
  "import http from 'node:http';",
  "import {createHash} from 'node:crypto';",
  "const identity=createHash('sha256').update(process.cwd()).digest('hex');",
  "const server=http.createServer((req,res)=>{res.setHeader('X-North-Project',identity);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,database:'postgresql'}));});",
  "server.listen(Number(process.env.PORT),'127.0.0.1');",
  "process.on('SIGTERM',()=>server.close(()=>process.exit(0)));",
].join('\n');
const exists = file => access(file).then(() => true, () => false);
async function unusedPort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function fixture(t, source = fixtureServer) {
  const directory = await mkdtemp(path.join(os.tmpdir(), '北向 desktop $-'));
  const port = await unusedPort();
  await writeFile(path.join(directory, '.env'), 'PORT=' + port + '\nPGHOST=desktop-test.invalid\nDESKTOP_TEST_SECRET=do-not-copy\n');
  await writeFile(path.join(directory, 'server.mjs'), source);
  t.after(async () => {
    try {
      const state = JSON.parse(await readFile(path.join(directory, '.runtime/desktop/server.json'), 'utf8'));
      try { process.kill(-state.pid, 'SIGTERM'); } catch {}
      for (let i = 0; i < 50; i++) {
        try { process.kill(state.pid, 0); } catch { break; }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    } catch {}
    await rm(directory, {recursive: true, force: true});
  });
  return {directory, port};
}

test('Desktop launch honors the project .env, survives launcher exit and reuses its service', async t => {
  const {directory, port} = await fixture(t);
  const {stdout} = await promisify(execFile)(process.execPath, [path.join(project, 'scripts/desktop/backend.mjs'), '--project', directory], {env: {...process.env, PORT: '1'}});
  const first = JSON.parse(stdout);
  assert.equal(first.url, 'http://127.0.0.1:' + port);
  assert.equal(first.started, true);
  assert.equal((await fetch(first.url + '/api/health')).status, 200);
  const second = await launchProject({projectDir: directory});
  assert.equal(second.started, false);
  const state = JSON.parse(await readFile(path.join(directory, '.runtime/desktop/server.json'), 'utf8'));
  assert.equal(state.pid, first.pid);
  assert.ok(!JSON.stringify(state).includes('do-not-copy'));
  assert.equal(await exists(path.join(directory, '.runtime/desktop/launch.lock')), false);
});

test('Concurrent Dock launches start exactly one backend', async t => {
  const {directory} = await fixture(t);
  const launches = await Promise.all([launchProject({projectDir: directory}), launchProject({projectDir: directory})]);
  assert.equal(launches.filter(result => result.started).length, 1);
  assert.equal(launches[0].url, launches[1].url);
});

test('A healthy service belonging to another project is neither reused nor stopped', async t => {
  const {directory, port} = await fixture(t);
  const unrelated = http.createServer((req, res) => {
    res.setHeader('X-North-Project', 'another-project');
    res.end(JSON.stringify({ok: true, database: 'postgresql'}));
  });
  await new Promise(resolve => unrelated.listen(port, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => unrelated.close(resolve)));
  await assert.rejects(launchProject({projectDir: directory}), /已被其他服务/);
  assert.equal((await fetch('http://127.0.0.1:' + port)).status, 200);
  assert.equal(await exists(path.join(directory, '.runtime/desktop/server.json')), false);
});

test('Backend failure releases its lock and a repaired project can be started again', async t => {
  const {directory} = await fixture(t, 'process.exit(9);');
  await assert.rejects(launchProject({projectDir: directory}), /本地服务启动失败/);
  assert.equal(await exists(path.join(directory, '.runtime/desktop/launch.lock')), false);
  assert.equal(await exists(path.join(directory, '.runtime/desktop/server.json')), false);
  await writeFile(path.join(directory, 'server.mjs'), fixtureServer);
  assert.equal((await launchProject({projectDir: directory})).started, true);
});

test('A startup timeout terminates its own backend and allows retry', async t => {
  const {directory} = await fixture(t, "setInterval(()=>{},1000);");
  await assert.rejects(launchProject({projectDir: directory, timeout: 400}), /未能及时启动/);
  assert.equal(await exists(path.join(directory, '.runtime/desktop/server.json')), false);
  await writeFile(path.join(directory, 'server.mjs'), fixtureServer);
  assert.equal((await launchProject({projectDir: directory})).started, true);
});

test('A dead launcher lock is recovered without modifying project settings', async t => {
  const {directory} = await fixture(t);
  const lock = path.join(directory, '.runtime/desktop/launch.lock');
  await mkdir(lock, {recursive: true});
  await writeFile(path.join(lock, 'owner.json'), JSON.stringify({pid: 2147483647}));
  const before = await readFile(path.join(directory, '.env'), 'utf8');
  assert.equal((await launchProject({projectDir: directory})).started, true);
  assert.equal(await readFile(path.join(directory, '.env'), 'utf8'), before);
});

test('Invalid ports are rejected before creating a background process', async t => {
  const {directory} = await fixture(t);
  for (const port of ['0', '65536', 'abc']) {
    await writeFile(path.join(directory, '.env'), 'PORT=' + port);
    await assert.rejects(launchProject({projectDir: directory}), /PORT 必须/);
  }
  assert.equal(await exists(path.join(directory, '.runtime/desktop/server.json')), false);
});

test('The application icon contains decodable PNG representations up to Retina 1024px', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'north-icon-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const file = path.join(directory, 'North.icns');
  await createIcon(project, file);
  const data = await readFile(file);
  assert.equal(data.toString('ascii', 0, 4), 'icns');
  assert.equal(data.readUInt32BE(4), data.length);
  const sizes = [];
  for (let offset = 8; offset < data.length;) {
    const length = data.readUInt32BE(offset + 4);
    assert.ok(length > 8 && offset + length <= data.length);
    const metadata = await sharp(data.subarray(offset + 8, offset + length)).metadata();
    assert.equal(metadata.format, 'png');
    assert.equal(metadata.width, metadata.height);
    sizes.push(metadata.width);
    offset += length;
  }
  assert.deepEqual(sizes, [16, 32, 64, 128, 256, 512, 1024]);
  assert.match(infoPlist('北向 & Test', 'cn.jiangyu.north.test'), /北向 &amp; Test/);
});

test('Installation on unsupported systems fails before creating an application', {skip: process.platform === 'darwin'}, async () => {
  await assert.rejects(install({projectDir: project}), /此安装器用于 macOS/);
});
