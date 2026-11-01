import assert from 'node:assert/strict';
import {pool,schema} from '../lib/db.mjs';
import {events,checkedOn,officialNewsSources} from '../data/competitor-news-2026.mjs';

// Validate the reviewed batch before opening a write transaction.
const allowedHosts = new Set(['www.aboutamazon.com','blinkforhome.com','www.apple.com','www.tp-link.com']);
const unique = new Set();
for (const e of events) {
  assert.ok(!unique.has(e.id),`Duplicate event: ${e.id}`); unique.add(e.id);
  assert.ok(Array.from(e.summary).length<=100,`Summary too long: ${e.id}`);
  assert.ok(['launch','promotion','important'].includes(e.kind));
  assert.ok(['published','updated'].includes(e.date_basis||'published'));
  assert.ok(e.published_on<=checkedOn,`Future publication: ${e.id}`);
  for (const d of [e.published_on,e.starts_on,e.ends_on].filter(Boolean)) assert.equal(new Date(d).toISOString().slice(0,10),d);
  assert.ok(!e.ends_on||(e.starts_on&&e.ends_on>=e.starts_on));
  const u=new URL(e.source_url); assert.equal(u.protocol,'https:'); assert.ok(allowedHosts.has(u.hostname));
}
const client=await pool.connect();
try {
  await client.query('BEGIN'); await schema(client);
  let inserted=0;
  for (const e of events) {
    const result=await client.query(`INSERT INTO competitor_events
      (id,competitor_id,kind,title,summary,published_on,starts_on,ends_on,source_url,date_basis)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(id) DO NOTHING`,
      [e.id,e.brand,e.kind,e.title,e.summary,e.published_on,e.starts_on||null,e.ends_on||null,e.source_url,e.date_basis||'published']);
    inserted+=result.rowCount;
  }
  for (const [id,links] of Object.entries(officialNewsSources)) {
    const row=(await client.query('SELECT sources FROM competitors WHERE id=$1 FOR UPDATE',[id])).rows[0];
    assert.ok(row,`Missing brand: ${id}`);
    const sources=[...row.sources];
    for (const link of links) if(!sources.some(s=>s.url.replace(/\/$/,'')===link.url.replace(/\/$/,''))&&sources.length<20) sources.push(link);
    await client.query('UPDATE competitors SET sources=$2 WHERE id=$1',[id,JSON.stringify(sources)]);
  }
  await client.query('COMMIT');
  console.log(JSON.stringify({reviewed:events.length,inserted,checkedOn,brands:[...new Set(events.map(e=>e.brand))].length}));
} catch(e) {await client.query('ROLLBACK');throw e;}
finally {client.release();await pool.end();}
