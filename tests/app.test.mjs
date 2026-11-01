import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {pool} from '../lib/db.mjs';
import {validSummary,safeUrl} from '../lib/sync.mjs';
const origin=`http://127.0.0.1:${process.env.PORT||4317}`;
const get=async path=>{const r=await fetch(origin+path);assert.equal(r.status,200);return r.json();};
test('Published records satisfy the 100-character limit and have usable source links',async()=>{
  const {items}=await get('/api/articles');assert.ok(items.length>=74);
  for(const a of items){assert.ok(Array.from(a.summary).length<=100);assert.ok(a.summary.length>0);assert.ok(safeUrl(a.url));assert.ok(a.source_name);}
});
test('Chinese search, category filters, and literal wildcard handling',async()=>{
  const found=await get('/api/articles?q='+encodeURIComponent('责任险'));assert.ok(found.items.some(a=>a.id==='amazon-insurance-2026'));
  const ai=await get('/api/articles?category=ai');assert.ok(ai.items.length>=3);assert.ok(ai.items.every(a=>a.category==='ai'));
  const injected=await get('/api/articles?q='+encodeURIComponent("' OR 1=1 --"));assert.equal(injected.items.length,0);
  const literal=await get('/api/articles?q='+encodeURIComponent('%'));assert.ok(literal.items.every(a=>[a.title,a.summary,...a.tags].join(' ').includes('%')));
});
test('Bookmarks survive a separate request and are stored in PostgreSQL',async()=>{
  const id='qa-'+randomUUID();
  try {
    await pool.query("INSERT INTO articles(id,source_id,title,summary,url,category,topic) VALUES($1,'amazon','持久化验证','这是一条用于验证收藏数据库持久化的临时记录。','https://sellercentral.amazon.com/','amazon','测试')",[id]);
    const result=await fetch(origin+`/api/articles/${id}/saved`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({saved:true})});assert.equal(result.status,200);
    assert.equal((await pool.query('SELECT saved FROM articles WHERE id=$1',[id])).rows[0].saved,true);
    const saved=await get('/api/articles?saved=true');assert.ok(saved.items.some(a=>a.id===id));
  }finally{await pool.query('DELETE FROM articles WHERE id=$1',[id]);}
});
test('Policy milestones use explicit dates; proposals are not marked effective',async()=>{
  const d=await get('/api/dashboard');assert.ok(d.events.length>=21);assert.ok(d.events.every(e=>/^\d{4}-\d{2}-\d{2}$/.test(e.end_date)));
  const p=(await get('/api/articles?category=policy')).items.find(a=>a.id==='fmc-spain-proposal');assert.equal(p.status,'proposed');assert.equal(p.effective_at,null);
});
test('Cross-origin mutations and local configuration downloads are rejected',async()=>{
  const r=await fetch(origin+'/api/sync',{method:'POST',headers:{Origin:'https://untrusted.example'}});assert.equal(r.status,403);
  const env=await fetch(origin+'/.env');assert.equal(env.status,404);
});
test('Unsafe links and invalid generated summaries cannot be published',()=>{
  assert.equal(safeUrl('javascript:alert(1)'),null);assert.equal(safeUrl('file:///etc/passwd'),null);
  assert.equal(validSummary({title:'News',summary:'An English-only summary of new developments.'}),false);
  assert.equal(validSummary({title:'测试标题',summary:'字'.repeat(101)}),false);
  assert.equal(validSummary({title:'测试标题',summary:'这是符合长度要求的中文事实摘要内容。'}),true);
});
test('Annual archive covers elapsed months and combines month, category and search',async()=>{
  const all=await get('/api/articles?year=2026');assert.ok(all.items.length>=73);
  assert.ok(all.items.every(a=>a.archive_date.startsWith('2026-')));
  for(let month=1;month<=10;month++)assert.ok(all.facets.some(f=>f.year===2026&&f.month===month&&f.count>0));
  const feb=await get('/api/articles?year=2026&month=2&category=amazon');
  assert.ok(feb.items.some(a=>a.id==='amazon-safe-t-2026'));
  assert.ok(feb.items.every(a=>a.category==='amazon'&&a.archive_date.startsWith('2026-02-')));
  assert.ok(feb.facets.some(f=>f.year===2026&&f.month===1));
  const ai=await get('/api/articles?year=2026&month=2&category=ai&q=Claude');
  assert.ok(ai.items.length>=2);assert.ok(ai.items.every(a=>a.category==='ai'&&a.archive_date.startsWith('2026-02-')));
  const future=await get('/api/articles?year=2027');assert.ok(future.items.some(a=>a.id==='amazon-bundling-2027'));
  assert.equal((await get('/api/articles?year=2025')).items.length,0);
});
test('Archive date boundaries do not substitute the date a record was checked',async()=>{
 const prefix='qa-'+randomUUID(),ids=[prefix+'-end',prefix+'-start',prefix+'-effective',prefix+'-undated'];
 try{
  for(let i=0;i<ids.length;i++)await pool.query("INSERT INTO articles(id,source_id,title,summary,url,category,topic,published_at,effective_at,checked_at) VALUES($1,'amazon',$2,'验证归档边界及无日期记录的行为。','https://sellercentral.amazon.com/','amazon','测试',$3,$4,'2026-10-24')",[ids[i],prefix,['2025-12-31','2026-01-01',null,null][i],i===2?'2026-02-01':null]);
  const jan=await get('/api/articles?year=2026&month=1&q='+prefix);assert.deepEqual(jan.items.map(a=>a.id),[ids[1]]);
  const feb=await get('/api/articles?year=2026&month=2&q='+prefix);assert.deepEqual(feb.items.map(a=>a.id),[ids[2]]);assert.equal(feb.items[0].date_basis,'effective');
  const year=await get('/api/articles?year=2026&q='+prefix);assert.equal(year.items.length,2);
  const whole=await get('/api/articles?q='+prefix);assert.equal(whole.items.length,4);
  assert.equal(whole.items.find(a=>a.id===ids[3]).archive_date,null);
 }finally{await pool.query('DELETE FROM articles WHERE id=ANY($1)',[ids]);}
});
test('Invalid year and month filters return a useful error',async()=>{
 for(const q of ['year=nope','year=2026&month=13','year=2026&month=-1','year=2026&month=1.5','month=2']){
  const r=await fetch(origin+'/api/articles?'+q);assert.equal(r.status,400,q);assert.ok((await r.json()).error);
 }
});
test.after(async()=>{await pool.end();});
