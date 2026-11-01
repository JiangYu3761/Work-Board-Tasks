import {createHash} from 'node:crypto';

export const FIELDS = {
  sale_price:['售价','price'], reference_price:['参考价','price'], seller:['卖家与发货方','price'],
  promotions:['促销与优惠条件','price'], availability:['可购买状态','price'],
  title:['标题','content'], bullets:['五点卖点','content'], description:['描述与规格','content'],
  aplus:['A+ 与品牌故事','content'], images:['主图与附图','content'], rating:['评分','content'],
  rating_count:['Rating 数量','content'], written_review_count:['文字评论数量','content'],
  star_distribution:['星级分布','content'], review_summary:['评论摘要','content'], reviews:['评论展示','content'],
};
export const MODULES=['price','content'];
const ordered=v=>Array.isArray(v)?v.map(ordered):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,ordered(v[k])])):v;
export const hash=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(ordered(value))).digest('hex');
export const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
export function text(value,max=500,optional=false){
  if(optional&&(value===undefined||value===null||value===''))return '';
  if(typeof value!=='string'||!value.trim()||value.length>max)fail(`请输入有效文本（最多 ${max} 字符）`);
  return value.trim();
}
export function parseASIN(input,marketplace='US'){
  if(marketplace!=='US')fail('当前采集适配美国站；其他站点将在完成口径验证后开放');
  const raw=text(input,2000);let asin=raw.toUpperCase();
  if(/^https?:/i.test(raw)){
    let u;try{u=new URL(raw);}catch{fail('商品链接无效');}
    if(u.protocol!=='https:'||!['amazon.com','www.amazon.com','smile.amazon.com'].includes(u.hostname)||u.port||u.username||u.password)fail('请使用 Amazon 美国站的 HTTPS 商品详情链接');
    asin=u.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:\/|$)/i)?.[1]?.toUpperCase();
  }
  if(!/^[A-Z0-9]{10}$/.test(asin||''))fail('请填写十位 ASIN 或包含 /dp/ASIN 的美国站商品链接');
  return {asin,marketplace,url:`https://www.amazon.com/dp/${asin}`};
}
export function profile(input={}){
  if(!input||typeof input!=='object'||Array.isArray(input))fail('观察条件无效');
  const fixed={country:'US',language:'en-US',currency:'USD',login:'guest',prime:false,viewport:'1440x1000',reviews:'pdp-default',offer:'featured-new'};
  for(const [key,v] of Object.entries(fixed))if(input[key]!==undefined&&input[key]!==v)fail(`当前不支持此观察条件：${key}`);
  const zip=text(input.zip||'60202',5);
  if(!/^\d{5}$/.test(zip))fail('配送邮编须为美国五位邮编');
  return {zip,country:'US',language:'en-US',currency:'USD',login:'guest',prime:false,viewport:'1440x1000',reviews:'pdp-default',offer:'featured-new'};
}
export function rules(input={}){
  const price_hours=Number(input.price_hours??4),content_hours=Number(input.content_hours??24);
  if(![1,4,12,24].includes(price_hours)||![4,12,24,48].includes(content_hours))fail('检查周期无效');
  const price_percent=Number(input.price_percent??5);
  if(!Number.isFinite(price_percent)||price_percent<0||price_percent>100)fail('价格提醒阈值应为 0–100%');
  return {price_hours,content_hours,price_percent};
}
export function reviewProfile(base,generation){
  if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(generation||''))fail('专用评论会话标识无效');
  return {...profile(base),login:'dedicated',prime:'unobserved',offer:'not-observed',session_generation:generation};
}
export const value=(v,raw='',extra={})=>({state:'observed',value:v,raw:String(raw||''),precision:'exact',...extra});
export const unknown=(reason='未取得')=>({state:'unknown',value:null,reason});
export const absent=(reason='完整区域中未展示')=>({state:'absent',value:null,reason});
export const valid=f=>f&&['observed','absent'].includes(f.state);
export function count(raw){
  const s=String(raw||'').trim();
  const approximate=/\d[\d.,]*\s*[kKmM]\b/.test(s)||/[+~≈]/.test(s);
  const match=s.match(/[\d][\d,]*/);
  return match?value(approximate?null:Number(match[0].replaceAll(',','')),s,{precision:approximate?'approximate':'exact'}):unknown('未找到明确数量');
}
export function normalize(v){
  if(typeof v==='string')return v.normalize('NFC').replace(/\s+/g,' ').trim();
  if(Array.isArray(v))return v.map(normalize);
  if(v&&typeof v==='object')return Object.fromEntries(Object.keys(v).sort().filter(k=>!['url','asset_id','captured_at','source_url','evidence_id','width','height',...(v.pixel_hash?['sha256','key']:[])].includes(k)).map(k=>[k,normalize(v[k])]));
  return v;
}
export function comparableValue(field){
  return field.state==='absent'?{absent:true}:{value:normalize(field.value),precision:field.precision||'exact',unit:field.unit||null,currency:field.currency||null,scope:field.scope||null,...(field.precision==='approximate'?{raw:field.raw}:{})};
}
export const equal=(a,b)=>JSON.stringify(comparableValue(a))===JSON.stringify(comparableValue(b));
function imageKeys(v){return (v||[]).map(x=>x.pixel_hash||x.sha256||x.key||x.url);}
function listChange(before,after){
  if(Array.isArray(before)&&Array.isArray(after)&&JSON.stringify([...before].sort())===JSON.stringify([...after].sort()))return 'reordered';
  return 'updated';
}
export function reviewChanges(before,after){
  const old=new Map((before||[]).map(x=>[x.id,x]));const next=new Map((after||[]).map(x=>[x.id,x]));const changes=[];
  for(const [id,r] of next){
    if(!old.has(id)){changes.push({id,kind:'entered',before:null,after:r});continue;}
    const prev=old.get(id);
    if(prev.position!==r.position||prev.region!==r.region)changes.push({id,kind:'moved',before:prev,after:r});
    const keys=['title','body','rating','date','variant','verified','vine','helpful','media'];
    const changed=keys.filter(k=>JSON.stringify(normalize(prev[k]))!==JSON.stringify(normalize(r[k])));
    if(changed.length)changes.push({id,kind:prev.complete===true&&r.complete===true&&!!prev.language&&prev.language===r.language?'edited':'display_changed',fields:changed,before:prev,after:r});
  }
  for(const [id,r] of old)if(!next.has(id))changes.push({id,kind:'left',before:r,after:null});
  return changes;
}
export function diffField(key,before,after,policy={}){
  if(!valid(before)||!valid(after)||equal(before,after))return null;
  if(before.state==='observed'&&after.state==='observed'&&((before.currency||null)!==(after.currency||null)||(before.unit||null)!==(after.unit||null)||(before.scope||null)!==(after.scope||null)))return {field:key,kind:'scope_changed',before,after,details:[],severity:'info',status:'pending'};
  let kind=before.state==='absent'?'appeared':after.state==='absent'?'not_displayed':'updated';
  let details=[],delta=null,percent=null,severity='info',status=after.state==='absent'?'pending':'observed';
  if(['sale_price','reference_price','rating','rating_count','written_review_count'].includes(key)&&typeof before.value==='number'&&typeof after.value==='number'&&before.precision!=='approximate'&&after.precision!=='approximate'){
    delta=Number((after.value-before.value).toFixed(4));percent=before.value>0?Number((delta/before.value*100).toFixed(2)):null;
  }
  if(key==='sale_price'&&percent!==null&&Math.abs(percent)>=(policy.price_percent??5))severity='important';
  if(key==='rating'&&delta!==null&&delta<0){severity='important';status='pending';}
  if(key==='rating_count'&&delta<=-20&&percent<=-2){severity='important';status='pending';}
  if(['title','images'].includes(key))severity='important';
  if(key==='sale_price'&&after.state==='absent')severity='important';
  if(['promotions','bullets','description','aplus','review_summary','seller','availability'].includes(key))severity='normal';
  if(key==='images'&&before.state==='observed'&&after.state==='observed')kind=listChange(imageKeys(before.value),imageKeys(after.value));
  if(key==='bullets'&&before.state==='observed'&&after.state==='observed')kind=listChange(before.value,after.value);
  if(key==='reviews'){
    details=reviewChanges(before.value,after.value);
    if(!details.length)return null;
    if(details.some(x=>['entered','moved'].includes(x.kind)&&x.after?.rating<=2&&x.after?.position<=3)){severity='important';status='pending';}
    else if(details.some(x=>x.kind==='edited'))severity='normal';
  }
  return {field:key,kind,before,after,details,delta,percent,severity,status};
}

