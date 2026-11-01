import {randomUUID} from 'node:crypto';
import {mkdir,chmod,readFile,writeFile,rename} from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright-core';
import {pool} from './db.mjs';
import {fail} from './asin-domain.mjs';

// Only inspect the public navigation bar. Never read credentials, cookies or account pages.
export function loginSignals(){
  const href=document.querySelector('#nav-link-accountList')?.getAttribute('href')||'';
  const greeting=document.querySelector('#nav-link-accountList-nav-line-1')?.textContent?.trim()||'';
  return {
    challenge:!!document.querySelector('#captchacharacters, form[action*="validateCaptcha"], #auth-captcha-image'),
    signedOut:/signin|sign-in/i.test(href)||/sign in/i.test(greeting),
    signedIn:!!document.querySelector('#nav-item-signout, a[href*="sign-out"]')&&!!greeting&&!/sign in/i.test(greeting)&&!(/signin|sign-in/i.test(href)),
  };
}
export async function probeLogin(page){
  const u=new URL(page.url());
  if(u.protocol!=='https:'||!['www.amazon.com','amazon.com'].includes(u.hostname))return 'unknown';
  if(/^\/ap\//.test(u.pathname))return 'needs_login';
  if(u.pathname!=='/'&&!/^\/ref=/.test(u.pathname)&&!/(?:\/dp\/|\/gp\/product\/)[A-Z0-9]{10}(?:\/|$)/i.test(u.pathname))return 'unknown';
  const s=await page.evaluate(loginSignals);
  return s.challenge?'challenge':s.signedOut?'needs_login':s.signedIn?'authenticated':'unknown';
}

export class ReviewSession {
  constructor({root=path.resolve('.runtime/asin-amazon-session'),db=pool,launch=(dir,options)=>chromium.launchPersistentContext(dir,options),probe=probeLogin}={}){
    this.root=root;this.db=db;this.launch=launch;this.probe=probe;this.mode=null;this.context=null;this.client=null;
    this.loaded=null;this.record={state:'needs_login',generation:null,verified_at:null,reason:'尚未登录专用 Amazon 会话'};
  }
  async load(){
    if(!this.loaded)this.loaded=(async()=>{
      await mkdir(this.root,{recursive:true,mode:0o700});await chmod(this.root,0o700);
      try{const r=JSON.parse(await readFile(path.join(this.root,'session.json'),'utf8'));if(['ready','needs_login','disabled'].includes(r.state))this.record=r;}catch(e){if(e.code!=='ENOENT')this.record.reason='会话状态需要重新验证';}
    })();
    await this.loaded;
  }
  async persist(patch){
    this.record={...this.record,...patch};
    const file=path.join(this.root,'session.json'),tmp=file+'.tmp';
    await writeFile(tmp,JSON.stringify(this.record),{mode:0o600});await rename(tmp,file);
  }
  async refreshRecord(){try{const r=JSON.parse(await readFile(path.join(this.root,'session.json'),'utf8'));if(['ready','needs_login','disabled'].includes(r.state))this.record=r;}catch{}}
  async status(){await this.load();if(!this.mode)await this.refreshRecord();return {state:this.mode||this.record.state,generation:this.record.generation,verified_at:this.record.verified_at,reason:this.record.reason,window_open:!!this.context&&['manual','verifying'].includes(this.mode)};}
  async acquire(mode){
    await this.load();if(this.mode)fail('专用会话正在使用中，请完成当前操作后再试',409);
    this.mode=mode;
    try{
      this.client=await this.db.connect();
      const lock=await this.client.query('SELECT pg_try_advisory_lock(43170403) AS ok');
      if(!lock.rows[0].ok)fail('另一个北向进程正在使用专用会话，请稍后再试',409);
      await this.refreshRecord();
    }catch(e){this.client?.release();this.client=null;this.mode=null;throw e;}
  }
  async release(){
    const c=this.client;this.client=null;this.mode=null;
    if(c){try{await c.query('SELECT pg_advisory_unlock(43170403)');}finally{c.release();}}
  }
  async browser(headless){
    const dir=path.join(this.root,'profile');await mkdir(dir,{recursive:true,mode:0o700});await chmod(dir,0o700);
    const context=await this.launch(dir,{headless,viewport:{width:1440,height:1000},locale:'en-US',timezoneId:'America/Chicago',...(process.env.ASIN_CHROMIUM_PATH?{executablePath:process.env.ASIN_CHROMIUM_PATH}:{})});
    context.setDefaultTimeout(12000);context.setDefaultNavigationTimeout(45000);return context;
  }
  async open(){
    if(this.mode==='manual'){await this.context.pages().at(-1)?.bringToFront();return this.status();}
    await this.acquire('opening');
    try{
      // Every manual login/repair starts a new identity boundary, even if the same account is used.
      await this.persist({state:'needs_login',generation:randomUUID(),verified_at:null,reason:'请在独立窗口手动登录，然后回到北向点击“验证并启用”'});
      const context=this.context=await this.browser(false);this.mode='manual';
      context.on('close',()=>{if(this.context===context){this.context=null;void this.release().catch(()=>{});}});
      const page=context.pages()[0]||await context.newPage();
      await page.goto('https://www.amazon.com/',{waitUntil:'domcontentloaded'}).catch(()=>{});
      await page.bringToFront();return this.status();
    }catch(e){await this.closeContext();await this.release();fail('专用浏览器未能打开，请检查隔离 Chromium 是否可用后重试',503);}
  }
  async closeContext(){const c=this.context;this.context=null;await c?.close();}
  async verify(){
    await this.load();
    if(this.mode!=='manual')fail('请先打开专用窗口，完成手动登录后再验证',409);
    this.mode='verifying';
    try{
      // The user invokes verification after finishing login. Do not navigate away from an auth form.
      const page=this.context.pages().at(-1);if(!page)fail('窗口已关闭，请重新打开',409);
      const state=await this.probe(page);
      if(state!=='authenticated'){
        await this.persist({state:'needs_login',reason:state==='challenge'?'Amazon 要求人工验证，请在专用窗口完成后再验证':state==='needs_login'?'尚未确认登录完成，请登录后返回 Amazon 首页再验证':'请在专用窗口打开 Amazon 美国站首页，再点击验证'});
        this.mode='manual';
        return this.status();
      }
      await this.persist({state:'ready',verified_at:new Date().toISOString(),reason:'会话已验证；下次内容检查将尝试取得具体评论'});
      await this.closeContext();await this.release();return this.status();
    }finally{if(this.mode==='verifying')this.mode='manual';}
  }
  async close(){
    await this.load();if(this.mode&&!['manual'].includes(this.mode))fail('会话正在检查，请稍后再关闭',409);
    await this.closeContext();await this.release();return this.status();
  }
  async disable(){
    await this.load();if(this.mode)fail('请先完成或关闭专用登录窗口',409);
    await this.acquire('disabling');
    try{await this.persist({state:'disabled',reason:'专用评论检查已停用；本机登录数据保留'});}finally{await this.release();}
    return this.status();
  }
  async use(callback){
    const s=await this.status();if(s.state!=='ready')return {unavailable:true,session:s};
    await this.acquire('capturing');let deadline;
    try{
      if(this.record.state!=='ready')return {unavailable:true,session:{...this.record,window_open:false}};
      this.context=await this.browser(true);
      deadline=setTimeout(()=>this.context?.close().catch(()=>{}),150000);deadline.unref();
      return await callback(this.context,this.record.generation);
    }catch(e){
      if(e.sessionInvalid)await this.persist({state:'needs_login',reason:'专用会话已失效或遇到访问验证，请打开窗口手动处理后重新验证'});
      throw e;
    }finally{clearTimeout(deadline);try{await this.closeContext();}finally{await this.release();}}
  }
  async stop(){if(this.mode==='manual'){await this.closeContext();await this.release();}}
}
export const reviewSession=new ReviewSession();
