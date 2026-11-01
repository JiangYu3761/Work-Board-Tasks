'use strict';
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const icon = (name,cls='')=>`<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const esc = value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const href = value=>{try{const u=new URL(value);return u.protocol==='https:'?esc(u.href):'#';}catch{return '#';}};
const categories={commerce:'跨境资讯',amazon:'亚马逊规则',policy:'美国政策',ai:'AI 与科技'};
const pageInfo={integrations:['外部接入','CONNECTIONS & AGENTS'],asin:['ASIN 监控','PRODUCT CHANGE INTELLIGENCE'],overview:['情报总览','YOUR DAILY ADVANTAGE'],competitors:['竞品监控','COMPETITIVE INTELLIGENCE'],'search-monitor':['搜索词监控','SEARCH VISIBILITY'],commerce:['跨境资讯','CROSS-BORDER COMMERCE'],amazon:['亚马逊规则','AMAZON POLICY WATCH'],policy:['美国政策与物流','POLICY & LOGISTICS'],ai:['AI 与科技','THE NEXT FRONTIER'],timeline:['政策日历','DATES THAT MATTER'],saved:['稍后阅读','YOUR READING LIST'],sources:['信息源','YOUR INFORMATION NETWORK']};
const state={week:'',weeks:[],nav:'overview',focus:'all',official:false,category:'all',query:'',days:0,sort:'latest',period:365,timelineYear:new Date().getFullYear(),expanded:false,year:new Date().getFullYear(),month:0,facets:[],dashboard:null,articles:[],cache:new Map(),request:0,syncing:false};
let toastTimer;
const dayMs=86400000;
function today(){return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date());}
function dateValue(d){return new Date(String(d).slice(0,10)+'T00:00:00Z').getTime();}
function dateShort(d){return d?String(d).slice(5,10).replace('-','.'):'';}
function dateFull(d){return d?String(d).slice(0,10).replaceAll('-','.'): '未提供';}
function daysUntil(d){return Math.round((dateValue(d)-dateValue(today()))/dayMs);}
function displayStatus(a){if(a.status==='proposed')return '征求意见';if(a.status==='scheduled')return daysUntil(a.effective_at)>0?'待生效':'已生效';return '';}
function toast(message){$('#toast').textContent=message;$('#toast').classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').classList.remove('visible'),4200);}
async function api(path,options={}){const res=await fetch(path,options);let data;try{data=await res.json();}catch{throw new Error('请通过本地服务打开页面：http://127.0.0.1:4317');}if(!res.ok)throw new Error(data.error||'请求失败');return data;}
function showError(error){$('#errorBanner').hidden=false;$('#errorBanner').textContent=error.message||String(error);}
function globe(){
  const stars=[[74,52],[289,64],[92,222],[297,239],[132,43],[252,207],[59,139],[233,44]];
  return `<svg class="feature-art" viewBox="0 0 360 290" aria-hidden="true"><defs><radialGradient id="orbGlow"><stop offset="0" stop-color="#9ce6c5" stop-opacity=".1"/><stop offset="1" stop-color="#9ce6c5" stop-opacity="0"/></radialGradient><clipPath id="orbClip"><circle cx="180" cy="145" r="83"/></clipPath></defs><circle cx="180" cy="145" r="126" fill="url(#orbGlow)" stroke="none"/><g stroke="#8ac5aa" stroke-width=".65" opacity=".37"><circle cx="180" cy="145" r="83"/><g clip-path="url(#orbClip)">${[24,49,70].map(rx=>`<ellipse cx="180" cy="145" rx="${rx}" ry="83"/>`).join('')}${[-50,-26,0,26,50].map(y=>`<ellipse cx="180" cy="${145+y}" rx="83" ry="${y===0?7:14}"/>`).join('')}<path d="m116 103 18-14 18 6 13-9 16 9-6 11 12 10-11 17-8 9-9-6-8 9-3 15-9 2-5-17-13-4-7-20m49 48 13 3 9 20-8 14-3 14-13 11-2-18-7-14 1-17m31-62 17-5 15 9 11-4 14 13 9 22-13 1-4 12-17-4-3-18-18-9-15-5m17 33 10 4 3 14-9 19-11 4-7-24 6-13m31 40 16-4 12 9-8 8-19-3z" fill="#8ac5aa" fill-opacity=".12" stroke-opacity=".8"/></g><circle cx="180" cy="145" r="103" stroke-dasharray="1 6" opacity=".55"/><g class="orbital"><ellipse cx="180" cy="145" rx="135" ry="42" transform="rotate(-34 180 145)"/><circle cx="280" cy="75" r="2" fill="#b0f1d2"/></g></g><path d="M147 123Q190 71 235 94" stroke="#b0f1d2" stroke-width="1" opacity=".6" stroke-dasharray="2 4"/><circle class="signal-halo" cx="235" cy="94" r="12" fill="none" stroke="#b0f1d2" stroke-opacity=".3"/><circle cx="235" cy="94" r="3" fill="#b0f1d2" stroke="none"/><circle cx="147" cy="123" r="2" fill="#b0f1d2" stroke="none"/>${stars.map(([x,y])=>`<circle class="star" cx="${x}" cy="${y}" r=".8" opacity=".4"/>`).join('')}</svg>`;
}
function renderOverview(){
  const d=state.dashboard;
  const featured=d.spotlights.find(a=>a.category==='amazon')||d.spotlights[0];
  if(featured){
    $('#featureCard').innerHTML=`<div class="feature-top">重点关注 / POLICY WATCH <span class="edition-no">VOL. 001</span></div>${globe()}<h2>${esc(featured.title)}</h2><p class="feature-summary">${esc(featured.summary)}</p><div class="feature-actions"><button class="button button-mint" data-open="${esc(featured.id)}">查看规则 ${icon('arrow')}</button><span class="feature-date">${featured.effective_at?dateFull(featured.effective_at)+' · '+displayStatus(featured):'已核实'}</span></div><div class="feature-bottom">AMAZON · UNITED STATES</div>`;
  }else{$('#featureCard').innerHTML='<h2>等待新的重要变化</h2>';}
  const upcoming=d.events.filter(e=>daysUntil(e.start_date&&daysUntil(e.start_date)>0?e.start_date:e.end_date)>=0).map(e=>({...e,nextDate:e.start_date&&daysUntil(e.start_date)>0?e.start_date:e.end_date})).sort((a,b)=>a.nextDate.localeCompare(b.nextDate));
  $('#deadlineList').innerHTML=upcoming.slice(0,3).map(e=>`<button class="deadline-item" data-open="${esc(e.article_id)}"><span class="date-tile"><b>${e.nextDate.slice(8,10)}</b><span>${e.nextDate.slice(5,7)} 月</span></span><span class="deadline-info"><strong>${esc(e.label)}</strong><small>${e.nextDate===e.start_date?'适用期开始':esc(e.kind==='意见期'?'征求意见截止':e.kind)}</small></span><span class="countdown">${daysUntil(e.nextDate)}<em>天后</em></span></button>`).join('')||'<p class="chart-subtitle">暂无临近的政策节点。</p>';
  const total=d.counts.reduce((a,b)=>a+b.count,0);
  const stats=[['grid','',total,'已收录资讯','CURATED UPDATES'],['globe','blue',d.counts.length,'资讯频道','YOUR CHANNELS'],['calendar','amber',upcoming.length,'待到节点','UPCOMING DATES'],['source','violet',d.sources.length,'来源入口','SOURCE NETWORK']];
  $('#signalStrip').innerHTML=stats.map(([i,c,v,t,en])=>`<div class="signal-stat"><div class="stat-icon ${c}">${icon(i)}</div><div><div class="stat-main"><strong>${String(v).padStart(2,'0')}</strong><small>${t}</small></div><div class="stat-caption">${en}</div></div></div>`).join('');
  for(const key of Object.keys(categories)){const count=d.counts.find(c=>c.category===key)?.count||0;document.querySelector(`[data-count="${key}"]`).textContent=count;}
  $('#savedCount').textContent=d.counts.reduce((a,b)=>a+b.saved,0);
  const metric=d.metrics[0];
  if(metric){$('#chartPeriod').textContent=metric.period;$('#marketChart').innerHTML=`<h3 class="chart-title">${esc(metric.title)}</h3><p class="chart-subtitle">${esc(metric.subtitle)}</p><div role="img" aria-label="${esc(metric.points.map(x=>x.label+'增长'+x.value+'%').join('；'))}">${metric.points.map(p=>`<div class="bar-row"><div class="bar-label"><span>${esc(p.label)}</span><b>+${esc(p.value)}<small>%</small></b></div><div class="bar-track"><div class="bar-fill" style="width:${Math.min(100,Math.max(0,p.value/40*100))}%"></div></div></div>`).join('')}</div><div class="chart-axis"><span>0%</span><span>10%</span><span>20%</span><span>30%</span><span>40%</span></div><div class="chart-foot"><span>统计期：${esc(metric.period)}</span><a href="${href(metric.source_url)}" target="_blank" rel="noopener noreferrer" class="source-link">原文 ${icon('external')}</a></div>`;}
  const ai=d.spotlights.find(a=>a.category==='ai');
  $('#aiSpotlight').hidden=!ai;
  if(ai)$('#aiSpotlight').innerHTML=`<div class="eyebrow">${icon('spark')} NEXT IN AI</div><h3>${esc(ai.title)}</h3><p>${esc(ai.summary)}</p><button class="text-button" data-open="${esc(ai.id)}">读懂这次变化 ${icon('arrow')}</button><div class="ai-orbits"></div>`;
  const last=d.lastRun;
  $('#updateLabel').textContent=last?.finished_at?`最近检查 ${new Date(last.finished_at).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})}${last.status==='complete'?'':' · 部分待更新'}`:'首批内容已核实';
  $('#footerStatus').textContent=d.pending?`${d.pending} 条新内容待整理`:'专注变化，保持清晰。';
  renderPriority();
  renderGantt();
}
function renderPriority(){
  const upcoming=state.dashboard.events.map(e=>({...e,next:e.start_date&&daysUntil(e.start_date)>=0?e.start_date:e.end_date})).filter(e=>daysUntil(e.next)>=0&&daysUntil(e.next)<=30).sort((a,b)=>a.next.localeCompare(b.next));
  $('#prioritySection').innerHTML=`<div class="priority-caption"><span class="live-marker"></span><strong>接下来 30 天</strong><span>${dateShort(today())} 起 · ${upcoming.length} 个已公布节点</span><button class="text-button" data-nav="timeline">全部日历 ${icon('arrow')}</button></div><div class="priority-grid">${upcoming.slice(0,2).map(e=>`<button class="priority-item" data-open="${esc(e.article_id)}"><span class="priority-number">${daysUntil(e.next)}<small>天后</small></span><span><strong>${esc(e.label)}</strong><small>${dateFull(e.next)} · ${esc(e.kind)}</small></span>${icon('chevron')}</button>`).join('')||'<div class="priority-item"><span class="muted">未来 30 天暂无已收录节点</span></div>'}<button class="priority-item rival-entry" data-nav="competitors"><span class="priority-icon">${icon('chart')}</span><span><strong>竞品在做什么？</strong><small>新品 · 促销 · 跨平台价格</small></span>${icon('arrow')}</button></div>`;
}
function renderGantt(){
  if(!state.dashboard)return;
  const annual=state.period===365;
  const years=[...new Set([Number(today().slice(0,4)),state.timelineYear,...state.dashboard.events.map(e=>Number(e.end_date.slice(0,4)))])].sort();
  $('#timelineYear').innerHTML=years.map(y=>`<option value="${y}" ${y===state.timelineYear?'selected':''}>${y} 年</option>`).join('');$('#timelineYear').hidden=!annual;
  const start=annual?dateValue(state.timelineYear+'-01-01'):dateValue(today()),end=annual?dateValue((state.timelineYear+1)+'-01-01'):start+state.period*dayMs;
  const x=d=>(dateValue(d)-start)/(end-start)*100;
  const events=state.dashboard.events.filter(e=>dateValue(e.end_date)>=start&&(annual?dateValue(e.start_date||e.end_date)<end:dateValue(e.start_date||e.end_date)<=end));
  const ticks=annual?Array.from({length:12},(_,i)=>`<span style="left:${x(state.timelineYear+'-'+String(i+1).padStart(2,'0')+'-01')}%">${i+1} 月</span>`).join(''):[0,1,2,3,4].map(i=>{const time=new Date(start+(end-start)*i/4);return `<span style="left:${i*25}%;${i===4?'transform:translateX(-100%)':''}">${i===0?'今天 · ':''}${String(time.getUTCMonth()+1).padStart(2,'0')}.${String(time.getUTCDate()).padStart(2,'0')}</span>`;}).join('');
  $('#ganttChart').innerHTML=`<div class="gantt"><div class="gantt-header"><span>规则 / 政策</span><div class="gantt-months">${ticks}</div></div>${events.map(e=>{
    const left=Math.max(0,x(e.start_date||e.end_date)),right=Math.min(100,x(e.end_date));
    const title=`${e.label} · ${e.start_date?dateFull(e.start_date)+' → ':''}${dateFull(e.end_date)} · ${e.kind}`;
    return `<div class="gantt-row"><button class="gantt-label" data-open="${esc(e.article_id)}" title="${esc(e.label)}">${esc(e.label)}</button><div class="gantt-track">${x(today())>=0&&x(today())<=100?`<i class="gantt-now" style="left:${x(today())}%" title="今天"></i>`:''}${e.start_date?`<button class="gantt-bar ${esc(e.color)}" data-open="${esc(e.article_id)}" style="left:${left}%;width:${Math.max(.5,right-left)}%" title="${esc(title)}" aria-label="${esc(title)}">${dateShort(e.end_date)}</button>`:`<button class="gantt-milestone ${esc(e.color)}" data-open="${esc(e.article_id)}" style="left:${left}%" title="${esc(title)}" aria-label="${esc(title)}">${left<86?dateShort(e.end_date):''}</button>`}</div></div>`;
  }).join('')||'<div class="loading-state">此时间范围内没有已收录的节点。</div>'}</div>`;
}
function card(a,index){
  const date=a.archive_date||a.published_at||a.effective_at;
  const status=displayStatus(a);
  return `<article class="news-row"><time class="row-date" datetime="${esc(date||'')}">${date?dateShort(date):'—'}<small>${a.date_basis==='effective'?'生效':date?'发布':'待定'}</small></time><span class="category-label ${esc(a.category)}">${esc(categories[a.category])}</span><div class="row-copy"><h3><button data-open="${esc(a.id)}">${esc(a.title)}</button>${status?`<span class="row-status ${a.status==='proposed'?'proposed':''}">${esc(status)}</span>`:''}</h3><p>${esc(a.summary)}</p></div><div class="row-tools"><a class="source-link" href="${href(a.url)}" target="_blank" rel="noopener noreferrer" title="打开${esc(a.source_name)}原文" aria-label="原文：${esc(a.title)}">原文 ${icon('external')}</a><button class="icon-button save-button ${a.saved?'saved':''}" data-save="${esc(a.id)}" aria-label="${a.saved?'取消收藏':'收藏'}：${esc(a.title)}" aria-pressed="${a.saved}">${icon('bookmark')}</button></div></article>`;
}
function renderArchive(){
  const now=today(),currentYear=Number(now.slice(0,4)),currentMonth=Number(now.slice(5,7));
  const years=[...new Set([currentYear,...state.facets.filter(f=>f.year).map(f=>f.year),...(state.year?[state.year]:[])])].sort((a,b)=>b-a);
  $('#yearSelect').innerHTML=years.map(y=>`<option value="${y}" ${state.year===y?'selected':''}>${y} 年</option>`).join('')+`<option value="0" ${!state.year?'selected':''}>全部年份</option>`;
  $('#previousYear').disabled=!state.year||state.year<=2000;$('#nextYear').disabled=!state.year||state.year>=2100;
  const months=Array.from({length:12},(_,i)=>({month:i+1,count:state.facets.filter(f=>(!state.year||f.year===state.year)&&f.month===i+1).reduce((n,f)=>n+f.count,0)}));
  const total=months.reduce((n,m)=>n+m.count,0),max=Math.max(1,...months.map(m=>m.count));
  $('#archiveSummary').innerHTML=`<b>${total}</b> 条已收录 <span>· ${state.year||'历年'}${state.year===currentYear?' / 截至 '+dateShort(now):''}</span>`;
  $('#monthSelector').innerHTML=`<button class="month-button all-months ${state.month===0?'active':''}" data-month="0" aria-pressed="${state.month===0}"><strong>${state.year?'全年':'全部'}</strong><span>${total} 条</span><i></i></button>`+months.map(m=>{const future=state.year>currentYear||(state.year===currentYear&&m.month>currentMonth);return `<button class="month-button ${state.month===m.month?'active':''} ${m.count?'':'uncollected'}" data-month="${m.month}" aria-label="${m.month}月，${m.count}条已收录" aria-pressed="${state.month===m.month}" ${!state.year?'disabled':''}><strong>${String(m.month).padStart(2,'0')}<small>月</small></strong><span>${m.count?m.count+' 条':future?'待发生':'未收录'}</span><i style="--bar-height:${m.count?Math.max(3,m.count/max*20):1}px"></i></button>`;}).join('');
  $('#feedDescription').textContent=`${state.year?state.year+' 年':'全部年份'} · ${state.month?state.month+' 月':'全年'} · ${state.query?'搜索“'+state.query+'”':'一句话看懂变化'}`;
}
function clearWeek(){state.week='';$('#weekSelect').value='';}
async function loadNewsWeeks(){const data=await api('/api/news-weeks');state.weeks=data.weeks;$('#weekSelect').innerHTML='<option value="">全部资讯</option><option value="curated">所有周重点</option>'+data.weeks.map(w=>`<option value="${esc(w.week_start)}">${dateFull(w.coverage_start)} — ${dateShort(w.coverage_end)}${w.partial?'（部分周）':''} · ${w.count} 条</option>`).join('');}
async function loadArticles(){
  const request=++state.request;
  const params=new URLSearchParams({week:state.week,category:state.category,focus:state.focus,official:String(state.official),q:state.query,year:state.year||'all',month:state.month,days:String(state.days),sort:state.sort,saved:String(state.nav==='saved')});
  try{
    const data=await api('/api/articles?'+params);if(request!==state.request)return;
    $('#errorBanner').hidden=true;
    state.articles=data.items;state.facets=data.facets||[];data.items.forEach(a=>state.cache.set(a.id,a));renderArchive();
    $('#feedTitle').innerHTML=(state.week?'每周重点':state.nav==='saved'?'我的收藏':state.nav==='amazon'?'规则与变更':state.nav==='policy'?'政策与监管':'全年速读')+' <span id="resultCount"></span>';
    $('#resultCount').textContent=data.items.length+' 条';
    if(state.week){const w=state.weeks.find(w=>w.week_start===state.week);$('#feedDescription').textContent=(w?dateFull(w.coverage_start)+' — '+dateFull(w.coverage_end):'所有已收录周重点')+' · '+data.items.length+' 条 · 按发布者当地日期归档';}
    $('#weeklyNote').textContent=state.week?'已筛选周重点 · 点击标题查看入选理由':'按周一至周日归档 · 重点精选';
    let previousMonth=null;
    $('#articleList').innerHTML=data.items.length?data.items.map((a,i)=>{
      const key=state.week?(a.weekly_info?.week_start||''):(a.archive_date||'').slice(0,7);let heading='';
      if(state.sort==='latest'&&!state.month&&key!==previousMonth){previousMonth=key;const w=state.week&&state.weeks.find(w=>w.week_start===key);const label=w?dateFull(w.coverage_start)+' — '+dateFull(w.coverage_end)+(w.partial?'（部分周）':''):state.week?'周起始 '+dateFull(key):key?key.replace('-',' 年 ')+' 月':'日期待确认';heading=`<div class="month-heading"><span>${label}</span><small>${data.items.filter(x=>(state.week?x.weekly_info?.week_start:(x.archive_date||'').slice(0,7))===key).length} 条</small></div>`;}
      return heading+card(a,i);
    }).join(''):`<div class="empty-state">${icon(state.nav==='saved'?'bookmark':'calendar')}<h3>${state.nav==='saved'?'此时间范围暂无收藏':state.month?state.year+' 年 '+state.month+' 月暂无已收录资讯':'此范围暂无已收录资讯'}</h3><p>可选择其他月份、全年，或切换频道。</p><button class="button button-outline" id="resetFilters">查看今年全部资讯</button></div>`;
    $('#feedEnd').innerHTML=`<span></span>已显示本次筛选的全部 ${data.items.length} 条<span></span>`;
    $('#feedEnd').hidden=!data.items.length;$('#overviewSection').hidden=true;
  }catch(error){if(request===state.request){showError(error);$('#articleList').innerHTML='<div class="empty-state"><h3>资讯暂时无法载入</h3><p>检查本地服务后，刷新页面重试。</p></div>';}}
}
async function loadDashboard(){const d=await api('/api/dashboard');state.dashboard=d;d.spotlights.forEach(a=>state.cache.set(a.id,a));renderOverview();}
function closeMenu(){$('#sidebar').classList.remove('open');$('#mobileScrim').classList.remove('open');$('#menuButton').setAttribute('aria-expanded','false');}
async function navigate(nav,{keepQuery=false}={}){
  if(!pageInfo[nav])nav='overview';state.nav=nav;state.category=categories[nav]?nav:'all';state.expanded=false;
  if(!keepQuery){state.query='';$('#searchInput').value='';state.days=0;$('#daysSelect').value='0';}
  history.replaceState(null,'','#'+nav);
  $$('.nav-item').forEach(b=>{b.classList.toggle('active',b.dataset.nav===nav);b.setAttribute('aria-current',b.dataset.nav===nav?'page':'false');});
  $$('#categoryTabs button').forEach(b=>b.classList.toggle('active',b.dataset.category===state.category));
  const [title,eyebrow]=pageInfo[nav];$('#pageTitle').innerHTML=esc(title)+'<span class="heading-dot">.</span>';$('#pageEyebrow').textContent=eyebrow;$('#breadcrumb').textContent=title;
  $('#overviewSection').hidden=true;
  $('#readingSection').hidden=['timeline','sources','competitors','search-monitor','asin','integrations'].includes(nav);
  $('#timelineSection').hidden=nav!=='timeline';
  $('#sourcesSection').hidden=nav!=='sources';
  $('#competitorsSection').hidden=nav!=='competitors';
  $('#searchMonitorSection').hidden=nav!=='search-monitor';
  $('#asinSection').hidden=nav!=='asin';
  $('#integrationsSection').hidden=nav!=='integrations';
  $('#prioritySection').hidden=!['overview','amazon','policy'].includes(nav);
  $('#syncButton').hidden=['competitors','search-monitor','asin','integrations'].includes(nav);$('#updateLabel').hidden=['competitors','search-monitor','asin','integrations'].includes(nav);
  $('#searchInput').placeholder=nav==='integrations'?'搜索接口、事件或投递记录…':nav==='asin'?'搜索 ASIN、产品或标签…':nav==='search-monitor'?'筛选监控词或词组…':nav==='competitors'?'搜索竞品动态或型号…':'搜索资讯、规则或关键词…';
  $('#searchInput').setAttribute('aria-label',$('#searchInput').placeholder);
  $('#categoryTabs').hidden=Object.hasOwn(categories,nav);
  $('#feedTitle').innerHTML=(nav==='saved'?'我的收藏':nav==='amazon'?'规则与变更':nav==='policy'?'政策与监管':'全年速读')+' <span id="resultCount"></span>';
  $('#feedDescription').textContent='一句话看懂变化，点击标题查看详情。';
  closeMenu();
  if(nav==='integrations')await window.Integrations.open();else if(nav==='asin')await window.ASINMonitor.open();else if(nav==='search-monitor')await window.SearchMonitor.open();else if(nav==='competitors')await window.Rivals.open();else if(nav==='sources')await loadSources();else if(nav!=='timeline')await loadArticles();
}
async function openArticle(id){
  let a=state.cache.get(id);
  if(!a){const data=await api('/api/articles');data.items.forEach(a=>state.cache.set(a.id,a));a=state.cache.get(id);}
  if(!a)return toast('此条资讯暂时不可用');
  const status=displayStatus(a),events=state.dashboard?.events.filter(e=>e.article_id===id)||[];
  $('#dialogContent').innerHTML=`<span class="category-label ${esc(a.category)}">${esc(categories[a.category])} / ${esc(a.topic)}</span><h2 id="dialogTitle">${esc(a.title)}</h2><p class="dialog-summary">${esc(a.summary)}</p><dl class="dialog-meta"><div><dt>适用地区</dt><dd>${esc(a.region)}</dd></div><div><dt>${a.published_at?'发布日期':'核实日期'}</dt><dd>${dateFull(a.published_at||a.checked_at)}</dd></div>${a.effective_at?`<div><dt>生效日期</dt><dd>${dateFull(a.effective_at)}</dd></div>`:''}${status?`<div><dt>当前状态</dt><dd>${esc(status)}</dd></div>`:''}${a.scope?`<div class="full"><dt>适用范围</dt><dd>${esc(a.scope)}</dd></div>`:''}</dl>${events.length?`<div class="dialog-events"><h3>相关时间节点</h3>${events.map(e=>`<div class="dialog-event">${esc(e.label)}<span>${e.start_date?dateFull(e.start_date)+' → ':''}${dateFull(e.end_date)}</span></div>`).join('')}</div>`:''}<div class="dialog-actions"><button class="button button-outline save-button ${a.saved?'saved':''}" data-save="${esc(a.id)}" aria-pressed="${a.saved}">${icon('bookmark')} ${a.saved?'已加入稍后阅读':'加入稍后阅读'}</button><a class="button button-mint" href="${href(a.url)}" target="_blank" rel="noopener noreferrer">${esc(a.source_name)} 原文 ${icon('external')}</a></div>`;
  if(a.weekly_info){const info=a.weekly_info;const section=document.createElement('div');section.className='dialog-events';section.innerHTML=`<h3>为何入选本周重点</h3><p>${esc(info.importance_reason)}</p><p class="chart-subtitle">核验时间：${dateFull(info.evidence.retrieved_at)}${info.evidence.limitation?' · '+esc(info.evidence.limitation):' · 官方来源核对'}</p><a class="source-link" href="${href(info.evidence.url)}" target="_blank" rel="noopener noreferrer">本次核验原文 ↗</a>`;$('#dialogContent .dialog-actions').before(section);}
  if(!$('#articleDialog').open)$('#articleDialog').showModal();
}
async function toggleSave(id){
  const a=state.cache.get(id);if(!a)return;
  const buttons=$$(`[data-save="${id}"]`);buttons.forEach(b=>b.disabled=true);
  try{
    const result=await api(`/api/articles/${id}/saved`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({saved:!a.saved})});
    a.saved=result.saved;state.cache.set(id,a);toast(a.saved?'已加入稍后阅读':'已取消收藏');
    await Promise.all([loadArticles(),loadDashboard()]);if($('#articleDialog').open)await openArticle(id);
  }catch(e){toast(e.message);}finally{buttons.forEach(b=>b.disabled=false);}
}
async function loadSources(){
  try{
    const d=await api('/api/sources');
    $('#sourcesSection').innerHTML=`<section class="panel source-intro"><div class="eyebrow">SOURCE CONNECTIONS</div><h2>每一条信息，都有来处。</h2><p>服务运行时，每 ${d.intervalHours} 小时检查已启用的信息源。${d.summaryReady?'已连接中文摘要服务；监管文件进入待核验队列。':'新条目会先保存到本地待整理队列；中文自动摘要服务尚未配置。'}</p><p>已展示的首批摘要经过核实。尚未接入的来源保留原站入口。</p></section><div class="source-list">${d.sources.map(s=>`<article class="panel source-card"><h3>${esc(s.name)}<span class="source-state ${s.enabled?(s.last_error?'error':'auto'):''}">${s.enabled?(s.last_error?'检查失败':'定时获取'):'待接入'}</span></h3><p>${esc(s.note)}</p><small>${s.last_success_at?'上次成功：'+new Date(s.last_success_at).toLocaleString('zh-CN',{hour12:false}):'尚无自动获取记录'}${s.pending?' · '+s.pending+' 条待整理':''}${s.last_error?' · '+esc(s.last_error):''}</small><a class="source-link" href="${href(s.url)}" target="_blank" rel="noopener noreferrer">访问原站 ${icon('external')}</a></article>`).join('')}</div>${d.candidates.length?`<section class="panel pending-list"><h2>待整理的新内容</h2><p class="chart-subtitle">这些原始标题尚未完成中文摘要或政策核验，不进入资讯主页。</p>${d.candidates.map(c=>`<div class="pending-item"><a href="${href(c.url)}" target="_blank" rel="noopener noreferrer">${esc(c.title)} ↗</a><small>${esc(c.source_name)} · ${dateFull(c.published_at)}</small></div>`).join('')}</section>`:''}`;
  }catch(e){showError(e);}
}
async function synchronize(){
  if(state.syncing)return;state.syncing=true;const b=$('#syncButton');b.disabled=true;b.classList.add('spin');b.querySelector('span').textContent='正在检查';
  try{
    const result=await api('/api/sync',{method:'POST'});
    if(result.status==='busy')toast('已有同步正在运行，请稍后查看');
    else if(result.status==='failed')toast('信息源检查失败，已有内容已保留');
    else toast(`检查完成：新增 ${result.discovered} 条，发布 ${result.published} 条${result.status==='partial'?'；部分来源未成功':''}${!result.summaryReady&&result.discovered?'，新内容待整理':''}`);
    await Promise.all([loadDashboard(),loadArticles()]);if(state.nav==='sources')await loadSources();
  }catch(e){toast(e.message);}finally{state.syncing=false;b.disabled=false;b.classList.remove('spin');b.querySelector('span').textContent='更新资讯';}
}
document.addEventListener('click',async event=>{
  const nav=event.target.closest('[data-nav]');if(nav){event.preventDefault();await navigate(nav.dataset.nav);window.scrollTo({top:0,behavior:'smooth'});return;}
  const save=event.target.closest('[data-save]');if(save){await toggleSave(save.dataset.save);return;}
  const open=event.target.closest('[data-open]');if(open){try{await openArticle(open.dataset.open);}catch(e){toast(e.message);}return;}
  const tab=event.target.closest('[data-category]');if(tab){state.category=tab.dataset.category;$$('#categoryTabs button').forEach(b=>b.classList.toggle('active',b===tab));await loadArticles();return;}
  const focus=event.target.closest('[data-focus]');if(focus){state.focus=focus.dataset.focus;$$('[data-focus]').forEach(b=>{b.classList.toggle('active',b===focus);b.setAttribute('aria-pressed',String(b===focus));});await loadArticles();return;}
  const month=event.target.closest('[data-month]');if(month){clearWeek();state.month=Number(month.dataset.month);state.days=0;$('#daysSelect').value='0';await loadArticles();return;}
  const period=event.target.closest('[data-period]');if(period){state.period=Number(period.dataset.period);$$('[data-period]').forEach(b=>b.classList.toggle('active',b===period));renderGantt();return;}
  const search=event.target.closest('[data-search]');if(search){state.query=search.dataset.search;$('#searchInput').value=state.query;await navigate('overview',{keepQuery:true});$('#readingSection').scrollIntoView({behavior:'smooth'});return;}
  if(event.target.closest('#resetFilters')){clearWeek();state.year=Number(today().slice(0,4));state.month=0;state.focus='all';state.official=false;$('#officialOnly').checked=false;$$('[data-focus]').forEach(b=>{b.classList.toggle('active',b.dataset.focus==='all');b.setAttribute('aria-pressed',String(b.dataset.focus==='all'));});await navigate('overview');}
  if(event.target.closest('#expandFeed')){state.expanded=true;await loadArticles();}
});
let searchTimer;
window.addEventListener('hashchange',()=>{const nav=location.hash.slice(1);if(pageInfo[nav]&&nav!==state.nav)navigate(nav);});
$('#searchInput').addEventListener('input',()=>{clearTimeout(searchTimer);searchTimer=setTimeout(async()=>{state.query=$('#searchInput').value.trim();if(state.nav==='integrations'){window.Integrations.search(state.query);return;}if(state.nav==='asin'){window.ASINMonitor.search(state.query);return;}if(state.nav==='search-monitor'){window.SearchMonitor.search(state.query);return;}if(state.nav==='competitors'){window.Rivals.search(state.query);return;}if(['sources','timeline'].includes(state.nav))await navigate('overview',{keepQuery:true});else await loadArticles();},220);});
$('#officialOnly').addEventListener('change',e=>{state.official=e.target.checked;loadArticles();});
$('#timelineYear').addEventListener('change',e=>{state.timelineYear=Number(e.target.value);renderGantt();});
$('#yearSelect').addEventListener('change',e=>{clearWeek();state.year=Number(e.target.value);state.month=0;state.days=0;$('#daysSelect').value='0';loadArticles();});
$('#previousYear').addEventListener('click',()=>{clearWeek();state.year--;state.month=0;state.days=0;$('#daysSelect').value='0';loadArticles();});
$('#nextYear').addEventListener('click',()=>{clearWeek();state.year++;state.month=0;state.days=0;$('#daysSelect').value='0';loadArticles();});
$('#sortSelect').addEventListener('change',event=>{state.sort=event.target.value;loadArticles();});
$('#daysSelect').addEventListener('change',event=>{clearWeek();state.days=Number(event.target.value);if(state.days){state.year=0;state.month=0;}loadArticles();});
$('#weekSelect').addEventListener('change',event=>{state.week=event.target.value;state.year=0;state.month=0;state.days=0;$('#daysSelect').value='0';loadArticles();});
$('#syncButton').addEventListener('click',synchronize);
$('#closeDialog').addEventListener('click',()=>$('#articleDialog').close());
$('#articleDialog').addEventListener('click',e=>{if(e.target===$('#articleDialog')){const r=e.target.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)e.target.close();}});
$('#menuButton').addEventListener('click',()=>{const open=!$('#sidebar').classList.contains('open');$('#sidebar').classList.toggle('open',open);$('#mobileScrim').classList.toggle('open',open);$('#menuButton').setAttribute('aria-expanded',String(open));});
$('#mobileScrim').addEventListener('click',closeMenu);
$('#themeButton').addEventListener('click',()=>{document.body.classList.toggle('light');try{localStorage.setItem('north-theme',document.body.classList.contains('light')?'light':'dark');}catch{}});
document.addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'){e.preventDefault();$('#searchInput').focus();}if(e.key==='Escape')closeMenu();});
try{document.body.classList.toggle('light',localStorage.getItem('north-theme')==='light');}catch{}
$('#pageDate').textContent=new Intl.DateTimeFormat('zh-CN',{year:'numeric',month:'long',day:'numeric',weekday:'long',timeZone:'Asia/Shanghai'}).format(new Date());
async function bootWorkspace(){
  try{await Promise.all([loadDashboard(),loadNewsWeeks()]);$('#dbDot').classList.add('connected');$('#connectionLabel').textContent='本地空间已连接';await navigate(location.hash.slice(1)||'overview');}
  catch(e){$('#connectionLabel').textContent='本地服务未连接';showError(location.protocol==='file:'?new Error('请启动本地服务后访问 http://127.0.0.1:4317，HTML 需要通过服务读取数据库。'):e);$('#featureCard').innerHTML='<h2>连接你的情报空间</h2><p class="feature-summary">本地服务连接后，这里将展示已保存的资讯。</p>';$('#articleList').innerHTML='<div class="empty-state"><h3>等待本地服务</h3><p>请在项目目录运行 npm start。</p></div>';}
}
// Deferred feature scripts must finish before navigating directly to their pages.
if(document.readyState==='complete')bootWorkspace();
else document.addEventListener('DOMContentLoaded',bootWorkspace,{once:true});
