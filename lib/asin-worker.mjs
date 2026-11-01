import {pool} from './db.mjs';
import {enqueue,saveSnapshot,targetById} from './asin-store.mjs';
import {capture} from './asin-capture.mjs';
import {FIELDS} from './asin-domain.mjs';
import {captureReviews} from './asin-review-capture.mjs';

export function startASINWorker(){
  let busy=false,stopped=false,timer;
  async function tick(){
    if(busy||stopped)return;busy=true;
    let c,run,locked=false;
    try{
      c=await pool.connect();
      locked=(await c.query('SELECT pg_try_advisory_lock(43170401) AS ok')).rows[0].ok;
      if(!locked)return;
      await c.query('UPDATE asin_worker_status SET heartbeat=now() WHERE id=1');
      // A process can die mid-run. Recover its lease without creating a fabricated snapshot.
      await c.query("UPDATE asin_runs SET state=CASE WHEN attempts<2 THEN 'queued' ELSE 'failed' END,reason='上次进程中断，任务租约已到期',scheduled_at=now(),finished_at=CASE WHEN attempts<2 THEN NULL ELSE now() END WHERE state='running' AND lease_until<now()");
      await c.query("UPDATE asin_runs r SET state='cancelled',reason='监控已暂停或观察条件已变更',finished_at=now() FROM asin_targets t WHERE t.id=r.target_id AND r.state='queued' AND (t.status!='active' OR t.profile_version!=r.profile_version)");
      const due=(await c.query("SELECT * FROM asin_targets WHERE status='active' AND blocked_reason IS NULL AND (next_price_at<=now() OR next_content_at<=now()) ORDER BY LEAST(next_price_at,next_content_at) LIMIT 50")).rows;
      for(const t of due)await enqueue(t.id,{module:new Date(t.next_content_at)<=new Date()?'all':'price'});
      const quota=(await c.query("SELECT daily_limit,(SELECT count(*) FROM asin_attempts WHERE started_at>=date_trunc('day',now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai') AS used FROM asin_worker_status WHERE id=1")).rows[0];
      if(Number(quota.used)>=quota.daily_limit){await c.query("UPDATE asin_worker_status SET last_error='今日检查额度已用完，等待下一个自然日' WHERE id=1");return;}
      run=(await c.query("WITH claimed AS (UPDATE asin_runs SET state='running',started_at=now(),lease_until=now()+interval '6 minutes',attempts=attempts+1 WHERE id=(SELECT id FROM asin_runs WHERE state='queued' AND scheduled_at<=now() ORDER BY scheduled_at,created_at LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *), logged AS (INSERT INTO asin_attempts(run_id,attempt,started_at) SELECT id,attempts,started_at FROM claimed) SELECT * FROM claimed")).rows[0];
      if(!run){await c.query('UPDATE asin_worker_status SET current_run=NULL,last_error=NULL WHERE id=1');return;}
      await c.query('UPDATE asin_worker_status SET current_run=$1,last_error=NULL WHERE id=1',[run.id]);
      const heartbeat=setInterval(async()=>{await c.query("UPDATE asin_worker_status SET heartbeat=now() WHERE id=1").catch(()=>{});await c.query("UPDATE asin_runs SET lease_until=now()+interval '6 minutes' WHERE id=$1 AND state='running'",[run.id]).catch(()=>{});},20000);heartbeat.unref();
      try{
        const target=await targetById(run.target_id);
        const result=await capture(target,run);
        await saveSnapshot(target.id,{...result,source:'browser',run_id:run.id,profile:run.profile,profile_version:run.profile_version});
        let missing=[...result.coverage.unknown_fields],reviewNote='';
        if(run.module!=='price'){
          try{
            const reviews=await captureReviews(target,run);
            if(reviews.unavailable)reviewNote='专用评论：'+reviews.session.reason;
            else{
              await saveSnapshot(target.id,{...reviews,run_id:run.id,profile_version:run.profile_version});
              missing=missing.filter(k=>reviews.fields[k]?.state!=='observed');
              reviewNote=reviews.fields.reviews.state==='observed'?`专用会话取得 ${reviews.fields.reviews.value.length} 条展示评论`:'专用会话未取得评论卡片，保留上次有效数据';
            }
          }catch(e){reviewNote=e.sessionInvalid?'专用评论会话需要重新登录或人工验证':'专用评论检查未完成，请查看会话状态后重试；访客字段已保存';}
        }
        const incomplete=missing.length>0||/未取得|未完成|重新登录|尚未登录|停用|手动登录/.test(reviewNote);
        const reason=[missing.length?'已保存可确认字段；未取得：'+missing.map(k=>FIELDS[k][0]).join('、'):'',reviewNote].filter(Boolean).join('。');
        await c.query("UPDATE asin_runs SET state=$2,finished_at=now(),evidence_id=$3,reason=$4 WHERE id=$1",[run.id,incomplete?'partial':'success',result.evidence_id,reason||null]);
        await c.query(`UPDATE asin_targets SET failure_count=0,blocked_reason=NULL,
          next_price_at=CASE WHEN $2 IN ('price','all') THEN now()+((rules->>'price_hours')||' hours')::interval ELSE next_price_at END,
          next_content_at=CASE WHEN $2 IN ('content','all') THEN now()+((rules->>'content_hours')||' hours')::interval ELSE next_content_at END
          WHERE id=$1 AND profile_version=$3`,[target.id,run.module,run.profile_version]);
      }catch(e){
        const reason=String(e.message).slice(0,1500),blocked=e.captureState==='blocked';
        await c.query('UPDATE asin_runs SET state=$2,finished_at=now(),reason=$3,evidence_id=$4 WHERE id=$1',[run.id,blocked?'blocked':'failed',reason,e.evidence_id||null]);
        await c.query(`UPDATE asin_targets SET failure_count=failure_count+1,
          blocked_reason=CASE WHEN $2 OR failure_count>=2 THEN $3 ELSE NULL END,
          next_price_at=now()+CASE WHEN failure_count=0 THEN interval '5 minutes' ELSE interval '20 minutes' END,
          next_content_at=now()+CASE WHEN failure_count=0 THEN interval '5 minutes' ELSE interval '20 minutes' END
          WHERE id=$1 AND profile_version=$4`,[run.target_id,blocked,reason,run.profile_version]);
        await c.query('UPDATE asin_worker_status SET last_error=$1 WHERE id=1',[reason]);
      }finally{clearInterval(heartbeat);}
    }catch(e){console.error('ASIN worker:',e.message);}
    finally{
      if(c){if(locked){await c.query('UPDATE asin_worker_status SET current_run=NULL,heartbeat=now() WHERE id=1').catch(()=>{});await c.query('SELECT pg_advisory_unlock(43170401)').catch(()=>{});}c.release();}
      busy=false;
    }
  }
  timer=setInterval(tick,30000);timer.unref();tick();
  return {wake:()=>{if(!stopped)setTimeout(tick,20).unref();},stop:async()=>{stopped=true;clearInterval(timer);while(busy)await new Promise(r=>setTimeout(r,100));}};
}
