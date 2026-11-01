import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {pool} from '../lib/db.mjs';
import {weekStart,weeksBetween,validDay,canonicalNewsUrl,validateBatch,importWeeklyNews} from '../lib/weekly-news.mjs';
const batch=JSON.parse(await readFile(new URL('../data/weekly-news/2026-07-25_2026-10-25.json',import.meta.url),'utf8'));
const origin=`http://127.0.0.1:${process.env.PORT||4317}`;
const get=async path=>{const r=await fetch(origin+path);assert.equal(r.status,200);return r.json();};
test('Calendar weeks handle a clipped first week, Sunday boundaries, leap days and year changes',()=>{
 assert.equal(weekStart('2026-07-26'),'2026-07-20');assert.equal(weekStart('2026-07-27'),'2026-07-27');
 assert.equal(weekStart('2027-01-01'),'2026-12-28');assert.ok(validDay('2024-02-29'));assert.equal(validDay('2026-02-29'),false);
 const w=weeksBetween('2026-07-25','2026-10-25');assert.equal(w.length,14);assert.equal(w[0].coverage_start,'2026-07-25');assert.ok(w[0].partial);assert.equal(w.at(-1).coverage_end,'2026-10-25');
});
test('News identities ignore tracking parameters but preserve model query identifiers',()=>{
 assert.equal(canonicalNewsUrl('https://example.org/story/?utm_source=x#section'),canonicalNewsUrl('https://example.org/story'));
 assert.notEqual(canonicalNewsUrl('https://qwen.ai/blog?id=a'),canonicalNewsUrl('https://qwen.ai/blog?id=b'));
});
test('Reviewed historical dataset has 14 explained weeks and rejects duplicate events and out-of-range dates',()=>{
 assert.equal(validateBatch(batch).length,14);assert.equal(batch.articles.length,101);
 assert.throws(()=>validateBatch({...batch,articles:[...batch.articles,batch.articles[0]]}),/Duplicate event/);
 assert.throws(()=>validateBatch({...batch,articles:[{...batch.articles[0],published_at:'2026-07-24'},...batch.articles.slice(1)]}),/Outside period/);
 assert.equal(batch.articles.filter(a=>a.evidence.verification_method==='official_publisher_search_index').length,1);
});
test('Weekly archive API returns accurate per-week counts, supports category search and rejects invalid Mondays',async()=>{
 const d=await get('/api/news-weeks');assert.ok(d.weeks.length>=14);
 const imported=await get('/api/articles?week=curated');assert.equal(imported.items.length,101);
 const first=await get('/api/articles?week=2026-07-20');assert.equal(first.items.length,3);assert.ok(first.items.every(a=>a.published_at>='2026-07-25'&&a.published_at<='2026-07-26'));
 const cross=await get('/api/articles?week=2026-08-31');assert.equal(cross.items.length,6);assert.ok(cross.items.some(a=>a.published_at.startsWith('2026-08'))&&cross.items.some(a=>a.published_at.startsWith('2026-09')));
 const commerce=await get('/api/articles?week=2026-10-19&category=commerce&q=Ads');assert.equal(commerce.items.length,1);assert.ok(commerce.items[0].weekly_info.importance_reason);
 for(const week of ['2026-07-26','2026-02-30',"' OR 1=1 --"]){const r=await fetch(origin+'/api/articles?week='+encodeURIComponent(week));assert.equal(r.status,400);}
});
test('Repeat import reuses normalized sources and preserves saved state and user-edited summaries',async()=>{
 const token='qa-weekly-'+randomUUID();const fixture={...batch,id:token,period_start:'2026-08-03',period_end:'2026-08-09',sources:[{id:token,name:'Temporary fixture',url:'https://example.org/',category:'ai'}],source_audits:[],articles:[{...batch.articles[0],event_key:token,source_id:token,published_at:'2026-08-03',url:`https://example.org/${token}/?utm_source=test`,evidence:{...batch.articles[0].evidence,url:`https://example.org/${token}/?utm_source=test`}}]};
 let id;
 try{const first=await importWeeklyNews(pool,fixture);assert.equal(first.inserted,1);id=first.articles[0].article_id;
  await pool.query("UPDATE articles SET saved=true,summary='保留用户自己的摘要。' WHERE id=$1",[id]);
  fixture.articles[0].url=`https://example.org/${token}`;fixture.articles[0].evidence.url=fixture.articles[0].url;
  const second=await importWeeklyNews(pool,fixture);assert.equal(second.inserted,0);assert.equal(second.reused,1);
  const row=(await pool.query('SELECT saved,summary FROM articles WHERE id=$1',[id])).rows[0];assert.equal(row.saved,true);assert.equal(row.summary,'保留用户自己的摘要。');
 }finally{await pool.query('DELETE FROM weekly_news_items WHERE batch_id=$1',[token]);await pool.query('DELETE FROM weekly_news_weeks WHERE batch_id=$1',[token]);await pool.query('DELETE FROM weekly_news_batches WHERE id=$1',[token]);if(id)await pool.query('DELETE FROM articles WHERE id=$1',[id]);await pool.query('DELETE FROM sources WHERE id=$1',[token]);}
});
test.after(()=>pool.end());
