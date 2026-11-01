'use strict';
window.Rivals=(()=>{
  const r={brands:[],id:null,data:null,tab:'events',year:0,month:'',kind:'announcements',page:1,line:null,query:'',request:0,archived:false,drawer:null,priceYear:0,priceMonth:0,from:'',to:'',series:{sale:true,list:true,effective:true}};
  const roles={own:'自有品牌',priority:'重点对手',competitor:'补充对照'};
  const productStatus={onsale:'在售',preorder:'预售',discontinued:'已停售'};
  const specs=p=>{const s=p.specs||{};return [s.lens_count?`单机 ${s.lens_count} 镜头`:'',s.pack_quantity?`${s.pack_quantity} 台装`:'',s.power||'',s.note||''].filter(Boolean).map(x=>`<span>${esc(x)}</span>`).join('');};
  const kinds={launch:'新品发布',promotion:'促销活动',important:'重要公告',guide:'使用指南',story:'品牌故事'};
  const calendar=window.RivalCalendar;
  const stock={in_stock:'在售',out_of_stock:'缺货',unknown:'库存未知'};
  const money=(n,currency=r.data?.competitor.currency||'USD')=>n==null?'—':new Intl.NumberFormat('zh-CN',{style:'currency',currency,currencyDisplay:'narrowSymbol',minimumFractionDigits:2,maximumFractionDigits:2}).format(Number(n));
  const currentBrand=()=>r.data.competitor;
  const ownBrandName=()=>r.brands.find(b=>b.role==='own'&&!b.archived)?.name||'我的品牌';
  const isDemo=()=>r.id==='demo';
  const effective=o=>o.coupon_type==='none'?o.sale_price:o.coupon_public?Math.round((o.coupon_type==='percent'?o.sale_price*(1-o.coupon_value/100):o.sale_price-o.coupon_value)*100)/100:null;
  const coupon=o=>o.coupon_type==='none'?'无优惠券':o.coupon_type==='percent'?`${o.coupon_value}% 优惠券`:`减 ${money(o.coupon_value)}`;
  const observations=id=>r.data.observations.filter(o=>o.listing_id===id);
  const latest=id=>observations(id).at(-1);
  const lineProducts=()=>r.data.products.filter(p=>p.line===r.line&&(!r.query||`${p.name} ${p.variant} ${p.line}`.toLowerCase().includes(r.query.toLowerCase())));
  const smallEmpty=(title,text)=>`<div class="rival-empty">${icon('chart')}<h3>${title}</h3><p>${text}</p></div>`;
  function demoData(){
    const y=Number(today().slice(0,4)),stamp=`${y}-10-24`;
    const products=[{id:'d-p1',line:'桌面充电',name:'Desk One 100W',variant:'黑色 · 3C1A · 美规',launched_at:`${y}-01-15`,status:'onsale'},{id:'d-p2',line:'桌面充电',name:'Desk Pro 140W',variant:'黑色 · 4C · 美规',launched_at:`${y}-09-08`,status:'onsale'},{id:'d-p3',line:'移动电源',name:'Pocket 10K',variant:'黑色 · 10,000mAh · 30W',launched_at:`${y}-06-12`,status:'onsale'}];
    const platforms=['品牌官网','Amazon US','Walmart'];
    const listings=products.flatMap((p,i)=>platforms.map((platform,j)=>({id:`d-l${i}${j}`,product_id:p.id,platform,seller:j===2?'Aster 官方店':'Aster 官方自营',url:'https://example.com/'})));
    const obs=[];
    for(const [i,p] of products.entries())for(let j=0;j<3;j++){
      for(let time=dateValue(p.launched_at);time<=Math.min(dateValue(today()),dateValue(stamp));time+=dayMs){
        const day=new Date(time).toISOString().slice(0,10),d=Number(day.slice(8)),m=Number(day.slice(5,7)),base=[79.99,119.99,39.99][i];
        // Deliberate gaps demonstrate that missing days are never filled with inferred prices.
        if(m===8&&d>=10&&d<=22)continue;
        const promo=(m===7&&d>=8&&d<=16)||(m===10&&d>=8&&d<=14);
        const price=base-(promo?20:0)+(j===2?5:0)-(m>=5&&i===0?5:0);
        const o={id:`d-o${i}${j}${day}`,listing_id:`d-l${i}${j}`,observed_on:day,list_price:base+10,sale_price:price,coupon_type:j===1&&m===10?'percent':'none',coupon_value:10,coupon_public:true,conditions:'',rating:4.5+(j===0?.1:0),review_count:Math.floor((time-dateValue(p.launched_at))/dayMs*(j===1?8:2))+15,availability:'in_stock',source_url:'https://example.com/'};
        o.effective_price=effective(o);obs.push(o);
      }
    }
    const events=[
      ['launch','Desk One 100W 上线','推出 100W 桌面充电器，提供 3C1A 接口。','01-15',null,null],
      ['launch','Pocket 10K 加入移动电源产品线','新增 10,000mAh、30W 便携型号。','06-12',null,null],
      ['promotion','夏季促销窗口','桌面充电产品参与限时降价，按平台分别记录到手价。','07-03','07-08','07-16'],
      ['launch','Desk Pro 140W 发布','桌面系列新增 140W 四口型号。','09-08',null,null],
      ['promotion','秋季活动开启','部分桌面型号降价，Amazon 示例另含 10% 优惠券。','10-07','10-08','10-14'],
      ['important','桌面系列补货','官网恢复黑色版本库存。','10-21',null,null],
      ['promotion','年末促销预告','已公布活动窗口，具体折扣尚未公布。','10-23','11-20','11-30']
    ].map(([kind,title,summary,pub,start,end],i)=>({id:`d-e${i}`,kind,title,summary,published_on:`${y}-${pub}`,starts_on:start?`${y}-${start}`:null,ends_on:end?`${y}-${end}`:null,source_url:'https://example.com/'})).filter(e=>e.published_on<=today()).sort((a,b)=>b.published_on.localeCompare(a.published_on));
    return {competitor:{id:'demo',name:'Aster',market:'美国',currency:'USD',website:'',sources:[],paused:false,archived:false},products,listings,observations:obs,events};
  }
  async function open(){
    try{r.brands=(await api('/api/competitors')).items;if(!r.id||(!isDemo()&&!r.brands.some(b=>b.id===r.id)))r.id=(r.brands.find(b=>!b.archived&&b.role==='priority'&&b.product_count&&b.focus?.includes('2K'))||r.brands.find(b=>!b.archived&&b.role==='priority'&&b.product_count)||r.brands.find(b=>!b.archived))?.id||'demo';r.query='';await select(r.id);}
    catch(e){$('#competitorsSection').innerHTML=smallEmpty('竞品数据暂时无法载入',esc(e.message));}
  }
  async function select(id){
    const request=++r.request;r.id=id;r.line=null;r.page=1;
    try{const data=id==='demo'?demoData():await api('/api/competitors/'+id);if(request!==r.request)return;r.data=data;r.line=data.products[0]?.line||null;render();}
    catch(e){if(request===r.request)toast(e.message);}
  }
  function render(){
    if(!r.data)return;
    const c=currentBrand(),brands=r.brands.filter(b=>r.archived||!b.archived),lines=[...new Set(r.data.products.map(p=>p.line))];
    $('#competitorsSection').innerHTML=`<div class="rival-topline"><p>${esc(ownBrandName())} 竞品档案 · 美国市场 · 重点看 2K 室内插电摄像头</p><div><button class="button button-outline" data-r-action="demo">查看交互示例</button><button class="button button-mint" data-r-action="add">＋ 添加竞品</button></div></div>
      <div class="rival-layout"><aside class="rival-sidebar"><div class="rival-list-heading">品牌档案 <span>${r.brands.filter(b=>!b.archived).length}</span></div>${brands.map(b=>`<button class="brand-item ${r.id===b.id?'active':''}" data-r-brand="${esc(b.id)}"><span class="brand-monogram">${esc(b.name.slice(0,1))}</span><span><strong>${esc(b.name)}</strong><small>${esc(b.market)} · ${b.archived?'已归档':b.paused?'已暂停':roles[b.role]||'补充对照'}${b.event_count?' · 已收录 '+(b.announcement_count??b.event_count)+' 条公告':''}</small></span></button>`).join('')||'<p class="rival-list-empty">添加品牌，建立你的竞品档案。</p>'}<button class="brand-item demo-brand ${isDemo()?'active':''}" data-r-brand="demo"><span class="brand-monogram">A</span><span><strong>Aster <i>示例</i></strong><small>虚构品牌 · 仅供体验</small></span></button><label class="archive-brands"><input id="showArchived" type="checkbox" ${r.archived?'checked':''}>显示已归档</label></aside>
      <div class="rival-main">${isDemo()?'<div class="demo-notice"><span>交互示例</span>品牌、事件与价格均为虚构；不会写入你的数据库。</div>':''}
      <div class="brand-heading"><div><div class="eyebrow">${esc(c.market)} / ${esc(c.currency)}${isDemo()?' · DEMO':''}</div><h2>${esc(c.name)}<span class="brand-status">${isDemo()?'示例品牌':c.archived?'已归档':c.paused?'已暂停':roles[c.role]||'补充对照'}</span></h2><p>已收录 ${r.data.events.filter(calendar.isAnnouncement).length} 条公告 <span>·</span> ${r.data.events.filter(e=>!calendar.isAnnouncement(e)).length} 篇指南与故事 <span>·</span> ${lines.length} 条产品线</p></div>${!isDemo()?`<button class="button button-outline" data-r-action="edit">品牌设置 ${icon('source')}</button>`:''}</div>
      ${c.focus?`<p class="brand-focus">${esc(c.focus)}</p>`:''}
      ${!isDemo()?coverageView():''}
      <div class="rival-tabs" role="tablist" aria-label="竞品视图"><button role="tab" aria-selected="${r.tab==='events'}" data-r-tab="events" class="${r.tab==='events'?'active':''}">${icon('calendar')}品牌动态</button><button role="tab" aria-selected="${r.tab==='products'}" data-r-tab="products" class="${r.tab==='products'?'active':''}">${icon('grid')}产品线与价格</button></div>
      <div id="rivalBody" role="tabpanel">${r.tab==='events'?eventsView():productsView()}</div></div></div>`;
  }
  function coverageView(){
    const c=currentBrand(),audits=r.data.coverage||[],checked=audits.map(a=>a.checked_on).sort().at(-1);
    const statuses={archive_complete:'公开归档已核齐',partial:'已补查，仍有缺口',unavailable:'尚未核齐',unconfirmed:'待确认'};
    return `<details class="brand-sources"><summary>收录范围 <span>${checked?'核对至 '+checked+' · 社媒尚未核齐':'来源待核对'}</span></summary><div class="coverage-list">${audits.map(a=>`<div class="coverage-row"><strong>${esc(a.label)} <small>${statuses[a.status]||'待核对'}</small></strong><p>${esc(a.detail)}</p><span>${a.period_start} — ${a.period_end}</span></div>`).join('')}</div><div>${[{label:'品牌官网',url:c.website},...c.sources,...audits.filter(a=>a.url).map(a=>({label:a.label,url:a.url}))].filter((s,i,all)=>s.url&&all.findIndex(t=>t.url===s.url)===i).map(s=>`<a href="${href(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.label)} ${icon('external')}</a>`).join('')||'尚未设置来源链接'}</div><p>按官方原文逐篇收录；同一事件的不同官方文章可能分别出现。当前为已核对的历史归档，定时采集尚未接通。</p></details>`;
  }
  function eventsView(){
    const years=[...new Set([Number(today().slice(0,4)),...r.data.events.map(e=>Number(e.published_on.slice(0,4)))])].sort((a,b)=>b-a);
    const options={today:today(),year:r.year,kind:r.kind,query:r.query};
    const base=calendar.filter(r.data.events,options),items=calendar.filter(base,{...options,month:r.month});
    const period=calendar.range(today(),r.year),pages=Math.max(1,Math.ceil(items.length/20));r.page=Math.min(r.page,pages);
    const pageItems=items.slice((r.page-1)*20,r.page*20);
    return `<div class="rival-year"><select id="rivalYear" aria-label="竞品动态年份"><option value="0" ${!r.year?'selected':''}>过去一年</option>${years.map(y=>`<option value="${y}" ${r.year===y?'selected':''}>${y} 年</option>`).join('')}</select><span>${period.start} — ${period.end}</span>${!isDemo()?'<button class="text-button" data-r-action="event">＋ 录入动态</button>':''}</div><div class="rival-months annual-months" aria-label="竞品动态月份">${['',...calendar.months(today(),r.year)].map(m=>`<button data-r-month="${m}" class="${r.month===m?'active':''}" aria-pressed="${r.month===m}" aria-label="竞品${m||'全部月份'}"><strong>${m?r.year?m.slice(5):m.slice(2).replace('-','.'):'全部'}</strong><small>${base.filter(e=>!m||e.published_on.startsWith(m)).length}</small></button>`).join('')}</div>
      <div class="rival-event-filters">${Object.entries({announcements:'全部公告',...kinds,all:'全部发布'}).map(([key,label])=>`<button class="${key===r.kind?'active':''}" aria-pressed="${key===r.kind}" data-r-kind="${key}">${label}</button>`).join('')}<span>已收录 ${items.length} 条</span></div>
      ${items.length?`<div class="rival-events">${pageItems.map(e=>`<article class="rival-event"><time datetime="${esc(e.published_on)}" title="${e.date_basis==='updated'?'原文更新日期':'发布日期'}"><small>${e.published_on.slice(0,4)}</small>${dateShort(e.published_on)}${e.date_basis==='updated'?'<small class="event-date-note">更新</small>':''}</time><span class="event-kind ${e.kind}">${kinds[e.kind]}</span><div><h3>${esc(e.title)}</h3><p>${esc(e.summary)}</p>${e.starts_on?`<small class="event-range">${e.kind==='launch'?'发售：':'活动：'}${dateFull(e.starts_on)}${e.ends_on?' — '+dateFull(e.ends_on):' 起'}${e.kind==='promotion'&&e.ends_on?e.ends_on<today()?' · 已结束':e.starts_on>today()?' · 未开始':' · 进行中':''}</small>`:''}</div>${isDemo()?'<span class="demo-tag">示例</span>':`<a href="${href(e.source_url)}" target="_blank" rel="noopener noreferrer" class="source-link" title="${esc(e.source_meta?.source_name||'官方原文')}">原文 ${icon('external')}</a>`}</article>`).join('')}</div>${pages>1?`<nav class="event-pagination" aria-label="公告分页"><button data-r-page="${r.page-1}" ${r.page===1?'disabled':''}>上一页</button><span>第 ${r.page} / ${pages} 页 · 共 ${items.length} 条</span><button data-r-page="${r.page+1}" ${r.page===pages?'disabled':''}>下一页</button></nav>`:''}`:smallEmpty(!r.data.events.length&&currentBrand().role==='own'?'待确认 '+esc(currentBrand().name)+' 官方来源':'所选时段暂无已收录动态',!r.data.events.length&&currentBrand().role==='own'?'补充品牌官网或官方社媒链接后收集，避免同名品牌混入。':'可切换月份或动态类型；无记录不表示品牌没有发布。')}${promotionView()}`;
  }
  function promotionView(){
    if(!['all','announcements','promotion'].includes(r.kind))return '';
    const period=calendar.range(today(),r.year,r.month),start=dateValue(period.start),end=dateValue(period.end)+dayMs;
    const events=r.data.events.map(e=>e.source_meta?.promotion_window?{...e,...e.source_meta.promotion_window,kind:'promotion'}:e).filter(e=>e.kind==='promotion'&&(!r.query||`${e.title} ${e.summary}`.toLowerCase().includes(r.query.toLowerCase()))&&e.starts_on&&e.ends_on&&dateValue(e.ends_on)>=start&&dateValue(e.starts_on)<end);
    if(!events.length)return '';
    const x=d=>Math.max(0,Math.min(100,(dateValue(d)-start)/(end-start)*100));
    return `<section class="promo-calendar"><div class="panel-heading"><h3>促销时间带</h3><small>按活动日期 · ${r.month||r.year||'过去一年'}</small></div><div class="promo-scale"><span>${period.start}</span><span>${new Date((start+end)/2).toISOString().slice(0,7)}</span><span>${period.end}</span></div>${events.map(e=>`<div class="promo-row"><span title="${esc(e.title)}">${esc(e.title)}</span><div><i style="left:${x(e.starts_on)}%;width:${Math.max(1,x(new Date(dateValue(e.ends_on)+dayMs).toISOString().slice(0,10))-x(e.starts_on))}%" title="${esc(e.title)}：${e.starts_on} → ${e.ends_on}" role="img" aria-label="${esc(e.title)}：${e.starts_on} 至 ${e.ends_on}"></i></div><small>${dateShort(e.starts_on)}—${dateShort(e.ends_on)}</small></div>`).join('')}</section>`;
  }
  function productsView(){
    const lines=[...new Set(r.data.products.map(p=>p.line))],products=lineProducts();
    const listings=r.data.listings.filter(l=>products.some(p=>p.id===l.product_id));
    const columns=[...new Set(listings.map(l=>`${l.platform}\u0000${l.seller}`))];
    return `<div class="product-section-head"><p>同款同规格横向对比 · ${esc(currentBrand().market)} / ${esc(currentBrand().currency)}</p>${!isDemo()?'<button class="button button-outline" data-r-action="product">＋ 新增型号</button>':''}</div>
      <div class="product-lines">${lines.map((line,i)=>`<button class="product-line ${r.line===line?'active':''}" data-r-line="${esc(line)}" aria-pressed="${r.line===line}"><span class="line-icon">${icon(i%2?'bag':'grid')}</span><span><strong>${esc(line)}</strong><small>${r.data.products.filter(p=>p.line===line).length} 个型号</small></span>${icon('chevron')}</button>`).join('')}</div>
      ${products.length?`<div class="comparison-heading"><h3>${esc(r.line)} <span>${products.length} 个型号</span></h3><small>点击价格展开历史</small></div><div class="comparison-scroll" tabindex="0" aria-label="跨平台价格表，可横向滚动"><table class="comparison-table"><thead><tr><th scope="col">型号 / 规格</th>${columns.map(key=>{const [platform,seller]=key.split('\u0000');return `<th scope="col">${esc(platform)}<small>${esc(seller)}</small></th>`;}).join('')}${!isDemo()?'<th scope="col">平台管理</th>':''}</tr></thead><tbody>${products.map(p=>`<tr><th scope="row"><strong>${esc(p.name)}</strong><span>${esc(p.variant)}</span><div class="product-specs">${specs(p)}</div><small>${productStatus[p.status]||'状态待确认'} · ${p.launched_at?dateFull(p.launched_at)+' 上线':'上线日待确认'}</small></th>${columns.map(key=>{const links=listings.filter(l=>l.product_id===p.id&&`${l.platform}\u0000${l.seller}`===key);return `<td>${links.length?links.map(priceCell).join(''):'<span class="no-listing">未关联商品</span>'}</td>`;}).join('')}${!isDemo()?`<td><button class="text-button" data-r-listing="${esc(p.id)}">＋ 关联平台</button></td>`:''}</tr>`).join('')}</tbody></table></div><p class="comparison-note">价格按最近一次记录展示，不含运费和税费；评论数采用页面原值，可能包含共享变体。缺失项显示「—」。</p>`:smallEmpty(r.query?'没有匹配的型号':currentBrand().role==='own'?esc(currentBrand().name)+' 产品资料待补充':'还没有产品线',r.query?'试试其他型号或清空搜索。':currentBrand().role==='own'?esc(currentBrand().name)+' 已设为自有品牌。补充官网或商品链接后，再建立准确的型号对照。':'新增一个型号，填写产品线和具体规格，再关联平台商品。')}`;
  }
  function priceCell(l){
    const o=latest(l.id),pack=r.data.products.find(p=>p.id===l.product_id)?.specs?.pack_quantity;
    if(!o)return `<button class="no-price" data-r-price="${esc(l.id)}">暂无价格记录 ${icon('arrow')}</button><a class="product-source" href="${href(l.url)}" target="_blank" rel="noopener noreferrer">商品原页 ↗</a>`;
    return `<div class="price-cell"><button class="price-main" data-r-price="${esc(l.id)}" aria-label="${esc(l.platform)} ${esc(r.data.products.find(p=>p.id===l.product_id).name)} 价格历史"><strong>${money(o.sale_price)}</strong>${icon('chart')}</button>${pack>1?`<span class="price-freshness">整套价 · 折合单台 ${money(o.sale_price/pack)}</span>`:''}${o.list_price!=null?`<span class="price-list">划线价 <s>${money(o.list_price)}</s></span>`:''}${o.coupon_type!=='none'?`<span class="coupon-tag">${esc(coupon(o))}</span><span class="price-after">${o.effective_price!=null?'券后 '+money(o.effective_price):'条件优惠 · 详见历史'}</span>`:''}<div class="rating-line">${o.rating==null?'评分 —':'★ '+o.rating.toFixed(1)}<span>· ${o.review_count==null?'评论 —':o.review_count.toLocaleString()+' 评论'}</span></div><small class="price-freshness">${stock[o.availability]} · ${dateFull(o.observed_on)} 记录</small>${!isDemo()?`<a class="product-source" href="${href(l.url)}" target="_blank" rel="noopener noreferrer">商品原页 ↗</a>`:''}</div>`;
  }
  function openPrice(id){r.drawer=id;r.priceYear=0;r.priceMonth=0;r.from='';r.to='';renderPrice();if(!$('#priceDrawer').open)$('#priceDrawer').showModal();}
  function renderPrice(){
    const l=r.data.listings.find(l=>l.id===r.drawer);if(!l)return;
    const p=r.data.products.find(p=>p.id===l.product_id),history=observations(l.id),o=history.at(-1);
    const years=[...new Set(history.map(o=>Number(o.observed_on.slice(0,4))))].sort((a,b)=>b-a);
    const filtered=history.filter(o=>(!r.priceYear||Number(o.observed_on.slice(0,4))===r.priceYear)&&(!r.priceMonth||Number(o.observed_on.slice(5,7))===r.priceMonth)&&(!r.from||o.observed_on>=r.from)&&(!r.to||o.observed_on<=r.to));
    const daily=[...new Map(filtered.map(o=>[o.observed_on,o])).values()];
    const prices=daily.map(o=>o.sale_price);
    $('#priceContent').innerHTML=`<div class="drawer-top"><div class="eyebrow">PRICE HISTORY ${isDemo()?'· 虚构数据示例':''}</div><button class="icon-button" data-r-action="close-price" aria-label="关闭价格历史">${icon('close')}</button></div><h2 id="priceTitle">${esc(p.name)}</h2><p class="drawer-subtitle">${esc(p.variant)} · ${esc(l.platform)} · ${esc(l.seller)}</p>
      <div class="price-summary"><div><span>最近记录售价</span><strong>${money(o?.sale_price)}</strong><small>${o?dateFull(o.observed_on):'暂无记录'}</small></div><div><span>筛选期最低售价</span><strong>${prices.length?money(Math.min(...prices)):'—'}</strong><small>${daily.length} 个有记录日期</small></div><div><span>最近券后价</span><strong>${o?money(o.effective_price):'—'}</strong><small>${o?esc(coupon(o)):'暂无记录'}</small></div></div>
      ${o?.conditions?`<div class="coupon-conditions">记录说明：${esc(o.conditions)}</div>`:''}
      <div class="history-filters"><select id="priceYear" aria-label="价格历史年份"><option value="0">全部年份</option>${years.map(y=>`<option value="${y}" ${r.priceYear===y?'selected':''}>${y} 年</option>`).join('')}</select><select id="priceMonth" aria-label="价格历史月份"><option value="0">全部月份</option>${Array.from({length:12},(_,i)=>`<option value="${i+1}" ${r.priceMonth===i+1?'selected':''}>${i+1} 月</option>`).join('')}</select><label>从<input id="priceFrom" aria-label="价格历史开始日期" type="date" value="${r.from}"></label><label>至<input id="priceTo" aria-label="价格历史结束日期" type="date" value="${r.to}"></label><button class="text-button" data-r-action="reset-price">重置</button></div>
      <div class="chart-legend">${[['sale','页面售价'],['list','划线价'],['effective','券后价']].map(([key,label])=>`<label class="legend-${key}"><input type="checkbox" data-r-series="${key}" ${r.series[key]?'checked':''}><i></i>${label}</label>`).join('')}<span>断线处为缺失日期</span></div>
      <div class="price-chart">${priceChart(daily)}</div><div id="priceHover" class="price-hover" aria-live="polite">悬停或用 Tab 选中价格点，查看当日明细。</div>
      <div class="history-coverage"><span>上线：${dateFull(p.launched_at)}</span><span>已存记录：${history.length?dateFull(history[0].observed_on)+' — '+dateFull(history.at(-1).observed_on):'尚未开始'}</span></div>
      <div class="history-heading"><h3>每日记录 <span>${filtered.length}</span></h3>${!isDemo()?`<button class="text-button" data-r-observation="${esc(l.id)}">＋ 记录价格</button>`:'<span class="demo-tag">示例数据</span>'}</div>
      <div class="history-scroll"><table class="history-table"><thead><tr><th>日期</th><th>售价</th><th>划线价</th><th>优惠券 / 条件</th><th>券后价</th><th>评分 / 评论</th></tr></thead><tbody>${[...filtered].reverse().map(o=>`<tr><td>${dateFull(o.observed_on)}</td><td>${money(o.sale_price)}</td><td>${money(o.list_price)}</td><td>${esc(coupon(o))}${o.conditions?`<small>${esc(o.conditions)}</small>`:''}</td><td>${money(o.effective_price)}</td><td>${o.rating??'—'} / ${o.review_count??'—'}</td></tr>`).join('')||'<tr><td colspan="6">所选范围内暂无价格记录</td></tr>'}</tbody></table></div>
      <div class="drawer-footer"><span>币种 ${esc(currentBrand().currency)} · 不含运费和税费 · 同日曲线采用最后一条记录</span>${!isDemo()?`<a class="button button-outline" href="${href(l.url)}" target="_blank" rel="noopener noreferrer">平台原页 ${icon('external')}</a>`:''}</div>`;
  }
  function priceChart(points){
    if(!points.length)return smallEmpty('暂无可绘制的价格','添加记录或调整时间范围。');
    const series=[['sale','sale_price'],['list','list_price'],['effective','effective_price']].filter(([key])=>r.series[key]);
    const value=(p,field)=>field==='effective_price'&&p.coupon_type==='none'?null:p[field];
    const values=points.flatMap(p=>series.map(([,key])=>value(p,key)).filter(n=>n!=null));
    if(!values.length)return smallEmpty('选择一种价格','勾选上方图例，显示对应价格曲线。');
    const min=Math.max(0,Math.min(...values)*.9),max=Math.max(...values)*1.08||1;
    const start=dateValue(points[0].observed_on),end=dateValue(points.at(-1).observed_on);
    const width=matchMedia('(max-width:760px)').matches?400:788,left=50,right=width-20,plotWidth=right-left;
    const x=d=>end===start?left+plotWidth/2:left+(dateValue(d)-start)/(end-start)*plotWidth,y=n=>208-(n-min)/(max-min)*170;
    const grid=Array.from({length:5},(_,i)=>{const v=min+(max-min)*i/4,yy=y(v);return `<line x1="${left}" x2="${right}" y1="${yy}" y2="${yy}" class="chart-grid"/><text x="${left-10}" y="${yy+4}" text-anchor="end">${v.toFixed(0)}</text>`;}).join('');
    const lines=series.map(([key,field])=>{let path='',previous=null;for(const p of points){const v=value(p,field);if(v==null){previous=null;continue;}path+=`${previous&&dateValue(p.observed_on)-dateValue(previous.observed_on)<=2*dayMs?'L':'M'}${x(p.observed_on).toFixed(2)},${y(v).toFixed(2)} `;previous=p;}return `<path d="${path}" class="price-series series-${key}"/>`+points.filter(p=>value(p,field)!=null).map(p=>`<circle cx="${x(p.observed_on)}" cy="${y(p[field])}" r="${points.length>80?1.8:3}" class="price-point series-${key}" data-r-point="${esc(p.id)}" tabindex="0" role="img" aria-label="${p.observed_on} ${key==='sale'?'售价':key==='list'?'划线价':'券后价'} ${money(p[field])}"><title>${p.observed_on} · ${money(p[field])}</title></circle>`).join('');}).join('');
    const labels=Array.from({length:end===start?1:5},(_,i)=>{const t=end===start?start:start+(end-start)*i/4;return `<text x="${end===start?left+plotWidth/2:left+plotWidth*i/4}" y="239" text-anchor="middle">${dateShort(new Date(t).toISOString())}</text>`;}).join('');
    return `<svg viewBox="0 0 ${width} 255" class="history-svg" role="img" aria-label="价格趋势，缺失超过两天的记录不连线">${grid}${lines}${labels}</svg>`;
  }
  const field=(label,name,value='',type='text',extra='')=>`<label class="form-field">${label}<input name="${name}" type="${type}" value="${esc(value??'')}" ${extra}></label>`;
  const selectField=(label,name,choices,value)=>`<label class="form-field">${label}<select name="${name}">${choices.map(([v,t])=>`<option value="${esc(v)}" ${v===value?'selected':''}>${esc(t)}</option>`).join('')}</select></label>`;
  function form(kind,target){
    if(isDemo()&&!['add'].includes(kind))return toast('这是交互示例。添加真实竞品后即可保存记录。');
    const c=kind==='edit'?currentBrand():{},maxDate=today();let title='',fields='',note='';
    if(kind==='add'||kind==='edit'){
      title=kind==='add'?'添加竞品':'品牌设置';fields=field('品牌名称','name',c.name,'text','required maxlength="80"')+field('国家 / 市场','market',c.market||'美国','text','required maxlength="60"')+selectField('币种','currency',['USD','EUR','GBP','CAD','AUD','JPY','CNY'].map(x=>[x,x]),c.currency||'USD')+selectField('品牌角色','role',Object.entries(roles),c.role||'competitor')+field('关注重点','focus',c.focus,'text','maxlength="160"')+field('品牌官网（可选）','website',c.website,'url','placeholder="https://"')+`<label class="form-field form-full">社媒、新闻页、店铺链接（每行一个）<textarea name="source_lines" rows="4" placeholder="https://www.instagram.com/品牌账号\nhttps://…">${esc((c.sources||[]).map(s=>s.url).join('\n'))}</textarea></label>`;
      if(kind==='edit')fields+=`<label class="form-check"><input type="checkbox" name="paused" ${c.paused?'checked':''}>暂停跟踪</label><label class="form-check"><input type="checkbox" name="archived" ${c.archived?'checked':''}>归档竞品（保留记录）</label>`;
      note='配置保存在本地。各来源自动采集尚待接入；已有产品后，市场和币种保持固定。';
    }else if(kind==='product'){
      title='新增产品型号';fields=field('所属产品线','line',r.line||'','text','required maxlength="80" placeholder="如：桌面充电"')+field('型号名称','name','','text','required maxlength="100"')+field('规格 / 变体','variant','','text','required maxlength="120" placeholder="如：黑色 · 100W · 美规"')+field('上线日期（可选）','launched_at','','date')+selectField('销售状态','status',Object.entries(productStatus),'onsale')+field('单台设备镜头数（未知留空）','lens_count','','number','min="1" max="20" step="1"')+field('套装内设备台数（未知留空）','pack_quantity','','number','min="1" max="100" step="1"')+field('供电方式（可选）','power','','text','maxlength="60" placeholder="如：插电供电，Wi-Fi 联网"');note='相同型号、颜色、容量和包装才归入同一行比较。';
    }else if(kind==='listing'){
      title='关联平台商品';fields=field('平台名称','platform','','text','required maxlength="60" placeholder="如：Amazon US"')+field('卖家 / 店铺','seller','','text','required maxlength="100"')+field('商品链接','url','','url','required placeholder="https://"');note='请确认链接指向当前型号及规格；不同卖家会分列展示。';
    }else if(kind==='event'){
      title='录入竞品动态';fields=selectField('动态类型','kind',Object.entries(kinds),'launch')+field('发布日期','published_on',maxDate,'date',`required max="${maxDate}"`)+field('标题','title','','text','required maxlength="100"')+field('原文链接','source_url','','url','required placeholder="https://"')+`<label class="form-field form-full">一句话摘要（不超过 100 字）<textarea name="summary" maxlength="100" required rows="3"></textarea></label>`+field('活动开始日期（可选）','starts_on','','date')+field('活动结束日期（可选）','ends_on','','date');
    }else if(kind==='observation'){
      title='记录价格';fields=field('观察日期','observed_on',maxDate,'date',`required max="${maxDate}"`)+field('页面售价','sale_price','','number','required min="0" step="0.01"')+field('页面划线价（可选）','list_price','','number','min="0" step="0.01"')+selectField('优惠券类型','coupon_type',[['none','无优惠券'],['amount','固定减额'],['percent','百分比优惠']],'none')+field('优惠数值','coupon_value','','number','min="0" step="0.01"')+selectField('库存状态','availability',Object.entries(stock),'unknown')+field('评分（可选，0–5）','rating','','number','min="0" max="5" step="0.1"')+field('评论数（可选）','review_count','','number','min="0" step="1"')+`<label class="form-check form-full"><input type="checkbox" name="coupon_public">已确认普通买家可领取，且可与当前售价叠加</label>`+field('优惠条件（会员、满额、订阅等）','conditions','','text','maxlength="300"')+field('记录来源链接','source_url',r.data.listings.find(l=>l.id===target)?.url,'url','required');note='仅对已确认可叠加的优惠计算券后价；空白评分和评论数按缺失值保存。';
    }
    $('#competitorFormContent').innerHTML=`<div class="form-heading"><h2 id="competitorFormTitle">${title}</h2><button type="button" class="icon-button" data-r-action="close-form" aria-label="关闭表单">${icon('close')}</button></div><form id="competitorForm" data-kind="${kind}" data-target="${esc(target||'')}" data-brand="${esc(r.id)}"><div class="form-grid">${fields}</div>${note?`<p class="form-note">${note}</p>`:''}<p id="competitorFormError" class="form-error" role="alert" hidden></p><div class="form-actions"><button type="button" class="button button-outline" data-r-action="close-form">取消</button><button class="button button-mint" type="submit">保存到本地</button></div></form>`;
    $('#competitorFormDialog').showModal();
  }
  async function submit(event){
    event.preventDefault();const f=event.target;if(f.id!=='competitorForm')return;
    const input=Object.fromEntries(new FormData(f)),kind=f.dataset.kind,target=f.dataset.target,brand=f.dataset.brand;let path='/api/competitors',payload=input;
    const button=f.querySelector('[type="submit"]');button.disabled=true;$('#competitorFormError').hidden=true;
    try{
      if(kind==='add'||kind==='edit'){
        const urls=(input.source_lines||'').split('\n').map(s=>s.trim()).filter(Boolean);
        payload={name:input.name,role:input.role,focus:input.focus,market:input.market,currency:input.currency,website:input.website,sources:urls.map(url=>({label:new URL(url).hostname.replace(/^www\./,''),url})),paused:f.elements.paused?.checked||false,archived:f.elements.archived?.checked||false};
        if(kind==='edit')path+='/'+brand;
      }else{
        path+='/'+brand+'/'+({product:'products',listing:'listings',event:'events',observation:'observations'}[kind]);
        if(kind==='listing')payload.product_id=target;
        if(kind==='observation'){payload.listing_id=target;payload.coupon_public=f.elements.coupon_public.checked;}
      }
      const result=await api(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
      $('#competitorFormDialog').close();toast('已保存到本地数据库');r.brands=(await api('/api/competitors')).items;
      if(kind==='add'){r.tab='events';r.month='';r.id=result.id;}
      if(kind==='product'||kind==='listing')r.tab='products';
      await select(r.id);
      if(kind==='product'){r.line=result.line;render();}
      if(kind==='observation')renderPrice();
    }catch(e){$('#competitorFormError').hidden=false;$('#competitorFormError').textContent=e.message.includes('Invalid URL')?'请检查来源链接，使用完整 HTTPS 地址。':e.message;}
    finally{button.disabled=false;}
  }
  document.addEventListener('submit',e=>{if(e.target.id==='competitorForm')submit(e);});
  document.addEventListener('click',async e=>{
    const b=e.target.closest('[data-r-brand]');if(b){await select(b.dataset.rBrand);return;}
    const tab=e.target.closest('[data-r-tab]');if(tab){r.tab=tab.dataset.rTab;render();return;}
    const month=e.target.closest('[data-r-month]');if(month){r.month=month.dataset.rMonth;r.page=1;render();return;}
    const kind=e.target.closest('[data-r-kind]');if(kind){r.kind=kind.dataset.rKind;r.page=1;render();return;}
    const page=e.target.closest('[data-r-page]');if(page){r.page=Math.max(1,Number(page.dataset.rPage));render();$('#rivalBody').scrollIntoView({block:'start'});return;}
    const line=e.target.closest('[data-r-line]');if(line){r.line=line.dataset.rLine;render();return;}
    const price=e.target.closest('[data-r-price]');if(price){openPrice(price.dataset.rPrice);return;}
    const listing=e.target.closest('[data-r-listing]');if(listing){form('listing',listing.dataset.rListing);return;}
    const observation=e.target.closest('[data-r-observation]');if(observation){form('observation',observation.dataset.rObservation);return;}
    const action=e.target.closest('[data-r-action]')?.dataset.rAction;
    if(action==='demo')await select('demo');
    else if(['add','edit','product','event'].includes(action))form(action);
    else if(action==='close-form')$('#competitorFormDialog').close();
    else if(action==='close-price')$('#priceDrawer').close();
    else if(action==='reset-price'){r.priceYear=0;r.priceMonth=0;r.from='';r.to='';renderPrice();}
  });
  document.addEventListener('change',e=>{
    if(e.target.id==='showArchived'){r.archived=e.target.checked;render();}
    else if(e.target.id==='rivalYear'){r.year=Number(e.target.value);r.month='';r.page=1;render();}
    else if(e.target.id==='priceYear'){r.priceYear=Number(e.target.value);r.priceMonth=0;r.from='';r.to='';renderPrice();}
    else if(e.target.id==='priceMonth'){r.priceMonth=Number(e.target.value);r.from='';r.to='';renderPrice();}
    else if(e.target.id==='priceFrom'||e.target.id==='priceTo'){
      const from=$('#priceFrom').value,to=$('#priceTo').value;
      if(from&&to&&from>to){toast('开始日期不能晚于结束日期');e.target.value=e.target.id==='priceFrom'?r.from:r.to;return;}
      r.from=from;r.to=to;r.priceYear=0;r.priceMonth=0;renderPrice();
    }else if(e.target.dataset.rSeries){r.series[e.target.dataset.rSeries]=e.target.checked;renderPrice();}
  });
  function hover(e){const point=e.target.closest('[data-r-point]');if(!point)return;const o=r.data.observations.find(o=>o.id===point.dataset.rPoint);if(o)$('#priceHover').textContent=`${dateFull(o.observed_on)} · 售价 ${money(o.sale_price)} · 划线价 ${money(o.list_price)} · ${coupon(o)} · 券后 ${money(o.effective_price)}${o.conditions?' · '+o.conditions:''}`;}
  document.addEventListener('pointerover',hover);document.addEventListener('focusin',hover);
  for(const id of ['priceDrawer','competitorFormDialog'])$('#'+id).addEventListener('click',e=>{if(e.target===e.currentTarget){const box=e.target.getBoundingClientRect();if(e.clientX<box.left||e.clientX>box.right||e.clientY<box.top||e.clientY>box.bottom)e.target.close();}});
  return {open,search:q=>{r.query=q;r.page=1;render();}};
})();
