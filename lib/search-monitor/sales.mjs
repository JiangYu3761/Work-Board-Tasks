import {parse} from 'csv-parse/sync';
import {ASIN,fail,text,integer,safeURL} from './model.mjs';
export const SALES_COLUMNS=['source','kind','marketplace','entity_type','entity_id','period_start','period_end','window_type','units','revenue','currency','as_of'];
function date(v,name){if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(v)||!Number.isFinite(Date.parse(v))||new Date(v).toISOString().slice(0,10)!==v)fail(`${name}须为真实日期 YYYY-MM-DD`);return v;}
export function parseSalesCSV(content){
  let rows;try{rows=parse(content,{columns:true,bom:true,skip_empty_lines:true,trim:true,relax_column_count:false});}catch{fail('CSV 格式有误，请使用模板列名并检查引号与逗号');}
  if(!rows.length||rows.length>10000)fail('每次须导入 1–10,000 行销量');
  const keys=new Set();
  return rows.map((r,i)=>{
    try{
      const source=text(r.source,'来源',80),kind=r.kind;if(!['estimated','official_own'].includes(kind))fail('kind 须为 estimated 或 official_own');
      if(r.marketplace!=='US')fail('首版销量仅支持 US');
      if(!['child','parent'].includes(r.entity_type)||!ASIN.test(r.entity_id||''))fail('请提供有效 ASIN 和 child／parent 粒度');
      const period_start=date(r.period_start,'统计起日'),period_end=date(r.period_end,'统计止日');
      if(period_start>period_end||period_end>new Date().toISOString().slice(0,10))fail('统计日期不能倒置或位于未来');
      if(!['calendar_month','rolling_30d','daily'].includes(r.window_type))fail('window_type 须为 calendar_month、rolling_30d 或 daily');
      if(r.window_type==='daily'&&period_start!==period_end)fail('daily 须为同一天');
      if(r.window_type==='rolling_30d'&&(Date.parse(period_end)-Date.parse(period_start))/86400000!==29)fail('rolling_30d 须覆盖 30 个自然日');
      if(r.window_type==='calendar_month'){const end=new Date(Date.UTC(Number(period_start.slice(0,4)),Number(period_start.slice(5,7)),0)).toISOString().slice(0,10);if(!period_start.endsWith('-01')||period_end!==end)fail('calendar_month 须为完整自然月');}
      const units=integer(r.units,'销售件数',0,1e9);let revenue=null;if(r.revenue!=null&&r.revenue!==''){revenue=Number(r.revenue);if(!Number.isFinite(revenue)||revenue<0||revenue>1e12)fail('销售额无效');}
      if(r.currency!=='USD')fail('美国站币种须为 USD');
      if(!r.as_of||!Number.isFinite(Date.parse(r.as_of))||Date.parse(r.as_of)>Date.now()+60000)fail('as_of 须为有效且非未来的更新时间');
      if(Date.parse(r.as_of)<Date.parse(period_end))fail('更新时间不能早于统计止日');
      const key=[source,kind,r.marketplace,r.entity_type,r.entity_id,period_start,period_end,r.window_type].join('|');if(keys.has(key))fail('存在重复统计实体与周期');keys.add(key);
      return {source,kind,marketplace:'US',entity_type:r.entity_type,entity_id:r.entity_id,period_start,period_end,window_type:r.window_type,units,revenue,currency:'USD',as_of:new Date(r.as_of).toISOString()};
    }catch(e){fail(`第 ${i+2} 行：${e.message}`);}
  });
}
export function identityInput(v){
  const asin=text(v.asin,'ASIN',10).toUpperCase();if(!ASIN.test(asin))fail('ASIN 无效');
  const parent_asin=v.parent_asin?text(v.parent_asin,'父 ASIN',10).toUpperCase():null;if(parent_asin&&(!ASIN.test(parent_asin)||parent_asin===asin))fail('父 ASIN 无效');
  if(typeof v.own!=='boolean')fail('请选择是否为自有产品');
  return {marketplace:'US',asin,parent_asin,brand:text(v.brand,'品牌',80),label:text(v.label??'','型号',120,true),own:v.own,source_url:safeURL(v.source_url)};
}
