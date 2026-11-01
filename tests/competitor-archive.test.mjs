import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import '../public/competitor-calendar.js';
const C=globalThis.RivalCalendar;
test('The annual calendar asset is served to the frontend',async()=>{
  const response=await fetch(`http://127.0.0.1:${process.env.PORT||4317}/competitor-calendar.js`);
  assert.equal(response.status,200);assert.match(await response.text(),/globalThis.RivalCalendar/);
});
test('Rolling year includes both October boundaries and keeps months distinct',()=>{
  const dates=['2025-10-23','2025-10-24','2025-12-31','2026-01-01','2026-10-24','2026-10-25'];
  const events=dates.map(published_on=>({published_on,kind:'launch',title:'新品',summary:''}));
  const opts={today:'2026-10-24'};
  assert.deepEqual(C.filter(events,opts).map(e=>e.published_on),dates.slice(1,5));
  assert.deepEqual(C.filter(events,{...opts,month:'2025-10'}).map(e=>e.published_on),['2025-10-24']);
  assert.deepEqual(C.filter(events,{...opts,month:'2026-10'}).map(e=>e.published_on),['2026-10-24']);
  assert.equal(C.months(opts.today).length,13);
  assert.deepEqual(C.range('2024-02-29'),{start:'2023-02-28',end:'2024-02-29'});
  assert.equal(C.filter(events,{...opts,year:2025}).length,3);
});
test('Announcement counts exclude guides and stories; source headlines remain searchable',()=>{
  const events=['launch','promotion','important','guide','story'].map(kind=>({kind,published_on:'2026-01-01',title:'中文摘要',summary:'',source_meta:{source_title:'Camera Launch'}}));
  assert.equal(C.filter(events,{today:'2026-10-24'}).length,3);
  assert.equal(C.filter(events,{today:'2026-10-24',kind:'all',query:'camera'}).length,5);
  assert.equal(C.filter(events,{today:'2026-10-24',kind:'guide'}).length,1);
  const launch={...events[0],source_meta:{promotion_window:{starts_on:'2026-01-01',ends_on:'2026-01-10'}}};
  assert.equal(C.filter([launch],{today:'2026-10-24',kind:'promotion'}).length,1);
});
test('Reviewed batch retains complete public archives, valid dates and unique source identities',()=>{
  const b=JSON.parse(fs.readFileSync(new URL('../data/competitor-announcements-2025-2026.json',import.meta.url)));
  const identities=new Set();
  for(const e of b.events){
    const key=e.brand+'|'+e.source_url.replace(/\/$/,'');assert.ok(!identities.has(key));identities.add(key);
    assert.ok(e.summary.length<=100&&e.title.length<=100);
    assert.ok(e.published_on>=b.period_start&&e.published_on<=b.period_end);
    assert.equal(new Date(e.published_on).toISOString().slice(0,10),e.published_on);
  }
  for(const [brand,host,count] of [['apple-us','www.apple.com',140],['ring-us','blog.ring.com',74],['blink-us','blinkforhome.com',11]])assert.equal(b.events.filter(e=>e.brand===brand&&new URL(e.source_url).hostname===host).length,count);
  assert.equal(b.events.filter(e=>e.brand==='blink-us'&&new URL(e.source_url).hostname==='blinkforhome.com'&&e.kind==='guide').length,10);
  assert.ok(b.coverage.some(a=>a.brand==='blink-us'&&a.status==='unavailable'));
});
