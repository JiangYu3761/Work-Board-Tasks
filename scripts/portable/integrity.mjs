import {createReadStream} from 'node:fs';
import {readFile,lstat,readlink} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const packageRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export async function sha256(file){const h=createHash('sha256');for await(const b of createReadStream(file))h.update(b);return h.digest('hex');}
export async function verify(root=packageRoot){
  const manifest=JSON.parse(await readFile(path.join(root,'manifest.json'),'utf8'));
  let checked=0;
  for(const item of manifest.files){
    const file=path.resolve(root,item.path);
    if(!file.startsWith(root+path.sep))throw Error('清单路径超出迁移包');
    const s=await lstat(file);
    if(item.link!==undefined){if(!s.isSymbolicLink()||await readlink(file)!==item.link)throw Error('链接校验失败：'+item.path);}
    else if(!s.isFile()||s.size!==item.size||await sha256(file)!==item.sha256)throw Error('文件校验失败：'+item.path);
    checked++;
  }
  return {ok:true,checked,package:manifest.name};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{console.log(JSON.stringify(await verify(),null,2));}catch(e){console.error('检查失败：'+e.message);process.exitCode=1;}
}
