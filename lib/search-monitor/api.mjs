import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {pool} from '../db.mjs';
import {collectorStatus,RUN_ROOT} from './collector.mjs';
import {getMonitor,saveMonitor,enqueue,transaction,audit} from './store.mjs';
import {fail,text,integer,hash,csv,rankSeries,dailyRanks,salesForProducts,aggregateSnapshot} from './model.mjs';
import {parseSalesCSV,identityInput,SALES_COLUMNS} from './sales.mjs';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function id(v){if(!UUID.test(v||''))fail('记录 ID 无效');return v;}
async function body(req){let b='';for await(const part of req){b+=part;if(Buffer.byteLength(b)>4*1024*1024)fail('文件超过 4 MB，请拆分导入',413);}let v;try{v=JSON.parse(b);}catch{fail('JSON 格式无效');}if(!v||typeof v!=='object'||Array.isArray(v))fail('请求格式无效');return v;}
async function historyFor(m,days){return (await pool.query(`SELECT s.id,s.observed_at,s.status,s.quality,s.summary,s.source_version,s.environment_key,j.kind,j.slot_key FROM search_snapshots s JOIN search_jobs j ON j.id=s.job_id WHERE s.monitor_id=$1 AND s.observed_at>=now()-($2::int*interval '1 day') ORDER BY s.observed_at DESC LIMIT 2200`,[m,days])).rows;}
async function snapshot(idValue){const s=(await pool.query('SELECT * FROM search_snapshots WHERE id=$1',[id(idValue)])).rows[0];if(!s)fail('快照不存在',404);return s;}
async function salesSelection(){return (await pool.query(`SELECT s.source,s.kind,s.marketplace,s.period_start,s.period_end,s.window_type,s.currency,count(DISTINCT(s.entity_type,s.entity_id))::int AS entities,max(s.as_of) AS as_of FROM search_sales s JOIN search_sales_batches b ON b.id=s.batch_id WHERE b.status='committed' GROUP BY 1,2,3,4,5,6,7 ORDER BY s.period_end DESC,s.source,s.kind LIMIT 100`)).rows.map(s=>({...s,key:hash([s.source,s.kind,s.marketplace,s.period_start,s.period_end,s.window_type,s.currency])}));}
async function selectedSales(sel){return (await pool.query(`SELECT DISTINCT ON (s.entity_type,s.entity_id) s.* FROM search_sales s JOIN search_sales_batches b ON b.id=s.batch_id WHERE b.status='committed' AND s.source=$1 AND s.kind=$2 AND s.marketplace=$3 AND s.period_start=$4 AND s.period_end=$5 AND s.window_type=$6 AND s.currency=$7 ORDER BY s.entity_type,s.entity_id,s.as_of DESC,b.committed_at DESC,s.id DESC`,[sel.source,sel.kind,sel.marketplace,sel.period_start,sel.period_end,sel.window_type,sel.currency])).rows;}
export async function searchAPI(req,url,send,res){
  if(!url.pathname.startsWith('/api/search/'))return false;
  try{
    const p=url.pathname.slice('/api/search/'.length).split('/');const [resource,key,action]=p;
    if(p.length>3)fail('接口不存在',404);
    const days=integer(url.searchParams.get('days')||30,'查询天数',1,365);
    if(req.method==='GET'&&resource==='overview'){
      const [monitors,worker,jobs,alerts,source,identities,sales]=await Promise.all([
        pool.query(`SELECT m.*,s.id AS snapshot_id,s.observed_at,s.status AS snapshot_status,s.quality,s.summary,j.status AS job_status,j.error_message,j.id AS job_id FROM search_monitors m LEFT JOIN LATERAL(SELECT * FROM search_snapshots WHERE monitor_id=m.id ORDER BY observed_at DESC LIMIT 1)s ON true LEFT JOIN LATERAL(SELECT * FROM search_jobs WHERE monitor_id=m.id ORDER BY created_at DESC LIMIT 1)j ON true ORDER BY m.priority,m.created_at`),
        pool.query('SELECT * FROM search_worker_state WHERE id=1'),
        pool.query(`SELECT j.*,m.keyword FROM search_jobs j JOIN search_monitors m ON m.id=j.monitor_id ORDER BY j.created_at DESC LIMIT 100`),
        pool.query(`SELECT a.*,m.keyword FROM search_alerts a JOIN search_monitors m ON m.id=a.monitor_id ORDER BY a.last_seen DESC LIMIT 100`),collectorStatus(),pool.query('SELECT * FROM search_asin_identities ORDER BY own DESC,brand,label'),salesSelection()
      ]);
      send(res,200,{monitors:monitors.rows,worker:worker.rows[0]||null,jobs:jobs.rows,alerts:alerts.rows,source,identities:identities.rows,sales_periods:sales,page_limit:Number(process.env.SEARCH_DAILY_PAGE_LIMIT)||300,capabilities:{marketplaces:['US'],devices:['desktop'],max_pages:3,sales_sync:'csv_import',ad_validation:'machine_identifiable'}});return true;
    }
    if(resource==='monitors'&&req.method==='POST'){
      if(action==='run'){const result=await enqueue(id(key));send(res,202,result);return true;}
      if(action&&action!=='update')fail('接口不存在',404);
      const result=await saveMonitor(await body(req),key?id(key):null);send(res,200,result);return true;
    }
    if(resource==='monitors'&&key&&req.method==='GET'){
      const monitor=await getMonitor(id(key));const [history,jobs,cohorts]=await Promise.all([historyFor(monitor.id,days),pool.query('SELECT * FROM search_jobs WHERE monitor_id=$1 ORDER BY scheduled_at DESC LIMIT 100',[monitor.id]),pool.query('SELECT * FROM search_cohorts WHERE monitor_id=$1 ORDER BY created_at DESC',[monitor.id])]);
      const latest=history.length?await snapshot(history[0].id):null;
      send(res,200,{monitor,history,latest,jobs:jobs.rows,cohorts:cohorts.rows,scope:{days,profile:monitor.profile},data_as_of:latest?.observed_at||null});return true;
    }
    if(resource==='snapshots'&&key&&req.method==='GET'){
      const s=await snapshot(key);if(action==='evidence'){
        const page=integer(url.searchParams.get('page')||1,'页码',1,3);if(!s.evidence_dir)fail('此快照没有原页截图',404);
        const dir=path.resolve(RUN_ROOT,s.evidence_dir);if(!dir.startsWith(RUN_ROOT+path.sep))fail('证据路径无效');
        let buffer;try{buffer=await readFile(path.join(dir,'screenshots',`search-p${page}.png`));}catch{fail('本页截图未保存或已超过保留期',404);}
        res.writeHead(200,{'Content-Type':'image/png','X-Content-Type-Options':'nosniff','Cache-Control':'private, max-age=60'});res.end(buffer);return true;
      }
      send(res,200,s);return true;
    }
    if(resource==='ranks'&&req.method==='GET'){
      const m=await getMonitor(id(url.searchParams.get('monitor'))),asin=text(url.searchParams.get('asin'),'ASIN',10);
      const h=(await pool.query(`SELECT s.id,COALESCE(s.observed_at,j.scheduled_at) AS observed_at,COALESCE(s.quality,'{"complete":false,"rank_valid":false}'::jsonb) AS quality,COALESCE(s.summary,'{"products":[]}'::jsonb) AS summary,s.source_version,j.kind,j.status AS job_status FROM search_jobs j LEFT JOIN search_snapshots s ON s.job_id=j.id WHERE j.monitor_id=$1 AND j.scheduled_at>=now()-($2::int*interval '1 day') AND (s.id IS NOT NULL OR (j.kind='scheduled' AND j.status IN ('failed','blocked','missed','cancelled'))) ORDER BY j.scheduled_at DESC LIMIT 2200`,[m.id,days])).rows,series=rankSeries(h,asin,m.profile.timezone);
      send(res,200,{series,daily:dailyRanks(series),scope:{monitor:m.id,asin,days,profile:m.profile}});return true;
    }
    if(resource==='identities'&&req.method==='POST'){
      const v=identityInput(await body(req));
      await transaction(async c=>{const previous=(await c.query('SELECT * FROM search_asin_identities WHERE marketplace=$1 AND asin=$2',[v.marketplace,v.asin])).rows[0]||null;
        await c.query(`INSERT INTO search_asin_identities(marketplace,asin,brand,label,parent_asin,own,source_url) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(marketplace,asin) DO UPDATE SET brand=EXCLUDED.brand,label=EXCLUDED.label,parent_asin=EXCLUDED.parent_asin,own=EXCLUDED.own,source_url=EXCLUDED.source_url,updated_at=now()`,[v.marketplace,v.asin,v.brand,v.label,v.parent_asin,v.own,v.source_url]);await audit(c,'identity.update',v.asin,{before:previous,after:v});});
      send(res,200,{...v,note:'映射用于后续采集；已有历史保留原身份。可显式重算已选快照。'});return true;
    }
    if(resource==='snapshots'&&key&&action==='recalculate'&&req.method==='POST'){
      const s=await snapshot(key);const identities=(await pool.query('SELECT * FROM search_asin_identities')).rows;const summary=aggregateSnapshot(s.data,identities);
      await transaction(async c=>{await audit(c,'snapshot.identity_recalculation',s.id,{before:s.summary,after:summary});await c.query('UPDATE search_snapshots SET summary=$2,source_version=$3 WHERE id=$1',[s.id,JSON.stringify(summary),s.source_version.split('/identity-')[0]+'/identity-'+hash(identities).slice(0,8)]);});send(res,200,{summary,note:'身份纠错已记录；该修订产生比较断点，不触发经营提醒。'});return true;
    }
    if(resource==='cohorts'&&req.method==='POST'){
      const v=await body(req),s=await snapshot(v.snapshot_id),name=text(v.name,'集合名称',80);const members=s.summary.products.map(p=>({asin:p.asin,brand:p.brand,parent_asin:p.parent_asin,own:p.own}));if(!s.quality.complete||!members.length)fail('请从完整有效的非空快照建立固定集合');
      const r=await pool.query('INSERT INTO search_cohorts(id,monitor_id,name,members,snapshot_id) VALUES($1,$2,$3,$4,$5) RETURNING *',[randomUUID(),s.monitor_id,name,JSON.stringify(members),s.id]);send(res,200,r.rows[0]);return true;
    }
    if(resource==='sales'&&req.method==='GET'){
      const periods=await salesSelection();const selected=periods.find(p=>p.key===url.searchParams.get('period'))||null;
      let products=[],scope='当前货架';
      if(url.searchParams.get('cohort')){const c=(await pool.query('SELECT * FROM search_cohorts WHERE id=$1',[id(url.searchParams.get('cohort'))])).rows[0];if(!c)fail('固定集合不存在',404);products=c.members;scope=c.name;}
      else if(url.searchParams.get('snapshot'))products=(await snapshot(url.searchParams.get('snapshot'))).summary.products;
      const rows=selected?await selectedSales(selected):[];
      const eligible=selected?.kind==='official_own'?products.filter(p=>p.own):products;
      send(res,200,{periods,selected,scope,brands:salesForProducts(eligible,rows),records:rows.filter(r=>eligible.some(p=>p.asin===r.entity_id||p.parent_asin===r.entity_id)),note:'搜索样本覆盖商品销量，不代表搜索词成交或品牌全店销量。'});return true;
    }
    if(resource==='sales-template'&&req.method==='GET'){
      res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="sales-template.csv"'});res.end('\ufeff'+SALES_COLUMNS.join(',')+'\r\n');return true;
    }
    if(resource==='sales-batches'&&key&&req.method==='GET'){const b=(await pool.query('SELECT * FROM search_sales_batches WHERE id=$1',[id(key)])).rows[0];if(!b)fail('导入批次不存在',404);send(res,200,{id:b.id,status:b.status,row_count:b.rows.length,rows:b.rows.slice(0,10)});return true;}
    if(resource==='sales-batches'&&req.method==='GET'){send(res,200,{batches:(await pool.query('SELECT id,filename,status,jsonb_array_length(rows) AS row_count,created_at,committed_at,reverted_at FROM search_sales_batches ORDER BY created_at DESC LIMIT 50')).rows});return true;}
    if(resource==='sales-preview'&&req.method==='POST'){
      const v=await body(req),content=text(v.content,'CSV 内容',4*1024*1024),filename=text(v.filename||'sales.csv','文件名',200),rows=parseSalesCSV(content),fileHash=hash(content);
      const old=(await pool.query('SELECT * FROM search_sales_batches WHERE file_hash=$1',[fileHash])).rows[0];if(old){send(res,200,{id:old.id,status:old.status,row_count:old.rows.length,rows:old.rows.slice(0,10),duplicate:true});return true;}
      const key=randomUUID();await pool.query('INSERT INTO search_sales_batches(id,file_hash,filename,rows) VALUES($1,$2,$3,$4)',[key,fileHash,filename,JSON.stringify(rows)]);send(res,200,{id:key,status:'preview',row_count:rows.length,rows:rows.slice(0,10),duplicate:false});return true;
    }
    if(resource==='sales-batches'&&key&&req.method==='POST'){
      id(key);if(!['commit','revert'].includes(action))fail('操作无效');
      const result=await transaction(async c=>{const b=(await c.query('SELECT * FROM search_sales_batches WHERE id=$1 FOR UPDATE',[key])).rows[0];if(!b)fail('导入批次不存在',404);
        if(action==='revert'){if(b.status==='committed'){await c.query("UPDATE search_sales_batches SET status='reverted',reverted_at=now() WHERE id=$1",[key]);await audit(c,'sales.revert',key,{});}return {id:key,status:b.status==='committed'?'reverted':b.status};}
        if(b.status==='committed')return {id:key,status:'committed',duplicate:true};if(b.status==='reverted')fail('已撤销批次不能再次提交；请导入核对后的新文件');
        for(const r of b.rows){if(r.kind==='official_own'){
          const own=await c.query('SELECT 1 FROM search_asin_identities WHERE marketplace=$1 AND own=true AND (asin=$2 OR parent_asin=$2)',[r.marketplace,r.entity_id]);if(!own.rowCount)fail(`官方自有销量 ${r.entity_id} 尚未确认自有身份`);}
          await c.query(`INSERT INTO search_sales(batch_id,source,kind,marketplace,entity_type,entity_id,period_start,period_end,window_type,units,revenue,currency,as_of) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,[key,...SALES_COLUMNS.map(k=>r[k])]);}
        await c.query("UPDATE search_sales_batches SET status='committed',committed_at=now() WHERE id=$1",[key]);await audit(c,'sales.commit',key,{rows:b.rows.length});return {id:key,status:'committed',rows:b.rows.length};});send(res,200,result);return true;
    }
    if(resource==='alerts'&&key&&req.method==='POST'){
      const v=await body(req);if(!['new','acknowledged','investigating','resolved','closed'].includes(v.state))fail('处理状态无效');
      const note=text(v.note??'','处理记录',2000,true),owner=text(v.owner??'','负责人',80,true);let review=v.review_on||null;if(review&&(!/^\d{4}-\d{2}-\d{2}$/.test(review)||!Number.isFinite(Date.parse(review))||new Date(review).toISOString().slice(0,10)!==review))fail('复查日期无效');
      const r=await pool.query('UPDATE search_alerts SET state=$2,note=$3,owner=$4,review_on=$5,updated_at=now() WHERE id=$1 RETURNING *',[id(key),v.state,note,owner,review]);if(!r.rowCount)fail('提醒不存在',404);await audit(pool,'alert.update',key,v);send(res,200,r.rows[0]);return true;
    }
    if(resource==='export'&&req.method==='GET'){
      const s=await snapshot(url.searchParams.get('snapshot'));const columns=['keyword','observed_at','postal_code','pages','source','source_version','snapshot_status','asin','title','brand','rank','ad_count','price','rating','reviews','bought_text'];const m=await getMonitor(s.monitor_id);
      const rows=s.summary.products.map(p=>({...p,rank:s.quality.rank_valid?p.rank:null,keyword:m.keyword,observed_at:s.observed_at.toISOString(),postal_code:m.profile.postal_code,pages:m.profile.pages,source:s.source,source_version:s.source_version,snapshot_status:s.status}));
      res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="search-snapshot.csv"'});res.end(csv(columns,rows));return true;
    }
    fail('接口不存在',404);
  }catch(e){if(e.status){send(res,e.status,{error:e.message});return true;}throw e;}
}
