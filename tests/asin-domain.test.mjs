import test from 'node:test';
import assert from 'node:assert/strict';
import {parseASIN,profile,value,unknown,absent,count,equal,diffField,reviewChanges,validateFields} from '../lib/asin-domain.mjs';
import {fieldsFromDOM} from '../lib/asin-capture.mjs';
const price=n=>value(n,'',{currency:'USD',scope:'featured-new'});
test('ASIN input canonicalizes product URLs and rejects foreign or executable URLs',()=>{
  assert.equal(parseASIN('https://www.amazon.com/product/dp/B0D6SX8VLQ?tag=test').asin,'B0D6SX8VLQ');
  assert.equal(parseASIN('b0d6sx8vlq').url,'https://www.amazon.com/dp/B0D6SX8VLQ');
  for(const input of ['https://amazon.com.evil.test/dp/B0D6SX8VLQ','https://amazon.com@127.0.0.1/dp/B0D6SX8VLQ','http://amazon.com/dp/B0D6SX8VLQ','file:///etc/passwd','short'])assert.throws(()=>parseASIN(input));
  assert.throws(()=>parseASIN('B0D6SX8VLQ','UK'));
});
test('Unsupported Prime, locale and review sorting contexts are not silently relabeled',()=>{
  assert.equal(profile({zip:'10001'}).zip,'10001');
  for(const p of [{prime:true},{currency:'EUR'},{reviews:'newest'},{zip:'000000'},{login:'member'}])assert.throws(()=>profile(p));
});
test('Unknown and failed captures never generate deletions or zero-price events',()=>{
  assert.equal(diffField('sale_price',price(100),unknown()),null);
  assert.equal(diffField('title',value('Old'),{state:'failed'}),null);
  assert.equal(diffField('title',value('Old'),absent()).status,'pending');
  assert.equal(diffField('sale_price',price(100),absent()).kind,'not_displayed');
});
test('Price changes retain exact before/after values, numeric deltas and configurable severity',()=>{
  const event=diffField('sale_price',price(100),price(90),{price_percent:5});
  assert.equal(event.delta,-10);assert.equal(event.percent,-10);assert.equal(event.severity,'important');
  assert.equal(diffField('sale_price',price(100),price(99),{price_percent:5}).severity,'info');
  assert.equal(diffField('sale_price',value(0,'',{currency:'USD'}),value(10,'',{currency:'USD'})).percent,null);
});
test('Rounded counts retain raw values without fabricated exact count deltas',()=>{
  assert.equal(count('1,234 ratings').value,1234);assert.equal(count('1.2K ratings').value,null);
  const e=diffField('rating_count',count('1.2K ratings'),count('1.3K ratings'));assert.equal(e.delta,null);assert.equal(e.percent,null);
  assert.equal(diffField('rating_count',value(1000),value(950)).status,'pending');
});
test('Text whitespace and image delivery URLs do not create semantic changes',()=>{
  assert.equal(diffField('title',value('Hello  World'),value('Hello\nWorld')),null);
  assert.ok(equal(value([{key:'one',pixel_hash:'same',sha256:'one',asset_id:'1',url:'https://a'}]),value([{key:'two',pixel_hash:'same',sha256:'two',asset_id:'2',url:'https://b'}])));
  const a=value([{key:'a',sha256:'a'},{key:'b',sha256:'b'}]),b=value([{key:'b',sha256:'b'},{key:'a',sha256:'a'}]);
  assert.equal(diffField('images',a,b).kind,'reordered');
});
test('Content change at the same image URL is detected',()=>{
  const e=diffField('images',value([{key:'a',sha256:'old',url:'https://example.com/a.jpg'}]),value([{key:'a',sha256:'new',url:'https://example.com/a.jpg'}]));assert.equal(e.kind,'updated');
});
test('Review entry, exit and movement never assert deletion of a review',()=>{
  const a=[{id:'R1',position:1,body:'same'},{id:'R2',position:2,body:'same'}];
  const b=[{id:'R3',position:1,rating:1},{id:'R1',position:2,body:'same'}];
  assert.deepEqual(reviewChanges(a,b).map(x=>x.kind),['entered','moved','left']);
  const e=diffField('reviews',value(a),value(b));assert.equal(e.status,'pending');assert.equal(e.severity,'important');
});
test('Review fragment changes cannot be asserted as full text edits',()=>{
  const r={id:'R1',position:1,body:'Some text',complete:false,language:'en-US'};
  assert.equal(reviewChanges([r],[{...r,body:'Some text more'}])[0].kind,'display_changed');
  assert.equal(reviewChanges([{...r,complete:true}],[{...r,body:'Edited',complete:true}])[0].kind,'edited');
});
test('Scope changes are excluded from numeric comparisons',()=>{
  const e=diffField('rating_count',value(100,'',{scope:'parent'}),value(20,'',{scope:'child'}));
  assert.equal(e.kind,'scope_changed');assert.equal(e.delta,undefined);assert.equal(e.status,'pending');
});
test('Snapshot validation catches invalid ratings, currencies, duplicate review IDs and counts',()=>{
  for(const f of [{rating:value(5.1)},{rating_count:value(1.5)},{sale_price:value(5,'',{currency:'EUR'})},{images:value(['url'])},{reviews:value([{id:'r',position:1},{id:'r',position:2}])}])assert.throws(()=>validateFields(f));
  assert.equal(validateFields({title:value('<script>not executable</script>')}).title.value,'<script>not executable</script>');
});
test('DOM normalization retains unavailable fields and separates ratings from written reviews',()=>{
  const f=fieldsFromDOM({title:'Product',price:'$1,299.99',rating:'4.7 out of 5 stars',rating_count:'1,234 ratings',written_review_count:'1,234 global ratings | 80 global reviews',images:[],promotions:[],reviews:[]});
  assert.equal(f.sale_price.value,1299.99);assert.equal(f.rating.value,4.7);assert.equal(f.rating_count.value,1234);assert.equal(f.written_review_count.value,80);
  assert.equal(f.promotions.state,'unknown');assert.equal(f.reviews.state,'unknown');assert.equal(f.images.state,'unknown');
  assert.deepEqual(Object.keys(fieldsFromDOM({},'price')),['sale_price','reference_price','seller','promotions','availability']);
});
