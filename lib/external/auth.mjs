import {randomBytes,randomUUID} from 'node:crypto';
import {digest,SCOPES,fail,textField,boundedInt} from './common.mjs';

export async function createToken(db,{name,scopes,days=90}) {
  name=textField(name,'凭证名称',80);days=boundedInt(days,90,1,365);
  if(!Array.isArray(scopes)||!scopes.length||scopes.some(s=>!SCOPES.includes(s)))fail(400,'INVALID_SCOPE','授权范围无效');
  const token='north_'+randomBytes(32).toString('base64url'),id=randomUUID();
  const {rows}=await db.query(`INSERT INTO north_api_tokens(id,name,token_hash,scopes,expires_at) VALUES($1,$2,$3,$4,now()+($5::int*interval '1 day')) RETURNING id,name,scopes,expires_at`,[id,name,digest(token),[...new Set(scopes)],days]);
  return {...rows[0],token};
}
export async function authenticate(db,header) {
  if(typeof header!=='string'||!/^Bearer north_[A-Za-z0-9_-]{43}$/.test(header))fail(401,'UNAUTHORIZED','需要有效的 Bearer Token');
  const {rows}=await db.query('SELECT id,name,scopes,expires_at FROM north_api_tokens WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>now()',[digest(header.slice(7))]);
  if(!rows.length)fail(401,'UNAUTHORIZED','凭证无效、已过期或已撤销');return rows[0];
}
const windows=new Map();
export function rateLimit(actor,method,now=Date.now()) {
  const key=actor.id+':'+(method==='GET'?'read':'write'),limit=method==='GET'?120:30;
  let item=windows.get(key);if(!item||item.until<=now){item={count:0,until:now+60000};windows.set(key,item);}
  if(++item.count>limit)fail(429,'RATE_LIMITED','调用频率过高，请 60 秒后重试');
  if(windows.size>2000)for(const [k,v]of windows)if(v.until<=now)windows.delete(k);
}
