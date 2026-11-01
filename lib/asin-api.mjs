import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {pool} from './db.mjs';
import {FIELDS,parseASIN,profile,hash,fail,diffField,valid} from './asin-domain.mjs';
import {createTarget,updateTarget,listTargets,detail,targetById,enqueue,saveSnapshot} from './asin-store.mjs';
import {evidence,evidenceRoot} from './asin-capture.mjs';
import {reviewSession} from './asin-session.mjs';

const uuid=s=>/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(s||'');
const csvCell=v=>'"'+String(v??'').replace(/^[=+@\-\t\r]/,"'$&").replaceAll('"','""')+'"';
async function snapshot(id,target){if(!uuid(id))fail('快照不存在',404);const s=(await pool.query('SELECT * FROM asin_snapshots WHERE id=$1 AND target_id=$2',[id,target])).rows[0];if(!s)fail('快照不存在',404);return s;}

export async function asinAPI(req,url,body,send,res,wake=()=>{}){
  if(!url.pathname.startsWith('/api/asin-monitors'))return false;
  const route=url.pathname.slice('/api/asin-monitors'.length).split('/').filter(Boolean),method=req.method;
  const reply=(data,status=200)=>{send(res,status,data);return true;};
  try{
    if(!route.length){
      if(method==='GET')return reply({...await listTargets(),review_session:await reviewSession.status()});
      if(method==='POST'){const result=await createTarget(await body(req));wake();return reply(result,201);}
    }
    if(route[0]==='session'){
      if(route.length===1&&method==='GET')return reply(await reviewSession.status());
      if(method==='POST'&&route.length===2){
        if(!['open','verify','close','disable'].includes(route[1]))fail('会话操作不存在',404);
        const session=await reviewSession[route[1]]();
        if(route[1]==='verify'&&session.state==='ready'){
          await pool.query("UPDATE asin_targets SET next_content_at=now() WHERE status='active' AND blocked_reason IS NULL");wake();
        }
        return reply(session);
      }
      fail('会话操作不存在',404);
    }
    if(route[0]==='catalog'&&method==='GET'){
      const rows=(await pool.query("SELECT l.id AS listing_id,l.url,p.name,c.name AS brand_name,c.id AS brand_id FROM competitor_listings l JOIN competitor_products p ON p.id=l.product_id JOIN competitors c ON c.id=p.competitor_id WHERE l.platform ILIKE '%amazon%' ORDER BY c.name,p.name")).rows;
      return reply({items:rows.flatMap(r=>{try{return [{...r,...parseASIN(r.url)}];}catch{return [];}})});
    }
    if(route[0]==='import'&&method==='POST'){
      const b=await body(req);if(!Array.isArray(b.items)||!b.items.length||b.items.length>50)fail('一次导入 1–50 个 ASIN');
      const results=[];
      for(const item of b.items){try{results.push({input:item.input||item.asin,ok:true,target:await createTarget({...b.defaults,...item})});}catch(e){results.push({input:item.input||item.asin,ok:false,error:e.message});}}
      wake();return reply({results},201);
    }
    if(route[0]==='notifications'&&method==='GET')return reply({items:(await pool.query('SELECT n.*,t.asin,t.name FROM asin_notifications n JOIN asin_targets t ON t.id=n.target_id ORDER BY n.created_at DESC LIMIT 100')).rows});
    if(route[0]==='notifications'&&route[1]==='read'&&method==='POST'){await pool.query('UPDATE asin_notifications SET read_at=now() WHERE read_at IS NULL');return reply({ok:true});}
    if(route[0]==='digest'&&method==='GET'){
      const day=url.searchParams.get('day')||new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date());
      if(!/^\d{4}-\d{2}-\d{2}$/.test(day))fail('日期无效');
      const items=(await pool.query(`SELECT t.asin,t.name,e.* FROM asin_events e JOIN asin_targets t ON t.id=e.target_id WHERE (window_end AT TIME ZONE 'Asia/Shanghai')::date=$1::date ORDER BY window_end DESC`,[day])).rows;
      return reply({day,timezone:'Asia/Shanghai',items});
    }
    if(route[0]==='settings'&&method==='POST'){
      const {daily_limit}=await body(req);if(!Number.isInteger(daily_limit)||daily_limit<1||daily_limit>1000)fail('每日额度需在 1–1000 次之间');
      await pool.query('UPDATE asin_worker_status SET daily_limit=$1 WHERE id=1',[daily_limit]);wake();return reply({ok:true});
    }
    const id=route[0];if(!uuid(id))fail('请求不存在',404);const target=await targetById(id);
    if(route.length===1){if(method==='GET')return reply({...await detail(id),review_session:await reviewSession.status()});if(method==='POST'){const result=await updateTarget(id,await body(req));wake();return reply(result);}}
    if(route[1]==='check'&&method==='POST'){const b=await body(req);const r=await enqueue(id,{manual:true,module:b.module||'all'});wake();return reply(r,202);}
    if(route[1]==='template'&&method==='GET')return reply({asin:target.asin,marketplace:target.marketplace,profile:target.profile,observed_at:new Date().toISOString(),fields:{title:{state:'unknown',value:null,reason:'请替换为真实观察值'},sale_price:{state:'unknown',value:null,reason:'observed 状态需提供数值及 currency: USD'}}});
    if(route[1]==='snapshots'&&method==='POST'){
      const b=await body(req);
      if(b.asin!==target.asin||b.marketplace!==target.marketplace)fail('导入文件的 ASIN 或站点与当前对象不一致');
      if(!b.profile||hash(profile(b.profile))!==hash(target.profile))fail('导入文件的观察条件与当前配置不一致，请核对配送邮编');
      // A manual import may not claim a browser run or refer to another target's stored assets.
      const assets=[];function scan(o){if(!o||typeof o!=='object')return;if(o.asset_id)assets.push(o.asset_id);for(const v of Object.values(o))if(v&&typeof v==='object')scan(v);}scan(b.fields);
      for(const asset of assets){if(!uuid(asset)||!(await pool.query('SELECT 1 FROM asin_evidence WHERE id=$1 AND target_id=$2',[asset,id])).rowCount)fail('图片证据引用无效');}
      const result=await saveSnapshot(id,{observed_at:b.observed_at,fields:b.fields,source:'manual',profile:target.profile,coverage:{module:'import',note:'人工导入；与浏览器采集独立比较'}});
      if(result.snapshot){const eid=await evidence(id,null,JSON.stringify(b,null,2),'application/json');await pool.query('UPDATE asin_snapshots SET evidence_id=$2 WHERE id=$1',[result.snapshot.id,eid]);result.snapshot.evidence_id=eid;}
      return reply(result,201);
    }
    if(route[1]==='snapshots'&&route[2]&&method==='GET')return reply(await snapshot(route[2],id));
    if(route[1]==='compare'&&method==='GET'){
      const before=await snapshot(url.searchParams.get('before'),id),after=await snapshot(url.searchParams.get('after'),id);
      if(before.source!==after.source||before.profile_version!==after.profile_version||hash(before.profile)!==hash(after.profile))fail('只能比较同一数据来源、同一观察条件版本和同一登录会话批次的快照');
      if(before.parser_version!==after.parser_version)fail('两次快照之间采集口径已更新，请选择同一采集版本下的快照');
      if(new Date(before.observed_at)>=new Date(after.observed_at))fail('请选择两个不同时间的快照，变化前时间须早于变化后');
      const changes=[],unavailable=[];
      for(const key of Object.keys(FIELDS)){if(!valid(before.fields[key])||!valid(after.fields[key])){unavailable.push(key);continue;}const d=diffField(key,before.fields[key],after.fields[key],target.rules);if(d)changes.push(d);}
      return reply({before,after,changes,unavailable});
    }
    if(route[1]==='events'&&uuid(route[2])&&method==='POST'){
      const b=await body(req),e=(await pool.query('SELECT * FROM asin_events WHERE id=$1 AND target_id=$2',[route[2],id])).rows[0];if(!e)fail('变化不存在',404);
      if(b.status&&!['confirmed','ignored'].includes(b.status))fail('复核状态无效');
      const note=String(b.note??e.note).slice(0,1000);
      await pool.query('UPDATE asin_events SET read_at=now(),starred=$3,note=$4,status=$5,confirmed_at=CASE WHEN $5=\'confirmed\' THEN COALESCE(confirmed_at,now()) ELSE confirmed_at END WHERE id=$1 AND target_id=$2',[e.id,id,b.starred===undefined?e.starred:!!b.starred,note,b.status||e.status]);
      await pool.query('UPDATE asin_notifications SET read_at=now() WHERE event_id=$1',[e.id]);return reply({ok:true});
    }
    if(route[1]==='evidence'&&uuid(route[2])&&method==='GET'){
      const file=(await pool.query('SELECT * FROM asin_evidence WHERE id=$1 AND target_id=$2',[route[2],id])).rows[0];
      if(!file||path.dirname(file.path)!==evidenceRoot)fail('证据不存在',404);
      const bytes=await readFile(file.path);const mime=['image/png','image/jpeg','image/webp','application/json'].includes(file.mime)?file.mime:'application/octet-stream';
      res.writeHead(200,{'Content-Type':mime,'Cache-Control':'private, max-age=86400','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'",'Content-Disposition':`${mime.startsWith('image/')?'inline':'attachment'}; filename="${file.id}.${mime==='application/json'?'json':'bin'}"`});res.end(bytes);return true;
    }
    if(route[1]==='export'&&method==='GET'){
      const format=url.searchParams.get('format')||'csv';
      if(format==='json'){
        const snapshots=(await pool.query('SELECT * FROM asin_snapshots WHERE target_id=$1 ORDER BY observed_at',[id])).rows;
        const events=(await pool.query('SELECT * FROM asin_events WHERE target_id=$1 ORDER BY window_end',[id])).rows;
        res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Content-Disposition':`attachment; filename="${target.asin}-history.json"`});res.end(JSON.stringify({target,snapshots,events},null,2));return true;
      }
      const rows=(await pool.query('SELECT * FROM asin_events WHERE target_id=$1 ORDER BY window_end',[id])).rows;
      const data=[['ASIN','字段','变化类型','变化前','变化后','差值','变化百分比','来源','观察条件版本','上次观察时间','本次观察时间','状态','变化前快照','变化后快照'],...rows.map(e=>[target.asin,FIELDS[e.field][0],e.kind,JSON.stringify(e.before_value),JSON.stringify(e.after_value),e.delta,e.percent,e.source,e.profile_version,e.window_start.toISOString(),e.window_end.toISOString(),e.status,e.before_snapshot_id,e.after_snapshot_id])].map(r=>r.map(csvCell).join(',')).join('\r\n');
      res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="${target.asin}-changes.csv"`});res.end('\uFEFF'+data);return true;
    }
    return reply({error:'请求不存在'},404);
  }catch(e){if(e.status)return reply({error:e.message},e.status);if(e instanceof SyntaxError)return reply({error:'JSON 文件格式无效'},400);console.error('ASIN API:',e);return reply({error:'操作未完成，请检查本地服务日志'},500);}
}
