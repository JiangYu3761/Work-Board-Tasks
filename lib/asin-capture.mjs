import {chromium} from 'playwright-core';
import sharp from 'sharp';
import {randomUUID,createHash} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pool} from './db.mjs';
import {FIELDS,value,unknown,count} from './asin-domain.mjs';

export const evidenceRoot=path.resolve('.runtime/asin-evidence');
export async function evidence(target,run,bytes,mime,source=null){
  const id=randomUUID(),data=Buffer.isBuffer(bytes)?bytes:Buffer.from(bytes);
  await mkdir(evidenceRoot,{recursive:true});
  const file=path.join(evidenceRoot,id);
  await writeFile(file,data,{flag:'wx'});
  await pool.query('INSERT INTO asin_evidence(id,target_id,run_id,path,mime,sha256,size,source_url) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[id,target,run,file,mime,createHash('sha256').update(data).digest('hex'),data.length,source]);
  return id;
}

// Runs in the page. Read only the selected product's regions, never recommendation cards.
export function extractAmazonDOM(){
  const visible=e=>!!e&&!!(e.getClientRects().length)&&getComputedStyle(e).visibility!=='hidden';
  const find=(s,root=document)=>[...root.querySelectorAll(s)].find(visible);
  const all=(s,root=document)=>[...root.querySelectorAll(s)].filter(visible);
  const txt=e=>e?.innerText?.replace(/\s+/g,' ').trim()||'';
  const get=s=>txt(find(s));
  const unique=a=>[...new Set(a.filter(Boolean))];
  const title=get('#productTitle');
  const root=find('#corePriceDisplay_desktop_feature_div')||find('#corePrice_feature_div')||find('#apex_desktop');
  const price=root?txt(find('.priceToPay .a-offscreen, .apexPriceToPay .a-offscreen, .a-price:not(.a-text-price) .a-offscreen',root)):get('#priceblock_ourprice, #priceblock_dealprice');
  // a-offscreen prices have zero-size boxes: their parent price element must be visible.
  const priceText=price||(root?.querySelector('[data-pricetopay-label]')?.textContent?.trim())||(root?[...root.querySelectorAll('.priceToPay .a-offscreen, .apexPriceToPay .a-offscreen, .a-price:not(.a-text-price) .a-offscreen')].filter(e=>visible(e.closest('.a-price'))).map(e=>e.textContent.trim()).find(Boolean):'');
  const reference=root?[...root.querySelectorAll('.a-text-price .a-offscreen')].filter(e=>visible(e.closest('.a-price'))).map(e=>e.textContent.trim())[0]:'';
  const promoNodes=all('#couponFeature, #vpcButton, #promoPriceBlockMessage_feature_div, #reinvent_price_desktop_newAccordionRow .couponLabelText, #dealBadge_feature_div');
  const promotions=unique(promoNodes.map(txt)).map(raw=>({type:/coupon/i.test(raw)?'coupon':/deal/i.test(raw)?'deal':'promotion',raw}));
  const detail=find('#productDescription, #tech');
  const specs=unique(all('#productDetails_techSpec_section_1 tr, #productDetails_detailBullets_sections1 tr, #detailBullets_feature_div li').map(txt));
  const aplus=find('#aplus, #aplus_feature_div, #btfContent1_feature_div');
  const imageNodes=all('#altImages img').filter(e=>!e.closest('.videoThumbnail')&&!/play-button|video-icon/.test(e.src));
  const mainImage=find('#landingImage')?.getAttribute('data-old-hires')||find('#landingImage')?.src;
  const imageUrls=unique(mainImage?[mainImage,...imageNodes.slice(1).map(e=>e.src)]:imageNodes.map(e=>e.src)).filter(u=>u&&/images.*amazon|media-amazon/.test(u));
  const reviewRoots=all('#cm-cr-dp-review-list [data-hook="review"], #cm-cr-global-review-list [data-hook="review"]');
  const seen=new Set();
  const reviews=reviewRoots.flatMap(e=>{
    const id=e.id||e.getAttribute('data-review-id');if(!id||seen.has(id))return [];seen.add(id);
    const body=find('[data-hook="review-body"]',e),raw=txt(body);
    const rating=(e.querySelector('[data-hook="review-star-rating"], [data-hook="cmps-review-star-rating"]')?.textContent||'').trim();
    return [{id,position:seen.size,region:e.closest('#cm-cr-global-review-list')?'global':'local',title:txt(find('[data-hook="review-title"]',e)),body:raw,rating:parseFloat(rating)||null,date:txt(find('[data-hook="review-date"]',e)),variant:txt(find('[data-hook="format-strip"]',e)),verified:!!find('[data-hook="avp-badge"]',e),vine:!!find('[data-hook="vine-review-badge"]',e),helpful:txt(find('[data-hook="helpful-vote-statement"]',e)),complete:!!body&&!body.querySelector('.a-expander-partial-collapse-header')&&!find('.a-expander-prompt',e)&&!raw.endsWith('…'),language:document.documentElement.lang||'en-US'}];
  }).slice(0,80);
  return {title,asin:document.querySelector('input#ASIN')?.value||document.querySelector('input[name="ASIN"]')?.value||'',price:priceText,reference,
    priceArea:!!root,promotions,promoCoverage:'已识别的优惠标签；未计算叠加后到手价',
    seller:get('#merchant-info, #sellerProfileTriggerId, #tabular-buybox')||[get('#merchantInfoFeature_feature_div'),get('#fulfillerInfoFeature_feature_div')].filter(Boolean).join(' · '),availability:get('#availability'),
    bullets:all('#feature-bullets li .a-list-item').map(txt).filter(Boolean),description:[txt(detail),...specs].filter(Boolean).join('\n'),
    aplus:aplus?{text:txt(aplus),images:unique(all('img',aplus).map(e=>e.src)).filter(u=>u&&!u.startsWith('data:'))}:null,
    images:imageUrls,rating:document.querySelector('#acrPopover')?.getAttribute('title')||document.querySelector('#acrPopover .a-icon-alt, #averageCustomerReviews .a-icon-alt')?.textContent||'',rating_count:get('#acrCustomerReviewText'),
    written_review_count:get('[data-hook="cr-filter-info-review-rating-count"]'),star_distribution:all('#histogramTable tr, #cm_cr_dp_d_rating_histogram a[href*="hist_"]').map(txt),
    review_summary:get('[data-hook="cr-insights-widget-summary"], [data-hook="cr-insights-widget"], #customerReviews [data-testid="overall-summary"]'),reviews,reviewArea:!!find('#reviewsMedley, #customerReviews'),reviewLoginRequired:/Sign in to see customer reviews/i.test(get('#customerReviews')),
    location:get('#glow-ingress-line2'),pageTitle:document.title};
}

export function fieldsFromDOM(d,module='all'){
  const f=Object.fromEntries(Object.keys(FIELDS).filter(k=>module==='all'||FIELDS[k][1]===module).map(k=>[k,unknown('页面未能确认此字段；保留上次有效值')]));
  const set=(k,v)=>{if(k in f)f[k]=v;};
  const price=s=>{const m=String(s||'').match(/\$\s*([\d,]+(?:\.\d{2})?)/);return m?value(Number(m[1].replaceAll(',','')),s,{currency:'USD',scope:'featured-new'}):unknown('未取得明确的美元售价');};
  set('sale_price',price(d.price));set('reference_price',price(d.reference));
  if(d.seller)set('seller',value(d.seller));
  if(d.availability)set('availability',value(d.availability));
  // An empty selector does not prove that a promotion or review was removed.
  if(d.promotions?.length)set('promotions',value(d.promotions,'',{scope:'visible-pdp-promotions'}));
  if(d.title)set('title',value(d.title));
  if(d.bullets?.length)set('bullets',value(d.bullets));
  if(d.description)set('description',value(d.description));
  if(d.aplus)set('aplus',value(d.aplus));
  const rating=String(d.rating||'').match(/([0-5](?:\.\d+)?)\s+out of 5/);
  if(rating)set('rating',value(Number(rating[1]),d.rating));
  if(d.rating_count&&!/\breviews?\b/i.test(d.rating_count))set('rating_count',count(d.rating_count));
  const written=String(d.written_review_count||'').match(/([\d,]+)\s+(?:global\s+)?reviews?\b/i);
  if(written)set('written_review_count',count(written[1]));
  if(d.star_distribution?.length)set('star_distribution',value(d.star_distribution));
  if(d.review_summary)set('review_summary',value(d.review_summary));
  if(d.reviewArea&&d.reviews?.length)set('reviews',value(d.reviews,'',{scope:'pdp-default-visible'}));
  if(d.reviewLoginRequired)set('reviews',unknown('Amazon 要求登录才能查看评论卡片；访客观察条件下无法采集'));
  return f;
}

async function imageAsset(url,target,run){
  const u=new URL(url);
  if(u.protocol!=='https:'||u.port||u.username||!['m.media-amazon.com','images-na.ssl-images-amazon.com','images-eu.ssl-images-amazon.com'].includes(u.hostname))throw new Error('图片来源不在允许列表');
  // Normalize only Amazon's documented-by-observation thumbnail suffix, preserving the asset ID.
  u.pathname=u.pathname.replace(/\._[^/]+_\.(jpg|jpeg|png|webp)$/i,'.$1');
  const res=await fetch(u,{redirect:'error',signal:AbortSignal.timeout(15000)});
  if(!res.ok||!res.headers.get('content-type')?.startsWith('image/'))throw new Error('图片读取失败');
  const chunks=[];let size=0;
  for await(const part of res.body){size+=part.length;if(size>6e6)throw new Error('图片超过 6 MB');chunks.push(part);}
  const data=Buffer.concat(chunks),sha256=createHash('sha256').update(data).digest('hex');
  const img=sharp(data,{limitInputPixels:40e6});const meta=await img.metadata();
  const pixels=await img.rotate().resize(256,256,{fit:'inside',withoutEnlargement:true}).removeAlpha().toColourspace('srgb').raw().toBuffer({resolveWithObject:true});
  const pixel_hash=createHash('sha256').update(pixels.data).update(`${pixels.info.width}x${pixels.info.height}`).digest('hex');
  const existing=(await pool.query('SELECT id FROM asin_evidence WHERE target_id=$1 AND sha256=$2 LIMIT 1',[target,sha256])).rows[0];
  const asset_id=existing?.id||await evidence(target,run,data,res.headers.get('content-type').split(';')[0],u.href);
  return {key:u.pathname,sha256,pixel_hash,asset_id,url:u.href,width:meta.width,height:meta.height};
}

export async function capture(target,run){
  let browser,page,deadline;
  const blocked=(message,code='blocked')=>Object.assign(new Error(message),{captureState:code});
  try{
    browser=await chromium.launch({headless:true,...(process.env.ASIN_CHROMIUM_PATH?{executablePath:process.env.ASIN_CHROMIUM_PATH}:{})});
    deadline=setTimeout(()=>browser?.close().catch(()=>{}),240000);deadline.unref();
    const context=await browser.newContext({viewport:{width:1440,height:1000},locale:'en-US',timezoneId:'America/Chicago'});
    page=await context.newPage();page.setDefaultTimeout(12000);page.setDefaultNavigationTimeout(45000);
    await page.route('**/*',r=>['media','font'].includes(r.request().resourceType())?r.abort():r.continue());
    const response=await page.goto(target.url,{waitUntil:'domcontentloaded'});
    const challenge=async()=>/validateCaptcha|captchacharacters|Type the characters you see|Click the button below to continue shopping|Robot Check/i.test(await page.content());
    if([403,429,503].includes(response?.status())||await challenge())throw blocked('Amazon 返回访问验证或限流页面；自动检查已暂停，请处理数据来源后重试');
    await page.locator('#productTitle').waitFor({timeout:18000}).catch(()=>{});
    let location=(await page.locator('#glow-ingress-line2').textContent().catch(()=>''))||'';
    if(!location.includes(run.profile.zip)){
      await page.locator('#nav-global-location-popover-link').click();
      await page.locator('#GLUXZipUpdateInput').fill(run.profile.zip);
      await page.locator('#GLUXZipUpdate').click();
      const close=page.locator('[name="glowDoneButton"], #GLUXConfirmClose');
      if(await close.first().isVisible().catch(()=>false))await close.first().click();
      await page.goto(target.url,{waitUntil:'domcontentloaded'});
      if(await challenge())throw blocked('设置配送地区时遇到访问验证；没有更新商品数据');
      await page.locator('#productTitle').waitFor({timeout:15000});
      location=(await page.locator('#glow-ingress-line2').textContent().catch(()=>''))||'';
    }
    if(!location.includes(run.profile.zip))throw blocked('未能确认配送邮编；为防止跨地区比较，本次没有保存商品快照');
    await page.waitForLoadState('networkidle',{timeout:6000}).catch(()=>{});
    if(run.module!=='price'){
      await page.evaluate(async()=>{for(let i=0;i<40;i++){window.scrollBy(0,1000);await new Promise(r=>setTimeout(r,220));if(window.scrollY+innerHeight>=document.documentElement.scrollHeight-20)break;}});
      const reviews=page.locator('#customerReviews').first();
      if(await reviews.isVisible().catch(()=>false)){
        await reviews.scrollIntoViewIfNeeded();
        await page.waitForFunction(()=>document.querySelector('#customerReviews [data-hook="review"]')||/Sign in to see customer reviews/i.test(document.querySelector('#customerReviews')?.innerText||''),{},{timeout:10000}).catch(()=>{});
      }
      await page.evaluate(()=>window.scrollTo(0,0));
    }
    const dom=await page.evaluate(extractAmazonDOM);
    if(dom.asin!==target.asin||!dom.title)throw blocked('页面 ASIN 与监控对象不一致，或关键区域未加载；请核对变体','partial');
    const fields=fieldsFromDOM(dom,run.module);
    if(run.module!=='price'){
      try{
        const assets=[];const keys=new Set();
        for(const url of dom.images.slice(0,15)){const a=await imageAsset(url,target.id,run.id);if(!keys.has(a.key)){assets.push(a);keys.add(a.key);}}
        if(assets.length)fields.images=value(assets,'',{scope:'pdp-gallery-up-to-15'});
      }catch(e){fields.images=unknown('图片内容未完整取得：'+e.message);}
      if(fields.aplus?.state==='observed'&&dom.aplus.images.length){
        try{const imgs=[];for(const url of dom.aplus.images.slice(0,30))imgs.push(await imageAsset(url,target.id,run.id));fields.aplus.value.images=imgs;}
        catch{fields.aplus=unknown('A+ 图片内容未完整取得');}
      }
    }
    const screenshot=await evidence(target.id,run.id,await page.screenshot({fullPage:false,timeout:15000}),'image/png',target.url);
    const sections={};
    if(run.module!=='price')for(const [key,selector] of [['reviews','#customerReviews'],['aplus','#aplus, #aplus_feature_div, #btfContent1_feature_div'],['description','#productDescription, #tech']]){
      const region=page.locator(selector).first();
      if(await region.isVisible().catch(()=>false))try{await region.scrollIntoViewIfNeeded();sections[key]=await evidence(target.id,run.id,await page.screenshot({fullPage:false,timeout:10000}),'image/png',target.url);}catch{}
    }
    const extracted=await evidence(target.id,run.id,JSON.stringify(dom,null,2),'application/json',target.url);
    return {fields,parser_version:'2',observed_at:new Date().toISOString(),evidence_id:screenshot,coverage:{module:run.module,extracted_evidence_id:extracted,section_evidence:sections,location_verified:true,image_limit:15,aplus_image_limit:30,review_limit:80,review_scope:'详情页默认展示，不含全量评论；只确认实际出现的字段',ratings_scope:'页面展示口径，可能合并变体',review_login_required:dom.reviewLoginRequired,unknown_fields:Object.keys(fields).filter(k=>fields[k].state==='unknown')}};
  }catch(error){
    if(page)try{error.evidence_id=await evidence(target.id,run.id,await page.screenshot({fullPage:false,timeout:8000}),'image/png',target.url);}catch{}
    throw error;
  }finally{clearTimeout(deadline);await browser?.close();}
}
