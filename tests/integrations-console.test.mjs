import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {pool} from '../lib/db.mjs';
import {transaction,lockEvents,insertEvent} from '../lib/external/events.mjs';
import {routes} from '../lib/external/contract.mjs';
const base=`http://127.0.0.1:${process.env.PORT||4317}`;
const prefix='qa-console-'+randomUUID(),ids=[];
const call=async(path,options={})=>{const r=await fetch(base+'/api/integrations/'+path,options);return {status:r.status,data:await r.json()};};
test.after(async()=>{await pool.query('DELETE FROM north_events WHERE id=ANY($1::bigint[])',[ids]);await pool.end();});
test('local console exposes status and credential metadata without keys or hashes',async()=>{
  const r=await call('overview');assert.equal(r.status,200);assert.equal(r.data.api.operation_count,routes.length);assert.equal(r.data.api.access,'local');assert.ok(Number.isInteger(r.data.events.total));
  for(const a of r.data.agents){assert.ok(a.name);assert.equal('token' in a,false);assert.equal('token_hash' in a,false);}
  const catalog=await call('catalog');assert.equal(catalog.data.operations.length,routes.length);
  assert.equal((await fetch(base+'/api/v1/search/overview')).status,401);
});
test('preview returns literal content without saving an event or sending a message',async()=>{
  const input={type:'agent.preview',title:prefix,body:'<script>alert("literal")</script> & 文本',severity:'info'};
  const r=await call('preview',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});
  assert.equal(r.status,200);assert.equal(r.data.dry_run,true);assert.equal(r.data.delivery_created,false);assert.ok(r.data.message.includes(input.body));
  assert.equal((await pool.query('SELECT 1 FROM north_events WHERE title=$1',[prefix])).rowCount,0);
  assert.equal((await call('preview',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...input,notify:true})})).status,400);
});
test('console rejects cross-origin requests, invalid input and all send or token mutations',async()=>{
  const post={method:'POST',headers:{'Content-Type':'application/json'},body:'{}'};
  assert.equal((await call('preview',{...post,headers:{...post.headers,Origin:'https://outside.example'}})).status,403);
  assert.equal((await call('overview',{headers:{'Sec-Fetch-Site':'cross-site'}})).status,403);
  for(const p of ['events','send','tokens','settings','deliveries/retry'])assert.equal((await call(p,post)).status,405);
  for(const p of ['events?before=-1','events?severity=none','deliveries?state=none','deliveries?before=------------------------------------'])assert.equal((await call(p)).status,400);
  assert.equal((await call('preview',post)).status,400);
});
test('event list supports literal search, severity filtering and descending cursors',async()=>{
  await transaction(pool,async c=>{await lockEvents(c);for(const severity of ['info','important','critical']){
    const r=await insertEvent(c,{source_key:prefix+severity,actor_id:prefix,event:{type:'external.test',severity,title:prefix,body:'验收临时记录，完成后清理。',object_ref:{},occurred_at:null}});ids.push(r.event.id);
  }});
  const first=await call('events?q='+prefix+'&limit=2');assert.equal(first.data.items.length,2);assert.equal(first.data.has_more,true);assert.equal(first.data.items[0].id,ids[2]);
  const second=await call('events?q='+prefix+'&limit=2&before='+first.data.next_cursor);assert.equal(second.data.items.length,1);assert.equal(second.data.items[0].id,ids[0]);
  const filtered=await call('events?q='+prefix+'&severity=important');assert.equal(filtered.data.items.length,1);assert.equal(filtered.data.items[0].severity,'important');
  assert.equal((await call('events?q='+prefix+'%25')).data.items.length,0);
});
test('navigation assets and downloadable handoff documents are served with fixed paths',async()=>{
  const index=await(await fetch(base+'/')).text();assert.match(index,/data-nav="integrations"/);assert.match(index,/integrationsSection/);
  for(const p of ['/integrations.js','/integrations.css'])assert.equal((await fetch(base+p)).status,200);
  for(const p of ['openapi.json','docs/agent','docs/design']){const r=await fetch(base+'/api/integrations/'+p);assert.equal(r.status,200);assert.match(r.headers.get('content-disposition'),/attachment/);}
  assert.equal((await call('docs/.env')).status,404);
});
