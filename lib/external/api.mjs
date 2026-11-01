import {randomUUID} from 'node:crypto';
import {access} from 'node:fs/promises';
import {constants} from 'node:fs';
import {authenticate,rateLimit} from './auth.mjs';
import {routes,matchRoute,capabilities,openapi} from './contract.mjs';
import {fail,jsonBody,boundedInt,textField} from './common.mjs';
import {eventInput,publishEvent,publicEvent} from './events.mjs';
import {channelConfig,formatMessage} from './feishu.mjs';

export function externalError(status,data,requestId) {
  const defaults={400:'INVALID_INPUT',401:'UNAUTHORIZED',403:'FORBIDDEN',404:'NOT_FOUND',405:'METHOD_NOT_ALLOWED',409:'CONFLICT',413:'BODY_TOO_LARGE',415:'UNSUPPORTED_MEDIA_TYPE',429:'RATE_LIMITED',500:'INTERNAL_ERROR'};
  return {error:{code:data.code||defaults[status]||'REQUEST_FAILED',message:typeof data.error==='string'?data.error:'请求未完成',request_id:requestId},request_id:requestId};
}
const uuid=value=>{if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value||''))fail(400,'INVALID_INPUT','ID 必须为 UUID');return value;};
export function cursor(value,fallback='0') {
  const v=value??fallback;if(!/^\d{1,19}$/.test(v)||BigInt(v)>9223372036854775807n)fail(400,'INVALID_CURSOR','游标必须为有效的十进制字符串');return v;
}
export async function integrationStatus(db) {
  const config=channelConfig();let executableAvailable=false;
  if(config.executable)try{await access(config.executable,constants.X_OK);executableAvailable=true;}catch{}
  const [state,counts]=await Promise.all([db.query('SELECT * FROM north_integration_state WHERE id=1'),db.query('SELECT state,count(*)::int AS count FROM north_deliveries GROUP BY state')]);
  return {feishu:{enabled:config.enabled,configured:config.configured,executable_available:executableAvailable,recipient_configured:!!config.chatId,identity:'bot',policy:config.policy,authentication:'由本地 lark-cli 管理，未在此接口验证'},worker:state.rows[0],deliveries:counts.rows};
}
export function prepareExternal(req,res,db,url) {
  if(!url.pathname.startsWith('/api/v1/')&&url.pathname!=='/api/v1')return;
  const context={requestId:randomUUID(),path:url.pathname,actor:null};res.external=context;
  res.setHeader('X-Request-Id',context.requestId);res.setHeader('X-North-API-Version','v1');
  res.setHeader('Cache-Control','no-store');
  res.once('finish',()=>{
    db.query('INSERT INTO north_api_audit(request_id,token_id,method,route,status) VALUES($1,$2,$3,$4,$5)',[context.requestId,context.actor?.id||null,req.method,context.route?.path||'/unmatched',res.statusCode]).catch(()=>console.error('API audit write failed'));
  });
}
export async function externalGate(req,res,url,db,send) {
  if(!res.external)return false;
  const actor=await authenticate(db,req.headers.authorization);res.external.actor=actor;
  const path=url.pathname.slice('/api/v1'.length),route=matchRoute(req.method,path);res.external.route=route;
  rateLimit(actor,req.method);
  if(!route)fail(routes.some(r=>r.pattern.test(path))?405:404,'ROUTE_NOT_AVAILABLE','接口或请求方法不存在');
  if(route.scope&&!actor.scopes.includes(route.scope))fail(403,'FORBIDDEN',`需要 ${route.scope} 权限`);
  if(req.method==='POST'&&!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']||''))fail(415,'UNSUPPORTED_MEDIA_TYPE','写请求需使用 application/json');
  if(!route.native){url.pathname='/api'+path;return false;}
  const reply=(data,status=200)=>{send(res,status,data);return true;};
  if(path==='/health'){await db.query('SELECT 1');return reply({ok:true,api_version:'v1',database:'postgresql'});}
  if(path==='/capabilities')return reply(capabilities(actor));
  if(path==='/openapi.json')return reply(openapi());
  if(path==='/integration-status'){
    return reply(await integrationStatus(db));
  }
  if(path.startsWith('/jobs/')){
    const [, ,kind,id]=path.split('/'),table=kind==='search'?'search_jobs':'asin_runs';
    const job=(await db.query(`SELECT * FROM ${table} WHERE id=$1`,[uuid(id)])).rows[0];if(!job)fail(404,'NOT_FOUND','任务不存在');return reply({kind,job});
  }
  if(path==='/events'&&req.method==='POST'){
    const result=await publishEvent(db,actor,req.headers['idempotency-key'],await jsonBody(req));return reply(result,result.duplicate?200:201);
  }
  if(path==='/events'){
    const after=cursor(url.searchParams.get('after')),limit=boundedInt(url.searchParams.get('limit'),50,1,200),type=url.searchParams.get('type');
    const items=(await db.query('SELECT * FROM north_events WHERE id>$1::bigint AND ($2::text IS NULL OR type=$2) ORDER BY id LIMIT $3',[after,type,limit+1])).rows;
    const selected=items.slice(0,limit);return reply({items:selected.map(publicEvent),next_cursor:selected.at(-1)?.id||after,has_more:items.length>limit});
  }
  if(path==='/notifications/preview'){
    const event=eventInput(await jsonBody(req));event.occurred_at??=new Date().toISOString();return reply({dry_run:true,message:formatMessage(event),channel:'feishu',delivery_created:false});
  }
  if(path==='/notifications'){
    const state=url.searchParams.get('state'),limit=boundedInt(url.searchParams.get('limit'),50,1,200),before=url.searchParams.get('before');
    if(state&&!['queued','sending','sent','failed','uncertain','cancelled'].includes(state))fail(400,'INVALID_INPUT','发送状态无效');
    // Cursor is a delivery UUID; timestamp + UUID gives deterministic pagination.
    if(before){uuid(before);if(!(await db.query('SELECT 1 FROM north_deliveries WHERE id=$1',[before])).rowCount)fail(400,'INVALID_CURSOR','投递游标不存在');}
    const items=(await db.query(`SELECT d.id,d.event_id,d.channel,d.state,d.attempts,d.provider_message_id,d.last_error,d.created_at,d.updated_at,e.title FROM north_deliveries d JOIN north_events e ON e.id=d.event_id WHERE ($1::text IS NULL OR d.state=$1) AND ($2::uuid IS NULL OR (d.created_at,d.id)<(SELECT created_at,id FROM north_deliveries WHERE id=$2)) ORDER BY d.created_at DESC,d.id DESC LIMIT $3`,[state,before,limit+1])).rows;
    const selected=items.slice(0,limit);return reply({items:selected,next_cursor:selected.at(-1)?.id||null,has_more:items.length>limit});
  }
  const match=path.match(/^\/notifications\/([^/]+)\/(retry|resolve)$/);
  if(match){
    const id=uuid(match[1]),input=await jsonBody(req);let query,params;
    if(match[2]==='retry'){
      query="UPDATE north_deliveries SET state='queued',available_at=now(),last_error=NULL,updated_at=now() WHERE id=$1 AND state='failed' RETURNING id,state";params=[id];
    }else{
      const note=textField(input.note,'核查记录',500),action=input.action;
      if(!['cancel','confirmed_sent','confirmed_not_sent'].includes(action))fail(400,'INVALID_INPUT','action 应为 cancel、confirmed_sent 或 confirmed_not_sent');
      const next={cancel:'cancelled',confirmed_sent:'sent',confirmed_not_sent:'queued'}[action];
      const providerId=action==='confirmed_sent'?textField(input.provider_message_id,'飞书消息 ID',200):null;
      query="UPDATE north_deliveries SET state=$2,available_at=now(),last_error=$3,provider_message_id=COALESCE($4,provider_message_id),updated_at=now() WHERE id=$1 AND (state='uncertain' OR ($2='cancelled' AND state IN ('queued','failed'))) RETURNING id,state";
      params=[id,next,'MANUAL_REVIEW: '+note,providerId];
    }
    const row=(await db.query(query,params)).rows[0];if(!row)fail(409,'INVALID_DELIVERY_STATE','投递不存在或当前状态不允许此操作');return reply(row);
  }
  fail(404,'NOT_FOUND','接口不存在');
}
