import {reviewSession,probeLogin} from './asin-session.mjs';
import {extractAmazonDOM,fieldsFromDOM,evidence} from './asin-capture.mjs';
import {reviewProfile} from './asin-domain.mjs';

const invalid=()=>Object.assign(new Error('专用会话需要重新登录或人工验证；访客商品检查继续运行'),{sessionInvalid:true});
export async function captureReviews(target,run,{session=reviewSession,saveEvidence=evidence}={}){
  return session.use(async(context,generation)=>{
    const page=await context.newPage();
    await page.route('**/*',r=>['media','font'].includes(r.request().resourceType())?r.abort():r.fallback());
    const response=await page.goto(target.url,{waitUntil:'domcontentloaded'});
    await page.locator('#productTitle').waitFor({timeout:18000}).catch(()=>{});
    if([403,429,503].includes(response?.status())||(await probeLogin(page))!=='authenticated')throw invalid();
    let location=await page.locator('#glow-ingress-line2').textContent().catch(()=>'');
    if(!location?.includes(run.profile.zip)){
      await page.locator('#nav-global-location-popover-link').click();
      await page.locator('#GLUXZipUpdateInput').fill(run.profile.zip);
      await page.locator('#GLUXZipUpdate').click();
      const close=page.locator('[name="glowDoneButton"], #GLUXConfirmClose').first();
      if(await close.isVisible().catch(()=>false))await close.click();
      await page.goto(target.url,{waitUntil:'domcontentloaded'});
      await page.locator('#productTitle').waitFor({timeout:15000}).catch(()=>{});
      if((await probeLogin(page))!=='authenticated')throw invalid();
      location=await page.locator('#glow-ingress-line2').textContent().catch(()=>'');
    }
    if(!location?.includes(run.profile.zip))throw new Error('专用评论页未能确认配送邮编，本次没有保存评论快照');
    await page.evaluate(async()=>{for(let i=0;i<40;i++){window.scrollBy(0,1000);await new Promise(r=>setTimeout(r,220));if(window.scrollY+innerHeight>=document.documentElement.scrollHeight-20)break;}});
    const region=page.locator('#customerReviews, #reviewsMedley').first();
    if(await region.isVisible().catch(()=>false))await region.scrollIntoViewIfNeeded();
    await page.waitForFunction(()=>document.querySelector('#customerReviews [data-hook="review"], #reviewsMedley [data-hook="review"]'),{},{timeout:10000}).catch(()=>{});
    if((await probeLogin(page))!=='authenticated')throw invalid();
    const dom=await page.evaluate(extractAmazonDOM);
    if(dom.asin!==target.asin||!dom.title)throw new Error('专用评论页 ASIN 不一致或未加载，未保存数据');
    if(dom.reviewLoginRequired)throw invalid();
    const extracted=fieldsFromDOM(dom,'content');
    const fields={reviews:extracted.reviews,written_review_count:extracted.written_review_count};
    const observed_at=new Date().toISOString(),profile=reviewProfile(run.profile,generation);
    // Evidence is limited to extracted product reviews. Never save authenticated-page screenshots,
    // full HTML, navigation/account names, addresses, cookies or author profile data.
    const evidence_id=await saveEvidence(target.id,run.id,JSON.stringify({asin:target.asin,observed_at,profile,fields},null,2),'application/json',target.url);
    return {fields,source:'browser-auth',parser_version:'reviews-1',profile,observed_at,evidence_id,coverage:{module:'reviews',location_verified:true,login_verified:true,review_limit:80,review_scope:'专用登录会话下详情页默认展示的评论；不代表全量评论',evidence_type:'extracted-review-json',unknown_fields:Object.keys(fields).filter(k=>fields[k].state==='unknown')}};
  });
}
