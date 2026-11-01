#!/usr/bin/env node
import {readFile,writeFile,mkdir,unlink} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const defaultConfig=path.join(ROOT,'.runtime/integrations/north.json');
const print=value=>process.stdout.write(JSON.stringify(value,null,2)+'\n');
const help=`NORTH CLI — stdout 为 JSON，错误写入 stderr，失败退出码为 1。

node bin/north.mjs doctor | capabilities | openapi
node bin/north.mjs request GET /search/overview
node bin/north.mjs request POST /search/monitors/UUID/run --json '{}'
node bin/north.mjs search overview | show UUID | run UUID
node bin/north.mjs search ranks --monitor UUID --asin ASIN --days 30
node bin/north.mjs asin list | show UUID | check UUID
node bin/north.mjs competitors list | show ID
node bin/north.mjs news list --q 搜索文本
node bin/north.mjs events list --after 0 --limit 50
node bin/north.mjs events publish --file event.json --key stable-business-key
node bin/north.mjs notify preview --file event.json
node bin/north.mjs notify send --file event.json --key stable-business-key
node bin/north.mjs notifications list --state uncertain
node bin/north.mjs notifications retry UUID
node bin/north.mjs notifications resolve UUID --file resolution.json

通用参数：--config 凭证JSON路径；--base-url 地址；--output 文件路径（图片/CSV 必填）。
请求体：--json JSON、--file 文件、--stdin 三选一。notify send 才请求实际通知。
本机管理员：auth create --name agent-name --scopes search:read,events:read --out 私密凭证文件
              auth list | auth revoke TOKEN_UUID
auth create 默认所有 read 权限、90 天；--scopes all 为全部业务权限；凭证只写文件、不打印。
新 Agent 先读 docs/AGENT_API.md；本命令可从任意目录调用。`;

