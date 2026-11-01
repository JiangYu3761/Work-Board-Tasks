import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {extractAmazonDOM,fieldsFromDOM} from '../lib/asin-capture.mjs';
import {loginSignals,probeLogin} from '../lib/asin-session.mjs';
import {captureReviews} from '../lib/asin-review-capture.mjs';
import {profile} from '../lib/asin-domain.mjs';
import {randomUUID} from 'node:crypto';
test('Live-layout regression: accessibility-only price, device specifications and login-gated reviews',async()=>{
  const browser=await chromium.launch({headless:true});
  try{
    const page=await browser.newPage();
    await page.setContent(`<html lang="en-US"><body><input id="ASIN" type="hidden" value="B000000001"><h1 id="productTitle">Example device</h1><div id="corePriceDisplay_desktop_feature_div"><span data-pricetopay-label="{priceToPay}">$89.99 with 25 percent savings</span><span class="a-price priceToPay"><span class="a-offscreen"> </span><span>$89.99</span></span><span class="a-price a-text-price"><span class="a-offscreen">$119.99</span></span></div><div id="merchantInfoFeature_feature_div">Shipper / Seller Amazon.com</div><div id="tech">Technical details: 100 mm</div><div id="btfContent1_feature_div">Rich product content</div><div id="acrPopover" title="4.3 out of 5 stars"></div><span id="acrCustomerReviewText">(5,638)</span><div id="customerReviews"><div id="cm_cr_dp_d_rating_histogram"><a href="/hist_5">5 star 73%</a></div><div data-testid="overall-summary">Customers find the sound clear.</div><p>Sign in to see customer reviews.</p></div><div id="glow-ingress-line2">Evanston 60202</div></body></html>`);
    const d=await page.evaluate(extractAmazonDOM),f=fieldsFromDOM(d);
    assert.equal(d.asin,'B000000001');assert.equal(f.sale_price.value,89.99);assert.equal(f.reference_price.value,119.99);
    assert.equal(f.rating_count.value,5638);assert.match(f.seller.value,/Amazon.com/);assert.match(f.description.value,/100 mm/);
    assert.equal(f.aplus.value.text,'Rich product content');assert.equal(f.review_summary.value,'Customers find the sound clear.');
    assert.equal(f.star_distribution.value[0],'5 star 73%');assert.equal(d.reviewLoginRequired,true);assert.equal(f.reviews.state,'unknown');assert.match(f.reviews.reason,/登录/);
  }finally{await browser.close();}
});
test('Review extraction reads only PDP review cards and retains stable identity without reviewer names',async()=>{
  const browser=await chromium.launch({headless:true});
  try{
    const page=await browser.newPage();
    await page.setContent(`<html lang="en-US"><body><div id="customerReviews"><div id="cm-cr-dp-review-list"><div data-hook="review" id="R123"><span class="a-profile-name">Excluded reviewer name</span><a data-hook="review-title">Review title</a><i data-hook="review-star-rating"><span>2.0 out of 5 stars</span></i><span data-hook="review-body">Shown body</span><span data-hook="avp-badge">Verified Purchase</span><span data-hook="review-date">Reviewed in the United States</span></div></div></div><div data-hook="review" id="UNRELATED">Recommended product review</div></body></html>`);
    const d=await page.evaluate(extractAmazonDOM);assert.equal(d.reviews.length,1);assert.equal(d.reviews[0].id,'R123');assert.equal(d.reviews[0].rating,2);assert.equal(d.reviews[0].verified,true);assert.ok(!JSON.stringify(d.reviews).includes('Excluded reviewer'));
  }finally{await browser.close();}
});
test('Login detection needs positive public-navigation evidence and never returns account identity',async()=>{
  const browser=await chromium.launch({headless:true});
  try{
    const page=await browser.newPage();
    await page.setContent('<a id="nav-link-accountList" href="/ap/signin"><span id="nav-link-accountList-nav-line-1">Hello, sign in</span></a>');
    let signals=await page.evaluate(loginSignals);assert.equal(signals.signedOut,true);assert.equal(signals.signedIn,false);
    await page.setContent('<a id="nav-link-accountList" href="/gp/css/homepage.html"><span id="nav-link-accountList-nav-line-1">Hello, Private name</span></a><a id="nav-item-signout" href="/gp/flex/sign-out.html">Sign Out</a>');
    signals=await page.evaluate(loginSignals);assert.equal(signals.signedIn,true);assert.ok(!JSON.stringify(signals).includes('Private name'));
    assert.equal(await probeLogin({url:()=> 'https://www.amazon.com/ap/signin',evaluate:()=>assert.fail('Never read a sign-in form')}),'needs_login');
    assert.equal(await probeLogin({url:()=> 'https://example.com/',evaluate:()=>assert.fail('No unrelated page access')}),'unknown');
    await page.setContent('<input id="captchacharacters">');signals=await page.evaluate(loginSignals);assert.equal(signals.challenge,true);assert.equal(signals.signedIn,false);
  }finally{await browser.close();}
});
test('Authenticated review capture preserves only review evidence and rejects an expired session',async()=>{
  const browser=await chromium.launch({headless:true});
  try{
    const context=await browser.newContext(),generation=randomUUID();let signedIn=true,saved=[];
    await context.route('**/*',r=>r.fulfill({contentType:'text/html',body:`<html lang="en-US"><body><a id="nav-link-accountList" href="${signedIn?'/gp/css/homepage.html':'/ap/signin'}"><span id="nav-link-accountList-nav-line-1">${signedIn?'Hello, Private name':'Hello, sign in'}</span></a>${signedIn?'<a id="nav-item-signout">Sign Out</a>':''}<input id="ASIN" value="B000000001"><h1 id="productTitle">Example</h1><div id="glow-ingress-line2">Private address 60202</div><div id="corePriceDisplay_desktop_feature_div"><span data-pricetopay-label>$99.99</span></div><div id="customerReviews"><div id="cm-cr-dp-review-list"><div id="R1" data-hook="review"><a data-hook="review-title">Title</a><span data-hook="review-body">Body</span><span class="a-profile-name">Private reviewer</span></div></div></div></body></html>`}));
    const session={use:callback=>callback(context,generation)},saveEvidence=async(...args)=>{saved.push(args);return randomUUID();};
    const target={id:randomUUID(),asin:'B000000001',url:'https://www.amazon.com/dp/B000000001'},run={id:randomUUID(),profile:profile()};
    const result=await captureReviews(target,run,{session,saveEvidence});assert.equal(result.source,'browser-auth');assert.equal(result.fields.reviews.value[0].id,'R1');assert.equal(result.profile.session_generation,generation);
    assert.equal(result.profile.prime,'unobserved');assert.equal(result.coverage.login_verified,true);assert.ok(!Object.hasOwn(result.fields,'sale_price'));assert.equal(saved.length,1);assert.equal(saved[0][3],'application/json');assert.ok(!saved[0][2].includes('Private'));assert.ok(!saved[0][2].includes('99.99'));
    signedIn=false;await assert.rejects(()=>captureReviews(target,run,{session,saveEvidence}),e=>e.sessionInvalid===true);assert.equal(saved.length,1);
  }finally{await browser.close();}
});
