// Isolated, anonymous browser capture for the local search monitor worker.
import {chromium} from 'playwright-core';
import {parseArgs} from 'node:util';
import {mkdir,writeFile} from 'node:fs/promises';
import {gzipSync} from 'node:zlib';
import path from 'node:path';
const {values:a}=parseArgs({options:{keyword:{type:'string'},country:{type:'string',default:'US'},pages:{type:'string',default:'3'},zip:{type:'string',default:'60202'},timezone:{type:'string',default:'America/Chicago'},out:{type:'string'}}});
if(!a.keyword||!a.out||a.country!=='US')throw new Error('Search keyword, US marketplace and output directory are required.');
await mkdir(path.join(a.out,'html'),{recursive:true});await mkdir(path.join(a.out,'screenshots'),{recursive:true});
let browser,page,stopping=false;
async function stop(){if(stopping)return;stopping=true;await browser?.close().catch(()=>{});process.exit(1);}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
function extract(){
  const text=n=>(n?.textContent||'').replace(/\s+/g,' ').trim();
  const visible=n=>!!n&&n.getClientRects().length>0&&getComputedStyle(n).visibility!=='hidden';
  const money=s=>{const m=s.match(/\$\s*([\d,]+(?:\.\d{1,2})?)/);return m?Number(m[1].replaceAll(',','')):null;};
  const cards=[...document.querySelectorAll('div.s-main-slot div[data-component-type="s-search-result"]')].filter(n=>/^[A-Z0-9]{10}$/.test(n.getAttribute('data-asin')||'')&&n.querySelector('h2 span'));
  const items=cards.map((el,i)=>({asin:el.getAttribute('data-asin'),title:text(el.querySelector('[data-cy="title-recipe"] h2 span, h2 a span, h2 span')),pagePosition:i+1,
    sponsored:el.classList.contains('AdHolder')||!!el.querySelector('.puis-sponsored-label-text, .s-sponsored-label-info-icon, [data-component-type="sp-sponsored-result"], a[href*="/sspa/click"], [aria-label="Sponsored"]')||[...el.querySelectorAll('span')].some(n=>n.childElementCount===0&&text(n)==='Sponsored'),
    hasVideo:!!el.querySelector('video, [data-component-type*="video"], [class*="video"]'),
    price:money(text(el.querySelector('.a-price:not(.a-text-price) .a-offscreen'))),rating:parseFloat(text(el.querySelector('.a-icon-alt')))||null,
    reviews:(()=>{const raw=text(el.querySelector('[data-csa-c-content-id="alf-customer-ratings-count-component"] span, span.a-size-base.s-underline-text'));return /^[\d,]+$/.test(raw)?Number(raw.replaceAll(',','')):null;})(),
    socialProofRaw:[...el.querySelectorAll('span')].map(text).find(s=>/^\d[\d,.KMkm+]*\s+bought in past month$/i.test(s))||null,
    widgetId:el.getAttribute('cel_widget_id'),componentType:el.getAttribute('data-component-type'),classificationStatus:'DOM_MARKERS',visible:visible(el)}));
  const marker=n=>`${n.getAttribute('cel_widget_id')||''} ${n.getAttribute('data-component-type')||''}`;
  const isAd=n=>/(?:^|[-_: ])(?:sb|hsa)(?:[-_: ]|$)|sponsored|adplacements?|ad-placements?|skyscraper|billboard/i.test(marker(n));
  const candidates=[...document.querySelectorAll('[cel_widget_id], [data-component-type]')].filter(n=>isAd(n)&&visible(n)&&!n.closest('[data-component-type="s-search-result"]'));
  const selected=candidates.filter(n=>!candidates.some(parent=>parent!==n&&parent.contains(n)));
  const natural=cards.filter((_,i)=>!items[i].sponsored),first=natural[0]?.getBoundingClientRect().top+window.scrollY,last=natural.at(-1)?.getBoundingClientRect().bottom+window.scrollY;
  const adUnits=selected.map(el=>{const r=el.getBoundingClientRect(),top=r.top+window.scrollY;
    const landingUrls=[...new Set([...el.querySelectorAll('a[href]')].map(n=>{const href=n.href,at=href.lastIndexOf('/https://');return (at<0?href:href.slice(at+1)).slice(0,2000);} ))];
    const slot=/left|right|skyscraper/i.test(marker(el))?'侧栏':Number.isFinite(first)&&top<first?'页首':Number.isFinite(last)&&top>=last?'页尾':'中部';
    return {widgetId:el.getAttribute('cel_widget_id'),componentType:el.getAttribute('data-component-type'),slot,topPx:Math.round(top),width:Math.round(r.width),height:Math.round(r.height),
      landingUrls,asins:[...new Set(landingUrls.map(u=>u.match(/\/dp\/([A-Z0-9]{10})/)?.[1]).filter(Boolean))],headline:text(el.querySelector('h1,h2,h3,[class*="headline"]')).slice(0,200),creativeText:text(el).slice(0,600),sponsoredLabelPresent:/\bSponsored\b/i.test(text(el)),hasVideo:!!el.querySelector('video,[data-component-type*="video"],[class*="video"]')};});
  const correction=text(document.querySelector('[data-component-type="s-search-suggestion"]'));
  return {items,adUnits,correctionText:correction||null,exhausted:!!document.querySelector('.s-pagination-next.s-pagination-disabled, .a-pagination .a-last.a-disabled'),title:document.title};
}
try{
  browser=await chromium.launch({headless:true,...(process.env.SEARCH_CHROMIUM_PATH?{executablePath:process.env.SEARCH_CHROMIUM_PATH}:{})});
  const context=await browser.newContext({viewport:{width:1440,height:900},locale:'en-US',timezoneId:a.timezone});
  await context.addCookies([{name:'i18n-prefs',value:'USD',url:'https://www.amazon.com/'},{name:'lc-main',value:'en_US',url:'https://www.amazon.com/'}]);
  page=await context.newPage();page.setDefaultTimeout(14000);page.setDefaultNavigationTimeout(60000);
  const raw={meta:{keyword:a.keyword,country:'US',pagesRequested:Number(a.pages),fetchedAt:new Date().toISOString()},items:[],itemObservations:[],adUnits:[],pageSignals:[]};
  const check=async response=>{if([403,429,503].includes(response?.status())||await page.locator('form[action*="validateCaptcha"], #captchacharacters').count()||/robot check|captcha/i.test(await page.title())){const err=new Error('Amazon access validation or rate limit');err.blocked=true;throw err;}};
  for(let p=1;p<=Number(a.pages);p++){
    const u=new URL('https://www.amazon.com/s');u.searchParams.set('k',a.keyword);u.searchParams.set('page',String(p));u.searchParams.set('language','en_US');
    await check(await page.goto(u.href,{waitUntil:'domcontentloaded'}));
    // A normal storefront continue button may precede the page; never solve challenges.
    const cont=page.getByRole('button',{name:'Continue shopping',exact:true});if(await cont.isVisible().catch(()=>false)){await cont.click();await page.waitForLoadState('domcontentloaded');await check();}
    await page.locator('#glow-ingress-line2').waitFor({timeout:20000});
    let zip=await page.locator('#glow-ingress-line2').innerText();
    if(p===1&&!zip.includes(a.zip)){
      for(let attempt=0;attempt<2&&!zip.includes(a.zip);attempt++){
        await page.waitForLoadState('load',{timeout:30000}).catch(()=>{});
        try{
          await page.locator('#nav-global-location-popover-link').click();await page.locator('#GLUXZipUpdateInput').fill(a.zip,{timeout:10000});await page.locator('#GLUXZipUpdate').click();
          const done=page.locator('[name="glowDoneButton"], #GLUXConfirmClose').first();await done.waitFor({state:'visible',timeout:6000}).catch(()=>{});if(await done.isVisible().catch(()=>false))await done.click();
        }catch(err){console.log('Delivery location interaction incomplete:',err.message.split('\n')[0]);}
        await check(await page.goto(u.href,{waitUntil:'domcontentloaded'}));await page.locator('#glow-ingress-line2').waitFor();zip=await page.locator('#glow-ingress-line2').innerText();
      }
    }
    if(!zip.includes(a.zip))throw new Error('Delivery location zip was not verified');
    raw.meta.deliveryLocationEvidence={verified:true,requested:a.zip,observed:zip};
    await page.locator('.s-main-slot, [data-component-type="s-search-results"]').first().waitFor({timeout:25000});
    await page.evaluate(async()=>{const start=Date.now();for(let y=0;y<document.documentElement.scrollHeight&&Date.now()-start<12000;y+=700){window.scrollTo(0,y);await new Promise(r=>setTimeout(r,120));}window.scrollTo(0,0);});
    const d=await page.evaluate(extract);raw.items.push(...d.items);raw.itemObservations.push(...d.items.map(i=>({...i,page:p})));raw.adUnits.push(...d.adUnits.map(u=>({...u,page:p})));
    raw.pageSignals.push({page:p,url:page.url(),title:d.title,correctionText:d.correctionText});raw.meta.pagesFetched=p;
    await writeFile(path.join(a.out,'html',`search-p${p}.html.gz`),gzipSync(await page.content()));await page.screenshot({path:path.join(a.out,'screenshots',`search-p${p}.png`),fullPage:true,timeout:30000});
    console.log(`Captured page ${p}: ${d.items.length} product observations, ${d.adUnits.length} non-grid ad modules.`);
    if(d.exhausted)break;
  }
  raw.meta.finishedAt=new Date().toISOString();await writeFile(path.join(a.out,'search.json'),JSON.stringify(raw));
}catch(err){if(page)await page.screenshot({path:path.join(a.out,'failure.png'),fullPage:false,timeout:8000}).catch(()=>{});console.error(err.message);process.exitCode=err.blocked?2:1;}
finally{await browser?.close();}
