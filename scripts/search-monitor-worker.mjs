import {pool,schema} from '../lib/db.mjs';
import {searchSchema} from '../lib/search-monitor/schema.mjs';
import {collect,cancelCollection} from '../lib/search-monitor/collector.mjs';
import {getMonitor,schedule,nextJob,putSnapshot,jobFailure,analyzeAlerts} from '../lib/search-monitor/store.mjs';
await schema();await searchSchema(pool);
const lock=await pool.connect();
if(!(await lock.query('SELECT pg_try_advisory_lock(43170025) AS acquired')).rows[0].acquired){console.log('Search monitor worker already running.');lock.release();await pool.end();process.exit(0);}
let stopped=false,current=null,timer=null;
const heartbeat=async(state,detail='')=>pool.query(`INSERT INTO search_worker_state(id,heartbeat_at,state,job_id,detail) VALUES(1,now(),$1,$2,$3) ON CONFLICT(id) DO UPDATE SET heartbeat_at=now(),state=EXCLUDED.state,job_id=EXCLUDED.job_id,detail=EXCLUDED.detail`,[state,current?.id||null,detail]);
const beat=setInterval(()=>heartbeat(current?'collecting':'idle').catch(()=>{}),15000);
async function tick(){
  if(stopped)return;
  try{await schedule();current=await nextJob();await heartbeat(current?'collecting':'idle');
    if(current){const job=current;try{const m=await getMonitor(job.monitor_id);const result=await collect(m,job);if(stopped)return;const s=await putSnapshot(job,m,result);await analyzeAlerts(m,s,job);}catch(e){if(!stopped)await jobFailure(job,e);}finally{current=null;}}
  }catch(e){console.error('Search worker:',e.code||e.name);await heartbeat('error','任务服务异常，请检查数据库与采集器').catch(()=>{});}
  if(!stopped)timer=setTimeout(tick,5000);
}
async function stop(){if(stopped)return;stopped=true;clearTimeout(timer);clearInterval(beat);cancelCollection();if(current)await pool.query("UPDATE search_jobs SET status='failed',error_code='WORKER_STOPPED',error_message='服务已停止；请重新采集当前时点',finished_at=now(),lease_until=NULL WHERE id=$1 AND status='running'",[current.id]).catch(()=>{});await heartbeat('offline','服务已停止').catch(()=>{});await lock.query('SELECT pg_advisory_unlock(43170025)').catch(()=>{});lock.release();await pool.end();process.exit(0);}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
console.log('Search monitor worker ready.');
await tick();
