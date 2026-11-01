import {randomUUID} from 'node:crypto';
import {pool} from '../db.mjs';
import {aggregateSnapshot,fail,monitorInput,slotCandidates,median,share,adShareSignal} from './model.mjs';
export async function transaction(fn){const c=await pool.connect();try{await c.query('BEGIN');const r=await fn(c);await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
export async function audit(db,action,object,details){await db.query('INSERT INTO search_audit_log(action,object_id,details) VALUES($1,$2,$3)',[action,object,JSON.stringify(details)]);}
export async function getMonitor(id,db=pool){const r=await db.query('SELECT * FROM search_monitors WHERE id=$1',[id]);if(!r.rowCount)fail('监控词不存在',404);return r.rows[0];}
export async function saveMonitor(input,id){
  const m=monitorInput(input);
  return transaction(async c=>{
    if(id){const old=await getMonitor(id,c);if(old.environment_key!==m.environment_key||old.keyword!==m.keyword)fail('历史范围不可改写；更换词、邮编或页深请新建监控');
      const r=await c.query(`UPDATE search_monitors SET group_name=$2,hours=$3,targets=$4,state=$5,priority=$6,updated_at=now(),scheduled_through=CASE WHEN state<>'active' AND $5='active' THEN now() ELSE scheduled_through END WHERE id=$1 RETURNING *`,[id,m.group_name,m.hours,JSON.stringify(m.targets),m.state,m.priority]);
      if(m.state!=='active')await c.query("UPDATE search_jobs SET status='cancelled',finished_at=now(),error_message='监控已暂停或归档' WHERE monitor_id=$1 AND kind='scheduled' AND status IN ('queued','retry','budget_held')",[id]);
      await audit(c,'monitor.update',id,{before:old,after:r.rows[0]});return r.rows[0];
    }
    const key=randomUUID();
    try{const r=await c.query(`INSERT INTO search_monitors(id,keyword,group_name,profile,environment_key,hours,targets,state,priority) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,[key,m.keyword,m.group_name,JSON.stringify(m.profile),m.environment_key,m.hours,JSON.stringify(m.targets),m.state,m.priority]);await audit(c,'monitor.create',key,m);return r.rows[0];}
    catch(e){if(e.code==='23505')fail('该词与环境已有监控，请打开已有记录');throw e;}
  });
}
export async function enqueue(id){return transaction(async c=>{
  const m=(await c.query('SELECT * FROM search_monitors WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!m)fail('监控词不存在',404);if(m.state==='archived')fail('请先恢复已归档的监控词');
  const queued=await c.query("SELECT * FROM search_jobs WHERE monitor_id=$1 AND status IN ('queued','running','retry','budget_held') ORDER BY created_at DESC LIMIT 1",[id]);if(queued.rowCount)return queued.rows[0];
  const recent=await c.query("SELECT 1 FROM search_jobs WHERE monitor_id=$1 AND created_at>now()-interval '60 seconds'",[id]);if(recent.rowCount)fail('刚刚采集过，请稍后重试',429);
  const r=await c.query("INSERT INTO search_jobs(id,monitor_id,kind,scheduled_at) VALUES($1,$2,'manual',now()) RETURNING *",[randomUUID(),id]);return r.rows[0];
});}
export async function schedule(now=new Date()){
  const monitors=(await pool.query("SELECT * FROM search_monitors WHERE state='active'")).rows;
  for(const m of monitors){
    const until=new Date(Math.min(now.getTime(),new Date(m.scheduled_through).getTime()+31*86400000));
    const slots=slotCandidates(new Date(new Date(m.scheduled_through).getTime()+1),until,m.profile.timezone,m.hours);
    await transaction(async c=>{for(const s of slots){const missed=now-new Date(s.at)>30*60000;await c.query(`INSERT INTO search_jobs(id,monitor_id,kind,slot_key,scheduled_at,status,finished_at,error_message) VALUES($1,$2,'scheduled',$3,$4,$5,$6,$7) ON CONFLICT(monitor_id,slot_key) DO NOTHING`,[randomUUID(),m.id,s.key,s.at,missed?'missed':'queued',missed?now:null,missed?'服务离线或超过采样时段':null]);}await c.query('UPDATE search_monitors SET scheduled_through=GREATEST(scheduled_through,$2) WHERE id=$1',[m.id,until]);});
  }
}
export async function nextJob(){return transaction(async c=>{
  await c.query("UPDATE search_jobs SET status='failed',finished_at=now(),error_code='WORKER_INTERRUPTED',error_message='采集进程中断，请重新采集当前时点' WHERE status='running' AND lease_until<now()");
  await c.query("UPDATE search_jobs SET status='missed',finished_at=now(),error_code='SLOT_EXPIRED',error_message='已超过计划时段，不补造历史' WHERE kind='scheduled' AND status IN ('queued','retry','budget_held') AND scheduled_at<now()-interval '30 minutes'");
  const r=await c.query(`SELECT j.* FROM search_jobs j JOIN search_monitors m ON m.id=j.monitor_id WHERE j.status IN ('queued','retry','budget_held') AND j.available_at<=now() AND m.state<>'archived' ORDER BY m.priority,j.scheduled_at FOR UPDATE OF j SKIP LOCKED LIMIT 1`);
  if(!r.rowCount)return null;
  const j=r.rows[0],m=await getMonitor(j.monitor_id,c);
  const used=(await c.query("SELECT COALESCE(sum(j.attempts*(m.profile->>'pages')::int),0)::int AS pages FROM search_jobs j JOIN search_monitors m ON m.id=j.monitor_id WHERE j.created_at>now()-interval '24 hours'")).rows[0].pages;
  const cap=Math.max(3,Number(process.env.SEARCH_DAILY_PAGE_LIMIT)||300);
  if(used+m.profile.pages>cap){await c.query("UPDATE search_jobs SET status='budget_held',available_at=now()+interval '30 minutes',error_code='DAILY_LIMIT',error_message='达到过去24小时页面请求上限' WHERE id=$1",[j.id]);return null;}
  return (await c.query("UPDATE search_jobs SET status='running',attempts=attempts+1,started_at=now(),lease_until=now()+interval '15 minutes',error_code=NULL,error_message=NULL WHERE id=$1 RETURNING *",[j.id])).rows[0];
});}
export async function putSnapshot(job,m,result){return transaction(async c=>{
  const identities=(await c.query('SELECT * FROM search_asin_identities WHERE marketplace=$1',[m.profile.marketplace])).rows;
  const summary=aggregateSnapshot(result.data,identities),id=randomUUID();
  await c.query(`INSERT INTO search_snapshots(id,job_id,monitor_id,observed_at,environment_key,source_version,source,status,quality,summary,data,evidence_dir,source_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,[id,job.id,m.id,result.observed_at,m.environment_key,result.source_version,result.source,result.status,JSON.stringify(result.quality),JSON.stringify(summary),JSON.stringify(result.data),result.evidence_dir||null,result.source_hash||null]);
  await c.query('UPDATE search_jobs SET status=$2,finished_at=now(),snapshot_id=$3,lease_until=NULL WHERE id=$1',[job.id,result.status,id]);
  await audit(c,'snapshot.create',id,{job_id:job.id,status:result.status,quality:result.quality});
  return {...result,id,summary};
});}
export async function jobFailure(job,e){
  const retry=['COLLECTOR_FAILED','COLLECTOR_TIMEOUT'].includes(e.code)&&job.attempts<3;
  await pool.query("UPDATE search_jobs SET status=$2,finished_at=CASE WHEN $2='retry' THEN NULL ELSE now() END,available_at=now()+interval '2 minutes',lease_until=NULL,error_code=$3,error_message=$4 WHERE id=$1 AND status='running'",[job.id,retry?'retry':e.code==='ACCESS_BLOCKED'?'blocked':'failed',e.code||'INTERNAL_ERROR',e.message.slice(0,500)]);
  await upsertAlert(job.monitor_id,'source','data_failure','采集需要检查',{job_id:job.id,code:e.code||'INTERNAL_ERROR',message:e.message.slice(0,500)});
}
export async function upsertAlert(m,object,rule,title,details){
  const existing=(await pool.query("SELECT id FROM search_alerts WHERE monitor_id=$1 AND object_key=$2 AND rule=$3 AND state IN ('new','acknowledged','investigating') ORDER BY first_seen DESC LIMIT 1",[m,object,rule])).rows[0];
  if(existing){await pool.query('UPDATE search_alerts SET last_seen=now(),details=$2,updated_at=now() WHERE id=$1',[existing.id,JSON.stringify(details)]);return;}
  const cooled=(await pool.query("SELECT 1 FROM search_alerts WHERE monitor_id=$1 AND object_key=$2 AND rule=$3 AND first_seen>now()-interval '24 hours'",[m,object,rule])).rowCount;
  if(!cooled)await pool.query('INSERT INTO search_alerts(id,monitor_id,object_key,rule,title,details) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),m,object,rule,title,JSON.stringify(details)]);
}
export async function analyzeAlerts(m,snapshot,job){
  if(!snapshot.quality.complete||!snapshot.quality.rank_valid){await upsertAlert(m.id,'quality','data_quality','搜索页面覆盖不足',{snapshot_id:snapshot.id,notes:snapshot.quality.notes});return;}
  await pool.query("UPDATE search_alerts SET state='resolved',updated_at=now() WHERE monitor_id=$1 AND rule IN ('data_failure','data_quality') AND state IN ('new','acknowledged','investigating')",[m.id]);
  if(job.kind!=='scheduled')return;
  const history=(await pool.query(`SELECT s.*,j.slot_key,j.status AS job_status FROM search_jobs j LEFT JOIN search_snapshots s ON s.job_id=j.id WHERE j.monitor_id=$1 AND j.kind='scheduled' ORDER BY j.scheduled_at DESC LIMIT 50`,[m.id])).rows;
  const recent=history.slice(0,2);if(recent.length<2||recent.some(s=>!s.quality?.complete||!s.quality?.rank_valid||s.source_version!==snapshot.source_version))return;
  const brands=new Set(history.flatMap(s=>s.summary?.brands?.map(b=>b.brand)||[]));
  for(const brand of brands){if(brand==='未知品牌')continue;const signal=adShareSignal(recent,history.slice(2),brand);if(!signal)continue;
    if(signal.triggered)await upsertAlert(m.id,'brand:'+brand,'ad_share_change',`${brand} 广告模块份额连续变化至少 10 个百分点`,{...signal,snapshot_ids:recent.map(s=>s.id),rule_version:1});
    if(signal.recovered)await pool.query("UPDATE search_alerts SET state='resolved',updated_at=now() WHERE monitor_id=$1 AND object_key=$2 AND rule='ad_share_change' AND state IN ('new','acknowledged','investigating')",[m.id,'brand:'+brand]);
  }
  for(const t of m.targets){
    const ranks=recent.map(s=>s.summary.products.find(p=>p.asin===t.asin)?.rank??null);
    const base=history.slice(2).filter(s=>s.quality?.complete&&s.source_version===snapshot.source_version&&new Date(s.observed_at)>Date.now()-7*86400000);
    const baseRanks=base.map(s=>s.summary.products.find(p=>p.asin===t.asin)?.rank??null);
    if(base.length<5)continue;
    const present=baseRanks.filter(Number.isFinite);
    const common={asin:t.asin,ranks,snapshot_ids:recent.map(s=>s.id),baseline_count:base.length,baseline_rank:median(present),baseline_appearance:share(present.length,base.length),rule_version:1};
    if(ranks.every(r=>r==null)&&present.length/base.length>=.8)await upsertAlert(m.id,t.asin,'not_observed',`${t.label||t.asin} 连续两次未观察到`,common);
    if(ranks.every(r=>r==null||r>20)&&baseRanks.filter(r=>r!=null&&r<=20).length/base.length>=.8)await upsertAlert(m.id,t.asin,'outside_top20',`${t.label||t.asin} 连续两次未进 Top20`,common);
    const slotBases=recent.map(s=>base.filter(b=>b.slot_key?.slice(-2)===s.slot_key?.slice(-2)).map(b=>b.summary.products.find(p=>p.asin===t.asin)?.rank).filter(Number.isFinite));
    if(ranks.every(Number.isFinite)&&slotBases.every(v=>v.length>=5)&&ranks.every((r,i)=>r-median(slotBases[i])>=10))await upsertAlert(m.id,t.asin,'rank_drop',`${t.label||t.asin} 自然位下降至少 10 位`,{...common,same_slot_baselines:slotBases.map(median)});
    for(const rule of ['not_observed','outside_top20','rank_drop']){
      const recovered=rule==='not_observed'?ranks.every(Number.isFinite):rule==='outside_top20'?ranks.every(r=>r!=null&&r<=20):ranks.every(Number.isFinite)&&slotBases.every(v=>v.length>=5)&&ranks.every((r,i)=>r-median(slotBases[i])<10);
      if(recovered)await pool.query("UPDATE search_alerts SET state='resolved',updated_at=now() WHERE monitor_id=$1 AND object_key=$2 AND rule=$3 AND state IN ('new','acknowledged','investigating')",[m.id,t.asin,rule]);
    }
  }
}
