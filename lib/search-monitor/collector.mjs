import {spawn} from 'node:child_process';
import {readFile,writeFile,mkdir,access} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {gunzipSync,gzipSync} from 'node:zlib';
import {load} from 'cheerio';
import {chromium} from 'playwright-core';
import {ASIN,assignRanks,hash} from './model.mjs';

export const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
export const RUN_ROOT=path.join(ROOT,'.runtime/search-monitor/runs');
const scriptPath=()=>path.join(ROOT,'scripts/capture-search-monitor.mjs');
const clean=t=>String(t||'').replace(/\s+/g,' ').trim();
function explicitBrand($,el){
  const value=clean($(el).find('[data-cy="title-recipe"] h5, .s-brand-name, [data-brand]').first().attr('data-brand')||$(el).find('[data-cy="title-recipe"] h5, .s-brand-name').first().text());
  if(!value||value.length>80||/sponsored|visit|shop|compatible|works with/i.test(value))return null;
  return value.replace(/^Brand:\s*/i,'');
}
export async function collectorStatus(){
  try{await access(scriptPath());await access(process.env.SEARCH_CHROMIUM_PATH||chromium.executablePath());return {available:true,name:'本机 Amazon 搜索采集器',scope:'US · 桌面 · 未登录',note:'广告与品牌识别覆盖随页面结构变化；每次保存原页证据。'};}
  catch{return {available:false,name:'本机 Amazon 搜索采集器',note:'本机 Chromium 或采集脚本不可用。请检查 SEARCH_CHROMIUM_PATH 与项目安装状态。'};}
}
export function normalizeCapture(raw,htmlPages,monitor){
  const meta=raw.meta||{},pages=[];
  const locationOK=meta.deliveryLocationEvidence?.verified===true&&String(meta.deliveryLocationEvidence.requested)===monitor.profile.postal_code;
  const identityOK=meta.country==='US'&&meta.keyword===monitor.keyword;
  const details=new Map((raw.items||[]).map(i=>[i.asin,i]));
  let exhausted=false;
  for(let p=1;p<=monitor.profile.pages;p++){
    const html=htmlPages[p],signal=(raw.pageSignals||[]).find(x=>x.page===p);
    if(!html||!signal){pages.push({page:p,complete:false,rank_valid:false,location_verified:false,modules:[],reason:'页面证据缺失'});continue;}
    const $=load(html),nav=clean($('#glow-ingress-line2').text());
    const pageLocation=nav.includes(monitor.profile.postal_code);
    const query=$('#twotabsearchtextbox').attr('value');
    let queryOK=(!query||query.normalize('NFKC').trim().toLowerCase()===monitor.keyword.toLowerCase())&&!signal.correctionText;
    let domainOK=false;try{domainOK=new URL(signal.url).hostname.replace(/^www\./,'')==='amazon.com'&&new URL(signal.url).searchParams.get('k')===monitor.keyword;}catch{}
    const blocked=!!$('form[action*="validateCaptcha"]').length||/robot check|captcha/i.test($('title').text());
    const domOrder=new Map($('*').toArray().map((n,i)=>[n,i]));
    const nodes=$('div.s-main-slot div[data-component-type="s-search-result"]').toArray().filter(n=>ASIN.test($(n).attr('data-asin')||'')&&$(n).find('h2 span').length);
    const observed=(raw.itemObservations||[]).filter(i=>i.page===p).sort((a,b)=>a.pagePosition-b.pagePosition);
    const noResults=/no results (?:for|match)|did not match any products/i.test(clean($('body').text()));
    const modules=[],moduleNodes=new Map();
    for(const [i,item] of observed.entries()){
      const node=nodes[item.pagePosition-1]?.attribs['data-asin']===item.asin?nodes[item.pagePosition-1]:null;
      const card=node?$(node):null;
      const recommendation=card?.parents('[data-component-type*="carousel"], [cel_widget_id*="carousel"], [data-component-type*="recommendation"]').length>0;
      const paid=node&&typeof item.sponsored==='boolean'?item.sponsored:null;
      const d=details.get(item.asin)||{};
      const natural=observed.filter(o=>o.sponsored===false);
      const region=natural.length&&item.pagePosition<natural[0].pagePosition?(p===1?'首页顶部':'后续页顶部'):natural.length&&item.pagePosition>natural.at(-1).pagePosition?'页尾':'主结果流';
      moduleNodes.set(`p${p}-card${i+1}`,node);
      modules.push({id:`p${p}-card${i+1}`,order:domOrder.get(node)??item.pagePosition,paid,ad_product:paid?'SP':null,creative_format:item.hasVideo?'视频':'商品卡',region,main_grid:!recommendation,brand:null,type_evidence:item.classificationStatus||null,items:[{asin:item.asin,title:item.title,brand:node?explicitBrand($,node):null,price:item.price??null,rating:d.rating??null,reviews:d.reviews??null,bought_text:d.socialProofRaw||null,card_observed:true,page_position:item.pagePosition,url:`https://www.amazon.com/dp/${item.asin}`}],targets:[{type:'asin',id:item.asin,url:`https://www.amazon.com/dp/${item.asin}`}],top_px:null});
    }
    for(const [i,ad] of (raw.adUnits||[]).filter(x=>x.page===p).entries()){
      const marker=`${ad.widgetId||''} ${ad.componentType||''}`;
      const paid=ad.sponsoredLabelPresent===true||/(?:^|[-_: ])(?:sb|hsa)(?:[-_: ]|$)|sp-sponsored|sponsored-brand/i.test(marker);
      if(!paid)continue;
      const sb=/(?:^|[-_: ])(?:sb|hsa)(?:[-_: ]|$)|sponsored-brand/i.test(marker);
      const adProduct=sb?'SB':/sp-sponsored|sponsored-product/i.test(marker)?'SP':'UNKNOWN';
      const candidates=$('[cel_widget_id], [data-component-type]').toArray().filter(n=>(ad.widgetId&&$(n).attr('cel_widget_id')===ad.widgetId)||(!ad.widgetId&&$(n).attr('data-component-type')===ad.componentType));
      const container=candidates[0]?$(candidates[0]):null;
      // A parent ad with nested search cards is one module, not parent + N SP modules.
      if(container){for(let at=modules.length-1;at>=0;at--){const node=moduleNodes.get(modules[at].id);if(node&&$(node).parents().toArray().includes(candidates[0]))modules.splice(at,1);}}
      const brand=container?clean(container.find('[data-brand-name], [class*="brand-name"], [class*="brandName"]').first().attr('data-brand-name')||container.find('[class*="brand-name"], [class*="brandName"]').first().text()):'';
      const asins=[...new Set((ad.asins||[]).filter(a=>ASIN.test(a)))];
      const cardNodes=container?.find('[data-asin]').toArray().filter(n=>ASIN.test($(n).attr('data-asin')||''))||[];
      const cards=cardNodes.filter(n=>!cardNodes.some(other=>other!==n&&$(n).parents().toArray().includes(other)&&$(other).attr('data-asin')===$(n).attr('data-asin'))).map(n=>$(n).attr('data-asin'));
      const hasCards=cards.length>0;
      const items=(hasCards?cards:asins).map(asin=>{const d=details.get(asin)||{};return {asin,title:d.title||asin,brand:null,price:d.price??null,rating:d.rating??null,reviews:d.reviews??null,card_observed:hasCards,organic_rank:null,url:`https://www.amazon.com/dp/${asin}`};});
      const targets=asins.map(asin=>({type:'asin',id:asin,url:`https://www.amazon.com/dp/${asin}`}));
      for(const rawURL of ad.landingUrls||[]){try{const u=new URL(rawURL);const store=u.pathname.match(/\/stores\/[^/]+\/page\/([a-z0-9-]+)/i)||u.pathname.match(/\/stores\/page\/([a-z0-9-]+)/i);if(store&&!targets.some(t=>t.id===store[1]))targets.push({type:'store',id:store[1],url:`https://www.amazon.com${u.pathname}`});}catch{}}
      modules.push({id:`p${p}-ad${i+1}`,order:domOrder.get(candidates[0])??(100000+i),paid:true,ad_product:adProduct,creative_format:ad.hasVideo?'视频':targets.some(t=>t.type==='store')&&!items.length?'品牌店入口':items.length>1?'商品集合':'展示图片',region:ad.slot==='页首'?(p===1?'首页顶部':'后续页顶部'):ad.slot==='页尾'?'页尾':ad.slot==='侧栏'?'侧栏':'主结果流',main_grid:false,brand:brand&&brand.length<=80?brand:null,headline:ad.headline||null,creative_text:ad.creativeText||null,top_px:ad.topPx,type_evidence:marker,items,targets,card_coverage:hasCards?'identified':'targets_only'});
    }
    modules.sort((a,b)=>a.order-b.order);
    const loaded=!blocked&&observed.length===nodes.length&&(observed.length>0||noResults)&&locationOK&&pageLocation&&identityOK&&queryOK&&domainOK;
    const paginationPresent=$('.s-pagination-container, .a-pagination').length>0;
    const nextDisabled=$('.s-pagination-next.s-pagination-disabled, .a-pagination .a-last.a-disabled').length>0;
    const end=loaded&&(noResults||(paginationPresent&&nextDisabled));
    pages.push({page:p,url:signal.url,complete:loaded,rank_valid:loaded,location_verified:pageLocation,query_verified:queryOK,end_of_results:end,correction:signal.correctionText||null,modules,reason:blocked?'访问验证':!pageLocation?'配送地区未验证':!queryOK?'查询发生改写':!domainOK?'站点或请求词不匹配':!loaded?'页面未完整取得':null});
    if(end){exhausted=true;break;}
  }
  const data=assignRanks({pages});
  const complete=pages.every(p=>p.complete)&&(pages.length===monitor.profile.pages||exhausted);
  const rankValid=complete&&pages.every(p=>p.rank_valid);
  const quality={complete,rank_valid:rankValid,ads_valid:complete,location_verified:locationOK&&pages.every(p=>p.location_verified),pages_expected:monitor.profile.pages,pages_captured:pages.filter(p=>p.complete).length,exhausted,card_coverage:pages.some(p=>p.modules.some(m=>m.card_coverage==='targets_only'))?'partial':'identified',notes:pages.filter(p=>p.reason).map(p=>`第 ${p.page} 页：${p.reason}`),ad_scope:'已渲染且可机器识别的广告模块，实际覆盖需人工抽验'};
  return {data,quality,observed_at:meta.fetchedAt||new Date().toISOString(),status:complete?'complete':'partial'};
}