// Imports are observations, never executable HTML. The schema is also used by the live collector.
export function validateFields(fields){
  if(!fields||Array.isArray(fields)||typeof fields!=='object')fail('快照必须包含 fields 对象');
  const out={};
  for(const [key,f] of Object.entries(fields)){
    if(!FIELDS[key])fail(`不支持的字段：${key}`);
    if(!f||!['observed','absent','unknown','failed'].includes(f.state))fail(`${key} 的字段状态无效`);
    if(JSON.stringify(f).length>180000)fail(`${key} 超过允许长度`);
    if(f.state==='observed'){
      if(f.value===undefined)fail(`${key} 缺少观察值`);
      if(['title','description','review_summary','availability'].includes(key)&&typeof f.value!=='string')fail(`${key} 应为文本`);
      if(['sale_price','reference_price','rating','rating_count','written_review_count'].includes(key)){
        if(f.precision==='approximate'&&f.value===null){if(typeof f.raw!=='string'||!f.raw)fail('近似数量须保留原文');}
        else if(typeof f.value!=='number'||!Number.isFinite(f.value)||f.value<0||f.value>1e10)fail(`${key} 数值无效`);
        if(key==='rating'&&f.value>5)fail('评分不能超过 5');
        if(key.endsWith('_count')&&f.value!==null&&!Number.isInteger(f.value))fail('数量须为整数');
      }
      if(['images','bullets','promotions','reviews'].includes(key)&&(!Array.isArray(f.value)||f.value.length>(key==='reviews'?80:60)))fail(`${key} 列表无效或超出覆盖上限`);
      if(key==='bullets'&&f.value.some(x=>typeof x!=='string'))fail('卖点列表仅接受文字');
      if(key==='images'&&f.value.some(x=>!x||typeof x!=='object'||!(x.sha256||x.key)))fail('图片须提供内容 SHA256 或来源资产 key');
      if(key==='reviews'){
        const ids=new Set();
        for(const r of f.value){if(!r||typeof r.id!=='string'||!r.id||ids.has(r.id)||!Number.isInteger(r.position)||r.position<1)fail('评论须有不重复的稳定 ID 和有效展示位置');if(r.rating!==undefined&&r.rating!==null&&(typeof r.rating!=='number'||r.rating<0||r.rating>5))fail('评论评分无效');ids.add(r.id);}
      }
      if(['sale_price','reference_price'].includes(key)&&f.currency!=='USD')fail('美国站价格须明确标注 USD');
    }
    out[key]={...f,value:f.state==='observed'?f.value:null};
  }
  if(!Object.keys(out).length)fail('至少提供一个字段');
  return out;
}
