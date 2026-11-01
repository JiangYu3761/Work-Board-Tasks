import {spawn} from 'node:child_process';
import {access} from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {fail} from './common.mjs';

export function channelConfig(env=process.env) {
  const enabled=env.NORTH_FEISHU_ENABLED==='1',executable=env.NORTH_FEISHU_CLI||'',chatId=env.NORTH_FEISHU_CHAT_ID||'';
  const policy=env.NORTH_NOTIFY_POLICY||'important';
  return {enabled,executable,chatId,policy,configured:enabled&&path.isAbsolute(executable)&&/^oc_[A-Za-z0-9_-]+$/.test(chatId)&&['important','manual'].includes(policy)};
}
export function formatMessage(event) {
  return [`北向 NORTH · ${{info:'信息',important:'重要',critical:'紧急'}[event.severity]||event.severity}`,event.title,event.body,
    `事件：${event.id||'预览'} · ${event.type}`,`观察时间：${new Date(event.occurred_at).toISOString()}`,
    event.object_ref?.kind?`对象：${event.object_ref.kind} / ${event.object_ref.id||''}`:''].filter(Boolean).join('\n');
}
export async function assertChannel(config=channelConfig()) {
  if(!config.configured)fail(409,'CHANNEL_NOT_CONFIGURED','飞书通道未启用或缺少绝对 CLI 路径、群 ID；可先预览或发布不通知的事件');
  try{await access(config.executable,constants.X_OK);}catch{fail(409,'CLI_NOT_AVAILABLE','飞书 CLI 不存在或不可执行');}
}
export function commandFor(delivery,event,config) {
  // No shell, no caller-supplied flags, no remote control of executable or recipient.
  return {file:config.executable,args:['im','+messages-send','--as','bot','--chat-id',delivery.destination,'--text',formatMessage(event),'--idempotency-key',delivery.id,'--format','json']};
}
export function decodeResult({code,stdout,timedOut,spawnError,overflow}) {
  if(spawnError)return {state:'failed',error:'CLI_START_FAILED'};
  if(timedOut||overflow)return {state:'uncertain',error:timedOut?'CLI_TIMEOUT':'CLI_OUTPUT_LIMIT'};
  let result;try{result=JSON.parse(stdout);}catch{return {state:'uncertain',error:'UNRECOGNIZED_CLI_OUTPUT'};}
  const messageId=result?.data?.message_id||result?.message_id;
  if(code===0&&result?.ok===true&&typeof messageId==='string'&&messageId)return {state:'sent',message_id:messageId};
  // A provider/network error may follow a successful send. Never blindly retry it.
  return {state:'uncertain',error:code===10?'CLI_APPROVAL_REQUIRED':'CLI_RESULT_REQUIRES_REVIEW'};
}
export async function deliverFeishu(delivery,event,config=channelConfig(),{spawnFn=spawn,timeoutMs=40000}={}) {
  try{await assertChannel(config);}catch(e){return {state:'failed',error:e.code};}
  if(delivery.destination!==config.chatId)return {state:'failed',error:'DESTINATION_CHANGED'};
  const {file,args}=commandFor(delivery,event,config);
  return new Promise(resolve=>{
    let child,stdout='',size=0,timedOut=false,overflow=false,spawnError=false,done=false;
    const finish=code=>{if(done)return;done=true;clearTimeout(timer);resolve(decodeResult({code,stdout,timedOut,spawnError,overflow}));};
    const timer=setTimeout(()=>{timedOut=true;child?.kill('SIGKILL');},timeoutMs);
    try{child=spawnFn(file,args,{shell:false,stdio:['ignore','pipe','pipe']});}catch{spawnError=true;finish(null);return;}
    child.on('error',()=>{spawnError=true;finish(null);});
    child.stdout.on('data',b=>{size+=b.length;if(size>65536){overflow=true;child.kill('SIGKILL');}else stdout+=b;});
    // Drain stderr but do not persist authentication details or raw provider output.
    child.stderr.on('data',b=>{size+=b.length;if(size>65536){overflow=true;child.kill('SIGKILL');}});
    child.on('close',finish);
  });
}