let activeChild=null;
export function cancelCollection(){if(activeChild){try{process.kill(-activeChild.pid,'SIGTERM');}catch{}activeChild=null;}}
export async function collect(monitor,job){
  const status=await collectorStatus();if(!status.available)throw Object.assign(new Error(status.note),{code:'SOURCE_UNAVAILABLE'});
  const root=ROOT,dir=path.join(RUN_ROOT,job.id,`attempt-${job.attempts}`);await mkdir(dir,{recursive:true});
  const script=scriptPath();
  const sourceVersion=hash(await readFile(script,'utf8')).slice(0,16);
  const started=Date.now();
  const run=await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[script,'--keyword',monitor.keyword,'--country','US','--pages',String(monitor.profile.pages),'--zip',monitor.profile.postal_code,'--out',dir,'--timezone',monitor.profile.timezone],{cwd:root,env:process.env,stdio:['ignore','pipe','pipe'],detached:true});activeChild=child;let log='';
    child.stdout.on('data',b=>{log=(log+b.toString()).slice(-12000);});child.stderr.on('data',b=>{log=(log+b.toString()).slice(-12000);});
    const timeout=setTimeout(()=>{try{process.kill(-child.pid,'SIGTERM');}catch{}},12*60*1000);
    child.once('error',e=>{clearTimeout(timeout);activeChild=null;reject(e);});
    child.once('close',(code,signal)=>{clearTimeout(timeout);activeChild=null;resolve({code,signal,log});});
  });
  await writeFile(path.join(dir,'collection.log'),run.log);
  if(run.code===2)throw Object.assign(new Error('Amazon 要求访问验证。此次未计入排名与份额；请稍后重试。'),{code:'ACCESS_BLOCKED'});
  if(run.code!==0)throw Object.assign(new Error(/zip|location/i.test(run.log)?'未能核实配送地区，未发布本次排名。':'采集未完成，请检查采集器与网络。'),{code:run.signal?'COLLECTOR_TIMEOUT':/zip|location/i.test(run.log)?'LOCATION_UNVERIFIED':'COLLECTOR_FAILED'});
  const source=await readFile(path.join(dir,'search.json'),'utf8');const raw=JSON.parse(source),html={};
  for(let p=1;p<=monitor.profile.pages;p++){try{html[p]=gunzipSync(await readFile(path.join(dir,'html',`search-p${p}.html.gz`))).toString('utf8');}catch{}}
  const normalized=normalizeCapture(raw,html,monitor);
  if(Date.now()-started>15*60*1000){normalized.quality.complete=false;normalized.quality.rank_valid=false;normalized.quality.ads_valid=false;normalized.status='partial';normalized.quality.notes.push('跨页采集超过 15 分钟');}
  // Keep a script-free evidence copy; screenshots and normalized data remain the viewing paths.
  for(const [p,sourceHTML] of Object.entries(html)){const $=load(sourceHTML);$('script,input[type="hidden"],noscript').remove();$('*').each((_,el)=>{for(const k of Object.keys(el.attribs||{}))if(/^on|csrf|token|nonce/i.test(k))$(el).removeAttr(k);});await writeFile(path.join(dir,'html',`search-p${p}.html.gz`),gzipSync($.html()));}
  return {...normalized,source:'north-amazon-browser',source_version:`${sourceVersion}/${MODEL_VERSION_LOCAL}`,source_hash:hash(source),evidence_dir:path.relative(RUN_ROOT,dir)};
}
const MODEL_VERSION_LOCAL='adapter-3';
