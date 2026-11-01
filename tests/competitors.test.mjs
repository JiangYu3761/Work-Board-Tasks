import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {pool} from '../lib/db.mjs';
const origin=`http://127.0.0.1:${process.env.PORT||4317}`;
const post=async(path,data,status=200)=>{const res=await fetch(origin+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});const body=await res.json();assert.equal(res.status,status,JSON.stringify(body));return body;};
const get=async path=>{const res=await fetch(origin+path);assert.equal(res.status,200);return res.json();};
const base={name:'qa-'+randomUUID(),market:'美国',currency:'USD',website:'https://example.com/',sources:[],paused:false,archived:false};
test('Competitor history persists, coupons are conditional, and markets cannot corrupt existing comparisons',async()=>{
 const ids=[];
 try{
  const c=await post('/api/competitors',{...base,role:'priority',focus:'2K 室内有线摄像头'});assert.equal(c.role,'priority');ids.push(c.id);
  const other=await post('/api/competitors',{...base,name:base.name+'-other'});ids.push(other.id);
  const path='/api/competitors/'+c.id;
  const p=await post(path+'/products',{line:'桌面充电',name:'QA 100W',variant:'黑色 · 美规',launched_at:'2026-01-01',lens_count:2,pack_quantity:3,power:'插电供电'});assert.equal(p.specs.lens_count,2);assert.equal(p.specs.pack_quantity,3);
  const l=await post(path+'/listings',{product_id:p.id,platform:'Amazon US',seller:'QA official',url:'https://example.com/product'});
  const observation={listing_id:l.id,observed_on:'2026-01-02',sale_price:79.99,list_price:99.99,coupon_type:'percent',coupon_value:10,coupon_public:true,conditions:'',rating:null,review_count:null,availability:'unknown'};
  const o1=await post(path+'/observations',observation);assert.equal(o1.effective_price,71.99);assert.equal(o1.rating,null);assert.equal(o1.review_count,null);
  const o2=await post(path+'/observations',{...observation,observed_on:'2026-01-03',sale_price:69.99,coupon_public:false,conditions:'仅会员可用',rating:4.6,review_count:100});assert.equal(o2.effective_price,null);
  const o3=await post(path+'/observations',{...observation,observed_on:'2026-01-04',coupon_type:'amount',coupon_value:5});assert.equal(o3.effective_price,74.99);
  const record=await get(path);assert.equal(record.observations.length,3);assert.equal(record.observations[0].sale_price,79.99);assert.equal(record.observations[1].sale_price,69.99);
  await post(path+'/observations',{...observation,observed_on:'2099-01-01'},400);
  await post(path+'/observations',{...observation,observed_on:'2025-12-31'},400);
  await post(path+'/observations',{...observation,coupon_value:101},400);
  await post(path+'/observations',{...observation,coupon_public:false,conditions:''},400);
  await post(path+'/observations',{...observation,sale_price:-1},400);
  await post(path+'/observations',{...observation,review_count:1.5},400);
  await post(path+'/observations',{...observation,source_url:'javascript:alert(1)'},400);
  await post('/api/competitors/'+other.id+'/observations',observation,400);
  await post('/api/competitors/'+other.id+'/listings',{product_id:p.id,platform:'Other',seller:'Other',url:'https://example.com'},400);
  await post(path,{...base,currency:'EUR'},400);assert.equal((await get(path)).competitor.currency,'USD');
  await post(path+'/events',{kind:'promotion',title:'QA 促销',summary:'核实后的简短促销说明。',published_on:'2026-01-02',starts_on:'2026-01-04',ends_on:'2026-01-03',source_url:'https://example.com'},400);
  await post(path+'/events',{kind:'launch',title:'QA 新品',summary:'字'.repeat(101),published_on:'2026-01-02',source_url:'https://example.com'},400);
  await post(path+'/events',{kind:'launch',title:'QA 新品',summary:'这是一条核实后的简短新品摘要。',published_on:'2026-01-02',source_url:'https://example.com'});
  const listed=(await get('/api/competitors')).items.find(b=>b.id===c.id);assert.equal(listed.event_count,1);
  assert.equal((await get(path)).events[0].date_basis,'published');
  await post(path,{...base,archived:true,paused:true});const archived=await get(path);assert.equal(archived.competitor.archived,true);assert.equal(archived.competitor.role,'priority');assert.equal(archived.competitor.focus,'2K 室内有线摄像头');assert.equal(archived.observations.length,3);assert.equal(archived.events.length,1);
  await post(path,{...base,archived:false});assert.equal((await get(path)).competitor.archived,false);
 }finally{await pool.query('DELETE FROM competitors WHERE id=ANY($1)',[ids]);}
});
test('Operations filters combine with official, year and month selections',async()=>{
 const r=await get('/api/articles?focus=fulfillment&official=true&year=2026&month=1');assert.ok(r.items.length>0);assert.ok(r.items.every(a=>a.official&&a.archive_date.startsWith('2026-01')));
 assert.ok(r.items.some(a=>a.id==='amazon-prep-2026'));
 const res=await fetch(origin+'/api/articles?focus=unknown');assert.equal(res.status,400);
});
test('Competitor API validates links and rejects foreign-origin writes',async()=>{
 await post('/api/competitors',{...base,website:'javascript:alert(1)'},400);
 await post('/api/competitors',{...base,sources:[{label:'Unsafe',url:'file:///etc/passwd'}]},400);
 await post('/api/competitors',null,400);
 await post('/api/competitors',{...base,role:'invalid'},400);
 const res=await fetch(origin+'/api/competitors',{method:'POST',headers:{Origin:'https://example.com','Content-Type':'application/json'},body:JSON.stringify(base)});assert.equal(res.status,403);
});
test.after(async()=>pool.end());
