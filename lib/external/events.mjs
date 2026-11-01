import {randomUUID} from 'node:crypto';
import {fail,textField,canonical,digest} from './common.mjs';
import {channelConfig,assertChannel} from './feishu.mjs';

export function eventInput(input) {
  const type=textField(input.type,'事件类型',100);
  if(!/^[a-z][a-z0-9_.-]+$/.test(type))fail(400,'INVALID_INPUT','事件类型应使用小写字母、数字、点、横线或下划线');
  if(!['info','important','critical'].includes(input.severity??'info'))fail(400,'INVALID_INPUT','事件级别无效');
  if(input.notify!==undefined&&typeof input.notify!=='boolean')fail(400,'INVALID_INPUT','notify 必须为布尔值');
  const ref=input.object_ref??{};
  if(!ref||typeof ref!=='object'||Array.isArray(ref)||Object.keys(ref).some(k=>!['kind','id'].includes(k)))fail(400,'INVALID_INPUT','object_ref 仅支持 kind、id');
  const object_ref={};for(const key of Object.keys(ref))object_ref[key]=textField(ref[key],key,120);
  const occurred_at=input.occurred_at===undefined?null:input.occurred_at;
  if(occurred_at!==null&&(typeof occurred_at!=='string'||!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(occurred_at)||!Number.isFinite(Date.parse(occurred_at))||Date.parse(occurred_at)>Date.now()+60000))fail(400,'INVALID_INPUT','occurred_at 必须是含时区且不晚于当前时间的 ISO 时间');
  return {type,severity:input.severity??'info',title:textField(input.title,'标题',120),body:textField(input.body,'内容',3000),object_ref,occurred_at:occurred_at?new Date(occurred_at).toISOString():null,notify:input.notify===true};
}
export async function transaction(pool,fn) {
  const client=await pool.connect();try{await client.query('BEGIN');const result=await fn(client);await client.query('COMMIT');return result;}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}
// Serialize before allocating sequence IDs so a cursor never skips a late commit.
export const lockEvents=c=>c.query('SELECT pg_advisory_xact_lock(4317,90210)');
export async function insertEvent(c,{source_key,actor_id,event,notify=false,destination=null}) {
  const content_hash=digest(canonical(event));
  const old=(await c.query('SELECT * FROM north_events WHERE source_key=$1',[source_key])).rows[0];
  if(old){if(old.content_hash!==content_hash)fail(409,'IDEMPOTENCY_CONFLICT','同一幂等键对应的内容不同');return {event:old,duplicate:true};}
  const saved=(await c.query(`INSERT INTO north_events(source_key,content_hash,type,severity,title,body,object_ref,actor_id,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9::timestamptz,now())) RETURNING *`,[source_key,content_hash,event.type,event.severity,event.title,event.body,JSON.stringify(event.object_ref||{}),actor_id,event.occurred_at])).rows[0];
  if(notify)await c.query('INSERT INTO north_deliveries(id,event_id,destination) VALUES($1,$2,$3)',[randomUUID(),saved.id,destination]);
  return {event:saved,duplicate:false};
}
export function publicEvent(e) {const {source_key,content_hash,actor_id,...rest}=e;return {...rest,origin:actor_id==='system'?'system':'agent'};}
export async function publishEvent(pool,actor,key,input,config=channelConfig()) {
  if(typeof key!=='string'||!/^[A-Za-z0-9_.:-]{1,120}$/.test(key))fail(400,'IDEMPOTENCY_KEY_REQUIRED','请提供 1–120 位 Idempotency-Key（字母、数字、点、冒号、横线或下划线）');
  const event=eventInput(input);
  if(!/^(agent|external)\./.test(event.type))fail(400,'RESERVED_EVENT_TYPE','外部内容使用 agent.* 或 external.* 类型；search.*、asin.* 留给系统事件');
  if(event.notify&&!actor.scopes.includes('notify:write'))fail(403,'FORBIDDEN','发送通知还需要 notify:write 权限');
  const source_key=`agent:${actor.id}:${key}`;
  return transaction(pool,async c=>{
    await lockEvents(c);
    // A replay remains valid even if the delivery channel has since been disabled.
    const existing=(await c.query('SELECT * FROM north_events WHERE source_key=$1',[source_key])).rows[0];
    if(!existing&&event.notify)await assertChannel(config);
    const result=await insertEvent(c,{source_key,actor_id:actor.id,event,notify:event.notify,destination:config.chatId});
    const deliveries=(await c.query('SELECT id,state,provider_message_id,last_error FROM north_deliveries WHERE event_id=$1',[result.event.id])).rows;
    return {...result,event:publicEvent(result.event),deliveries};
  });
}

