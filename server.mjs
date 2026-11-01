import http from 'node:http';
import {readFile} from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {spawn} from 'node:child_process';
import { pool, schema } from './lib/db.mjs';
import {weeklyNewsSchema,validDay,weekStart} from './lib/weekly-news.mjs';
import { competitorsAPI } from './lib/competitors.mjs';
import {searchSchema} from './lib/search-monitor/schema.mjs';
import {searchAPI} from './lib/search-monitor/api.mjs';
import {asinSchema} from './lib/asin-schema.mjs';
import {asinAPI} from './lib/asin-api.mjs';
import {startASINWorker} from './lib/asin-worker.mjs';
import {reviewSession} from './lib/asin-session.mjs';
import {externalSchema} from './lib/external/schema.mjs';
import {prepareExternal,externalGate,externalError} from './lib/external/api.mjs';
import {startIntegrationWorker} from './lib/external/worker.mjs';
import {integrationsConsole} from './lib/external/console.mjs';
import { syncAll, summaryReady } from './lib/sync.mjs';
import pg from 'pg';
pg.types.setTypeParser(1082, val=>val);
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'public');
const port=Number(process.env.PORT||4317);
const headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
function send(res,status,data){res.writeHead(status,headers);res.end(JSON.stringify(res.external&&status>=400?externalError(status,data,res.external.requestId):data));}
async function body(req){let result='';const limit=/^\/api\/(?:v1\/)?asin-monitors(?:\/|$)/.test(req.url)?2000000:16000;for await(const chunk of req){result+=chunk;if(Buffer.byteLength(result)>limit)throw Object.assign(new Error('提交内容超过允许大小'),{status:413});}try{return JSON.parse(result||'{}');}catch{throw Object.assign(new Error('JSON 格式无效'),{status:400});}}
// News is indexed by publication date; undated announcements use their explicit effective date.
const archiveDate='COALESCE(a.published_at,a.effective_at)';
const baseSelect=`SELECT a.*,${archiveDate} AS archive_date,CASE WHEN a.published_at IS NOT NULL THEN 'published' WHEN a.effective_at IS NOT NULL THEN 'effective' ELSE 'undated' END AS date_basis,s.name AS source_name, (a.source_id NOT IN ('amz123','cifnews')) AS official,
 (SELECT jsonb_build_object('week_start',i.week_start,'sector',i.sector,'importance_reason',i.importance_reason,'evidence',i.evidence) FROM weekly_news_items i JOIN weekly_news_batches b ON b.id=i.batch_id WHERE i.article_id=a.id ORDER BY b.updated_at DESC,b.id LIMIT 1) AS weekly_info
 FROM articles a JOIN sources s ON s.id=a.source_id`;
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1');
  prepareExternal(req,res,pool,url);
  try {
    if(!['GET','POST'].includes(req.method))return send(res,405,{error:'不支持此操作'});
    const host=req.headers.host||'';
    if(![`127.0.0.1:${port}`,`localhost:${port}`].includes(host))return send(res,403,{error:'只允许本机访问'});
    if(req.method==='POST' && req.headers.origin && ![`http://127.0.0.1:${port}`,`http://localhost:${port}`].includes(req.headers.origin))return send(res,403,{error:'请求来源无效'});
    if(await externalGate(req,res,url,pool,send))return;
    if(await integrationsConsole(req,url,pool,send,res))return;
    if(url.pathname==='/api/health') {await pool.query('SELECT 1');return send(res,200,{ok:true,database:'postgresql'});}
    if(await asinAPI(req,url,body,send,res,()=>asinWorker?.wake()))return;
    if(await searchAPI(req,url,send,res))return;
    if(await competitorsAPI(req,url,body,send,res))return;
    if(url.pathname==='/api/news-weeks'){
      const batches=await pool.query('SELECT * FROM weekly_news_batches ORDER BY period_end DESC,id');
      const weeks=await pool.query(`SELECT w.week_start::text,w.week_end::text,min(w.coverage_start)::text AS coverage_start,max(w.coverage_end)::text AS coverage_end,bool_or(w.partial) AS partial,count(DISTINCT i.article_id)::int AS count FROM weekly_news_weeks w LEFT JOIN weekly_news_items i USING(batch_id,week_start) GROUP BY w.week_start,w.week_end ORDER BY w.week_start DESC`);
      return send(res,200,{batches:batches.rows,weeks:weeks.rows});
    }
    if(url.pathname==='/api/articles') {
      const params=[],where=[]; const add=(value,clause)=>{params.push(value);where.push(clause.replaceAll('?',`$${params.length}`));};
      const category=url.searchParams.get('category'); if(category&&category!=='all')add(category,'a.category=?');
      const week=url.searchParams.get('week');
      if(week&&week!=='curated'&&(!validDay(week)||weekStart(week)!==week))return send(res,400,{error:'周日期须为有效的周一（YYYY-MM-DD）'});
      if(week==='curated')where.push('EXISTS (SELECT 1 FROM weekly_news_items w WHERE w.article_id=a.id)');
      else if(week)add(week,'EXISTS (SELECT 1 FROM weekly_news_items w WHERE w.article_id=a.id AND w.week_start=?::date)');
      const q=(url.searchParams.get('q')||'').trim().slice(0,150);if(q)add(`%${q.replace(/[\\%_]/g,'\\$&')}%`,"(a.title ILIKE ? OR a.summary ILIKE ? OR array_to_string(a.tags,' ') ILIKE ? OR a.topic ILIKE ? OR a.scope ILIKE ?)");
      if(url.searchParams.get('saved')==='true')where.push('a.saved=true');
      if(url.searchParams.get('official')==='true')where.push("a.source_id NOT IN ('amz123','cifnews')");
      const focusPatterns={cost:'费用|费率|附加费|成本|关税|收费|保险',fulfillment:'FBA|FBM|物流|运输|入仓|配送|履约|退货|仓储|空运|海运',compliance:'合规|规则|监管|保险|责任险|申报|禁令|诉讼|征求意见|标题|评论|捆绑',growth:'新品|发布|促销|Prime|销售|购物|AI|模型'};
      const focus=url.searchParams.get('focus');
      if(focus&&focus!=='all'&&!focusPatterns[focus])return send(res,400,{error:'主题无效'});
      if(focusPatterns[focus])add(focusPatterns[focus],"concat_ws(' ',a.title,a.summary,a.topic,array_to_string(a.tags,' ')) ~* ?");
      const yearRaw=url.searchParams.get('year'),monthRaw=url.searchParams.get('month');
      const year=yearRaw&&yearRaw!=='all'?Number(yearRaw):null,month=monthRaw?Number(monthRaw):0;
      if((yearRaw&&yearRaw!=='all'&&(!/^\d{4}$/.test(yearRaw)||year<2000||year>2100))||(monthRaw&&(!/^\d{1,2}$/.test(monthRaw)||month<0||month>12))||(month&&!year))return send(res,400,{error:'年份或月份无效'});
      const scope=where.length?' WHERE '+where.join(' AND '):'';
      const facets=await pool.query(`SELECT extract(year FROM ${archiveDate})::int AS year,extract(month FROM ${archiveDate})::int AS month,count(*)::int AS count FROM articles a${scope} GROUP BY 1,2 ORDER BY 1 DESC,2`,params);
      if(year){add(`${year}-${String(month||1).padStart(2,'0')}-01`,`${archiveDate}>=?::date`);add(month===12?`${year+1}-01-01`:month?`${year}-${String(month+1).padStart(2,'0')}-01`:`${year+1}-01-01`,`${archiveDate}<?::date`);}
      const days=Number(url.searchParams.get('days'));if([7,30,90].includes(days))add(days,`${archiveDate}>=CURRENT_DATE-(?::integer) AND ${archiveDate}<=CURRENT_DATE`);
      const order=url.searchParams.get('sort')==='priority'?`a.priority DESC,${archiveDate} DESC NULLS LAST`:`${archiveDate} DESC NULLS LAST,a.priority DESC`;
      const result=await pool.query(`${baseSelect}${where.length?' WHERE '+where.join(' AND '):''} ORDER BY ${order},a.id`,params);
      return send(res,200,{items:result.rows,facets:facets.rows});
    }
    if(url.pathname==='/api/dashboard') {
      const [articles,events,metrics,counts,sources,runs,pending]=await Promise.all([
        pool.query(`${baseSelect} ORDER BY a.priority DESC LIMIT 6`),
        pool.query('SELECT e.*,a.title,a.category,a.summary,a.url FROM policy_events e JOIN articles a ON a.id=e.article_id ORDER BY e.end_date'),
        pool.query('SELECT * FROM metrics'),
        pool.query('SELECT category,count(*)::integer AS count,count(*) FILTER(WHERE saved)::integer AS saved FROM articles GROUP BY category'),
        pool.query('SELECT id,name,enabled,last_success_at,last_error FROM sources'),
        pool.query('SELECT * FROM sync_runs ORDER BY started_at DESC LIMIT 1'),
        pool.query("SELECT count(*)::integer AS count FROM candidates WHERE state='pending'")
      ]);
      return send(res,200,{spotlights:articles.rows,events:events.rows,metrics:metrics.rows,counts:counts.rows,sources:sources.rows,lastRun:runs.rows[0]||null,pending:pending.rows[0].count,summaryReady:summaryReady(),serverDate:new Date().toISOString()});
    }
    if(url.pathname==='/api/sources') {
      const sources=await pool.query('SELECT s.*, (SELECT count(*)::int FROM candidates c WHERE c.source_id=s.id AND c.state=\'pending\') AS pending FROM sources s ORDER BY enabled DESC,name');
      const candidates=await pool.query("SELECT c.id,c.title,c.url,c.published_at,s.name AS source_name FROM candidates c JOIN sources s ON s.id=c.source_id WHERE c.state='pending' ORDER BY c.published_at DESC NULLS LAST LIMIT 20");
      return send(res,200,{sources:sources.rows,candidates:candidates.rows,summaryReady:summaryReady(),intervalHours:Number(process.env.SYNC_INTERVAL_HOURS||4)});
    }
    const saved=url.pathname.match(/^\/api\/articles\/([a-z0-9-]+)\/saved$/);
    if(saved && req.method==='POST'){
      const input=await body(req);if(typeof input.saved!=='boolean')return send(res,400,{error:'收藏状态无效'});
      const result=await pool.query('UPDATE articles SET saved=$2,updated_at=now() WHERE id=$1 RETURNING id,saved',[saved[1],input.saved]);
      return send(res,result.rowCount?200:404,result.rows[0]||{error:'资讯不存在'});
    }
    if(url.pathname==='/api/sync'&&req.method==='POST')return send(res,200,await syncAll());
    if(url.pathname.startsWith('/api/'))return send(res,404,{error:'接口不存在'});
    const allowed={'/':'index.html','/index.html':'index.html','/styles.css':'styles.css','/app.js':'app.js','/competitors.js':'competitors.js','/competitor-calendar.js':'competitor-calendar.js','/workspace.css':'workspace.css','/favicon.svg':'favicon.svg','/search-monitor.js':'search-monitor.js','/search-monitor.css':'search-monitor.css','/asin.js':'asin.js','/asin.css':'asin.css'};
    allowed['/integrations.js']='integrations.js';allowed['/integrations.css']='integrations.css';
    const file=allowed[url.pathname];if(!file)return send(res,404,{error:'页面不存在'});
    const mime=file.endsWith('.css')?'text/css':file.endsWith('.js')?'text/javascript':file.endsWith('.svg')?'image/svg+xml':'text/html';
    const buffer=await readFile(path.join(root,file));
    res.writeHead(200,{'Content-Type':`${mime}; charset=utf-8`,'Cache-Control':'no-cache','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'"});res.end(buffer);
  } catch(error){const status=error.status||500;if(status>=500)console.error('Request failed:',error.code||error.name);if(!res.headersSent)send(res,status,{error:status<500?error.message:'暂时无法读取本地数据，请检查服务和数据库连接。',code:status<500?error.code:'INTERNAL_ERROR'});else res.end();}
});
await schema();
await weeklyNewsSchema(pool);
await searchSchema(pool);
await asinSchema(pool);
await externalSchema(pool);
const asinWorker=process.env.ASIN_WORKER_DISABLED==='1'?null:startASINWorker();
const integrationWorker=process.env.NORTH_INTEGRATION_WORKER_DISABLED==='1'?null:startIntegrationWorker(pool);
server.listen(port,'127.0.0.1',()=>console.log(`NORTH is ready: http://127.0.0.1:${port}`));
const searchWorker=process.env.SEARCH_WORKER_DISABLED==='1'?null:spawn(process.execPath,['--env-file-if-exists=.env','scripts/search-monitor-worker.mjs'],{cwd:path.dirname(fileURLToPath(import.meta.url)),env:process.env,stdio:['ignore','inherit','inherit']});
searchWorker?.on('error',e=>console.error('Search worker did not start:',e.code||e.name));
const intervalHours=Math.max(1,Number(process.env.SYNC_INTERVAL_HOURS||4)||4);
const timer=setInterval(()=>syncAll().catch(()=>console.error('Scheduled sync failed')),intervalHours*3600000);
timer.unref();
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{clearInterval(timer);searchWorker?.kill('SIGTERM');server.close(async()=>{await Promise.all([asinWorker?.stop(),integrationWorker?.stop()]);await reviewSession.stop();await pool.end();process.exit(0);});});
