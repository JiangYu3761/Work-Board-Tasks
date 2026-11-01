import {createHash} from 'node:crypto';
export const MODEL_VERSION='north-serp-v1';
export const ASIN=/^[A-Z0-9]{10}$/;
export const UNKNOWN='未知品牌';
export const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
export function text(v,name,max=120,empty=false){if(typeof v!=='string'||v.trim().length>max||(!empty&&!v.trim()))fail(`${name}无效`);return v.trim();}
export function integer(v,name,min,max){if(v===''||v==null||typeof v==='boolean'||!Number.isInteger(Number(v))||Number(v)<min||Number(v)>max)fail(`${name}须为 ${min}–${max} 的整数`);return Number(v);}
export const hash=v=>createHash('sha256').update(typeof v==='string'?v:JSON.stringify(v)).digest('hex');
export function safeURL(v){try{const u=new URL(v);if(u.protocol!=='https:'||u.username||u.password||u.href.length>2000)fail('来源须为 HTTPS 链接');return u.href;}catch{fail('来源须为完整 HTTPS 链接');}}
export function profileOf(input={}){
  if(!input||typeof input!=='object'||Array.isArray(input))fail('采样环境格式无效');
  if(input.marketplace&&input.marketplace!=='US')fail('首版采集仅支持美国站');
  const postal_code=input.postal_code??'60202';if(!/^\d{5}$/.test(postal_code))fail('邮编须为 5 位美国邮编');
  const timezone=input.timezone??'America/Chicago';if(!['America/Chicago','America/New_York','America/Los_Angeles','America/Denver'].includes(timezone))fail('请选择美国采样时区');
  return {marketplace:'US',postal_code,timezone,pages:integer(input.pages??3,'页数',1,3),device:'desktop',viewport:'1440x900',language:'en-US',session:'anonymous',sort:'featured',version:1};
}
export function monitorInput(input){
  if(!input||typeof input!=='object'||(input.hours!=null&&!Array.isArray(input.hours))||(input.targets!=null&&!Array.isArray(input.targets)))fail('监控配置格式无效');
  if(input.targets?.some(t=>!t||typeof t!=='object'||Array.isArray(t)))fail('目标 ASIN 格式无效');
  const keyword=text(input.keyword,'搜索词',160).normalize('NFKC').replace(/\s+/g,' ');
  const profile=profileOf(input.profile);
  const hours=[...new Set((input.hours??[8,14,20]).map(x=>integer(x,'采样小时',0,23)))].sort((a,b)=>a-b);
  if(!hours.length||hours.length>6)fail('每天须设置 1–6 个采样时段');
  const targets=(input.targets??[]).map(t=>{const asin=text(t.asin,'ASIN',10).toUpperCase();if(!ASIN.test(asin))fail('ASIN 须为 10 位字母数字');return {asin,label:text(t.label??'','型号',100,true),goal_rank:integer(t.goal_rank??20,'目标位次',1,300)};});
  if(targets.length>30||new Set(targets.map(t=>t.asin)).size!==targets.length)fail('目标 ASIN 重复或超过 30 个');
  const state=input.state??'draft';if(!['draft','active','paused','archived'].includes(state))fail('监控状态无效');
  return {keyword,profile,environment_key:hash(profile),hours,targets,state,group_name:text(input.group_name??'','词组',60,true),priority:integer(input.priority??2,'优先级',1,3)};
}
export const median=values=>{const v=values.filter(Number.isFinite).sort((a,b)=>a-b);return v.length?(v[Math.floor((v.length-1)/2)]+v[Math.ceil((v.length-1)/2)])/2:null;};
export const share=(n,d)=>d?100*n/d:null;
export function aggregateSnapshot(data,identities=[]){
  const identity=new Map(identities.map(i=>[i.asin,i]));
  const products=new Map(),brands=new Map(),adTypes={},regions={};
  let ads=0,adCards=0,organic=0,unknownAds=0,unknownTypes=0,gridAds=0;const adObservations=[];
  const brandRow=name=>{if(!brands.has(name))brands.set(name,{brand:name,links:new Set(),organic_links:new Set(),ad_links:new Set(),organic_cards:0,top20:0,ad_modules:0,ad_cards:0});return brands.get(name);};
  for(const page of data.pages){
    for(const module of page.modules){
      const allBrands=new Set(module.items.map(i=>identity.get(i.asin)?.brand||i.brand).filter(Boolean));
      const moduleBrand=module.brand||((module.ad_product==='SP'&&allBrands.size===1)?[...allBrands][0]:null)||UNKNOWN;
      if(module.paid===true){ads++;brandRow(moduleBrand).ad_modules++;if(moduleBrand===UNKNOWN)unknownAds++;const type=module.ad_product||'UNKNOWN';if(type==='UNKNOWN')unknownTypes++;adTypes[type]=(adTypes[type]||0)+1;regions[module.region]=(regions[module.region]||0)+1;adObservations.push({id:module.id,brand:moduleBrand,type,format:module.creative_format,region:module.region,page:page.page});}
      for(const item of module.items){
        if(!ASIN.test(item.asin||''))continue;
        const mapped=identity.get(item.asin);
        const brand=mapped?.brand||item.brand||UNKNOWN;
        const b=brandRow(brand);b.links.add(item.asin);
        if(!products.has(item.asin))products.set(item.asin,{asin:item.asin,title:item.title||mapped?.label||item.asin,brand,parent_asin:mapped?.parent_asin||null,own:mapped?.own||false,rank:null,ad_count:0,price:item.price??null,rating:item.rating??null,reviews:item.reviews??null,bought_text:item.bought_text||null,occurrences:0});
        const p=products.get(item.asin);p.occurrences++;
        if(module.paid===true){p.ad_count++;b.ad_links.add(item.asin);if(item.card_observed!==false){adCards++;b.ad_cards++;}if(module.main_grid)gridAds++;}
        if(module.paid===false&&module.main_grid){organic++;b.organic_cards++;b.organic_links.add(item.asin);if(item.organic_rank!=null){p.rank=p.rank==null?item.organic_rank:Math.min(p.rank,item.organic_rank);if(item.organic_rank<=20)b.top20++;}}
      }
    }
  }
  return {version:MODEL_VERSION,organic_cards:organic,ad_modules:ads,ad_cards:adCards,ad_observations:adObservations,grid_ad_density:share(gridAds,gridAds+organic),unique_asins:products.size,unknown_ad_brand_share:share(unknownAds,ads),unknown_ad_type_share:share(unknownTypes,ads),ad_types:adTypes,regions,products:[...products.values()],brands:[...brands.values()].map(b=>({...b,links:[...b.links],organic_links:[...b.organic_links],ad_links:[...b.ad_links],ad_share:share(b.ad_modules,ads),organic_share:share(b.organic_cards,organic)})).sort((a,b)=>b.ad_modules-a.ad_modules||b.links.length-a.links.length)};
}
export function assignRanks(data){
  let rank=0,contiguous=true;
  for(const [index,page] of data.pages.entries()){
    if(page.page!==index+1||!page.rank_valid)contiguous=false;
    let pageRank=0;
    for(const module of page.modules){
      for(const item of module.items){
        item.organic_rank=null;item.page_organic_rank=null;
        if(!module.main_grid)continue;
        if(module.paid===null){contiguous=false;page.rank_valid=false;}
        if(module.paid===false){pageRank++;rank++;item.page_organic_rank=pageRank;if(contiguous)item.organic_rank=rank;}
      }
    }
    page.organic_count=pageRank;
  }
  return data;
}
export function slotCandidates(start,end,timezone,hours){
  const fmt=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23'});
  const out=[],seen=new Set();
  for(let t=Math.ceil(new Date(start).getTime()/3600000)*3600000;t<=new Date(end).getTime();t+=3600000){
    const p=Object.fromEntries(fmt.formatToParts(t).map(p=>[p.type,p.value]));const h=Number(p.hour);if(!hours.includes(h))continue;
    const key=`${p.year}-${p.month}-${p.day}@${p.hour}`;if(seen.has(key))continue;seen.add(key);out.push({at:new Date(t).toISOString(),key});
  }
  return out;
}
export function rankSeries(history,asin,timezone){
  const fmt=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'});
  return history.map(s=>{const product=s.summary.products.find(p=>p.asin===asin);return {snapshot_id:s.id,observed_at:s.observed_at,day:fmt.format(new Date(s.observed_at)),rank:s.quality.rank_valid?product?.rank??null:null,state:!s.quality.rank_valid?'invalid':product?.rank!=null?'observed':s.quality.complete?'not_observed':'partial',ad_count:product?.ad_count??null,kind:s.kind,source_version:s.source_version};});
}
export function dailyRanks(series){
  const groups=new Map();for(const s of series.filter(x=>x.kind==='scheduled')){if(!groups.has(s.day))groups.set(s.day,[]);groups.get(s.day).push(s);}
  return [...groups].map(([day,rows])=>{const valid=rows.filter(x=>['observed','not_observed'].includes(x.state));const ranks=valid.map(x=>x.rank).filter(Number.isFinite);return {day,rank:median(ranks),observed:ranks.length,valid:valid.length,expected:rows.length,appearance:share(ranks.length,valid.length)};});
}
export function adShareSignal(recent,history,brand){
  const eligible=s=>s?.quality?.complete&&s.quality.ads_valid&&s.summary.ad_modules>=10&&(s.summary.unknown_ad_brand_share??100)<=20;
  if(recent.length!==2||recent.some(s=>!eligible(s))||recent[0].source_version!==recent[1].source_version)return null;
  const values=recent.map(s=>s.summary.brands.find(b=>b.brand===brand)?.ad_share??0);
  const bases=recent.map(s=>history.filter(h=>eligible(h)&&h.source_version===s.source_version&&h.slot_key?.slice(-2)===s.slot_key?.slice(-2)&&new Date(h.observed_at)<new Date(recent[1].observed_at)&&new Date(h.observed_at)>=new Date(recent[1].observed_at)-7*86400000).map(h=>h.summary.brands.find(b=>b.brand===brand)?.ad_share??0));
  if(bases.some(b=>b.length<5))return null;
  const medians=bases.map(median),changes=values.map((v,i)=>v-medians[i]);
  return {brand,shares:values,baselines:medians,baseline_count:Math.min(...bases.map(b=>b.length)),changes,triggered:changes.every(v=>v>=10)||changes.every(v=>v<=-10),recovered:changes.every(v=>Math.abs(v)<10)};
}
export function csv(columns,rows){const cell=v=>{let s=String(v??'');if(/^[\s]*[=+\-@]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';};return '\ufeff'+[columns,...rows.map(r=>columns.map(c=>r[c]))].map(row=>row.map(cell).join(',')).join('\r\n');}
export function salesForProducts(products,rows){
  const byAsin=new Map(products.map(p=>[p.asin,p]));
  const byParent=new Map();for(const p of products)if(p.parent_asin){if(!byParent.has(p.parent_asin))byParent.set(p.parent_asin,[]);byParent.get(p.parent_asin).push(p);}
  const parentRows=new Map(rows.filter(r=>r.entity_type==='parent'&&byParent.has(r.entity_id)).map(r=>[r.entity_id,r]));
  const seen=new Set(),brands=new Map();
  for(const p of products){if(!brands.has(p.brand))brands.set(p.brand,{brand:p.brand,total_asins:0,covered_asins:0,units:0,entities:0,parent_entities:0});brands.get(p.brand).total_asins++;}
  for(const r of rows){
    const members=r.entity_type==='parent'?(byParent.get(r.entity_id)||[]):byAsin.has(r.entity_id)?[byAsin.get(r.entity_id)]:[];
    if(!members.length)continue;
    if(r.entity_type==='child'&&members[0].parent_asin&&parentRows.has(members[0].parent_asin))continue;
    if(new Set(members.map(p=>p.brand)).size!==1)continue;
    const k=r.entity_type+':'+r.entity_id;if(seen.has(k))continue;seen.add(k);
    const b=brands.get(members[0].brand);b.units+=Number(r.units);b.entities++;if(r.entity_type==='parent')b.parent_entities++;
    b.covered_asins+=members.length;
  }
  return [...brands.values()].map(b=>({...b,units:b.entities?b.units:null,coverage:share(b.covered_asins,b.total_asins)}));
}
