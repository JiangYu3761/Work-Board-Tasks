import {randomUUID} from 'node:crypto';
import {pool} from './db.mjs';
const fail=message=>{throw Object.assign(new Error(message),{status:400});};
const str=(v,name,max=120,optional=false)=>{if(optional&&(v==null||v===''))return '';if(typeof v!=='string'||!v.trim()||Array.from(v.trim()).length>max)fail(`${name}不能为空，且不能超过 ${max} 字`);return v.trim();};
const link=(v,optional=false)=>{if(optional&&!v)return '';try{const u=new URL(v);if(u.protocol!=='https:'||u.username||u.password||u.href.length>2000)fail('请填写完整 HTTPS 链接');return u.href;}catch{fail('请填写完整 HTTPS 链接');}};
const date=(v,optional=false)=>{if(!v&&optional)return null;if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(v)||Number(v.slice(0,4))<2000||Number(v.slice(0,4))>2100||!Number.isFinite(Date.parse(v))||new Date(v).toISOString().slice(0,10)!==v)fail('日期无效');return v;};
const num=(v,name,{optional=false,max=9999999999.99,integer=false}={})=>{if(optional&&(v==null||v===''))return null;if(v==null||v===''||typeof v==='boolean'||!['number','string'].includes(typeof v))fail(`${name}无效`);if(typeof v==='string'&&!v.trim())fail(`${name}无效`);const n=Number(v);if(!Number.isFinite(n)||n<0||n>max||(integer&&!Number.isInteger(n)))fail(`${name}无效`);return n;};
const choice=(v,values)=>values.includes(v)?v:fail('选项无效');
const bool=v=>typeof v==='boolean'?v:fail('状态无效');
export function effectivePrice(o){
  if(o.sale_price==null)return null;
  const price=Number(o.sale_price);
  if(o.coupon_type==='none')return price;
  if(!o.coupon_public)return null;
  return Math.round((o.coupon_type==='percent'?price*(1-Number(o.coupon_value)/100):price-Number(o.coupon_value))*100)/100;
}
const normalize=o=>({...o,list_price:o.list_price==null?null:Number(o.list_price),sale_price:Number(o.sale_price),coupon_value:o.coupon_value==null?null:Number(o.coupon_value),rating:o.rating==null?null:Number(o.rating),effective_price:effectivePrice(o)});
export async function competitorsAPI(req,url,body,send,res){
  if(url.pathname!=='/api/competitors'&&!url.pathname.startsWith('/api/competitors/'))return false;
  try{
    const parts=url.pathname.split('/').filter(Boolean),id=parts[2],resource=parts[3];
    if(parts.length>4)return send(res,404,{error:'接口不存在'}),true;
    if(req.method==='GET'&&!id){
      const result=await pool.query(`SELECT c.*,(SELECT count(*)::int FROM competitor_products p WHERE p.competitor_id=c.id) AS product_count,(SELECT count(*)::int FROM competitor_events e WHERE e.competitor_id=c.id) AS event_count,(SELECT count(*)::int FROM competitor_events e WHERE e.competitor_id=c.id AND e.kind IN ('launch','promotion','important')) AS announcement_count FROM competitors c ORDER BY c.archived,CASE c.role WHEN 'own' THEN 0 WHEN 'priority' THEN 1 ELSE 2 END,c.created_at,c.name`);
      send(res,200,{items:result.rows});return true;
    }
    let competitor;
    if(id){competitor=(await pool.query('SELECT * FROM competitors WHERE id=$1',[id])).rows[0];if(!competitor){send(res,404,{error:'竞品不存在'});return true;}}
    if(req.method==='GET'&&id&&!resource){
      const [products,listings,observations,events,coverage]=await Promise.all([
        pool.query('SELECT * FROM competitor_products WHERE competitor_id=$1 ORDER BY line,name',[id]),
        pool.query('SELECT l.* FROM competitor_listings l JOIN competitor_products p ON p.id=l.product_id WHERE p.competitor_id=$1 ORDER BY l.platform,l.seller',[id]),
        pool.query('SELECT o.* FROM competitor_observations o JOIN competitor_listings l ON l.id=o.listing_id JOIN competitor_products p ON p.id=l.product_id WHERE p.competitor_id=$1 ORDER BY o.observed_on,o.created_at,o.id',[id]),
        pool.query('SELECT * FROM competitor_events WHERE competitor_id=$1 ORDER BY published_on DESC,created_at DESC,id',[id]),
        pool.query('SELECT * FROM competitor_source_audits WHERE competitor_id=$1 ORDER BY label',[id])
      ]);
      send(res,200,{competitor,products:products.rows,listings:listings.rows,observations:observations.rows.map(normalize),events:events.rows,coverage:coverage.rows});return true;
    }
    if(req.method!=='POST'){send(res,404,{error:'接口不存在'});return true;}
    const input=await body(req);
    if(!input||typeof input!=='object'||Array.isArray(input))fail('提交内容格式无效');
    if(!resource){
      const name=str(input.name,'竞品名称',80),market=str(input.market,'国家 / 市场',60),currency=str(input.currency,'币种',3).toUpperCase();
      if(!['USD','EUR','GBP','CAD','AUD','JPY','CNY'].includes(currency))fail('币种无效');
      const website=link(input.website,true);
      const role=choice(input.role??competitor?.role??'competitor',['own','priority','competitor']);
      const focus=str(input.focus??competitor?.focus??'','关注重点',160,true);
      if(!Array.isArray(input.sources)||input.sources.length>20)fail('最多可设置 20 个来源');
      const sources=input.sources.map(s=>({label:str(s.label,'来源名称',50),url:link(s.url)}));
      if(id&&(currency!==competitor.currency||market!==competitor.market)&&(await pool.query('SELECT 1 FROM competitor_products WHERE competitor_id=$1 LIMIT 1',[id])).rowCount)fail('已有产品记录，市场和币种不能修改；请另建一个市场');
      const key=id||randomUUID();
      const result=id?await pool.query('UPDATE competitors SET name=$2,market=$3,currency=$4,website=$5,sources=$6,paused=$7,archived=$8,role=$9,focus=$10 WHERE id=$1 RETURNING *',[key,name,market,currency,website,JSON.stringify(sources),bool(input.paused),bool(input.archived),role,focus]):await pool.query('INSERT INTO competitors(id,name,market,currency,website,sources,role,focus) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',[key,name,market,currency,website,JSON.stringify(sources),role,focus]);
      send(res,200,result.rows[0]);return true;
    }
    if(!id){send(res,404,{error:'请先添加竞品'});return true;}
    if(resource==='products'){
      const line=str(input.line,'产品线',80),name=str(input.name,'型号',100),variant=str(input.variant,'规格 / 变体',120),launched=date(input.launched_at,true);
      const lens=num(input.lens_count,'单机镜头数',{optional:true,max:20,integer:true}),pack=num(input.pack_quantity,'套装台数',{optional:true,max:100,integer:true});
      if(lens===0||pack===0)fail('镜头数和套装台数须大于零，未知请留空');
      const specs={lens_count:lens,pack_quantity:pack,power:str(input.power,'供电方式',60,true)};
      const result=await pool.query('INSERT INTO competitor_products(id,competitor_id,line,name,variant,launched_at,status,specs) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',[randomUUID(),id,line,name,variant,launched,choice(input.status||'onsale',['onsale','preorder','discontinued']),JSON.stringify(specs)]);
      send(res,200,result.rows[0]);return true;
    }
    if(resource==='listings'){
      if(!(await pool.query('SELECT 1 FROM competitor_products WHERE id=$1 AND competitor_id=$2',[input.product_id,id])).rowCount)fail('产品不属于当前竞品');
      const result=await pool.query('INSERT INTO competitor_listings(id,product_id,platform,seller,url) VALUES($1,$2,$3,$4,$5) RETURNING *',[randomUUID(),input.product_id,str(input.platform,'平台',60),str(input.seller,'卖家',100),link(input.url)]);
      send(res,200,result.rows[0]);return true;
    }
    if(resource==='observations'){
      const listing=(await pool.query('SELECT l.*,p.launched_at FROM competitor_listings l JOIN competitor_products p ON p.id=l.product_id WHERE l.id=$1 AND p.competitor_id=$2',[input.listing_id,id])).rows[0];
      if(!listing)fail('商品链接不属于当前竞品');
      const observed=date(input.observed_on),now=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date());
      if(observed>now)fail('不能记录未来日期的实际价格');
      if(listing.launched_at&&observed<listing.launched_at)fail('记录日期不能早于商品上线日期');
      const price=num(input.sale_price,'售价'),list=num(input.list_price,'划线价',{optional:true});
      const type=choice(input.coupon_type,['none','amount','percent']);
      const value=type==='none'?null:num(input.coupon_value,'优惠券',{max:type==='percent'?100:price});
      const publicCoupon=bool(input.coupon_public),conditions=str(input.conditions,'优惠条件',300,true);
      if(type!=='none'&&!publicCoupon&&!conditions)fail('请填写条件优惠的适用条件');
      const rating=num(input.rating,'评分',{optional:true,max:5}),reviews=num(input.review_count,'评论数',{optional:true,max:2147483647,integer:true});
      const result=await pool.query(`INSERT INTO competitor_observations(id,listing_id,observed_on,list_price,sale_price,coupon_type,coupon_value,coupon_public,conditions,rating,review_count,availability,source_url) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,[randomUUID(),input.listing_id,observed,list,price,type,value,publicCoupon,conditions,rating,reviews,choice(input.availability,['in_stock','out_of_stock','unknown']),link(input.source_url||listing.url)]);
      send(res,200,normalize(result.rows[0]));return true;
    }
    if(resource==='events'){
      const published=date(input.published_on),start=date(input.starts_on,true),end=date(input.ends_on,true);
      if(end&&!start)fail('请填写活动开始日期');if(start&&end&&start>end)fail('结束日期不能早于开始日期');
      if(published>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date()))fail('发布日期不能晚于今天；未来活动请填写开始日期');
      const result=await pool.query('INSERT INTO competitor_events(id,competitor_id,kind,title,summary,published_on,starts_on,ends_on,source_url) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',[randomUUID(),id,choice(input.kind,['launch','promotion','important','guide','story']),str(input.title,'标题',100),str(input.summary,'摘要',100),published,start,end,link(input.source_url)]);
      send(res,200,result.rows[0]);return true;
    }
    send(res,404,{error:'接口不存在'});return true;
  }catch(e){if(e.status===400||e instanceof SyntaxError){send(res,400,{error:e.status===400?e.message:'提交内容格式无效'});return true;}throw e;}
}
