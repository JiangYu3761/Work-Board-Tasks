import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,stat,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {ReviewSession} from '../lib/asin-session.mjs';

async function fixture(t){
  const root=await mkdtemp(path.join(os.tmpdir(),'north-review-session-'));
  let loggedIn=false,lock=false,closed=0,launches=[];
  const db={connect:async()=>({query:async sql=>{if(sql.includes('pg_try')){if(lock)return {rows:[{ok:false}]};lock=true;return {rows:[{ok:true}]};}lock=false;return {rows:[]};},release(){}})};
  const launch=async(dir,options)=>{
    launches.push({dir,options});const c=new EventEmitter();
    c.setDefaultTimeout=()=>{};c.setDefaultNavigationTimeout=()=>{};
    const page={goto:async()=>{},bringToFront:async()=>{}};c.pages=()=>[page];
    c.close=async()=>{closed++;c.emit('close');};return c;
  };
  const session=new ReviewSession({root,db,launch,probe:async()=>loggedIn?'authenticated':'needs_login'});
  t.after(async()=>{await session.stop();await rm(root,{recursive:true,force:true});});
  return {session,root,db,launch,loggedIn:v=>{loggedIn=v;},get closed(){return closed;},launches};
}
test('Manual login is required, failed verification keeps the window, success flushes the profile',async t=>{
  const f=await fixture(t),s=f.session;
  assert.equal((await s.status()).state,'needs_login');assert.equal((await s.use(()=>assert.fail())).unavailable,true);
  await assert.rejects(()=>s.verify(),/先打开/);
  const first=await s.open();assert.equal(first.state,'manual');assert.ok(first.generation);
  await s.open();assert.equal(f.launches.length,1);
  assert.equal((await s.verify()).state,'manual');assert.equal(f.closed,0);
  f.loggedIn(true);const ready=await s.verify();assert.equal(ready.state,'ready');assert.equal(ready.window_open,false);assert.equal(f.closed,1);
  assert.equal((await stat(f.root)).mode&0o777,0o700);assert.equal((await stat(path.join(f.root,'session.json'))).mode&0o777,0o600);
  const persisted=JSON.parse(await readFile(path.join(f.root,'session.json'),'utf8'));assert.deepEqual(Object.keys(persisted).sort(),['generation','reason','state','verified_at']);
  const restarted=new ReviewSession({root:f.root,db:f.db,launch:f.launch});assert.equal((await restarted.status()).state,'ready');
  await s.use(async(c,generation)=>{assert.equal(generation,first.generation);assert.equal((await s.status()).state,'capturing');await assert.rejects(()=>s.open(),/使用中/);});
  assert.equal(f.launches.at(-1).options.headless,true);assert.equal((await s.status()).state,'ready');assert.equal(f.closed,2);
});
test('Expired login disables only review capture, and manual repair changes the comparison identity',async t=>{
  const f=await fixture(t),s=f.session;await s.open();f.loggedIn(true);const first=await s.verify();
  await assert.rejects(()=>s.use(async()=>{throw Object.assign(new Error('expired'),{sessionInvalid:true});}),/expired/);
  assert.equal((await s.status()).state,'needs_login');assert.equal((await s.use(()=>assert.fail())).unavailable,true);
  const next=await s.open();assert.notEqual(next.generation,first.generation);
  await s.close();assert.equal((await s.status()).window_open,false);assert.equal((await s.status()).state,'needs_login');
  await s.open();await s.verify();await s.disable();assert.equal((await s.status()).state,'disabled');assert.equal((await s.use(()=>assert.fail())).unavailable,true);
});
test('A separate process cannot launch the same profile while the login window owns its lock',async t=>{
  const f=await fixture(t);await f.session.open();
  const other=new ReviewSession({root:f.root,db:f.db,launch:f.launch});await assert.rejects(()=>other.open(),/另一个北向进程/);
  assert.equal(f.launches.length,1);await f.session.close();
});
test('Ordinary review extraction failures release the browser without falsely expiring login',async t=>{
  const f=await fixture(t);await f.session.open();f.loggedIn(true);await f.session.verify();
  await assert.rejects(()=>f.session.use(async()=>{throw new Error('layout changed');}),/layout changed/);
  assert.equal((await f.session.status()).state,'ready');assert.equal(f.closed,2);
});
