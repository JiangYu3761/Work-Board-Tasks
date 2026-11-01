import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {pool} from '../lib/db.mjs';
import {externalSchema} from '../lib/external/schema.mjs';
import {createToken,authenticate,rateLimit} from '../lib/external/auth.mjs';
import {SCOPES,digest} from '../lib/external/common.mjs';
import {routes,matchRoute,openapi} from '../lib/external/contract.mjs';
import {publishEvent,bridgeEvents,transaction,insertEvent,lockEvents} from '../lib/external/events.mjs';
import {decodeResult,commandFor,deliverFeishu,channelConfig} from '../lib/external/feishu.mjs';
import {deliverOne} from '../lib/external/worker.mjs';
const base=`http://127.0.0.1:${process.env.PORT||4317}/api/v1`,prefix='qa-external-'+randomUUID();
let writer,reader;const tokenIds=[],monitorIds=[],eventIds=[];
const event={type:'external.qa',severity:'important',title:'集成测试事件',body:'验证通知通道，不发送真实飞书消息。'};
const config={enabled:true,configured:true,executable:process.execPath,chatId:'oc_qa_external',policy:'important'};
async function call(p,{actor=writer,method='GET',body,headers={}}={}){
  const r=await fetch(base+p,{method,headers:{...(actor?{Authorization:'Bearer '+actor.token}:{}),...(method==='POST'?{'Content-Type':'application/json'}:{}),...headers},body:body===undefined?(method==='POST'?'{}':undefined):JSON.stringify(body)});
  return {status:r.status,data:(r.headers.get('content-type')||'').includes('application/json')?await r.json():await r.text(),headers:r.headers};
}
test.before(async()=>{
  await externalSchema(pool);writer=await createToken(pool,{name:prefix,scopes:SCOPES});reader=await createToken(pool,{name:prefix+'-read',scopes:['search:read','events:read']});tokenIds.push(writer.id,reader.id);
});
test.after(async()=>{
  await pool.query('DELETE FROM north_events WHERE actor_id=ANY($1) OR id=ANY($2::bigint[]) OR source_key LIKE $3',[tokenIds,eventIds,'qa:'+prefix+'%']);
  if(monitorIds.length){await pool.query("DELETE FROM north_events WHERE object_ref->>'id' IN (SELECT id::text FROM search_alerts WHERE monitor_id=ANY($1::uuid[]))",[monitorIds]);await pool.query('DELETE FROM search_audit_log WHERE object_id=ANY($1)',[monitorIds]);await pool.query('DELETE FROM search_monitors WHERE id=ANY($1::uuid[])',[monitorIds]);}
  await pool.query('DELETE FROM north_api_audit WHERE token_id=ANY($1::uuid[])',[tokenIds]);await pool.query('DELETE FROM north_api_tokens WHERE id=ANY($1::uuid[])',[tokenIds]);await pool.end();
});
test('v1 rejects unauthenticated, revoked and expired keys; database stores a hash',async()=>{
  const r=await call('/search/overview',{actor:null});assert.equal(r.status,401);assert.equal(r.data.error.code,'UNAUTHORIZED');assert.equal(r.headers.get('x-request-id'),r.data.error.request_id);
  const row=(await pool.query('SELECT token_hash FROM north_api_tokens WHERE id=$1',[writer.id])).rows[0];assert.equal(row.token_hash,digest(writer.token));assert.notEqual(row.token_hash,writer.token);
  const expired=await createToken(pool,{name:prefix+'-expired',scopes:['events:read']});tokenIds.push(expired.id);
  await pool.query("UPDATE north_api_tokens SET expires_at=now()-interval '1 second' WHERE id=$1",[expired.id]);assert.equal((await call('/health',{actor:expired})).status,401);
  await pool.query("UPDATE north_api_tokens SET expires_at=now()+interval '1 day',revoked_at=now() WHERE id=$1",[expired.id]);assert.equal((await call('/health',{actor:expired})).status,401);
});
test('scope enforcement and exact route/method allowlist prevent bypass',async()=>{
  assert.equal((await call('/search/monitors',{actor:reader,method:'POST',body:{keyword:'not-created'}})).status,403);
  assert.equal((await call('/asin-monitors',{actor:reader})).status,403);
  assert.equal((await call('/search/overview/ignored-extra')).status,404);
  assert.equal((await call('/search/overview',{method:'POST'})).status,405);
  assert.equal((await call('/events',{method:'POST',headers:{'Content-Type':'text/plain'},body:event})).status,415);
  assert.equal((await call('/health',{method:'POST',headers:{Origin:'https://foreign.example'}})).status,403);
});
test('capability and OpenAPI documents share the live permission registry',async()=>{
  const c=await call('/capabilities',{actor:reader});assert.equal(c.status,200);assert.equal(c.data.operations.length,routes.length);
  assert.equal(c.data.operations.find(r=>r.path==='/api/v1/search/monitors'&&r.method==='POST').allowed,false);
  const api=(await call('/openapi.json')).data;assert.equal(api.openapi,'3.1.0');assert.equal(Object.values(api.paths).reduce((n,v)=>n+Object.keys(v).length,0),routes.length);
  for(const r of routes)assert.equal(matchRoute(r.method,r.path.replace(/\{[^}]+\}/g,'test'))?.path,r.path);
});
test('v1 reads real domain data and writes through the same validation and persistence',async()=>{
  const legacy=await(await fetch(base.replace('/api/v1','')+'/api/search/overview')).json();const current=await call('/search/overview');assert.equal(current.status,200);
  assert.deepEqual(current.data.monitors.map(x=>x.id),legacy.monitors.map(x=>x.id));
  const invalid=await call('/search/monitors',{method:'POST',body:{keyword:prefix,profile:{marketplace:'UK'}}});assert.equal(invalid.status,400);
  const created=await call('/search/monitors',{method:'POST',body:{keyword:prefix,state:'paused'}});assert.equal(created.status,200);monitorIds.push(created.data.id);
  const d=await call('/search/monitors/'+created.data.id);assert.equal(d.data.monitor.keyword,prefix);
  const bad=await call('/search/monitors/'+created.data.id+'/update',{method:'POST',body:{...created.data,keyword:'changed scope'}});assert.equal(bad.status,400);
  const jobId=randomUUID();await pool.query("INSERT INTO search_jobs(id,monitor_id,kind,status,scheduled_at,finished_at) VALUES($1,$2,'manual','failed',now()-interval '1 year',now()-interval '1 year')",[jobId,created.data.id]);
  assert.equal((await call('/jobs/search/'+jobId)).data.job.status,'failed');
  const csv=await call('/search/sales-template');assert.equal(csv.status,200);assert.match(csv.headers.get('content-type'),/text\/csv/);assert.match(csv.data,/marketplace/);
});
test('event publication is durable, idempotent under concurrency and detects conflicting reuse',async()=>{
  const key=prefix+'-idempotent';const all=await Promise.all(Array.from({length:5},()=>call('/events',{method:'POST',body:event,headers:{'Idempotency-Key':key}})));
  assert.equal(all.filter(r=>r.status===201).length,1);assert.equal(new Set(all.map(r=>r.data.event.id)).size,1);
  const id=all[0].data.event.id;eventIds.push(id);
  const conflict=await call('/events',{method:'POST',body:{...event,body:'内容已改变'},headers:{'Idempotency-Key':key}});assert.equal(conflict.status,409);
  const first=await call('/events?type=external.qa&after=0&limit=200',{actor:reader});assert.ok(first.data.items.some(x=>x.id===id));assert.equal(typeof first.data.next_cursor,'string');assert.ok(!('source_key' in first.data.items[0]));assert.equal(first.data.items[0].origin,'agent');
  assert.equal((await call('/events',{method:'POST',body:{...event,type:'search.alert'},headers:{'Idempotency-Key':prefix+'-spoof'}})).status,400);
  assert.equal((await call('/events?after=-1')).status,400);
  assert.equal((await call('/events',{method:'POST',body:event})).status,400);
});
test('preview has no side effects and notifying requires a configured channel plus notify scope',async()=>{
  const before=await pool.query('SELECT count(*) FROM north_deliveries');const r=await call('/notifications/preview',{method:'POST',body:event});assert.equal(r.status,200);assert.equal(r.data.dry_run,true);assert.equal(r.data.delivery_created,false);assert.match(r.data.message,/北向 NORTH/);
  assert.equal((await pool.query('SELECT count(*) FROM north_deliveries')).rows[0].count,before.rows[0].count);
  await assert.rejects(()=>publishEvent(pool,{...writer,scopes:['events:write']},prefix+'-forbidden',{...event,notify:true},config),e=>e.status===403);
  await assert.rejects(()=>publishEvent(pool,writer,prefix+'-disabled',{...event,notify:true},channelConfig({})),e=>e.code==='CHANNEL_NOT_CONFIGURED');
});
test('event cursors do not miss transactions that commit late',async()=>{
  const client=await pool.connect();let early;
  try{
    await client.query('BEGIN');await lockEvents(client);early=await insertEvent(client,{source_key:'qa:'+prefix+'-order-a',actor_id:writer.id,event:{...event,occurred_at:null}});eventIds.push(early.event.id);
    let finished=false;const later=publishEvent(pool,writer,prefix+'-order-b',event).then(r=>{finished=true;eventIds.push(r.event.id);return r;});
    await new Promise(resolve=>setTimeout(resolve,60));assert.equal(finished,false);
    const unseen=(await pool.query('SELECT id FROM north_events WHERE id=$1',[early.event.id])).rowCount;assert.equal(unseen,0);
    await client.query('COMMIT');const result=await later;assert.ok(BigInt(result.event.id)>BigInt(early.event.id));
  }finally{await client.query('ROLLBACK');client.release();}
});
test('the bridge deduplicates lifecycle alerts and does not backfill pre-install history',async()=>{
  const monitor=monitorIds[0],oldId=randomUUID(),newId=randomUUID();
  await pool.query("INSERT INTO search_alerts(id,monitor_id,object_key,rule,title,details,first_seen) VALUES($1,$3,'qa-old','rank_drop','旧测试提醒','{}',now()-interval '1 year'),($2,$3,'qa-new','rank_drop','新测试提醒','{}',now())",[oldId,newId,monitor]);
  await bridgeEvents(pool,channelConfig({}));await bridgeEvents(pool,channelConfig({}));
  const r=await pool.query('SELECT * FROM north_events WHERE source_key=ANY($1)',[['search-alert:'+oldId,'search-alert:'+newId]]);assert.equal(r.rowCount,1);assert.equal(r.rows[0].source_key,'search-alert:'+newId);eventIds.push(r.rows[0].id);
  assert.equal((await pool.query('SELECT 1 FROM north_deliveries WHERE event_id=$1',[r.rows[0].id])).rowCount,0);
});
test('delivery claims are exclusive and uncertain results cannot be blindly retried',async()=>{
  const published=await publishEvent(pool,writer,prefix+'-delivery',{...event,notify:true},config);const delivery=published.deliveries[0];eventIds.push(published.event.id);
  let sends=0;const transport=async()=>{sends++;await new Promise(r=>setTimeout(r,50));return {state:'uncertain',error:'CLI_TIMEOUT'};};
  await Promise.all([deliverOne(pool,config,transport,{deliveryId:delivery.id}),deliverOne(pool,config,transport,{deliveryId:delivery.id})]);assert.equal(sends,1);
  assert.equal((await call('/notifications/'+delivery.id+'/retry',{method:'POST'})).status,409);
  const resolved=await call('/notifications/'+delivery.id+'/resolve',{method:'POST',body:{action:'cancel',note:'测试模拟，不发送'}});assert.equal(resolved.data.state,'cancelled');
  const replay=await publishEvent(pool,writer,prefix+'-delivery',{...event,notify:true},channelConfig({}));assert.equal(replay.duplicate,true);assert.equal(replay.deliveries.length,1);
});
test('Feishu adapter preserves literal arguments and only records verified provider receipts as sent',async()=>{
  const message={...event,occurred_at:new Date().toISOString(),body:'$(touch /tmp/should-not-exist); `echo bad`\n@/private/file'};
  const command=commandFor({id:randomUUID(),destination:'oc_qa_external'},message,config);assert.equal(command.file,process.execPath);assert.ok(command.args[command.args.indexOf('--text')+1].includes(message.body));assert.ok(command.args.includes('--idempotency-key'));
  assert.equal(decodeResult({code:0,stdout:'{"ok":true,"data":{"message_id":"om_test"}}'}).state,'sent');
  for(const r of [{code:0,stdout:'{}'},{code:1,stdout:'{"ok":false}'},{timedOut:true,stdout:''},{code:0,stdout:'{"ok":true,"data":{}}'}])assert.equal(decodeResult(r).state,'uncertain');
  assert.equal(decodeResult({spawnError:true}).state,'failed');
  let options;
  const spawnFn=(file,args,o)=>{options=o;const c=new EventEmitter();c.stdout=new EventEmitter();c.stderr=new EventEmitter();c.kill=()=>queueMicrotask(()=>c.emit('close',null));return c;};
  const timed=await deliverFeishu({id:randomUUID(),destination:config.chatId},message,config,{spawnFn,timeoutMs:5});assert.equal(options.shell,false);assert.equal(timed.state,'uncertain');
});
test('per-token rate limiting has independent read and write budgets',()=>{
  const actor={id:randomUUID()};for(let i=0;i<30;i++)rateLimit(actor,'POST',1000);
  assert.throws(()=>rateLimit(actor,'POST',1000),e=>e.status===429);assert.doesNotThrow(()=>rateLimit(actor,'GET',1000));assert.doesNotThrow(()=>rateLimit(actor,'POST',61001));
});
test('CLI runs outside the project, downloads files and returns structured nonzero errors',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'north-cli-test-')),file=path.join(dir,'config.json');
  const cli=fileURLToPath(new URL('../bin/north.mjs',import.meta.url)),run=promisify(execFile);
  try{
    await writeFile(file,JSON.stringify({base_url:base.replace('/api/v1',''),token:reader.token}),{mode:0o600});
    const args=[cli,'--config',file];
    const read=await run(process.execPath,[...args,'search','overview'],{cwd:dir});assert.ok(Array.isArray(JSON.parse(read.stdout).monitors));
    const output=path.join(dir,'sales.csv');await run(process.execPath,[...args,'request','GET','/search/sales-template','--output',output],{cwd:dir});assert.match(await readFile(output,'utf8'),/marketplace/);
    await assert.rejects(()=>run(process.execPath,[...args,'request','POST','/search/monitors','--json','{}'],{cwd:dir}),e=>e.code===1&&JSON.parse(e.stderr).error.code==='FORBIDDEN'&&e.stdout==='');
    await assert.rejects(()=>run(process.execPath,[...args,'request','GET','/../../api/health'],{cwd:dir}),e=>e.code===1&&JSON.parse(e.stderr).error.code==='CLI_ERROR');
  }finally{await rm(dir,{recursive:true,force:true});}
});
