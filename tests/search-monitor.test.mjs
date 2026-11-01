import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {pool} from '../lib/db.mjs';
import {monitorInput,assignRanks,aggregateSnapshot,rankSeries,dailyRanks,slotCandidates,salesForProducts,csv,adShareSignal} from '../lib/search-monitor/model.mjs';
import {normalizeCapture} from '../lib/search-monitor/collector.mjs';
import {parseSalesCSV,SALES_COLUMNS} from '../lib/search-monitor/sales.mjs';
import {putSnapshot,enqueue,schedule} from '../lib/search-monitor/store.mjs';
const base=`http://127.0.0.1:${process.env.PORT||4317}/api/search/`;
async function request(path,body,status=200){const r=await fetch(base+path,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const v=await r.json();assert.equal(r.status,status,JSON.stringify(v));return v;}
const A='B000000001',B='B000000002',P='B000000009';
const card=(asin,paid=false)=>({id:randomUUID(),main_grid:true,paid,ad_product:paid?'SP':null,creative_format:'商品卡',region:'主结果流',items:[{asin,title:'Test',brand:'Alpha',card_observed:true}]});
test('Natural ranks preserve duplicate positions across pages and stop at incomplete pages',()=>{
  const pages=[{page:1,rank_valid:true,modules:[card(A,true),...Array.from({length:48},()=>card(A))]},{page:2,rank_valid:true,modules:Array.from({length:48},(_,i)=>card(i===37?B:A))}];
  assignRanks({pages});assert.equal(pages[1].modules[37].items[0].organic_rank,86);
  const s=aggregateSnapshot({pages});assert.equal(s.products.find(p=>p.asin===B).rank,86);assert.equal(s.unique_asins,2);assert.equal(s.organic_cards,96);
  pages[0].rank_valid=false;assignRanks({pages});assert.equal(pages[1].modules[37].items[0].organic_rank,null);
});
test('Ad modules, actual cards and unique links are independent; unknown brand remains denominator',()=>{
  const modules=[card(A,true),{id:'sb',paid:true,ad_product:'SB',main_grid:false,brand:'Beta',creative_format:'视频',region:'首页顶部',items:[{asin:A},{asin:B},{asin:A}]},{id:'unknown',paid:true,ad_product:'UNKNOWN',region:'页尾',main_grid:false,items:[]}];
  const s=aggregateSnapshot({pages:[{modules}]});assert.equal(s.ad_modules,3);assert.equal(s.ad_cards,4);assert.equal(s.unique_asins,2);assert.equal(s.brands.find(b=>b.brand==='Beta').ad_share,100/3);assert.equal(s.unknown_ad_brand_share,100/3);assert.equal(s.ad_types.SB,1);
  modules[1].items.forEach(i=>i.card_observed=false);assert.equal(aggregateSnapshot({pages:[{modules}]}).ad_cards,1);
});
test('Missing, invalid and manual samples never become zero ranks or daily medians',()=>{
  const summary={products:[{asin:A,rank:7}]};const h=[{id:'1',observed_at:'2026-10-01T14:00Z',quality:{complete:true,rank_valid:true},summary,kind:'scheduled'},{id:'2',observed_at:'2026-10-01T20:00Z',quality:{complete:true,rank_valid:true},summary:{products:[]},kind:'scheduled'},{id:'3',observed_at:'2026-10-01T21:00Z',quality:{complete:false,rank_valid:false},summary,kind:'scheduled'},{id:'4',observed_at:'2026-10-01T22:00Z',quality:{complete:true,rank_valid:true},summary:{products:[{asin:A,rank:1}]},kind:'manual'}];
  const r=rankSeries(h,A,'America/Chicago');assert.equal(r[1].state,'not_observed');assert.equal(r[2].rank,null);assert.deepEqual(dailyRanks(r).map(d=>[d.rank,d.observed,d.valid,d.appearance]),[[7,1,2,50]]);
});
test('DST repeated local hour produces one slot and spring missing hour is not invented',()=>{
  const fall=slotCandidates('2026-11-01T05:00Z','2026-11-01T09:00Z','America/Chicago',[1]);assert.equal(fall.length,1);assert.equal(fall[0].key,'2026-11-01@01');
  assert.equal(slotCandidates('2026-03-08T06:00Z','2026-03-08T11:00Z','America/Chicago',[2]).length,0);
});
test('Monitoring input validates scope, duplicates and sampling hours',()=>{
  assert.throws(()=>monitorInput({keyword:'x',hours:'8'}));assert.throws(()=>monitorInput({keyword:'x',targets:[{asin:A},{asin:A}]}));assert.throws(()=>monitorInput({keyword:'x',profile:{postal_code:'abc'}}));
  assert.deepEqual(monitorInput({keyword:'  indoor   camera ',hours:[20,8,8]}).hours,[8,20]);
});
test('Collector matches DOM occurrence order, verifies postal code, preserves SP video',()=>{
  const m=monitorInput({keyword:'indoor camera',profile:{pages:1}}),raw={meta:{country:'US',keyword:m.keyword,deliveryLocationEvidence:{verified:true,requested:'60202'}},pageSignals:[{page:1,url:'https://www.amazon.com/s?k=indoor+camera'}],itemObservations:[{page:1,pagePosition:1,asin:A,title:'A',sponsored:true,hasVideo:true},{page:1,pagePosition:2,asin:A,title:'A again',sponsored:false}],items:[],adUnits:[]};
  const html=`<div id="glow-ingress-line2">Evanston 60202</div><input id="twotabsearchtextbox" value="indoor camera"><div class="s-main-slot"><div data-component-type="s-search-result" data-asin="${A}"><h2><span>A</span></h2></div><div data-component-type="s-search-result" data-asin="${A}"><h2><span>A again</span></h2></div></div>`;
  const v=normalizeCapture(raw,{1:html},m);assert.equal(v.quality.complete,true);assert.equal(v.data.pages[0].modules[0].ad_product,'SP');assert.equal(v.data.pages[0].modules[0].creative_format,'视频');assert.equal(v.data.pages[0].modules[1].items[0].organic_rank,1);
  assert.equal(normalizeCapture(raw,{1:html.replace('Evanston 60202','New York 10001')},m).quality.rank_valid,false);
  raw.pageSignals[0].correctionText='Showing results for other';assert.equal(normalizeCapture(raw,{1:html},m).quality.rank_valid,false);
});
test('Brand ad share alert requires two comparable samples, enough baseline and low unknown share',()=>{
  const s=(day,h,value=20)=>({observed_at:`2026-10-${String(day).padStart(2,'0')}T${h}:00Z`,slot_key:`2026-10-${day}@${h}`,source_version:'v1',quality:{complete:true,ads_valid:true},summary:{ad_modules:20,unknown_ad_brand_share:0,brands:[{brand:'Alpha',ad_share:value}]}});
  const base=[];for(let d=18;d<=23;d++)for(const h of ['08','14'])base.push(s(d,h));const recent=[s(24,'14',35),s(24,'08',32)];
  assert.equal(adShareSignal(recent,base,'Alpha').triggered,true);recent[0].summary.unknown_ad_brand_share=25;assert.equal(adShareSignal(recent,base,'Alpha'),null);
});
test('A sponsored parent module does not double-count its nested search cards',()=>{
  const m=monitorInput({keyword:'camera',profile:{pages:1}}),raw={meta:{country:'US',keyword:'camera',deliveryLocationEvidence:{verified:true,requested:'60202'}},pageSignals:[{page:1,url:'https://www.amazon.com/s?k=camera'}],itemObservations:[{page:1,pagePosition:1,asin:A,title:'A',sponsored:true},{page:1,pagePosition:2,asin:B,title:'B',sponsored:true}],items:[],adUnits:[{page:1,widgetId:'sb-top-slot',sponsoredLabelPresent:true,asins:[A,B],landingUrls:[],hasVideo:true,slot:'页首'}]};
  const html=`<div id="glow-ingress-line2">60202</div><div class="s-main-slot"><div cel_widget_id="sb-top-slot"><span>Sponsored</span><div data-component-type="s-search-result" data-asin="${A}"><h2><span>A</span></h2><div data-asin="${A}"></div></div><div data-component-type="s-search-result" data-asin="${B}"><h2><span>B</span></h2></div></div></div>`;
  const v=normalizeCapture(raw,{1:html},m),s=aggregateSnapshot(v.data);assert.equal(s.ad_modules,1);assert.equal(s.ad_types.SB,1);assert.equal(s.ad_cards,2);assert.equal(s.organic_cards,0);assert.equal(s.unique_asins,2);
});
test('Sales collapse parent/child overlap and preserve unavailable versus zero',()=>{
  const products=[{asin:A,parent_asin:P,brand:'Alpha'},{asin:B,parent_asin:P,brand:'Alpha'},{asin:'B000000003',brand:'Beta'}];
  const s=salesForProducts(products,[{entity_type:'parent',entity_id:P,units:100},{entity_type:'child',entity_id:A,units:40},{entity_type:'child',entity_id:B,units:60}]);
  assert.equal(s[0].units,100);assert.equal(s[0].coverage,100);assert.equal(s[0].entities,1);assert.equal(s[1].units,null);
  assert.equal(salesForProducts(products,[{entity_type:'child',entity_id:A,units:0}])[0].units,0);
});
test('Sales import rejects invalid windows, duplicate scope, and protects spreadsheet exports',()=>{
  const r=['QA','estimated','US','child',A,'2026-09-01','2026-09-30','calendar_month','100','','USD','2026-10-01T00:00:00Z'].join(',');const c=SALES_COLUMNS.join(',')+'\n'+r;
  assert.equal(parseSalesCSV(c)[0].units,100);assert.throws(()=>parseSalesCSV(c+'\n'+r));assert.throws(()=>parseSalesCSV(c.replace('2026-09-30','2026-09-29')));assert.ok(csv(['title'],[{title:'=HYPERLINK("x")'}]).includes("'=HYPERLINK"));
});
test('API persists snapshots, immutable scopes, fixed cohorts, idempotent CSV import and revert',async()=>{
  const name='QA-search-'+randomUUID();let m,batch,shot;try{
    m=await request('monitors',{keyword:name,profile:{pages:1}});
    await request(`monitors/${m.id}/update`,{...m,profile:{...m.profile,pages:2}},400);
    const job=(await pool.query("INSERT INTO search_jobs(id,monitor_id,kind,scheduled_at,status) VALUES($1,$2,'import',now(),'running') RETURNING *",[randomUUID(),m.id])).rows[0];
    const data=assignRanks({pages:[{page:1,complete:true,rank_valid:true,modules:[card(A)]}]});
    shot=await putSnapshot(job,m,{observed_at:new Date().toISOString(),source:'qa',source_version:'qa-v1',status:'complete',quality:{complete:true,rank_valid:true,ads_valid:true},data});
    assert.equal((await request('monitors/'+m.id)).latest.id,shot.id);assert.equal((await request(`ranks?monitor=${m.id}&asin=${A}`)).series[0].rank,1);
    const cohort=await request('cohorts',{snapshot_id:shot.id,name:'QA fixed cohort'});assert.equal(cohort.members.length,1);
    const content=SALES_COLUMNS.join(',')+'\n'+[name,'estimated','US','child',A,'2026-09-01','2026-09-30','calendar_month','17','','USD','2026-10-01T00:00:00Z'].join(',');
    batch=await request('sales-preview',{content,filename:'qa.csv'});assert.equal(batch.row_count,1);assert.equal((await request('sales-preview',{content,filename:'qa.csv'})).id,batch.id);assert.equal((await request('sales-batches/'+batch.id)).status,'preview');
    await request(`sales-batches/${batch.id}/commit`,{});assert.equal((await request(`sales-batches/${batch.id}/commit`,{})).duplicate,true);
    let sales=await request('sales?cohort='+cohort.id);const period=sales.periods.find(p=>p.source===name);assert.ok(period);sales=await request(`sales?cohort=${cohort.id}&period=${period.key}`);assert.equal(sales.brands[0].units,17);
    await request(`sales-batches/${batch.id}/revert`,{});assert.equal((await request('sales?cohort='+cohort.id)).periods.some(p=>p.source===name),false);
    await request(`sales-batches/${batch.id}/commit`,{},400);
    const exportFile=await fetch(base+'export?snapshot='+shot.id);assert.equal(exportFile.status,200);assert.ok((await exportFile.text()).includes(name));
    await request(`snapshots/${shot.id}/evidence?page=0`,undefined,400);
  }finally{
    if(batch){await pool.query('DELETE FROM search_sales WHERE batch_id=$1',[batch.id]);await pool.query('DELETE FROM search_sales_batches WHERE id=$1',[batch.id]);}
    if(m)await pool.query('DELETE FROM search_monitors WHERE id=$1',[m.id]);
    await pool.query('DELETE FROM search_audit_log WHERE object_id=ANY($1)',[[m?.id,batch?.id,shot?.id].filter(Boolean)]);
  }
});
test('Scheduler records offline missed slots without generating retrospective snapshots',async()=>{
  let m;try{m=await request('monitors',{keyword:'QA-schedule-'+randomUUID(),hours:[8,14,20]});await pool.query("UPDATE search_monitors SET state='active',scheduled_through='2026-10-01T00:00Z' WHERE id=$1",[m.id]);await schedule(new Date('2026-10-02T23:00Z'));const jobs=(await pool.query('SELECT * FROM search_jobs WHERE monitor_id=$1',[m.id])).rows;assert.ok(jobs.length>=5);assert.ok(jobs.every(j=>j.status==='missed'));await schedule(new Date('2026-10-02T23:00Z'));assert.equal((await pool.query('SELECT count(*)::int AS n FROM search_jobs WHERE monitor_id=$1',[m.id])).rows[0].n,jobs.length);}finally{if(m)await pool.query('DELETE FROM search_monitors WHERE id=$1',[m.id]);}
});
test('Search APIs reject unsafe origin, invalid IDs and malformed configuration',async()=>{
  assert.equal((await fetch(base+'monitors',{method:'POST',headers:{origin:'https://bad.example','content-type':'application/json'},body:'{}'})).status,403);
  await request('monitors/not-a-uuid',undefined,400);await request('monitors',{keyword:'bad',hours:'no'},400);await request('identities',{asin:A,brand:'X',own:false,source_url:'javascript:alert(1)'},400);
});
test.after(()=>pool.end());
