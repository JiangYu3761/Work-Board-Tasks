import {readFile} from 'node:fs/promises';
import {integrationStatus,cursor} from './api.mjs';
import {routes,openapi} from './contract.mjs';
import {boundedInt,fail,jsonBody} from './common.mjs';
import {publicEvent,eventInput} from './events.mjs';
import {formatMessage} from './feishu.mjs';

// Trusted local UI only, behind the server's loopback Host / Origin checks.
// This namespace cannot issue tokens, publish events, change config or send messages.
export async function integrationsConsole(req,url,db,send,res) {
  if(!url.pathname.startsWith('/api/integrations/'))return false;
  const route=url.pathname.slice('/api/integrations/'.length),reply=(data,status=200)=>{send(res,status,data);return true;};
  if(req.headers['sec-fetch-site']==='cross-site')fail(403,'FORBIDDEN','请从本机工作台打开');
  if(route==='preview'&&req.method==='POST'){
    if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']||''))fail(415,'UNSUPPORTED_MEDIA_TYPE','请提交 JSON 内容');
    const input=await jsonBody(req);if(input.notify===true)fail(400,'PREVIEW_ONLY','此界面仅用于预览');
    const event=eventInput({...input,notify:false});event.occurred_at??=new Date().toISOString();
    return reply({dry_run:true,message:formatMessage(event),event,delivery_created:false});
  }
  if(req.method!=='GET')return reply({error:'此界面不支持该操作'},405);
  if(route==='overview'){
    const [status,events,agents,audit]=await Promise.all([
      integrationStatus(db),
      db.query("SELECT count(*)::int AS total,count(*) FILTER(WHERE created_at>=now()-interval '24 hours')::int AS last_24h FROM north_events"),
      db.query("SELECT t.id,t.name,t.scopes,t.created_at,t.expires_at,t.revoked_at,CASE WHEN t.revoked_at IS NOT NULL THEN 'revoked' WHEN t.expires_at<=now() THEN 'expired' ELSE 'active' END AS state,(SELECT max(a.created_at) FROM north_api_audit a WHERE a.token_id=t.id) AS last_used_at FROM north_api_tokens t ORDER BY t.created_at DESC"),
      db.query("SELECT count(*)::int AS requests,count(*) FILTER(WHERE status>=400)::int AS errors FROM north_api_audit WHERE created_at>=now()-interval '24 hours'")
    ]);
    return reply({...status,api:{version:'v1',operation_count:routes.length,base_path:'/api/v1',access:'local'},events:events.rows[0],agents:agents.rows,audit:audit.rows[0],as_of:new Date().toISOString()});
  }
  if(route==='catalog')return reply({operations:routes.map(({pattern,...r})=>({...r,path:'/api/v1'+r.path})),openapi:openapi()});
  if(route==='openapi.json'){
    res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Content-Disposition':'attachment; filename="north-openapi-v1.json"','Cache-Control':'no-store'});res.end(JSON.stringify(openapi(),null,2));return true;
  }
  const documents={'docs/agent':'AGENT_API.md','docs/design':'外部通道与API需求设计.md','docs/verification':'外部通道验收.md'};
  if(documents[route]){
    const content=await readFile(new URL('../../docs/'+documents[route],import.meta.url));
    res.writeHead(200,{'Content-Type':'text/markdown; charset=utf-8','Content-Disposition':`attachment; filename="north-${route.split('/')[1]}.md"`,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(content);return true;
  }
  const q=(url.searchParams.get('q')||'').trim().slice(0,120),search=q?'%'+q.replace(/[\\%_]/g,'\\$&')+'%':null;
  const limit=boundedInt(url.searchParams.get('limit'),30,1,100);
  if(route==='events'){
    const severity=url.searchParams.get('severity')||null,before=url.searchParams.get('before');
    if(severity&&!['info','important','critical'].includes(severity))fail(400,'INVALID_INPUT','事件级别无效');
    if(before)cursor(before);
    const rows=(await db.query(`SELECT * FROM north_events WHERE ($1::bigint IS NULL OR id<$1) AND ($2::text IS NULL OR severity=$2) AND ($3::text IS NULL OR concat_ws(' ',title,body,type,id::text) ILIKE $3) ORDER BY id DESC LIMIT $4`,[before,severity,search,limit+1])).rows;
    const items=rows.slice(0,limit).map(publicEvent);return reply({items,has_more:rows.length>limit,next_cursor:items.at(-1)?.id||null});
  }
  if(route==='deliveries'){
    const state=url.searchParams.get('state')||null,before=url.searchParams.get('before');
    if(state&&!['queued','sending','sent','failed','uncertain','cancelled'].includes(state))fail(400,'INVALID_INPUT','投递状态无效');
    if(before&&(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(before)||!(await db.query('SELECT 1 FROM north_deliveries WHERE id=$1',[before])).rowCount))fail(400,'INVALID_CURSOR','投递游标无效');
    const rows=(await db.query(`SELECT d.id,d.event_id,d.state,d.attempts,d.provider_message_id,d.last_error,d.created_at,d.updated_at,e.title,e.body,e.type,e.severity FROM north_deliveries d JOIN north_events e ON e.id=d.event_id WHERE ($1::text IS NULL OR d.state=$1) AND ($2::uuid IS NULL OR (d.created_at,d.id)<(SELECT created_at,id FROM north_deliveries WHERE id=$2)) AND ($3::text IS NULL OR concat_ws(' ',e.title,e.body,e.type,d.id::text) ILIKE $3) ORDER BY d.created_at DESC,d.id DESC LIMIT $4`,[state,before,search,limit+1])).rows;
    const items=rows.slice(0,limit);return reply({items,has_more:rows.length>limit,next_cursor:items.at(-1)?.id||null});
  }
  return reply({error:'接口不存在'},404);
}