export async function bridgeEvents(pool,config=channelConfig()) {
  return transaction(pool,async c=>{
    await lockEvents(c);
    const queries=[
      `SELECT 'search-alert:'||a.id AS source_key,'search.alert' AS type,'important' AS severity,a.title,
        m.keyword||' · 规则：'||a.rule||' · 请在监控页面查看证据与处理记录。' AS body,
        jsonb_build_object('kind','search_alert','id',a.id) AS object_ref,a.first_seen AS occurred_at
        FROM search_alerts a JOIN search_monitors m ON m.id=a.monitor_id,north_integration_state s
        WHERE a.first_seen>=s.enabled_at AND a.state NOT IN ('resolved','closed') AND a.rule<>'data_failure'
        AND NOT EXISTS(SELECT 1 FROM north_events e WHERE e.source_key='search-alert:'||a.id) ORDER BY a.first_seen LIMIT 100`,
      `SELECT 'search-job:'||j.id AS source_key,'search.job.failed' AS type,'important' AS severity,'搜索采集未完成' AS title,
        m.keyword||' · 状态：'||j.status||' · 错误代码：'||COALESCE(j.error_code,'UNKNOWN') AS body,
        jsonb_build_object('kind','search_job','id',j.id) AS object_ref,j.finished_at AS occurred_at
        FROM search_jobs j JOIN search_monitors m ON m.id=j.monitor_id,north_integration_state s
        WHERE j.finished_at>=s.enabled_at AND j.status IN ('failed','blocked')
        AND NOT EXISTS(SELECT 1 FROM north_events e WHERE e.source_key='search-job:'||j.id) ORDER BY j.finished_at LIMIT 100`,
      `SELECT 'asin-notification:'||n.id AS source_key,'asin.change' AS type,
        CASE WHEN e.severity='important' THEN 'important' ELSE 'info' END AS severity,n.title,
        t.asin||' · 字段：'||e.field||' · 状态：'||e.status||' · 具体变化见商品监控证据。' AS body,
        jsonb_build_object('kind','asin_event','id',e.id) AS object_ref,e.window_end AS occurred_at
        FROM asin_notifications n JOIN asin_events e ON e.id=n.event_id JOIN asin_targets t ON t.id=n.target_id,north_integration_state s
        WHERE n.created_at>=s.enabled_at AND e.status NOT IN ('ignored','transient')
        AND NOT EXISTS(SELECT 1 FROM north_events x WHERE x.source_key='asin-notification:'||n.id) ORDER BY n.created_at LIMIT 100`,
      `SELECT 'asin-run:'||r.id AS source_key,'asin.job.failed' AS type,'important' AS severity,'商品采集未完成' AS title,
        t.asin||' · 模块：'||r.module||' · 状态：'||r.state||' · 请检查商品监控的任务记录。' AS body,
        jsonb_build_object('kind','asin_job','id',r.id) AS object_ref,r.finished_at AS occurred_at
        FROM asin_runs r JOIN asin_targets t ON t.id=r.target_id,north_integration_state s
        WHERE r.finished_at>=s.enabled_at AND r.state IN ('failed','blocked')
        AND NOT EXISTS(SELECT 1 FROM north_events e WHERE e.source_key='asin-run:'||r.id) ORDER BY r.finished_at LIMIT 100`
    ];
    let count=0;
    for(const sql of queries){const {rows}=await c.query(sql);for(const {source_key,...event}of rows){
      await insertEvent(c,{source_key,actor_id:'system',event,notify:config.configured&&config.policy==='important'&&event.severity!=='info',destination:config.chatId});count++;
    }}
    await c.query('UPDATE north_integration_state SET heartbeat_at=now(),last_error=NULL WHERE id=1');return count;
  });
}
