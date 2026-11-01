import {randomUUID} from 'node:crypto';
import {pool} from './db.mjs';
import {FIELDS,parseASIN,profile,reviewProfile,rules,text,fail,hash,valid,equal,diffField,validateFields} from './asin-domain.mjs';

export async function createTarget(input){
  if(!input||typeof input!=='object'||Array.isArray(input))fail('监控配置无效');
  const identity=parseASIN(input.input||input.asin,input.marketplace||'US');
  const config=profile(input.profile),policy=rules(input.rules);
  const status=input.status==='paused'?'paused':'active';
  const name=text(input.name,240,true),tags=text(input.tags,200,true);
  let brand=input.brand_id||null,listing=input.listing_id||null;
  if(brand&&!(await pool.query('SELECT 1 FROM competitors WHERE id=$1',[brand])).rowCount)fail('品牌不存在');
  if(listing){
    const l=(await pool.query('SELECT l.url,p.competitor_id FROM competitor_listings l JOIN competitor_products p ON p.id=l.product_id WHERE l.id=$1',[listing])).rows[0];
    if(!l||parseASIN(l.url).asin!==identity.asin||brand&&brand!==l.competitor_id)fail('商品链接与 ASIN 或品牌不匹配');
    brand=l.competitor_id;
  }
  const c=await pool.connect();
  try{
    await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock(43170402)');
    if((await c.query("SELECT count(*)::int AS n FROM asin_targets WHERE status!='archived'")).rows[0].n>=50)fail('当前试运行上限为 50 个监控对象');
    const row=(await c.query('INSERT INTO asin_targets(id,asin,marketplace,url,name,brand_id,listing_id,tags,status,profile,rules) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *',[randomUUID(),identity.asin,identity.marketplace,identity.url,name,brand,listing,tags,status,config,policy])).rows[0];
    await c.query('COMMIT');return row;
  }catch(e){await c.query('ROLLBACK');if(e.code==='23505')fail('此 ASIN 已在监控清单中；可从归档列表恢复',409);throw e;}finally{c.release();}
}
export async function targetById(id,db=pool){
  if(!/^[a-f0-9-]{36}$/.test(id||''))fail('监控对象不存在',404);
  const t=(await db.query('SELECT * FROM asin_targets WHERE id=$1',[id])).rows[0];
  if(!t)fail('监控对象不存在',404);return t;
}
export async function updateTarget(id,input){
  if(!input||typeof input!=='object'||Array.isArray(input))fail('监控配置无效');
  const c=await pool.connect();
  try{
    await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock(43170402)');await c.query('SELECT id FROM asin_targets WHERE id=$1 FOR UPDATE',[id]);
    const t=await targetById(id,c);const p=input.profile?profile(input.profile):t.profile;const r=input.rules?rules(input.rules):t.rules;
    const changed=hash(p)!==hash(t.profile),scheduleChanged=hash(r)!==hash(t.rules);const status=input.status??t.status;
    if(!['active','paused','archived'].includes(status))fail('状态无效');
    if(t.status==='archived'&&status!=='archived'&&(await c.query("SELECT count(*)::int AS n FROM asin_targets WHERE status!='archived'")).rows[0].n>=50)fail('当前试运行上限为 50 个监控对象');
    const name=input.name===undefined?t.name:text(input.name,240,true),tags=input.tags===undefined?t.tags:text(input.tags,200,true);
    const row=(await c.query(`UPDATE asin_targets SET name=$2,tags=$3,status=$4,profile=$5,rules=$6,
      profile_version=profile_version+$7,updated_at=now(),
      next_price_at=CASE WHEN $8 THEN now() ELSE next_price_at END,
      next_content_at=CASE WHEN $8 THEN now() ELSE next_content_at END,
      blocked_reason=CASE WHEN $8 THEN NULL ELSE blocked_reason END,
      failure_count=CASE WHEN $8 THEN 0 ELSE failure_count END WHERE id=$1 RETURNING *`,[id,name,tags,status,p,r,changed?1:0,changed||scheduleChanged||(t.status!=='active'&&status==='active')])).rows[0];
    if(status!=='active'||changed)await c.query("UPDATE asin_runs SET state='cancelled',finished_at=now(),reason='监控暂停、归档或观察条件变更' WHERE target_id=$1 AND state='queued'",[id]);
    await c.query('COMMIT');return row;
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
export async function enqueue(id,{manual=false,module='all'}={}){
  const t=await targetById(id);
  if(t.status!=='active')fail('请先恢复监控，再执行检查');
  if(!['all','price','content'].includes(module))fail('检查模块无效');
  const pending=(await pool.query("SELECT * FROM asin_runs WHERE target_id=$1 AND state IN ('queued','running')",[id])).rows[0];if(pending)return pending;
  if(manual){
    const recent=(await pool.query("SELECT * FROM asin_runs WHERE target_id=$1 AND source='browser' AND started_at>now()-interval '5 minutes' ORDER BY started_at DESC LIMIT 1",[id])).rows[0];
    if(recent)fail('这个 ASIN 在 5 分钟内已经检查过，请稍后再试',429);
  }else if(t.blocked_reason)return null;
  const idRun=randomUUID();
  const r=(await pool.query("INSERT INTO asin_runs(id,target_id,profile_version,profile,module) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING *",[idRun,id,t.profile_version,t.profile,module])).rows[0];
  if(manual&&r)await pool.query('UPDATE asin_targets SET blocked_reason=NULL,failure_count=0 WHERE id=$1',[id]);
  return r||(await pool.query("SELECT * FROM asin_runs WHERE target_id=$1 AND state IN ('queued','running')",[id])).rows[0];
}
function alertTitle(t,e){return `${t.name||t.asin} · ${FIELDS[e.field][0]}${e.kind==='reordered'?'顺序变化':'发生变化'}${e.status==='pending'?'（待复核）':''}`;}
async function notify(c,t,event){
  if(t.status!=='active'||event.severity==='info'||['transient','ignored'].includes(event.status)||event.status==='pending'&&event.field!=='promotions')return;
  await c.query('INSERT INTO asin_notifications(id,event_id,target_id,title) VALUES($1,$2,$3,$4) ON CONFLICT(event_id) DO NOTHING',[randomUUID(),event.id,t.id,alertTitle(t,event)]);
}
export async function saveSnapshot(id,input){
  const fields=validateFields(input.fields);const when=new Date(input.observed_at);
  if(!Number.isFinite(when.getTime())||when.getTime()>Date.now()+300000||when.getFullYear()<2000)fail('观察时间无效或在未来');
  const source=['browser','browser-auth'].includes(input.source)?input.source:'manual';const c=await pool.connect();
  try{
    await c.query('BEGIN');await c.query('SELECT id FROM asin_targets WHERE id=$1 FOR UPDATE',[id]);
    const t=await targetById(id,c),version=input.profile_version??t.profile_version,observedProfile=input.profile??t.profile;
    if(source==='browser-auth'){
      if(Object.keys(fields).some(k=>!['reviews','written_review_count'].includes(k)))fail('专用登录会话只用于评论，不能写入价格等访客字段');
      const base=version===t.profile_version?t.profile:{...observedProfile,login:'guest',prime:false,offer:'featured-new'};
      if(hash(observedProfile)!==hash(reviewProfile(base,observedProfile.session_generation)))fail('专用评论观察条件与当前配置不一致');
    }else if(version===t.profile_version&&hash(profile(observedProfile))!==hash(t.profile))fail('快照的配送地区等观察条件与当前配置不一致');
    const sid=randomUUID();
    const parser=source==='browser-auth'?String(input.parser_version||'reviews-1'):source==='browser'?String(input.parser_version||'2'):'1';
    const inserted=(await c.query(`INSERT INTO asin_snapshots(id,target_id,run_id,profile_version,profile,source,observed_at,fields,coverage,evidence_id,fingerprint,parser_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT DO NOTHING RETURNING *`,[sid,id,input.run_id||null,version,observedProfile,source,when,fields,input.coverage||{},input.evidence_id||null,hash(fields),parser])).rows[0];
    if(!inserted){await c.query('COMMIT');return {duplicate:true,events:0};}
    let events=0,baselines=0,confirmed=0;
    const previousHeads=new Map((await c.query('SELECT h.*,s.parser_version,s.profile FROM asin_field_heads h JOIN asin_snapshots s ON s.id=h.snapshot_id WHERE h.target_id=$1 AND h.profile_version=$2 AND h.source=$3',[id,version,source])).rows.map(h=>[h.field,h]));
    for(const [key,f] of Object.entries(fields)){
      if(!valid(f))continue;
      const previous=previousHeads.get(key);
      if(previous&&new Date(previous.observed_at)>=when)continue;
      const pending=(await c.query("SELECT * FROM asin_events WHERE target_id=$1 AND profile_version=$2 AND source=$3 AND field=$4 AND status='pending' ORDER BY window_end DESC LIMIT 1",[id,version,source,key])).rows[0];
      const comparable=previous?.parser_version===parser&&hash(previous.profile)===hash(observedProfile);
      if(pending&&comparable&&pending.after_snapshot_id===previous.snapshot_id){
        const same=equal(pending.after_value,f);
        await c.query('UPDATE asin_events SET status=$2,confirmed_at=$3 WHERE id=$1',[pending.id,same?'confirmed':'transient',same?when:null]);
        if(same){confirmed++;if(version===t.profile_version)await notify(c,t,{...pending,status:'confirmed'});}
      }
      const change=comparable?diffField(key,previous.data,f,t.rules):null;
      if(!comparable)baselines++;
      if(change){
        const event={...change,id:randomUUID()};
        if(pending&&pending.after_snapshot_id===previous.snapshot_id&&equal(pending.before_value,f)){event.status='transient';event.severity='info';}
        // The featured offer can change seller at the same time as its price.
        if(key==='sale_price'&&fields.seller&&valid(fields.seller)){
          const seller=previousHeads.get('seller');
          if(seller&&!equal(seller.data,fields.seller))event.details=[{kind:'seller_changed',before:seller.data.value,after:fields.seller.value}];
        }
        await c.query(`INSERT INTO asin_events(id,target_id,profile_version,source,field,kind,before_snapshot_id,after_snapshot_id,before_value,after_value,details,delta,percent,severity,status,window_start,window_end) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,[event.id,id,version,source,key,event.kind,previous.snapshot_id,sid,previous.data,f,JSON.stringify(event.details),event.delta??null,event.percent??null,event.severity,event.status,previous.observed_at,when]);
        if(version===t.profile_version)await notify(c,t,event);events++;
      }
      await c.query(`INSERT INTO asin_field_heads(target_id,profile_version,source,field,snapshot_id,observed_at,data) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(target_id,profile_version,source,field) DO UPDATE SET snapshot_id=EXCLUDED.snapshot_id,observed_at=EXCLUDED.observed_at,data=EXCLUDED.data`,[id,version,source,key,sid,when,f]);
    }
    if(!t.name&&fields.title?.state==='observed'&&version===t.profile_version)await c.query("UPDATE asin_targets SET name=$2 WHERE id=$1 AND name=''",[id,fields.title.value.slice(0,240)]);
    await c.query('COMMIT');return {snapshot:inserted,events,baselines,confirmed};
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
export async function detail(id){
  const target=await targetById(id);
  const results=await Promise.all([
    pool.query('SELECT h.*,s.profile FROM asin_field_heads h JOIN asin_snapshots s ON s.id=h.snapshot_id WHERE h.target_id=$1 AND h.profile_version=$2 ORDER BY h.source,h.field',[id,target.profile_version]),
    pool.query('SELECT id,profile_version,profile,parser_version,source,observed_at,coverage,evidence_id,received_at,jsonb_object_keys(fields) AS field FROM asin_snapshots WHERE target_id=$1 ORDER BY observed_at DESC LIMIT 1600',[id]),
    pool.query('SELECT * FROM asin_events WHERE target_id=$1 ORDER BY window_end DESC,id DESC LIMIT 200',[id]),
    pool.query('SELECT * FROM asin_runs WHERE target_id=$1 ORDER BY created_at DESC LIMIT 30',[id]),
    pool.query("SELECT id,observed_at,source,profile_version,fields->'sale_price' AS price,fields->'rating' AS rating,fields->'rating_count' AS rating_count FROM asin_snapshots WHERE target_id=$1 AND profile_version=$2 ORDER BY observed_at DESC LIMIT 500",[id,target.profile_version]),
    pool.query('SELECT DISTINCT ON(source) source,observed_at,profile,fields,coverage FROM asin_snapshots WHERE target_id=$1 AND profile_version=$2 ORDER BY source,observed_at DESC',[id,target.profile_version]),
  ]);
  const byId=new Map();for(const s of results[1].rows){if(!byId.has(s.id))byId.set(s.id,{...s,fields:[]});byId.get(s.id).fields.push(s.field);delete byId.get(s.id).field;}
  return {target,heads:results[0].rows,snapshots:[...byId.values()].slice(0,100),events:results[2].rows,runs:results[3].rows,history:results[4].rows.reverse(),latest:results[5].rows};
}
export async function listTargets(){
  const {rows}=await pool.query(`SELECT t.*,c.name AS brand_name,
    (SELECT count(*)::int FROM asin_events e WHERE e.target_id=t.id AND e.window_end>now()-interval '24 hours') AS changes,
    (SELECT count(*)::int FROM asin_events e WHERE e.target_id=t.id AND e.status='pending') AS pending,
    (SELECT row_to_json(r) FROM (SELECT id,state,reason,finished_at,started_at FROM asin_runs r WHERE r.target_id=t.id ORDER BY created_at DESC LIMIT 1) r) AS last_run,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('field',h.field,'source',h.source,'data',h.data,'observed_at',h.observed_at,'snapshot_id',h.snapshot_id)) FROM asin_field_heads h WHERE h.target_id=t.id AND h.profile_version=t.profile_version),'[]') AS heads
    FROM asin_targets t LEFT JOIN competitors c ON c.id=t.brand_id ORDER BY t.created_at DESC`);
  const worker=(await pool.query('SELECT * FROM asin_worker_status WHERE id=1')).rows[0];
  const used=(await pool.query("SELECT count(*)::int AS n FROM asin_attempts WHERE started_at>=date_trunc('day',now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai'")).rows[0].n;
  const alerts=(await pool.query('SELECT count(*)::int AS n FROM asin_notifications WHERE read_at IS NULL')).rows[0].n;
  return {items:rows,worker:{...worker,used_today:used,mode:'local'},unread:alerts,fields:FIELDS};
}