function endpointBase(value){
  const u=new URL(value);
  if(u.username||u.password||u.search||u.hash||!['http:','https:'].includes(u.protocol)||u.pathname!=='/')throw new Error('base-url 必须是无路径、无凭证的 HTTP(S) origin');
  if(u.protocol==='http:'&&!['127.0.0.1','localhost','[::1]'].includes(u.hostname))throw new Error('远程连接必须使用 HTTPS；本机或 SSH 隧道可用 HTTP');
  return u.origin;
}
async function inputBody(options){
  if([options.json!==undefined,!!options.file,!!options.stdin].filter(Boolean).length>1)throw new Error('--json、--file、--stdin 只能使用一个');
  let text=options.json;
  if(options.file)text=await readFile(options.file,'utf8');
  if(options.stdin){text='';for await(const c of process.stdin){text+=c;if(Buffer.byteLength(text)>4*1024*1024)throw new Error('输入超过 4 MB');}}
  const value=text===undefined?{}:JSON.parse(text);
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('输入必须是 JSON 对象');return value;
}
async function localAuth(args,o){
  try{process.loadEnvFile(path.join(ROOT,'.env'));}catch(e){if(e.code!=='ENOENT')throw e;}
  const {pool}=await import('../lib/db.mjs'),{externalSchema}=await import('../lib/external/schema.mjs'),{createToken}=await import('../lib/external/auth.mjs'),{SCOPES}=await import('../lib/external/common.mjs');
  try{
    await externalSchema(pool);
    if(args[0]==='list'){print({tokens:(await pool.query('SELECT id,name,scopes,created_at,expires_at,revoked_at FROM north_api_tokens ORDER BY created_at DESC')).rows});return;}
    if(args[0]==='revoke'){
      if(!/^[a-f0-9-]{36}$/i.test(args[1]||''))throw new Error('需要有效的 Token UUID');
      const r=await pool.query('UPDATE north_api_tokens SET revoked_at=now() WHERE id=$1 RETURNING id,name,revoked_at',[args[1]]);if(!r.rowCount)throw new Error('凭证不存在');print(r.rows[0]);return;
    }
    if(args[0]!=='create'||!o.name||!o.out)throw new Error('用法：auth create --name 名称 --out 文件 [--scopes 权限列表]');
    const base_url=endpointBase(o['base-url']||`http://127.0.0.1:${process.env.PORT||4317}`),out=path.resolve(o.out);
    const scopes=o.scopes==='all'?SCOPES:o.scopes?o.scopes.split(','):SCOPES.filter(s=>s.endsWith(':read'));
    await mkdir(path.dirname(out),{recursive:true,mode:0o700});
    // Reserve the file first; never overwrite an existing credential or follow a symlink.
    await writeFile(out,'',{flag:'wx',mode:0o600});
    let created;
    try{created=await createToken(pool,{name:o.name,scopes,days:o.days||90});await writeFile(out,JSON.stringify({base_url,token:created.token},null,2)+'\n',{mode:0o600});}
    catch(e){if(created)await pool.query('DELETE FROM north_api_tokens WHERE id=$1',[created.id]);await unlink(out);throw e;}
    const {token,...metadata}=created;print({...metadata,config_file:out});
  }finally{await pool.end();}
}
async function main(){
  const {positionals:a,values:o}=parseArgs({allowPositionals:true,options:Object.fromEntries([
    ...['config','base-url','output','json','file','key','after','before','limit','type','state','monitor','asin','days','q','name','scopes','out'].map(n=>[n,{type:'string'}]),
    ['stdin',{type:'boolean'}],['help',{type:'boolean'}]
  ])});
  if(o.help||!a.length||a[0]==='help'){process.stdout.write(help+'\n');return;}
  if(a[0]==='auth')return localAuth(a.slice(1),o);
  let config;try{config=JSON.parse(await readFile(o.config||process.env.NORTH_CONFIG||defaultConfig,'utf8'));}catch{throw new Error('无法读取 CLI 凭证配置；先使用 auth create，或指定 --config / NORTH_CONFIG');}
  const base=endpointBase(o['base-url']||config.base_url||'http://127.0.0.1:4317');
  if(typeof config.token!=='string'||!/^north_[A-Za-z0-9_-]{43}$/.test(config.token))throw new Error('凭证配置格式无效');
  let method='GET',endpoint,data;
  if(a[0]==='doctor')endpoint='/integration-status';
  else if(a[0]==='capabilities')endpoint='/capabilities';
  else if(a[0]==='openapi')endpoint='/openapi.json';
  else if(a[0]==='request'){method=(a[1]||'').toUpperCase();endpoint=a[2];if(!['GET','POST'].includes(method))throw new Error('仅支持 GET 和 POST');}
  else if(a[0]==='search'){
    if(a[1]==='overview')endpoint='/search/overview';
    else if(a[1]==='show')endpoint='/search/monitors/'+encodeURIComponent(a[2]||'');
    else if(a[1]==='run'){endpoint='/search/monitors/'+encodeURIComponent(a[2]||'')+'/run';method='POST';}
    else if(a[1]==='ranks')endpoint='/search/ranks?'+new URLSearchParams({monitor:o.monitor||'',asin:o.asin||'',days:o.days||'30'});
  }else if(a[0]==='asin'){
    if(a[1]==='list')endpoint='/asin-monitors';
    else if(a[1]==='show'||a[1]==='check'){endpoint='/asin-monitors/'+encodeURIComponent(a[2]||'')+(a[1]==='check'?'/check':'');if(a[1]==='check')method='POST';}
  }else if(a[0]==='competitors'){
    if(a[1]==='list')endpoint='/competitors';else if(a[1]==='show')endpoint='/competitors/'+encodeURIComponent(a[2]||'');
  }else if(a[0]==='news'&&a[1]==='list')endpoint='/articles?'+new URLSearchParams({q:o.q||''});
  else if(a[0]==='events'){
    if(a[1]==='list')endpoint='/events?'+new URLSearchParams({after:o.after||'0',limit:o.limit||'50',...(o.type?{type:o.type}:{})});
    else if(a[1]==='publish'){endpoint='/events';method='POST';}
  }else if(a[0]==='notify'&&['preview','send'].includes(a[1])){
    endpoint=a[1]==='preview'?'/notifications/preview':'/events';method='POST';data={...await inputBody(o),notify:a[1]==='send'};
  }else if(a[0]==='notifications'){
    if(a[1]==='list')endpoint='/notifications?'+new URLSearchParams({limit:o.limit||'50',...(o.state?{state:o.state}:{}),...(o.before?{before:o.before}:{})});
    else if(['retry','resolve'].includes(a[1])){endpoint='/notifications/'+encodeURIComponent(a[2]||'')+'/'+a[1];method='POST';}
  }
  if(!endpoint)throw new Error('未知命令；运行 north --help 查看用法');
  endpoint=endpoint.replace(/^\/api\/v1(?=\/)/,'');
  if(!endpoint.startsWith('/')||endpoint.startsWith('//')||endpoint.includes('#'))throw new Error('接口路径必须是 /search/... 等站内路径');
  const url=new URL('/api/v1'+endpoint,base);if(url.origin!==base||!url.pathname.startsWith('/api/v1/'))throw new Error('只允许调用 /api/v1/ 接口');
  if(method==='POST')data??=await inputBody(o);
  if(method==='POST'&&url.pathname==='/api/v1/events'&&!o.key)throw new Error('发布事件需使用 --key 提供稳定业务幂等键；重试沿用同一键');
  const headers={Authorization:'Bearer '+config.token,...(method==='POST'?{'Content-Type':'application/json'}:{}),...(o.key?{'Idempotency-Key':o.key}:{})};
  let response;try{response=await fetch(url,{method,headers,body:method==='POST'?JSON.stringify(data):undefined,redirect:'manual',signal:AbortSignal.timeout(60000)});}catch{throw new Error('连接失败或超时；写操作的结果可能尚未确定，请查询任务/事件状态后再决定是否重试');}
  if(response.status>=300&&response.status<400)throw new Error('拒绝 HTTP 跳转；请检查 base-url 配置');
  const media=response.headers.get('content-type')||'';
  if(!response.ok){let error;try{error=(await response.json()).error;}catch{}throw Object.assign(new Error(error?.message||'API 请求失败'),{api:{status:response.status,...error}});}
  if(o.output){await writeFile(o.output,Buffer.from(await response.arrayBuffer()),{flag:'wx',mode:0o600});print({output:path.resolve(o.output),content_type:media});}
  else if(media.includes('application/json'))print(await response.json());
  else throw new Error('此接口返回文件，请使用 --output 路径保存（不会覆盖已有文件）');
}
main().catch(e=>{process.stderr.write(JSON.stringify({error:e.api||{code:'CLI_ERROR',message:e.message}})+'\n');process.exitCode=1;});
