import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {unlink} from 'node:fs/promises';
import {pool} from '../lib/db.mjs';
import {value,unknown,absent,reviewProfile} from '../lib/asin-domain.mjs';
import {saveSnapshot} from '../lib/asin-store.mjs';
const origin=`http://127.0.0.1:${process.env.PORT||4317}`,base='/api/asin-monitors',ids=[];
const req=async(path,data,status=200)=>{const r=await fetch(origin+path,data===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});const b=await r.json();assert.equal(r.status,status,JSON.stringify(b));return b;};
const create=async()=>{const r=await req(base,{asin:'X'+randomUUID().replaceAll('-','').slice(0,9).toUpperCase(),name:'自动测试 · 临时记录',status:'paused'},201);ids.push(r.id);return r;};
const at=n=>new Date(Date.now()-3600000+n*60000).toISOString();
const price=n=>value(n,'',{currency:'USD',scope:'featured-new'});
const sample=(t,n,fields)=>({asin:t.asin,marketplace:'US',profile:t.profile,observed_at:at(n),fields});
test('Snapshots persist exact before/after data; duplicate and unavailable observations do not corrupt heads',async()=>{
  const t=await create(),p=base+'/'+t.id;
  const first=sample(t,0,{sale_price:price(100),title:value('Before'),rating_count:value(1000)});
  const a=await req(p+'/snapshots',first,201);assert.equal(a.events,0);assert.equal(a.baselines,3);
  assert.equal((await req(p+'/snapshots',first,201)).duplicate,true);
  await req(p+'/snapshots',sample(t,1,{sale_price:unknown(),title:unknown()}),201);
  let d=await req(p);assert.equal(d.heads.find(x=>x.field==='sale_price').data.value,100);assert.equal(d.events.length,0);
  const b=await req(p+'/snapshots',sample(t,2,{sale_price:price(80),title:value('After'),rating_count:value(1001)}),201);assert.equal(b.events,3);
  d=await req(p);const e=d.events.find(x=>x.field==='sale_price');assert.equal(e.before_value.value,100);assert.equal(e.after_value.value,80);assert.equal(Number(e.delta),-20);
  const compare=await req(p+`/compare?before=${a.snapshot.id}&after=${b.snapshot.id}`);assert.equal(compare.changes.length,3);
  await req(p+`/compare?before=${b.snapshot.id}&after=${a.snapshot.id}`,undefined,400);
  const csv=await (await fetch(origin+p+'/export?format=csv')).text();assert.ok(csv.includes('变化前'));assert.ok(csv.includes('sale_price')===false);assert.ok(csv.includes('80'));
  const all=await req(p+'/export?format=json');assert.equal(all.snapshots.length,3);
});
test('Artificial source claims, foreign evidence and incompatible profiles are rejected or separated',async()=>{
  const t=await create(),p=base+'/'+t.id;
  await req(p+'/snapshots',{...sample(t,0,{sale_price:price(10)}),source:'browser'},201);
  assert.equal((await req(p)).heads[0].source,'manual');
  await req(p+'/snapshots',{...sample(t,1,{sale_price:price(10)}),asin:'B000000000'},400);
  await req(p+'/snapshots',{...sample(t,1,{sale_price:price(10)}),profile:{...t.profile,prime:true}},400);
  await req(p+'/snapshots',sample(t,1,{images:value([{key:'a',asset_id:randomUUID()}])}),400);
  await saveSnapshot(t.id,{source:'browser',observed_at:at(2),fields:{sale_price:price(99)}});
  const d=await req(p);assert.equal(d.events.length,0);assert.equal(d.heads.length,2);
  const manual=d.snapshots.find(s=>s.source==='manual'),browser=d.snapshots.find(s=>s.source==='browser');await req(p+`/compare?before=${manual.id}&after=${browser.id}`,undefined,400);
});
test('Profile changes create a new baseline, while backfills cannot move the current head backwards',async()=>{
  const t=await create(),p=base+'/'+t.id;
  await req(p+'/snapshots',sample(t,1,{title:value('Latest')}),201);
  await req(p+'/snapshots',sample(t,0,{title:value('Older')}),201);assert.equal((await req(p)).heads[0].data.value,'Latest');
  const updated=await req(p,{profile:{zip:'10001'}});assert.equal(updated.profile_version,2);
  await req(p+'/snapshots',sample(t,2,{title:value('Wrong context')}),400);
  const r=await req(p+'/snapshots',sample(updated,2,{title:value('New context')}),201);assert.equal(r.events,0);assert.equal(r.baselines,1);
  const d=await req(p);assert.equal(d.heads.length,1);assert.equal(d.snapshots.length,3);
});
test('Pending rating and disappearance events are confirmed or marked transient on the next valid observation',async()=>{
  const t=await create(),p=base+'/'+t.id;
  await req(p+'/snapshots',sample(t,0,{rating:value(4.8),title:value('Present')}),201);
  await req(p+'/snapshots',sample(t,1,{rating:value(4.6),title:absent()}),201);
  assert.ok((await req(p)).events.every(e=>e.status==='pending'));
  await req(p+'/snapshots',sample(t,2,{rating:value(4.6),title:value('Present')}),201);
  const d=await req(p);assert.equal(d.events.find(e=>e.field==='rating').status,'confirmed');assert.equal(d.events.find(e=>e.field==='title'&&e.kind==='not_displayed').status,'transient');
  const e=d.events[0];await req(p+'/events/'+e.id,{starred:true,note:'已人工核对',status:'confirmed'});
  const checked=(await req(p)).events.find(x=>x.id===e.id);assert.equal(checked.starred,true);assert.equal(checked.note,'已人工核对');
});
test('Concurrent seller/price changes retain the old seller even when fields arrive seller-first',async()=>{
  const t=await create(),p=base+'/'+t.id;
  await req(p+'/snapshots',sample(t,0,{seller:value('Seller A'),sale_price:price(100)}),201);
  await req(p+'/snapshots',sample(t,1,{seller:value('Seller B'),sale_price:price(90)}),201);
  const e=(await req(p)).events.find(e=>e.field==='sale_price');assert.equal(e.details[0].before,'Seller A');assert.equal(e.details[0].after,'Seller B');
});
test('Pause/archive keep historical evidence and reject capture; failed bulk rows do not roll back successful rows',async()=>{
  const t=await create(),p=base+'/'+t.id;
  await req(p+'/check',{},400);await req(p+'/snapshots',sample(t,0,{title:value('Preserved')}),201);
  const r=await req(base+'/import',{items:[{asin:t.asin},{asin:'invalid'}],defaults:{status:'paused'}},201);assert.equal(r.results.filter(x=>x.ok).length,0);
  await req(p,{status:'archived'});const d=await req(p);assert.equal(d.target.status,'archived');assert.equal(d.snapshots.length,1);assert.equal(d.heads[0].data.value,'Preserved');
  const e=await fetch(origin+p+'/evidence/'+d.snapshots[0].evidence_id);assert.equal(e.status,200);assert.equal(e.headers.get('content-type'),'application/json');
  const other=await create();assert.equal((await fetch(origin+base+'/'+other.id+'/evidence/'+d.snapshots[0].evidence_id)).status,404);
});
test('Local access boundary and import validation remain intact',async()=>{
  const t=await create();
  assert.equal((await fetch(origin+base,{method:'POST',headers:{Origin:'https://evil.example'}})).status,403);
  assert.equal((await fetch(origin+base+'/'+t.id+'/snapshots',{method:'POST',body:'{'})).status,400);
  assert.equal((await fetch(origin+base+'/'+t.id+'/snapshots',{method:'POST',body:'x'.repeat(2000001)})).status,413);
  const r=await req(base);assert.ok(r.fields.reviews);assert.equal(r.worker.mode,'local');
});
test('A collector upgrade establishes fresh field baselines instead of reporting a product change',async()=>{
  const t=await create();
  await saveSnapshot(t.id,{source:'browser',parser_version:'old-layout',observed_at:at(0),fields:{images:value([{key:'old',sha256:'one'}])}});
  const r=await saveSnapshot(t.id,{source:'browser',parser_version:'new-layout',observed_at:at(1),fields:{images:value([{key:'new',sha256:'two'}])}});
  assert.equal(r.events,0);assert.equal(r.baselines,1);assert.equal((await req(base+'/'+t.id)).events.length,0);
});
test('Alerts honor price thresholds, confirm rating drops, and suppress transient disappearance recoveries',async()=>{
  const t=await create(),p=base+'/'+t.id;
  await pool.query("UPDATE asin_targets SET status='active',blocked_reason='test isolation',next_price_at=now()+interval '1 day',next_content_at=now()+interval '1 day' WHERE id=$1",[t.id]);
  await req(p+'/snapshots',sample(t,0,{sale_price:price(100),rating:value(4.8),title:value('Same')}),201);
  await req(p+'/snapshots',sample(t,1,{sale_price:price(99),rating:value(4.6),title:absent()}),201);
  const total=async()=>Number((await pool.query('SELECT count(*) AS n FROM asin_notifications WHERE target_id=$1',[t.id])).rows[0].n);
  assert.equal(await total(),0);
  await req(p+'/snapshots',sample(t,2,{sale_price:price(80),rating:value(4.6),title:value('Same')}),201);
  assert.equal(await total(),2);
  const d=await req(p);assert.equal(d.events.find(e=>e.field==='title'&&e.kind==='appeared').status,'transient');
  await req(p+'/snapshots',sample(t,3,{sale_price:price(80),rating:value(4.6),title:value('Same')}),201);assert.equal(await total(),2);
});
test('Dedicated reviews isolate guest prices, session generations, comparisons and manual source claims',async()=>{
  const t=await create(),p=base+'/'+t.id,g1=randomUUID(),g2=randomUUID();
  const review=body=>value([{id:'R123',position:1,body,title:'Example',rating:4,complete:true,language:'en-US'}],'',{scope:'pdp-default-visible'});
  const snap=(n,g,body)=>saveSnapshot(t.id,{source:'browser-auth',profile:reviewProfile(t.profile,g),observed_at:at(n),fields:{reviews:review(body)}});
  await saveSnapshot(t.id,{source:'browser',observed_at:at(0),fields:{sale_price:price(100),reviews:review('Guest')}});
  const a=await snap(1,g1,'First');assert.equal(a.events,0);
  const b=await snap(2,g1,'Edited');assert.equal(b.events,1);
  const c=await snap(3,g2,'Another session');assert.equal(c.events,0);assert.equal(c.baselines,1);
  await saveSnapshot(t.id,{source:'browser-auth',profile:reviewProfile(t.profile,g2),observed_at:at(4),fields:{reviews:unknown('expired')}});
  const d=await req(p);assert.equal(d.heads.find(h=>h.source==='browser-auth').data.value[0].body,'Another session');assert.equal(d.heads.find(h=>h.field==='sale_price').data.value,100);
  await req(p+`/compare?before=${a.snapshot.id}&after=${b.snapshot.id}`);
  await req(p+`/compare?before=${b.snapshot.id}&after=${c.snapshot.id}`,undefined,400);
  await assert.rejects(()=>saveSnapshot(t.id,{source:'browser-auth',profile:reviewProfile(t.profile,g1),observed_at:at(5),fields:{sale_price:price(1)}}),/只用于评论/);
  await assert.rejects(()=>saveSnapshot(t.id,{source:'browser-auth',profile:reviewProfile({...t.profile,zip:'10001'},g1),observed_at:at(5),fields:{reviews:review('Wrong zip')}}),/观察条件/);
  await req(p+'/snapshots',{...sample(t,6,{reviews:review('Manual')}),source:'browser-auth'},201);assert.equal((await req(p)).heads.find(h=>h.source==='manual').data.value[0].body,'Manual');
  const s=await req(base+'/session');assert.ok(['state','generation','verified_at','reason','window_open'].every(k=>Object.hasOwn(s,k)));assert.ok(!JSON.stringify(s).includes('cookie'));
});
test.after(async()=>{
  const files=(await pool.query('SELECT path FROM asin_evidence WHERE target_id=ANY($1::uuid[])',[ids])).rows;
  await pool.query('DELETE FROM asin_targets WHERE id=ANY($1::uuid[])',[ids]);
  await Promise.all(files.map(f=>unlink(f.path).catch(()=>{})));await pool.end();
});
