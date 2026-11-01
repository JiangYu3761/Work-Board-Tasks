import {createHash} from 'node:crypto';

export const SCOPES=['news:read','news:write','competitors:read','competitors:write','search:read','search:write','asin:read','asin:write','events:read','events:write','notify:write'];
export const fail=(status,code,message)=>{throw Object.assign(new Error(message),{status,code});};
export const digest=value=>createHash('sha256').update(value).digest('hex');
export const canonical=value=>JSON.stringify(value,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
export function textField(value,name,max,{optional=false}={}) {
  if(optional&&value===undefined)return '';
  if(typeof value!=='string'||!value.trim()||value.length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value))fail(400,'INVALID_INPUT',`${name} 必须是 1–${max} 字符的文本`);
  return value.trim();
}
export async function jsonBody(req,limit=65536) {
  let size=0;const chunks=[];
  for await(const c of req){size+=c.length;if(size>limit)fail(413,'BODY_TOO_LARGE','请求内容过大');chunks.push(c);}
  let input;try{input=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');}catch{fail(400,'INVALID_JSON','JSON 格式无效');}
  if(!input||typeof input!=='object'||Array.isArray(input))fail(400,'INVALID_INPUT','请求必须为 JSON 对象');return input;
}
export function boundedInt(value,fallback,min,max) {
  if(value===null||value===undefined)return fallback;
  if(!/^\d+$/.test(String(value))||!Number.isSafeInteger(Number(value))||Number(value)<min||Number(value)>max)fail(400,'INVALID_INPUT',`整数必须在 ${min}–${max} 之间`);
  return Number(value);
}
