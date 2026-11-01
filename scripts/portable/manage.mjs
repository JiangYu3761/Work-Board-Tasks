import {spawn,execFileSync} from 'node:child_process';
import {mkdir,readFile,writeFile,rm,access,chmod,readdir,rename} from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import {randomBytes,createHash} from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {packageRoot as ROOT,verify} from './integrity.mjs';

const APP=path.join(ROOT,'app'),STATE=path.join(ROOT,'.state'),PG=path.join(ROOT,'runtime/postgres/bin'),DATA=path.join(STATE,'postgres'),LOCK=path.join(STATE,'launch-lock');
const require=createRequire(path.join(APP,'package.json')),pg=require('pg');
const readJSON=async file=>JSON.parse(await readFile(file,'utf8'));
const exists=async file=>{try{await access(file);return true;}catch{return false;}};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const save=async(file,value)=>{await writeFile(file+'.tmp',JSON.stringify(value,null,2)+'\n',{mode:0o600});await rename(file+'.tmp',file);};
function owned(pid){
  if(!Number.isInteger(pid)||pid<2)return false;
  try{return execFileSync('/bin/ps',['-p',String(pid),'-o','command='],{encoding:'utf8'}).includes(path.join(ROOT,'support/manage.mjs')+' start');}catch{return false;}
}
async function run(file,args,env=process.env){
  return new Promise((resolve,reject)=>{
    const child=spawn(file,args,{env,cwd:ROOT,stdio:['ignore','pipe','pipe']});let output='';
    child.stdout.on('data',b=>{output=(output+b).slice(-10000);});child.stderr.on('data',b=>{output=(output+b).slice(-10000);});
    child.on('error',reject);child.on('exit',code=>code===0?resolve(output):reject(Error(path.basename(file)+' 退出 '+code+'\n'+output)));
  });
}
async function portFree(port){return new Promise(resolve=>{const s=net.createServer();s.once('error',()=>resolve(false));s.listen(port,'127.0.0.1',()=>s.close(()=>resolve(true)));});}
async function freePort(start){for(let p=start;p<start+40;p++)if(await portFree(p))return p;throw Error('没有可用的本机端口，请关闭其他北向副本后重试');}
async function openBrowser(url){if(process.env.NORTH_NO_OPEN!=='1')spawn('/usr/bin/open',[url],{stdio:'ignore'}).on('error',()=>{});}
async function stop(){
  const state=await readJSON(path.join(STATE,'running.json')).catch(()=>null);
  if(!state||!owned(state.pid)){console.log('这个迁移包当前未运行。');return;}
  process.kill(state.pid,'SIGTERM');
  for(let i=0;i<120;i++){if(!owned(state.pid)){console.log('北向和随包数据库已停止。');return;}await sleep(250);}
  throw Error('停止仍在进行，请查看运行窗口和 .state/logs，不要强行拔出存储设备');
}
async function start(){
  if(process.platform!=='darwin'||process.arch!=='arm64')throw Error('此包适用于 Apple 芯片 Mac。请使用对应 Windows / Intel 版本。');
  const version=execFileSync('/usr/bin/sw_vers',['-productVersion'],{encoding:'utf8'}).trim();
  if(Number(version.split('.')[0])<14)throw Error('此离线版本要求 macOS 14 或以上。');
  await mkdir(STATE,{recursive:true,mode:0o700});await chmod(STATE,0o700);
  const running=await readJSON(path.join(STATE,'running.json')).catch(()=>null);
  if(running&&owned(running.pid)){console.log('本包已经运行：'+running.url);await openBrowser(running.url);return;}
  try{await mkdir(LOCK,{mode:0o700});}catch(e){
    if(e.code!=='EEXIST')throw e;
    const lock=await readJSON(path.join(LOCK,'owner.json')).catch(()=>null);
    if(!lock||owned(lock.pid))throw Error('另一个启动正在进行；如果已异常中断，请删除本包 .state/launch-lock 后重试。');
    await rm(LOCK,{recursive:true});await mkdir(LOCK,{mode:0o700});
  }
  await save(path.join(LOCK,'owner.json'),{pid:process.pid});
  let child=null,dbStarted=false,stopping=false,dbEnv;
  const cleanup=async()=>{
    if(stopping)return;stopping=true;
    if(child&&child.exitCode===null){child.kill('SIGTERM');for(let i=0;i<100&&child.exitCode===null;i++)await sleep(200);if(child.exitCode===null)child.kill('SIGKILL');}
    if(dbStarted)await run(path.join(PG,'pg_ctl'),['-D',DATA,'-m','fast','-w','stop'],dbEnv).catch(e=>console.error(e.message));
    await rm(path.join(STATE,'running.json'),{force:true});await rm(LOCK,{recursive:true,force:true});
  };
  process.once('SIGTERM',()=>cleanup().then(()=>process.exit(0)));process.once('SIGINT',()=>cleanup().then(()=>process.exit(0)));
  try{
    if(!await exists(path.join(STATE,'verified.json'))){console.log('检查迁移包完整性…');const result=await verify();await save(path.join(STATE,'verified.json'),{...result,at:new Date().toISOString()});console.log('完整性校验通过：'+result.checked+' 个文件。');}
    await mkdir(path.join(STATE,'logs'),{recursive:true});
    let cfg=await readJSON(path.join(STATE,'config.json')).catch(()=>null);
    if(!cfg){cfg={password:randomBytes(32).toString('base64url'),database:'personal_radar',user:'north'};await save(path.join(STATE,'config.json'),cfg);}
    cfg.httpPort=await freePort(Number(process.env.NORTH_PORT)||cfg.httpPort||4317);
    // Only ever manage this package's cluster, never the computer's existing database.
    const postgresRunning=await run(path.join(PG,'pg_ctl'),['-D',DATA,'status']).then(()=>true).catch(()=>false);
    cfg.pgPort=postgresRunning?cfg.pgPort:await freePort(Number(process.env.NORTH_PGPORT)||cfg.pgPort||55432);
    if(!cfg.pgPort)throw Error('数据库端口状态无效，请先停止旧迁移实例');
    await save(path.join(STATE,'config.json'),cfg);
    dbEnv={...process.env,PGHOST:'127.0.0.1',PGPORT:String(cfg.pgPort),PGUSER:cfg.user,PGPASSWORD:cfg.password,PGDATABASE:cfg.database};
    if(!await exists(path.join(DATA,'PG_VERSION'))){
      console.log('首次启动：创建独立数据库…');const pw=path.join(STATE,'init-password');await writeFile(pw,cfg.password+'\n',{mode:0o600});
      try{await run(path.join(PG,'initdb'),['-D',DATA,'-U',cfg.user,'--pwfile',pw,'--auth-local=trust','--auth-host=scram-sha-256','--encoding=UTF8','--locale=C'],dbEnv);}finally{await rm(pw,{force:true});}
    }
    const socket=path.join(os.tmpdir(),'north-'+createHash('sha256').update(ROOT).digest('hex').slice(0,16));await mkdir(socket,{recursive:true,mode:0o700});await chmod(socket,0o700);
    if(!postgresRunning)await run(path.join(PG,'pg_ctl'),['-D',DATA,'-l',path.join(STATE,'logs/postgres.log'),'-o',`-h 127.0.0.1 -p ${cfg.pgPort} -k ${socket}`,'-w','start'],dbEnv);
    dbStarted=true;
    const admin=new pg.Client({host:'127.0.0.1',port:cfg.pgPort,user:cfg.user,password:cfg.password,database:'postgres'});await admin.connect();
    try{
      const present=(await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[cfg.database])).rowCount;
      if(!present)await admin.query('CREATE DATABASE personal_radar');
    }finally{await admin.end();}
    if(!await exists(path.join(STATE,'restored.json'))){
      const check=new pg.Client({host:'127.0.0.1',port:cfg.pgPort,user:cfg.user,password:cfg.password,database:cfg.database});await check.connect();
      let tables;try{tables=Number((await check.query("SELECT count(*) AS n FROM pg_tables WHERE schemaname='public'")).rows[0].n);}finally{await check.end();}
      if(tables)throw Error('数据库已有内容但缺少还原完成标记。为避免覆盖，已停止；请保留 .state 并检查日志。');
      console.log('首次启动：还原全部业务数据…');
      await run(path.join(PG,'pg_restore'),['--no-owner','--no-acl','--exit-on-error','--single-transaction','-d',cfg.database,path.join(ROOT,'backup/database.dump')],dbEnv);
      const db=new pg.Client({host:'127.0.0.1',port:cfg.pgPort,user:cfg.user,password:cfg.password,database:cfg.database});await db.connect();
      try{
        const expected=await readJSON(path.join(ROOT,'backup/database-inventory.json'));
        for(const [table,n] of Object.entries(expected.tables)){if(!/^[a-z_]+$/.test(table))throw Error('表名无效');const actual=Number((await db.query('SELECT count(*) AS n FROM "'+table+'"')).rows[0].n);if(actual!==n)throw Error('数据数量校验失败：'+table);}
      }finally{await db.end();}
      await save(path.join(STATE,'restored.json'),{at:new Date().toISOString()});
    }
    const db=new pg.Client({host:'127.0.0.1',port:cfg.pgPort,user:cfg.user,password:cfg.password,database:cfg.database});await db.connect();
    try{
      const rows=(await db.query('SELECT id,path,sha256 FROM asin_evidence')).rows;
      for(const r of rows){const file=path.join(APP,'.runtime/asin-evidence',r.id);if(!await exists(file))throw Error('缺少商品证据文件：'+r.id);if(r.path!==file)await db.query('UPDATE asin_evidence SET path=$1 WHERE id=$2',[file,r.id]);}
    }finally{await db.end();}
    const custom=await readFile(path.join(ROOT,'settings.env'),'utf8');
    const chrome=path.join(ROOT,'runtime/browsers/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
    const managed={...Object.fromEntries(['PGHOST','PGPORT','PGUSER','PGPASSWORD','PGDATABASE'].map(k=>[k,dbEnv[k]])),PORT:String(cfg.httpPort),PLAYWRIGHT_BROWSERS_PATH:path.join(ROOT,'runtime/browsers'),SEARCH_CHROMIUM_PATH:chrome,ASIN_CHROMIUM_PATH:chrome};
    const text=custom.split('\n').filter(line=>!Object.keys(managed).some(k=>line.startsWith(k+'='))).join('\n')+'\n'+Object.entries(managed).map(([k,v])=>k+'='+JSON.stringify(v)).join('\n')+'\n';
    await writeFile(path.join(APP,'.env'),text,{mode:0o600});await chmod(path.join(APP,'.env'),0o600);
    const url='http://127.0.0.1:'+cfg.httpPort;
    for(const name of await readdir(path.join(APP,'.runtime/integrations')).catch(()=>[])){
      if(!name.endsWith('.json'))continue;const file=path.join(APP,'.runtime/integrations',name),config=await readJSON(file).catch(()=>null);
      if(config?.token&&config.base_url&&/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(config.base_url)){config.base_url=url;await save(file,config);}
    }
    const appEnv={...process.env,...managed};
    if(process.env.NORTH_VERIFY_MODE==='1')Object.assign(appEnv,{ASIN_WORKER_DISABLED:'1',SEARCH_WORKER_DISABLED:'1',NORTH_INTEGRATION_WORKER_DISABLED:'1'});
    // Configuration comes from this package, not unrelated shell PG/Feishu settings.
    for(const k of Object.keys(appEnv))if(k.startsWith('NORTH_FEISHU_')||k.startsWith('SUMMARY_'))delete appEnv[k];
    child=spawn(process.execPath,['--env-file=.env','server.mjs'],{cwd:APP,env:appEnv,stdio:['ignore','pipe','pipe']});
    const log=createWriteStream(path.join(STATE,'logs/server.log'),{flags:'a'});child.stdout.pipe(log,{end:false});child.stderr.pipe(log,{end:false});
    let spawnError;child.on('error',e=>{spawnError=e;});
    let healthy=false;for(let i=0;i<120;i++){
      if(spawnError)throw spawnError;if(child.exitCode!==null)throw Error('北向服务启动失败，请查看 .state/logs/server.log');
      try{const r=await fetch(url+'/api/health',{signal:AbortSignal.timeout(1000)});if(r.ok&&(await r.json()).ok){healthy=true;break;}}catch{}await sleep(250);
    }
    if(!healthy)throw Error('服务未能完成启动，请查看 .state/logs/server.log');
    await save(path.join(STATE,'running.json'),{pid:process.pid,server_pid:child.pid,url,started_at:new Date().toISOString()});
    console.log('\n北向已经启动：'+url+'\n数据库和图片已还原。请保持此窗口打开；按 Control+C 或双击“停止北向”退出。');
    await openBrowser(url);
    await new Promise((resolve,reject)=>{child.once('exit',code=>code===0||stopping?resolve():reject(Error('服务意外退出：'+code)));});log.end();
  }finally{await cleanup();}
}
try{if(process.argv[2]==='stop')await stop();else if(process.argv[2]==='start')await start();else throw Error('用法：manage.mjs start | stop');}
catch(e){console.error('\n启动 / 停止失败：'+e.message);process.exitCode=1;}
