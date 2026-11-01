import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {pool,schema} from '../lib/db.mjs';
const batch=JSON.parse(fs.readFileSync(new URL('../data/competitor-announcements-2025-2026.json',import.meta.url)));
export const canonical=url=>{const u=new URL(url);u.hash='';u.search='';return u.href.replace(/\/$/,'');};
const allowed=new Set(['blog.ring.com','www.apple.com','blinkforhome.com','www.aboutamazon.com','www.tp-link.com','tapo.com','www.prnewswire.com','www.businesswire.com']);
const seen=new Set();
for(const e of batch.events){
  const key=e.brand+'|'+canonical(e.source_url);assert.ok(!seen.has(key),`Duplicate source: ${key}`);seen.add(key);
  assert.ok(Array.from(e.title).length<=100&&Array.from(e.summary).length<=100,`Text exceeds limit: ${e.id}`);
  assert.ok(['launch','promotion','important','guide','story'].includes(e.kind));
  assert.ok(['published','updated'].includes(e.date_basis));
  assert.ok(e.published_on>=batch.period_start&&e.published_on<=batch.period_end,`Outside period: ${e.id}`);
  assert.equal(new Date(e.published_on).toISOString().slice(0,10),e.published_on);
  assert.equal(new URL(e.source_url).protocol,'https:');assert.ok(allowed.has(new URL(e.source_url).hostname));
}
const client=await pool.connect();
try{
  await client.query('BEGIN');await schema(client);
  // Canonical source identity prevents duplication with the earlier curated batch and manual entries.
  const existing=(await client.query('SELECT id,competitor_id,source_url FROM competitor_events')).rows;
  const known=new Map(existing.map(e=>[e.competitor_id+'|'+canonical(e.source_url),e.id]));
  let inserted=0,matched=0;
  for(const e of batch.events){
    const meta={source_title:e.source_title||'',source_name:e.source_name||'',date_evidence:e.date_evidence||'',checked_on:batch.checked_on,...(e.promotion_window?{promotion_window:e.promotion_window}:{})};
    const id=known.get(e.brand+'|'+canonical(e.source_url));
    if(id){await client.query('UPDATE competitor_events SET source_meta=source_meta||$2::jsonb WHERE id=$1',[id,JSON.stringify(meta)]);matched++;continue;}
    await client.query(`INSERT INTO competitor_events(id,competitor_id,kind,title,summary,published_on,starts_on,ends_on,source_url,date_basis,source_meta) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[e.id,e.brand,e.kind,e.title,e.summary,e.published_on,e.starts_on||null,e.ends_on||null,e.source_url,e.date_basis,JSON.stringify(meta)]);inserted++;
  }
  for(const a of batch.coverage){
    const id='audit-'+createHash('sha256').update(a.brand+'|'+a.label).digest('hex').slice(0,20);
    await client.query(`INSERT INTO competitor_source_audits(id,competitor_id,label,url,status,period_start,period_end,checked_on,found,detail) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(id) DO UPDATE SET url=EXCLUDED.url,status=EXCLUDED.status,period_start=EXCLUDED.period_start,period_end=EXCLUDED.period_end,checked_on=EXCLUDED.checked_on,found=EXCLUDED.found,detail=EXCLUDED.detail`,[id,a.brand,a.label,a.url,a.status,a.period_start,a.period_end,a.checked_on,a.found??null,a.detail]);
  }
  await client.query('COMMIT');console.log(JSON.stringify({reviewed:batch.events.length,inserted,matched,coverage:batch.coverage.length}));
}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();await pool.end();}
