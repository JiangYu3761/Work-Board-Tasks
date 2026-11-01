'use strict';
window.ASINMonitor=(()=>{
  const base='/api/asin-monitors',section=()=>$('#asinSection');
  const S={data:null,detail:null,view:'list',tab:'changes',query:'',filter:'active',source:'browser',field:'all',eventStatus:'all'};
  const labels={sale_price:'售价',reference_price:'参考价',seller:'卖家与发货方',promotions:'促销与优惠条件',availability:'可购买状态',title:'标题',bullets:'五点卖点',description:'描述与规格',aplus:'A+ 与品牌故事',images:'主图与附图',rating:'评分',rating_count:'Rating 数量',written_review_count:'文字评论数量',star_distribution:'星级分布',review_summary:'评论摘要',reviews:'评论展示'};
  const kinds={updated:'内容变化',appeared:'开始展示',not_displayed:'本次未展示',reordered:'顺序变化',scope_changed:'统计口径变化',entered:'进入展示区',left:'离开展示区',moved:'位置变化',edited:'内容变化',display_changed:'展示文本变化'};
  const states={active:'监控中',paused:'已暂停',archived:'已归档',queued:'排队中',running:'检查中',success:'检查完成',partial:'部分取得',failed:'检查失败',blocked:'需要处理',cancelled:'已取消',observed:'已观测',pending:'待复核',confirmed:'已确认',transient:'短暂变化',ignored:'已忽略'};
  const date=t=>t?new Date(t).toLocaleString('zh-CN',{hour12:false,timeZone:'Asia/Shanghai'}):'尚未取得';
  const source=s=>s==='browser-auth'?'专用会话评论':s==='browser'?'访客页面采集':'人工导入';
  const needsAttention=t=>t.status==='active'&&(!!t.blocked_reason||['partial','failed','blocked'].includes(t.last_run?.state));
  const post=(url,data={})=>api(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
  const evidenceLink=(id,label='查看证据')=>id?`<a href="${base}/${S.detail.target.id}/evidence/${esc(id)}" target="_blank" rel="noopener">${label} ↗</a>`:'';
  const badge=(s,label)=>`<span class="am-badge ${['blocked','failed','pending'].includes(s)?'am-warn':s==='important'?'am-important':''}">${esc(label||states[s]||s)}</span>`;
  function summary(f){
    if(!f)return '未取得';if(f.state==='absent')return '该次观察未展示';if(f.state!=='observed')return '未取得';
    if(f.precision==='approximate')return f.raw+'（近似）';
    if(f.currency)return new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(f.value);
    if(typeof f.value==='number')return f.value.toLocaleString('en-US');
    if(typeof f.value==='string')return f.value;
    if(Array.isArray(f.value))return f.value.map(x=>typeof x==='string'?x:x.raw||x.title||x.id||x.key||JSON.stringify(x)).join(' · ');
    return JSON.stringify(f.value,null,2);
  }
  const sessionNames={needs_login:'待登录 / 需要处理',manual:'等待手动登录',opening:'正在打开窗口',verifying:'正在验证',capturing:'正在检查评论',ready:'已验证',disabled:'已停用',disabling:'正在停用'};
  function sessionBanner(s){return `<div class="am-session"><div><strong>专用 Amazon 评论会话 · ${esc(sessionNames[s?.state]||'未配置')}</strong><p>${esc(s?.reason||'登录后可尝试采集具体评论卡片')}。价格等公开字段沿用访客条件。</p></div><div class="am-actions">${S.view==='detail'?'<button class="button button-outline" data-am="review-data">查看评论数据</button>':''}<button class="button button-outline" data-am="session">管理登录会话</button></div></div>`;}
  function sessionDialog(s){
    const manual=s.state==='manual',busy=['opening','verifying','capturing','disabling'].includes(s.state);
    dialog('专用 Amazon 登录会话',`<p><strong>${esc(sessionNames[s.state])}</strong> · ${esc(s.reason)}</p><ol class="am-session-steps"><li>打开独立浏览器，在 Amazon 美国站手动登录。</li><li>登录后回到 Amazon 首页，再回北向点击“验证并启用”。</li><li>验证通过后窗口会关闭，系统安排下一次内容检查；具体评论采集成功后建立基线。</li></ol><p class="am-footnote">登录数据仅保存在这台电脑的专用目录。请在 Amazon 窗口输入密码和验证码。每次重新打开登录窗口都会建立新的评论会话批次；历史仍可查看。</p><p>上次验证：${date(s.verified_at)}</p><div class="am-actions"><button class="button button-mint" data-am="session-${manual?'verify':'open'}" ${busy?'disabled':''}>${manual?'验证并启用':'打开专用登录窗口'}</button>${manual?'<button class="button button-outline" data-am="session-open">显示登录窗口</button><button class="button button-outline" data-am="session-close">关闭登录窗口</button>':''}${s.state==='ready'?'<button class="button button-outline" data-am="session-disable">停用评论会话</button>':''}<button class="button button-outline" data-am="session">刷新状态</button></div>`);
  }
  function current(t,key){return t.heads.find(h=>h.field===key&&h.source==='browser')||t.heads.find(h=>h.field===key&&h.source==='manual');}
  async function load(){S.data=await api(base);if(S.view==='list')renderList();}
  function renderList(){
    const d=S.data;if(!d)return;const active=d.items.filter(t=>t.status==='active'),blocked=active.filter(needsAttention);
    const fresh=d.worker.heartbeat&&Date.now()-new Date(d.worker.heartbeat)<90000;
    const rows=d.items.filter(t=>(S.filter==='all'||S.filter==='blocked'&&needsAttention(t)||S.filter==='active'&&t.status!=='archived'||t.status===S.filter)&&`${t.asin} ${t.name} ${t.brand_name} ${t.tags}`.toLowerCase().includes(S.query.toLowerCase()));
    section().innerHTML=`<div class="am-intro"><div><p class="am-kicker">WATCH THE DETAILS</p><h2>每一次变化，都有前后。</h2><p>持续记录指定商品的价格、内容与评论展示，保留变化依据。</p></div><button class="button button-mint" data-am="add">＋ 添加 ASIN</button></div>
      <div class="am-stats"><div><span>监控中的商品</span><strong>${active.length}<small>/ 50</small></strong></div><div><span>近 24 小时变化</span><strong>${d.items.reduce((n,t)=>n+t.changes,0)}</strong></div><div><span>待复核变化</span><strong>${d.items.reduce((n,t)=>n+t.pending,0)}</strong></div><div><span>需要处理</span><strong class="${blocked.length?'am-amber':''}">${blocked.length}</strong></div></div>
      <div class="am-runtime"><span class="am-dot ${fresh?'am-online':''}"></span><span>${fresh?'本地检查服务运行中':'本地检查服务未就绪'} · 今日 ${d.worker.used_today} / ${d.worker.daily_limit} 次</span><span class="am-runtime-note">电脑休眠或服务关闭时暂停；恢复后补查最新状态</span><button data-am="settings">设置</button></div>
      ${sessionBanner(d.review_session)}
      ${d.worker.last_error?`<p class="am-notice">${esc(d.worker.last_error)}</p>`:''}
      <div class="am-toolbar"><div class="am-tabs" role="group" aria-label="监控状态">${[['active','当前清单'],['blocked','需要处理'],['archived','归档'],['all','全部']].map(([v,l])=>`<button data-am-filter="${v}" class="${S.filter===v?'active':''}" aria-pressed="${S.filter===v}">${l}</button>`).join('')}</div><div class="am-actions"><button class="button button-outline" data-am="digest">今日变化</button><button class="button button-outline" data-am="alerts">提醒 ${d.unread?`(${d.unread})`:''}</button><button class="button button-outline" data-am="refresh">刷新</button></div></div>
      ${rows.length?`<div class="am-table-wrap"><table class="am-table"><thead><tr><th>商品 / ASIN</th><th>售价</th><th>评分 / Rating 数量</th><th>最近检查</th><th>24h 变化</th><th>状态</th></tr></thead><tbody>${rows.map(t=>{
        const p=current(t,'sale_price'),r=current(t,'rating'),n=current(t,'rating_count'),last=t.last_run;
        return `<tr><td><button class="am-product" data-am-detail="${t.id}"><strong>${esc(t.name||t.asin)}</strong><span>${esc(t.brand_name||'未分组')} · ${t.asin} · US</span></button>${t.tags?`<small>${esc(t.tags)}</small>`:''}</td><td><strong>${esc(summary(p?.data))}</strong><small>${p?source(p.source)+' · '+date(p.observed_at):'等待首次有效采集'}</small></td><td><strong>${r?esc(summary(r.data))+' / 5':'—'}</strong><small>${n?esc(summary(n.data))+' ratings':'Rating 数量未取得'}</small></td><td>${last?badge(last.state):'尚未检查'}<small>${last?date(last.finished_at||last.started_at):'添加后自动排队'}</small></td><td><button class="am-count" data-am-detail="${t.id}">${t.changes}</button></td><td>${badge(t.blocked_reason?'blocked':t.status)}<small>价格 ${t.rules.price_hours}h / 内容 ${t.rules.content_hours}h</small></td></tr>`;
      }).join('')}</tbody></table></div>`:`<div class="am-empty"><span class="am-empty-icon">${icon('bag')}</span><h3>${S.query?'没有匹配的商品':S.filter==='archived'?'暂无归档商品':S.filter==='blocked'?'当前没有需要处理的监控':'从你关心的 ASIN 开始'}</h3><p>输入 ASIN、粘贴 Amazon 链接，或从已有竞品档案中选择。<br>首次取得的数据作为基线；从第二次有效观察开始记录变化。</p><button class="button button-mint" data-am="add">添加监控对象</button></div>`}
      <p class="am-footnote">当前适配 Amazon 美国站 · 访客 / 非 Prime · 固定配送邮编。促销保留原始条件；评论记录详情页当次展示，不代表全量评论。</p>`;
  }
  async function openDetail(id){S.detail=await api(`${base}/${id}`);S.view='detail';S.tab='changes';S.field='all';S.eventStatus='all';S.source=S.detail.heads.some(h=>h.source==='browser')?'browser':S.detail.heads.some(h=>h.source==='manual')?'manual':'browser';renderDetail();}
  function renderDetail(){
    const d=S.detail,t=d.target;
    section().innerHTML=`<div class="am-breadcrumb"><button data-am="back">← 监控清单</button><span>${t.asin} / US</span>${badge(t.blocked_reason?'blocked':t.status)}</div>
      <div class="am-detail-heading"><div><h2>${esc(t.name||t.asin)}</h2><p>配送 ${t.profile.zip} · 访客 / 非 Prime · 观察条件 v${t.profile_version} · 时间均为北京时间</p></div><a class="button button-outline" href="${href(t.url)}" target="_blank" rel="noopener">商品原页 ↗</a></div>
      ${t.blocked_reason?`<div class="am-notice"><strong>自动检查已暂停</strong><p>${esc(t.blocked_reason)}</p><span>已有历史保留。处理来源后可点击“立即检查”重试。</span></div>`:''}
      ${sessionBanner(d.review_session)}
      <div class="am-toolbar"><div class="am-actions"><button class="button button-mint" data-am="check" ${t.status!=='active'?'disabled':''}>立即检查</button><button class="button button-outline" data-am="edit">编辑设置</button><button class="button button-outline" data-am="toggle">${t.status==='active'?'暂停监控':'恢复监控'}</button><button class="button button-outline" data-am="import">导入快照</button><button class="button button-outline" data-am="detail-refresh">刷新</button></div><div class="am-actions"><a href="${base}/${t.id}/export?format=csv">导出变化 CSV</a><a href="${base}/${t.id}/export?format=json">完整历史 JSON</a></div></div>
      <div class="am-toolbar am-detail-tabs"><div class="am-tabs" role="group" aria-label="商品详情视图">${[['changes','变化时间线'],['current','当前数据'],['compare','快照对比'],['history','数值历史'],['runs','运行记录']].map(([k,l])=>`<button data-am-tab="${k}" class="${S.tab===k?'active':''}" aria-pressed="${S.tab===k}">${l}</button>`).join('')}</div><label class="am-select-label">数据来源<select id="amSource"><option value="browser" ${S.source==='browser'?'selected':''}>真实页面采集</option><option value="browser-auth" ${S.source==='browser-auth'?'selected':''}>专用会话评论</option><option value="manual" ${S.source==='manual'?'selected':''}>人工导入</option></select></label></div><div id="amDetailBody"></div>`;
    renderTab();
  }
  function renderTab(){
    const d=S.detail,root=$('#amDetailBody');
    if(S.tab==='changes'){
      const events=d.events.filter(e=>e.source===S.source&&(S.field==='all'||e.field===S.field)&&(S.eventStatus==='all'||e.status===S.eventStatus));
      root.innerHTML=`<div class="am-filter-row"><label>变化字段 <select id="amField"><option value="all">全部字段</option>${Object.entries(labels).map(([k,l])=>`<option value="${k}" ${S.field===k?'selected':''}>${l}</option>`).join('')}</select></label><label>复核状态 <select id="amEventStatus">${[['all','全部'],['pending','待复核'],['confirmed','已确认'],['transient','短暂变化'],['ignored','已忽略']].map(([k,l])=>`<option value="${k}" ${S.eventStatus===k?'selected':''}>${l}</option>`).join('')}</select></label><small>展示最近 200 条变化；完整历史可导出。</small></div>
        <p class="am-footnote">时间区间表示两次观察之间发生变化，无法确认准确发生时刻。评论“离开展示区”不等于评论被删除。</p>${events.length?events.map(eventCard).join(''):empty('暂未发现变化','首次数据用于建立基线。请等待下一次有效观察，或切换数据来源与筛选条件。')}`;
    }else if(S.tab==='current'){
      root.innerHTML=`${S.source==='browser-auth'?'<p class="am-notice">仅展示当前会话批次的评论。重新登录后等待新基线；旧会话记录仍可从历史快照查看。此来源不采集价格、评分和 Rating 数量。</p>':''}<p class="am-footnote">以下为各字段最近一次有效观察。缺失或失败不会覆盖旧值；请结合观察时间和运行记录判断新鲜度。</p><div class="am-current-grid">${Object.entries(labels).filter(([key])=>S.source!=='browser-auth'||['reviews','written_review_count'].includes(key)).map(([key,label])=>{const h=d.heads.find(h=>h.field===key&&h.source===S.source&&(S.source!=='browser-auth'||h.profile.session_generation===d.review_session?.generation));return `<article class="am-field-card"><header><h3>${label}</h3><small>${h?date(h.observed_at):'等待数据'}</small></header>${fieldHTML(key,h?.data||d.latest?.find(s=>s.source===S.source&&(S.source!=='browser-auth'||s.profile.session_generation===d.review_session?.generation))?.fields[key])}${h?`<button class="am-link" data-am-snapshot="${h.snapshot_id}">查看该次完整快照</button>`:''}</article>`;}).join('')}</div>`;
    }else if(S.tab==='compare'){
      const snaps=d.snapshots.filter(s=>s.source===S.source);
      const option=(s,i,which)=>`<option value="${s.id}" ${(which==='before'&&i===1||which==='after'&&i===0)?'selected':''}>${date(s.observed_at)} · 条件 v${s.profile_version} · ${s.fields.length} 项</option>`;
      root.innerHTML=`<p class="am-footnote">可比较任意两次同来源、同观察条件的快照。字段未取得时会明确列出，不把空值当成删除。</p>${snaps.length>=2?`<form id="amCompareForm" class="am-compare-form"><label>变化前<select name="before">${snaps.map((s,i)=>option(s,i,'before')).join('')}</select></label><span>→</span><label>变化后<select name="after">${snaps.map((s,i)=>option(s,i,'after')).join('')}</select></label><button class="button button-mint">对比快照</button></form><div id="amCompareResult"></div>`:empty('至少需要两次有效快照','快照不会自动补造历史数据。')}`;
    }else if(S.tab==='history'){
      const history=d.history.filter(h=>h.source===S.source&&S.source!=='browser-auth');
      root.innerHTML=`<p class="am-footnote">展示当前观察条件下最近 500 次记录；“未取得”表示该次未观察此数值，折线不会跨缺失点连接。</p>${history.length?chart(history)+`<div class="am-table-wrap"><table class="am-table"><thead><tr><th>观察时间</th><th>售价</th><th>评分</th><th>Rating 数量</th><th></th></tr></thead><tbody>${[...history].reverse().map(h=>`<tr><td>${date(h.observed_at)}</td><td>${esc(summary(h.price))}</td><td>${esc(summary(h.rating))}</td><td>${esc(summary(h.rating_count))}</td><td><button data-am-snapshot="${h.id}">快照详情</button></td></tr>`).join('')}</tbody></table></div>`:empty('尚无数值历史','价格、评分和 Rating 数量会按观察时间保存在这里。')}`;
    }else if(S.tab==='runs'){
      root.innerHTML=`<p class="am-footnote">运行记录只对应真实页面采集；人工导入记录在快照历史。显示最近 30 次。</p>${d.runs.length?d.runs.map(r=>`<article class="am-run"><div>${badge(r.state)}<strong>${r.module==='all'?'全字段':r.module==='price'?'价格与促销':'内容与口碑'}</strong><span>${date(r.started_at||r.scheduled_at)}</span></div><p>${esc(r.reason||'任务正常推进')}</p><small>观察条件 v${r.profile_version} · 尝试 ${r.attempts} 次 · ${r.finished_at?'结束 '+date(r.finished_at):'等待完成'}</small>${evidenceLink(r.evidence_id)}</article>`).join(''):empty('还没有检查记录','启用监控后，系统会按配置自动检查。')}`;
    }
  }
  function empty(title,text){return `<div class="am-empty am-empty-small"><h3>${title}</h3><p>${text}</p></div>`;}
  function fieldHTML(key,f,marked=null){
    if(!f||!['observed','absent'].includes(f.state))return `<p class="am-muted">未取得${f?.reason?' · '+esc(f.reason):''}</p>`;
    if(f.state==='absent')return `<p class="am-amber">该次观察未展示</p><small>${esc(f.reason||'')}</small>`;
    if(f.precision==='approximate')return `<p>${esc(f.raw)} <small>近似值，不计算精确差值</small></p>`;
    if(key==='images')return `<div class="am-images">${f.value.map((im,i)=>`<figure>${im.asset_id?`<a href="${base}/${S.detail.target.id}/evidence/${esc(im.asset_id)}" target="_blank" rel="noopener"><img loading="lazy" src="${base}/${S.detail.target.id}/evidence/${esc(im.asset_id)}" alt="第 ${i+1} 张商品图片"></a>`:'<div class="am-image-placeholder">未导入图片文件</div>'}<figcaption>${i===0?'主图':'附图 '+i} · ${esc((im.pixel_hash||im.sha256||im.key||'').slice(0,12))}</figcaption></figure>`).join('')}</div>`;
    if(key==='reviews')return `<div class="am-reviews">${f.value.map(r=>`<article class="am-review"><header><b>#${r.position} · ${r.rating??'—'} 星</b><small>${esc(r.id)} · ${esc(r.region||'默认展示')}</small></header><strong>${esc(r.title||'')}</strong><p>${esc(r.body||'')}</p><small>${esc(r.date||'')} ${r.verified?'· 已验证购买':''} ${r.vine?'· Vine':''} ${r.complete?'· 完整文本':'· 展示片段'}</small></article>`).join('')}</div>`;
    if(key==='aplus'&&f.value&&typeof f.value==='object')return `<p class="am-pre">${esc(f.value.text||'')}</p>${Array.isArray(f.value.images)&&f.value.images[0]?.asset_id?fieldHTML('images',{state:'observed',value:f.value.images}):`<small>${f.value.images?.length||0} 张内容图片</small>`}`;
    if(key==='bullets')return `<ol class="am-bullets">${f.value.map(x=>`<li>${esc(x)}</li>`).join('')}</ol>`;
    if(key==='promotions')return f.value.map(x=>`<p class="am-pre">${esc(typeof x==='string'?x:x.raw||JSON.stringify(x,null,2))}</p>`).join('')||'<p>本次未展示优惠</p>';
    return `<p class="am-pre">${marked||esc(summary(f))}</p>`;
  }
  function markedText(a,b){
    if(typeof a?.value!=='string'||typeof b?.value!=='string'||a.value.length>15000||b.value.length>15000)return [null,null];
    let p=0,z=0;const x=a.value,y=b.value;while(p<Math.min(x.length,y.length)&&x[p]===y[p])p++;while(z<Math.min(x.length,y.length)-p&&x[x.length-1-z]===y[y.length-1-z])z++;
    return [x,y].map((s,i)=>esc(s.slice(0,p))+`<mark class="${i?'am-added':'am-removed'}">${esc(s.slice(p,s.length-z))}</mark>`+esc(z?s.slice(-z):''));
  }
  function eventCard(e){
    const before=e.before_value||e.before,after=e.after_value||e.after,marked=markedText(before,after);
    return `<details class="am-event ${e.severity==='important'?'am-event-important':''}"><summary><span class="am-event-field">${labels[e.field]||esc(e.field)}</span><span>${esc(kinds[e.kind]||e.kind)} ${e.delta!==null&&e.delta!==undefined?`<b class="am-delta">${Number(e.delta)>0?'+':''}${e.delta}${e.percent!==null&&e.percent!==undefined?' ('+(Number(e.percent)>0?'+':'')+e.percent+'%)':''}</b>`:''}</span>${badge(e.status)}<small>${e.window_end?date(e.window_end):'选定快照'}</small><span class="am-chevron">⌄</span></summary><div class="am-event-body">
      ${e.window_start?`<p class="am-footnote">观察区间：${date(e.window_start)} → ${date(e.window_end)} · ${source(e.source)} · 条件 v${e.profile_version}</p>`:''}
      ${e.details?.length?`<div class="am-change-notes">${e.details.map(x=>x.kind==='seller_changed'?'<p>此次价格变化伴随卖家变化，请同时核对报价主体。</p>':`<p><b>${esc(kinds[x.kind]||x.kind)}</b> · ${esc(x.id||'')} ${x.before?.position?'#'+x.before.position:''}${x.after?.position?' → #'+x.after.position:''}${x.fields?.length?' · '+esc(x.fields.join(' / ')):''}</p>`).join('')}</div>`:''}
      <div class="am-diff"><section><h4>变化前</h4>${fieldHTML(e.field,before,marked[0])}</section><section><h4>变化后</h4>${fieldHTML(e.field,after,marked[1])}</section></div>
      ${e.id?`<div class="am-event-actions"><button data-am-snapshot="${e.before_snapshot_id}">变化前快照与证据 ↗</button><button data-am-snapshot="${e.after_snapshot_id}">变化后快照与证据 ↗</button><button data-am-review="${e.id}">${e.starred?'★ 已关注 · 备注':'复核 / 备注'}</button></div>${e.note?`<p>备注：${esc(e.note)}</p>`:''}`:''}</div></details>`;
  }
  function chart(history){
    const nums=history.filter(h=>h.price?.state==='observed'&&typeof h.price.value==='number');if(nums.length<2)return '';
    const prices=nums.map(h=>h.price.value),lo=Math.min(...prices),hi=Math.max(...prices),span=hi-lo||1,start=+new Date(history[0].observed_at),duration=+new Date(history.at(-1).observed_at)-start||1;
    let draw=false;const d=history.map(h=>{if(h.price?.state!=='observed'||typeof h.price.value!=='number'){draw=false;return '';}const x=50+(+new Date(h.observed_at)-start)/duration*850,y=160-(h.price.value-lo)/span*120;const p=`${draw?'L':'M'}${x.toFixed(2)},${y.toFixed(2)}`;draw=true;return p;}).join(' ');
    return `<div class="am-chart"><span>售价趋势 · USD</span><svg viewBox="0 0 940 200" role="img" aria-label="售价趋势，最低 ${lo} 美元，最高 ${hi} 美元。详细数值见下方表格"><path d="M50 40H900M50 160H900" class="am-gridline"/><text x="0" y="44">${hi.toFixed(2)}</text><text x="0" y="164">${lo.toFixed(2)}</text><path d="${d}" class="am-chart-line"/><text x="50" y="192">${date(history[0].observed_at)}</text><text x="900" y="192" text-anchor="end">${date(history.at(-1).observed_at)}</text></svg></div>`;
  }
  function dialog(title,content){$('#asinDialogContent').innerHTML=`<div class="am-dialog-heading"><h2 id="asinDialogTitle">${title}</h2><button type="button" class="icon-button" data-am="close" aria-label="关闭">${icon('close')}</button></div>${content}<p id="amFormError" class="am-form-error" role="alert" hidden></p>`;if(!$('#asinDialog').open)$('#asinDialog').showModal();}
  async function addDialog(){
    const catalog=await api(base+'/catalog');const existing=new Set(S.data.items.map(t=>t.asin));
    dialog('添加 ASIN 监控',`<form id="amAddForm"><label>ASIN 或 Amazon 美国站链接<textarea name="inputs" rows="3" placeholder="每行一个 ASIN 或商品链接"></textarea></label><details class="am-catalog"><summary>从现有竞品档案选择 (${catalog.items.length})</summary>${catalog.items.map((x,i)=>`<label><input type="checkbox" name="catalog" value="${i}" ${existing.has(x.asin)?'disabled':''}><span>${esc(x.brand_name)} · ${esc(x.name)}<small>${x.asin}${existing.has(x.asin)?' · 已添加':''}</small></span></label>`).join('')}</details><div class="am-form-grid"><label>配送邮编<input name="zip" value="60202" pattern="[0-9]{5}" maxlength="5" required></label><label>标签（可选）<input name="tags" maxlength="200" placeholder="如：重点竞品"></label>${ruleFields({price_hours:4,content_hours:24,price_percent:5})}</div><label class="am-checkbox"><input type="checkbox" name="paused">先保存为暂停状态，暂不自动检查</label><p class="am-footnote">访客 / 非 Prime · USD · 默认评论展示。价格与促销按配置周期检查，内容包括评分、图片和评论。首次观察用于建立基线。</p><button class="button button-mint">添加监控</button></form>`);
    $('#amAddForm')._catalog=catalog.items;
  }
  function ruleFields(r){return `<label>价格 / 促销周期<select name="price_hours">${[1,4,12,24].map(n=>`<option value="${n}" ${r.price_hours===n?'selected':''}>每 ${n} 小时</option>`).join('')}</select></label><label>内容 / 口碑周期<select name="content_hours">${[4,12,24,48].map(n=>`<option value="${n}" ${r.content_hours===n?'selected':''}>每 ${n} 小时</option>`).join('')}</select></label><label>价格提醒阈值 (%)<input name="price_percent" type="number" min="0" max="100" step="0.1" value="${r.price_percent}" required></label>`;}
  function editDialog(){const t=S.detail.target;dialog('监控设置',`<form id="amEditForm"><label>商品名称<input name="name" value="${esc(t.name)}" maxlength="240"></label><label>标签<input name="tags" value="${esc(t.tags)}" maxlength="200"></label><div class="am-form-grid"><label>配送邮编<input name="zip" value="${t.profile.zip}" pattern="[0-9]{5}" maxlength="5" required></label>${ruleFields(t.rules)}</div><p class="am-notice">修改配送邮编后建立新的观察条件版本，首次数据作为新基线；历史仍然保留。</p><div class="am-actions"><button class="button button-mint">保存设置</button><button type="button" class="button button-outline" data-am="archive">归档此监控</button></div></form>`);}
  const formRules=f=>({price_hours:Number(f.get('price_hours')),content_hours:Number(f.get('content_hours')),price_percent:Number(f.get('price_percent'))});
  async function refreshDetail(){S.detail=await api(`${base}/${S.detail.target.id}`);renderDetail();}
  async function onClick(e){
    const b=e.target.closest('button');if(!b||b.disabled)return;
    try{
      if(b.dataset.amDetail){$('#asinDialog').close();await openDetail(b.dataset.amDetail);return;}
      if(b.dataset.amFilter){S.filter=b.dataset.amFilter;renderList();return;}
      if(b.dataset.amTab){S.tab=b.dataset.amTab;renderDetail();return;}
      if(b.dataset.amSnapshot){const s=await api(`${base}/${S.detail.target.id}/snapshots/${b.dataset.amSnapshot}`);dialog('观察快照',`<p>${date(s.observed_at)} · ${source(s.source)} · 配送 ${s.profile.zip} · 条件 v${s.profile_version}${s.profile.session_generation?' · 会话批次 '+esc(s.profile.session_generation.slice(0,8)):''}</p><p>${evidenceLink(s.evidence_id,'查看原始证据')}${s.coverage.extracted_evidence_id?' · '+evidenceLink(s.coverage.extracted_evidence_id,'下载提取原文'):''}${Object.entries(s.coverage.section_evidence||{}).map(([k,v])=>' · '+evidenceLink(v,labels[k]+'区域截图')).join('')}</p><div class="am-current-grid">${Object.entries(s.fields).map(([k,f])=>`<article class="am-field-card"><h3>${labels[k]}</h3>${fieldHTML(k,f)}</article>`).join('')}</div><details><summary>采集覆盖说明</summary><pre>${esc(JSON.stringify(s.coverage,null,2))}</pre></details>`);return;}
      if(b.dataset.amReview){const item=S.detail.events.find(x=>x.id===b.dataset.amReview);dialog('复核变化',`<form id="amReviewForm" data-id="${item.id}"><p>${labels[item.field]} · ${date(item.window_end)}</p><label>处理结果<select name="status"><option value="">保留当前状态</option value="confirmed">已人工确认</option><option value="ignored">忽略此变化</option></select></label><label class="am-checkbox"><input type="checkbox" name="starred" ${item.starred?'checked':''}>持续关注</label><label>备注<textarea name="note" rows="4" maxlength="1000">${esc(item.note)}</textarea></label><button class="button button-mint">保存复核</button></form>`);return;}
      const action=b.dataset.am;if(!action)return;
      if(action==='close'){$('#asinDialog').close();return;}
      if(action==='review-data'){S.source='browser-auth';S.tab='current';renderDetail();return;}
      if(action==='session'){sessionDialog(await api(base+'/session'));return;}
      if(action.startsWith('session-')){
        b.disabled=true;const s=await post(base+'/session/'+action.slice(8));
        if(S.view==='detail')await refreshDetail();else await load();
        sessionDialog(s);if(s.state==='ready')toast('会话已验证，内容检查已安排');return;
      }
      if(action==='add')return await addDialog();
      if(action==='edit')return editDialog();
      if(action==='refresh'||action==='back'){S.view='list';S.detail=null;return await load();}
      if(action==='detail-refresh')return await refreshDetail();
      if(action==='toggle'){await post(`${base}/${S.detail.target.id}`,{status:S.detail.target.status==='active'?'paused':'active'});return await refreshDetail();}
      if(action==='archive'){await post(`${base}/${S.detail.target.id}`,{status:'archived'});$('#asinDialog').close();toast('已归档，历史数据保留');return await refreshDetail();}
      if(action==='check'){b.disabled=true;await post(`${base}/${S.detail.target.id}/check`);toast('已加入检查队列');S.tab='runs';return await refreshDetail();}
      if(action==='import'){dialog('导入真实观察快照',`<p>用于补充你已取得的真实页面数据。导入数据独立于页面自动采集，不会冒充自动采集结果。</p><p><a href="${base}/${S.detail.target.id}/template" target="_blank" rel="noopener">打开 JSON 模板 ↗</a></p><form id="amImportForm"><label>选择 JSON 文件<input name="file" type="file" accept="application/json,.json" required></label><p class="am-footnote">须含当前 ASIN、站点、配送邮编、观察时间及 fields。observed 为已观测，absent 为确认未展示，unknown 为未取得。图片需内容 SHA256 或资产 key；外部图片不会自动显示。</p><button class="button button-mint">导入快照</button></form>`);return;}
      if(action==='settings'){dialog('本地检查设置',`<form id="amSettingsForm"><label>每日最大检查次数<input name="daily_limit" type="number" value="${S.data.worker.daily_limit}" min="1" max="1000" required></label><p class="am-footnote">按北京时间自然日计数。达到上限后队列保留到次日；单个 ASIN 手动检查间隔至少 5 分钟。</p><button class="button button-mint">保存</button></form>`);return;}
      if(action==='alerts'){const d=await api(base+'/notifications');dialog('变化提醒',`<p>提醒只保留需要关注的变化，全部记录仍在每个 ASIN 的时间线。</p><button class="button button-outline" data-am="read-alerts">全部标记为已读</button>${d.items.length?d.items.map(x=>`<article class="am-run"><button data-am-detail="${x.target_id}"><strong>${x.read_at?'':'● '}${esc(x.title)}</strong></button><small>${date(x.created_at)}</small></article>`).join(''):empty('暂无提醒','达到提醒规则的变化会出现在这里。')}`);return;}
      if(action==='read-alerts'){await post(base+'/notifications/read');$('#asinDialog').close();await load();toast('已标记为已读');return;}
      if(action==='digest'){const d=await api(base+'/digest');dialog('今日变化 · '+d.day,`<p>按北京时间汇总 ${d.items.length} 条变化。没有取得数据不代表商品没有变化。</p>${d.items.length?d.items.map(x=>`<article class="am-run"><button data-am-detail="${x.target_id}"><strong>${esc(x.name||x.asin)} · ${labels[x.field]}</strong></button><p>${esc(kinds[x.kind])} · ${source(x.source)} · ${states[x.status]}</p><small>${date(x.window_end)}</small></article>`).join(''):empty('今天暂无变化记录','查看运行状态，确认监控是否正常取得数据。')}`);return;}
    }catch(err){toast(err.message);if(b.isConnected)b.disabled=false;}
  }
  async function onSubmit(e){
    const form=e.target;if(!form.id.startsWith('am'))return;e.preventDefault();const submit=form.querySelector('button:not([type="button"])');if(submit)submit.disabled=true;
    try{
      const f=new FormData(form);
      if(form.id==='amAddForm'){
        const list=String(f.get('inputs')||'').split(/\n|,/).map(x=>x.trim()).filter(Boolean).map(input=>({input}));
        for(const index of f.getAll('catalog')){const x=form._catalog[Number(index)];list.push({input:x.asin,listing_id:x.listing_id,brand_id:x.brand_id,name:x.name});}
        if(!list.length)throw new Error('请填写 ASIN 或从竞品档案选择商品');
        const r=await post(base+'/import',{items:list,defaults:{profile:{zip:f.get('zip')},rules:formRules(f),tags:f.get('tags'),status:f.has('paused')?'paused':'active'}});
        const errors=r.results.filter(x=>!x.ok);S.view='list';await load();
        if(errors.length){dialog('导入结果',`<p>成功添加 ${r.results.length-errors.length} 个，未添加 ${errors.length} 个。</p>${errors.map(x=>`<p>${esc(x.input)}：${esc(x.error)}</p>`).join('')}<button class="button button-mint" data-am="close">完成</button>`);}else{$('#asinDialog').close();toast(`已添加 ${list.length} 个监控对象`);}
      }else if(form.id==='amEditForm'){await post(`${base}/${S.detail.target.id}`,{name:f.get('name'),tags:f.get('tags'),profile:{zip:f.get('zip')},rules:formRules(f)});$('#asinDialog').close();await refreshDetail();toast('设置已保存');}
      else if(form.id==='amImportForm'){const file=f.get('file');if(file.size>2000000)throw new Error('文件不能超过 2 MB');const b=JSON.parse(await file.text());const r=await post(`${base}/${S.detail.target.id}/snapshots`,b);$('#asinDialog').close();S.source='manual';await refreshDetail();toast(r.duplicate?'该快照已存在':`已保存快照 · ${r.events} 项变化 · ${r.baselines} 项基线`);}
      else if(form.id==='amReviewForm'){await post(`${base}/${S.detail.target.id}/events/${form.dataset.id}`,{status:f.get('status')||undefined,starred:f.has('starred'),note:f.get('note')});$('#asinDialog').close();await refreshDetail();}
      else if(form.id==='amSettingsForm'){await post(base+'/settings',{daily_limit:Number(f.get('daily_limit'))});$('#asinDialog').close();await load();}
      else if(form.id==='amCompareForm'){const d=await api(`${base}/${S.detail.target.id}/compare?${new URLSearchParams({before:f.get('before'),after:f.get('after')})}`);$('#amCompareResult').innerHTML=`<p class="am-footnote">${date(d.before.observed_at)} → ${date(d.after.observed_at)} · ${d.changes.length} 项变化 · ${d.unavailable.length} 项缺少可比较数据</p>${d.changes.map(eventCard).join('')||empty('可比较字段未发生变化','未取得的字段不参与比较。')}<details><summary>未参与比较的字段</summary><p>${d.unavailable.map(x=>labels[x]).join('、')||'无'}</p></details>`;}
    }catch(err){const el=$('#amFormError');if($('#asinDialog').open&&el){el.textContent=err instanceof SyntaxError?'JSON 文件格式无效，请检查文件内容':err.message;el.hidden=false;}else toast(err.message);}finally{if(submit?.isConnected)submit.disabled=false;}
  }
  section().addEventListener('click',onClick);$('#asinDialog').addEventListener('click',onClick);
  section().addEventListener('submit',onSubmit);$('#asinDialog').addEventListener('submit',onSubmit);
  section().addEventListener('change',e=>{if(e.target.id==='amSource'){S.source=e.target.value;renderTab();}if(e.target.id==='amField'){S.field=e.target.value;renderTab();}if(e.target.id==='amEventStatus'){S.eventStatus=e.target.value;renderTab();}});
  setInterval(()=>{if(!section().hidden&&S.view==='list'&&!$('#asinDialog').open)load().catch(()=>{if(S.data){S.data.worker.heartbeat=null;S.data.worker.last_error='无法连接本地服务，请重新启动服务后刷新；下方保留上次读取的数据';renderList();}});},30000);
  return {open:async()=>{S.view='list';S.detail=null;try{await load();}catch(e){section().innerHTML=empty('监控数据暂时无法载入',esc(e.message));}},search:q=>{S.query=q;S.view='list';renderList();}};
})();
