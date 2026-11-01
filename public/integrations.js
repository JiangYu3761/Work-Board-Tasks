(() => {
  'use strict';
  const root=()=>document.querySelector('#integrationsSection');
  const e=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const ico=n=>`<svg aria-hidden="true"><use href="#i-${n}"/></svg>`;
  const time=v=>v?new Date(v).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}):'尚无记录';
  const tabs=[['overview','接入总览'],['api','API 与 CLI'],['events','事件记录'],['preview','通知预览'],['deliveries','投递记录']];
  const names={news:'资讯',dashboard:'资讯总览',articles:'资讯',sources:'信息源','news-weeks':'每周重点',sync:'来源同步',competitors:'品牌竞品',search:'搜索词监控','asin-monitors':'ASIN 监控',jobs:'采集任务',events:'事件',notifications:'通知',health:'服务状态',capabilities:'能力清单','openapi.json':'接口协议','integration-status':'通道状态'};
  const severity={info:'信息',important:'重要',critical:'紧急'},statuses={queued:'待投递',sending:'发送中',sent:'已送达',failed:'发送失败',uncertain:'待核查',cancelled:'已取消'};
  const S={tab:'overview',data:null,catalog:null,q:'',module:'all',level:'',deliveryState:'',items:[],next:null,more:false,seq:0,draft:{type:'agent.report.ready',severity:'info',title:'',body:''},preview:null,previewPending:false};
  const get=async(p,o={})=>{const r=await fetch('/api/integrations/'+p,o),d=await r.json();if(!r.ok)throw new Error(d.error?.message||d.error||'暂时无法读取，请重试');return d;};
  const badge=(text,kind='')=>`<span class="ig-badge ${e(kind)}">${e(text)}</span>`;
  const count=key=>S.data?.deliveries.find(x=>x.state===key)?.count||0;
  function empty(title,body,action=''){return `<div class="ig-empty">${ico('source')}<h3>${e(title)}</h3><p>${e(body)}</p>${action}</div>`;}
  function frame(){root().innerHTML=`<div class="ig-toolbar"><p>让监控结果连接 CLI、其他 Agent 与通知通道。</p><div><span id="igUpdated" class="ig-note"></span><button class="button button-outline" data-ig-refresh>${ico('refresh')} 刷新</button></div></div><div id="igError" class="error-banner" role="alert" hidden></div><nav class="ig-tabs" role="tablist" aria-label="外部接入页面">${tabs.map(([key,label])=>`<button role="tab" id="igTab-${key}" aria-controls="igView" aria-selected="${key===S.tab}" tabindex="${key===S.tab?0:-1}" data-ig-tab="${key}">${label}</button>`).join('')}</nav><div id="igView" role="tabpanel" aria-labelledby="igTab-${S.tab}"></div>`;}
  function error(err){const el=root().querySelector('#igError');if(el){el.textContent=err.message;el.hidden=false;}}
  const clearError=()=>{const el=root().querySelector('#igError');if(el)el.hidden=true;};
  async function refresh(){
    clearError();const b=root().querySelector('[data-ig-refresh]');if(b)b.disabled=true;
    try{S.catalog=null;S.data=await get('overview');root().querySelector('#igUpdated').textContent='更新于 '+time(S.data.as_of);await view();}
    catch(err){error(err);if(!S.data)root().querySelector('#igView').innerHTML=empty('接入状态暂时无法载入','检查本机服务后，点击右上角刷新。');}
    finally{if(b)b.disabled=false;}
  }
  function select(tab){
    if(!tabs.some(x=>x[0]===tab))return;S.tab=tab;S.seq++;clearError();
    const url=new URL(location.href);url.searchParams.set('ig_view',tab);history.replaceState(null,'',url.pathname+url.search+url.hash);
    root().querySelectorAll('[data-ig-tab]').forEach(b=>{b.setAttribute('aria-selected',String(b.dataset.igTab===tab));b.tabIndex=b.dataset.igTab===tab?0:-1;});
    root().querySelector('#igView').setAttribute('aria-labelledby','igTab-'+tab);view().catch(error);
  }
  async function view(){
    const el=root().querySelector('#igView');if(!el||!S.data)return;
    if(S.tab==='overview'){el.innerHTML=overview();return;}
    if(S.tab==='preview'){el.innerHTML=previewView();return;}
    if(S.tab==='api'){
      if(!S.catalog){const seq=++S.seq;el.innerHTML='<p class="ig-loading" role="status">正在载入接口清单…</p>';S.catalog=await get('catalog');if(seq!==S.seq||S.tab!=='api')return;}
      el.innerHTML=apiView();renderCatalog();return;
    }
    if(['events','deliveries'].includes(S.tab)){renderRecordsFrame();await loadRecords();}
  }
  function overview(){
    const d=S.data,f=d.feishu,online=d.worker?.heartbeat_at&&!d.worker.last_error&&Date.parse(d.as_of)-Date.parse(d.worker.heartbeat_at)<90000;
    const active=d.agents.filter(a=>a.state==='active').length,issues=count('failed')+count('uncertain');
    return `<div class="ig-stat-grid"><div><span>开放接口</span><strong>${d.api.operation_count}<small>项</small></strong><p>覆盖监控、竞品、资讯与通知</p></div><div><span>已记录事件</span><strong>${d.events.total}<small>条</small></strong><p>过去 24 小时新增 ${d.events.last_24h} 条</p></div><div><span>有效 Agent 凭证</span><strong>${active}<small>个</small></strong><p>可独立授权与撤销</p></div><div><span>需要留意的投递</span><strong class="${issues?'ig-warn':''}">${issues}<small>条</small></strong><p>${count('uncertain')} 条待核查 · ${count('failed')} 条失败</p></div></div>
    <div class="ig-overview-grid"><section class="ig-panel ig-connection-panel"><div class="ig-section-head"><div><span class="eyebrow">ONE WORKSPACE, MANY AGENTS</span><h2>同一份数据，多种接入方式</h2></div>${badge('本机 API 可用','good')}</div><p class="ig-description">保留你的监控配置和历史。更换 Agent 后，仍可继续查询、分析和处理。</p>
      <div class="ig-flow"><div><span class="ig-node-icon">${ico('chart')}</span><b>北向工作台</b><small>搜索词 · 商品 · 品牌</small></div><span class="ig-flow-arrow">→</span><div><span class="ig-node-icon">${ico('source')}</span><b>API / CLI</b><small>统一接口与事件流</small></div><span class="ig-flow-arrow">→</span><div><span class="ig-node-icon">${ico('spark')}</span><b>外部 Agent</b><small>调用与持续读取</small></div></div>
      <div class="ig-endpoint"><span>API 地址</span><code>${e(location.origin)}/api/v1</code><button class="ig-copy" data-ig-copy="${e(location.origin)}/api/v1">复制地址</button></div><div class="ig-panel-bottom"><span>${badge(online?'事件服务运行中':'事件服务需检查',online?'good':'warn')}<small>心跳：${time(d.worker?.heartbeat_at)}</small></span><button class="ig-link" data-ig-go="api">查看接入方式 →</button></div></section>
    <section class="ig-panel ig-channel-panel"><div class="ig-section-head"><span class="ig-channel-mark">飞</span>${badge(f.enabled?(f.configured?'已配置':'配置不完整'):'暂未启用',f.enabled&&!f.configured?'warn':'neutral')}</div><h2>飞书通知</h2><p class="ig-description">${f.enabled?'通道状态来自当前配置。实际送达以投递记录为准。':'按你的选择，先保留接口与预览。飞书连接稍后配置。'}</p><ul class="ig-checklist"><li><span>通知预览</span>${badge('可使用','good')}</li><li><span>本机飞书 CLI</span>${badge(f.executable_available?'已找到':'待配置',f.executable_available?'good':'neutral')}</li><li><span>接收群</span>${badge(f.recipient_configured?'已设置':'待设置',f.recipient_configured?'good':'neutral')}</li><li><span>真实发送</span>${badge(f.enabled?'已启用':'已关闭',f.enabled?'good':'neutral')}</li></ul><button class="button button-mint" data-ig-go="preview">${ico('external')} 打开通知预览</button><small class="ig-note">预览不会发送消息，也不会新增投递。</small></section></div>
    <div class="ig-overview-grid ig-bottom-grid"><section class="ig-panel"><div class="ig-section-head"><h2>事件与投递</h2><button class="ig-link" data-ig-go="events">查看事件 →</button></div><div class="ig-delivery-summary">${['queued','sending','sent','failed','uncertain','cancelled'].map(k=>`<button data-ig-state="${k}"><strong>${count(k)}</strong><span>${statuses[k]}</span></button>`).join('')}</div><p class="ig-note">事件表示发生的变化，投递记录表示消息发送进展。两者分别记录。</p></section><section class="ig-panel"><div class="ig-section-head"><h2>把能力交给下一个 Agent</h2>${ico('arrow')}</div><p class="ig-description">接口清单、接入手册和独立凭证，让新 Agent 从当前进度继续。</p><div class="ig-doc-links"><a href="/api/integrations/docs/agent" download>Agent 接入手册 ↓</a><a href="/api/integrations/openapi.json" download>OpenAPI 协议 ↓</a><a href="/api/integrations/docs/design" download>完整设计说明 ↓</a></div></section></div>`;
  }
  const command=(value,label='复制命令')=>`<div class="ig-command"><code>${e(value)}</code><button class="ig-copy" data-ig-copy="${e(value)}">${label}</button></div>`;
  function apiView(){
    const modules=[...new Set(S.catalog.operations.map(r=>r.path.split('/')[3]))];
    return `<div class="ig-section-head ig-title-row"><div><h2>API 与 CLI 接入</h2><p class="ig-note">接口和网页使用相同的数据与业务规则。${S.data.api.operation_count} 项能力可供其他 Agent 调用。</p></div><a class="button button-outline" href="/api/integrations/openapi.json" download>下载 OpenAPI ↓</a></div>
      <div class="ig-api-start"><section class="ig-panel"><span class="ig-step">01 / 连接</span><h3>先确认本机服务</h3><p>在项目目录运行。现有 CLI 可直接检查状态。</p>${command('node bin/north.mjs doctor')}${command('node bin/north.mjs capabilities')}</section><section class="ig-panel"><span class="ig-step">02 / 授权</span><h3>为新 Agent 分配独立凭证</h3><p>默认创建只读凭证，按实际任务增加权限。</p>${command('node bin/north.mjs auth create --name new-agent --out .runtime/integrations/new-agent.json')}<a class="ig-link" href="/api/integrations/docs/agent" download>下载完整接入手册 ↓</a></section><section class="ig-panel"><span class="ig-step">03 / 调用</span><h3>查询业务或读取新事件</h3><p>使用对应凭证；事件消费者保存自己的游标。</p>${command('node bin/north.mjs --config .runtime/integrations/new-agent.json search overview')}${command('node bin/north.mjs --config .runtime/integrations/new-agent.json events list --after 0')}</section></div>
      <details class="ig-panel ig-agent-list"><summary>Agent 凭证概况 <span>${S.data.agents.length} 个凭证记录 · 不显示密钥</span></summary><p class="ig-note">CLI 默认使用本机工作台凭证。新 Agent 使用自己的配置文件路径；API 仍需要 Bearer Token。</p>${S.data.agents.length?S.data.agents.map(a=>`<div class="ig-agent-row"><div><b>${e(a.name)}</b><small>到期：${time(a.expires_at)} · 最近调用：${time(a.last_used_at)}</small></div>${badge({active:'有效',expired:'已过期',revoked:'已撤销'}[a.state],a.state==='active'?'good':'neutral')}<small>${a.scopes.length} 项权限</small></div>`).join(''):empty('还没有 Agent 凭证','使用上方命令创建独立凭证。')}</details>
      <section class="ig-panel"><div class="ig-section-head"><h2>接口目录 <small id="igApiCount"></small></h2><label class="ig-inline-label">业务模块<select id="igModule" aria-label="筛选接口模块"><option value="all">全部模块</option>${modules.map(m=>`<option value="${e(m)}" ${m===S.module?'selected':''}>${e(names[m]||m)}</option>`).join('')}</select></label></div><p class="ig-note">点击接口查看参数和权限。顶部搜索可按用途、路径或权限查找。</p><div id="igApiRows"></div></section>
      <p class="ig-footnote">当前为本机接口。远程 Agent 通过 SSH 隧道或仅开放 /api/v1/ 的 HTTPS 网关接入。</p>`;
  }
  function renderCatalog(){
    const rows=S.catalog.operations.filter(r=>(S.module==='all'||r.path.split('/')[3]===S.module)&&(!S.q||[r.summary,r.path,r.scope,names[r.path.split('/')[3]]].join(' ').toLowerCase().includes(S.q.toLowerCase())));
    root().querySelector('#igApiCount').textContent=rows.length+' 项';
    root().querySelector('#igApiRows').innerHTML=rows.length?rows.map(r=>`<button class="ig-api-row" data-ig-route="${e(r.method+' '+r.path)}"><span class="ig-method ${r.method==='POST'?'post':''}">${r.method}</span><span><b>${e(r.summary)}</b><code>${e(r.path)}</code></span><span class="ig-api-scope">${e(r.scope||'有效凭证')}</span>${ico('chevron')}</button>`).join(''):empty('没有匹配的接口','试试其他业务模块或清空顶部搜索。');
  }
  function previewView(){
    return `<div class="ig-section-head ig-title-row"><div><h2>先看看消息会是什么样</h2><p class="ig-note">填写内容，生成飞书纯文本预览。不会发送、保存事件或加入队列。</p></div>${badge('仅预览','good')}</div><div class="ig-preview-grid"><form id="igPreviewForm" class="ig-panel ig-form"><div class="ig-section-head"><h3>通知内容</h3><button type="button" class="ig-link" data-ig-example>填入示例</button></div><label>通知标题<input name="title" id="igPreviewTitle" value="${e(S.draft.title)}" placeholder="例如：本周搜索词分析已完成" maxlength="120" required></label><div class="ig-field-pair"><label>重要程度<select name="severity">${Object.entries(severity).map(([k,v])=>`<option value="${k}" ${S.draft.severity===k?'selected':''}>${v}</option>`).join('')}</select></label><label>内容类型<select name="type"><option value="agent.report.ready" ${S.draft.type==='agent.report.ready'?'selected':''}>分析报告</option><option value="agent.task.finished" ${S.draft.type==='agent.task.finished'?'selected':''}>任务完成</option><option value="external.notice" ${S.draft.type==='external.notice'?'selected':''}>其他通知</option></select></label></div><label>通知正文<textarea name="body" id="igPreviewBody" rows="8" maxlength="3000" placeholder="写下需要告知的内容、数据时间和下一步。" required>${e(S.draft.body)}</textarea></label><div class="ig-form-footer"><span id="igBodyCount" class="ig-note">${S.draft.body.length} / 3000</span><button type="submit" class="button button-mint">生成预览 ${ico('arrow')}</button></div></form><section class="ig-panel ig-preview-result"><div class="ig-section-head"><h3>消息预览</h3>${badge('飞书 · 机器人','neutral')}</div><div id="igPreviewPane" aria-live="polite">${previewPane()}</div><div class="ig-preview-hint">${ico('shield')}<span>飞书连接稍后配置。这里生成的内容只供预览。</span></div></section></div>`;
  }
  function previewPane(){return S.preview?`<div class="ig-chat"><span class="ig-chat-avatar">N</span><div><b>北向 NORTH <small>机器人预览</small></b><pre>${e(S.preview.message)}</pre></div></div><div class="ig-preview-actions"><span class="ig-note">此内容尚未发送</span><button type="button" class="button button-outline" data-ig-copy-preview>复制预览</button></div>`:empty('在这里查看通知效果','填写左侧内容，或点击「填入示例」，然后生成预览。');}
  function captureDraft(){const f=root().querySelector('#igPreviewForm');if(f)S.draft=Object.fromEntries(new FormData(f).entries());}
  function renderRecordsFrame(){
    const deliveries=S.tab==='deliveries';root().querySelector('#igView').innerHTML=`<section class="ig-panel"><div class="ig-section-head ig-record-head"><div><h2>${deliveries?'投递记录':'事件记录'}</h2><p class="ig-note">${deliveries?'只展示本机飞书通道的真实投递结果。':'监控变化、最终采集失败和 Agent 发布的内容，按入库时间倒序排列。'}</p></div><label class="ig-inline-label">${deliveries?'投递状态':'重要程度'}<select id="igRecordFilter" aria-label="${deliveries?'筛选投递状态':'筛选事件级别'}"><option value="">全部</option>${Object.entries(deliveries?statuses:severity).map(([k,v])=>`<option value="${k}" ${k===(deliveries?S.deliveryState:S.level)?'selected':''}>${v}</option>`).join('')}</select></label></div><div id="igRecords" aria-live="polite"></div><div class="ig-load-more"><button class="button button-outline" id="igMore" hidden>加载更早记录</button></div></section>${deliveries?'<p class="ig-footnote">“待核查”表示可能已经送达，核对飞书后再处理。外部 Agent 自行发送的消息，不会自动出现在此列表。</p>':'<p class="ig-footnote">没有事件时保持为空。通知预览不会写入这里，也不会补造历史变化。</p>'}`;
  }
  async function loadRecords(append=false){
    const seq=++S.seq,deliveries=S.tab==='deliveries',params=new URLSearchParams({limit:'30',q:S.q});
    if(deliveries&&S.deliveryState)params.set('state',S.deliveryState);if(!deliveries&&S.level)params.set('severity',S.level);if(append&&S.next)params.set('before',S.next);
    const el=root().querySelector('#igRecords'),b=root().querySelector('#igMore');b.disabled=true;if(!append)el.innerHTML='<p class="ig-loading" role="status">正在读取记录…</p>';
    try{const data=await get((deliveries?'deliveries':'events')+'?'+params);if(seq!==S.seq)return;
      S.items=append?[...S.items,...data.items]:data.items;S.next=data.next_cursor;S.more=data.has_more;
      el.innerHTML=S.items.length?`<div class="ig-records">${S.items.map(r=>`<button class="ig-record" data-ig-record="${e(r.id)}"><span class="ig-record-icon ${e(deliveries?r.state:r.severity)}">${ico(deliveries?'arrow':'chart')}</span><span class="ig-record-copy"><b>${e(r.title)}</b><span>${e(r.body)}</span><small>${e(r.type)} · ${deliveries?'事件 #'+e(r.event_id):r.origin==='system'?'系统监控':'外部 Agent'} · ${time(r.created_at)}</small></span>${badge(deliveries?statuses[r.state]:severity[r.severity],deliveries?r.state:r.severity)}${ico('chevron')}</button>`).join('')}</div>`:empty(S.q||(deliveries?S.deliveryState:S.level)?'没有匹配的记录':deliveries?'还没有投递记录':'还没有外部事件',S.q||(deliveries?S.deliveryState:S.level)?'清空顶部搜索或调整筛选后再试。':deliveries?'飞书发送尚未启用。启用后，已入队和已送达的消息会在这里显示。':'系统生成的重要变化、任务失败或 Agent 发布的内容，会自动出现在这里。',`<button class="button button-outline" data-ig-go="preview">打开通知预览</button>`);
      b.hidden=!S.more;
    }catch(err){if(seq===S.seq){error(err);if(!append)el.innerHTML=empty('记录暂时无法读取','点击右上角刷新重试。');}}
    finally{if(seq===S.seq)b.disabled=false;}
  }
  function dialog(title,html){const d=document.querySelector('#integrationDialog');document.querySelector('#integrationDialogContent').innerHTML=`<div class="ig-section-head"><h2 id="integrationDialogTitle">${e(title)}</h2><button class="icon-button" data-ig-close aria-label="关闭接入详情">${ico('close')}</button></div>${html}`;d.showModal();}
  function showRoute(key){
    const r=S.catalog.operations.find(r=>r.method+' '+r.path===key);if(!r)return;
    const operation=S.catalog.openapi.paths[r.path.slice('/api/v1'.length)]?.[r.method.toLowerCase()],schema=operation?.requestBody?.content?.['application/json']?.schema;
    dialog(r.summary,`<div class="ig-route-heading"><span class="ig-method ${r.method==='POST'?'post':''}">${r.method}</span><code>${e(r.path)}</code></div><p>需要权限：<code>${e(r.scope||'任意有效凭证')}</code></p><p class="ig-note">${r.async?'返回 202 表示已排队，请再查询任务结果。':'使用与网页一致的校验、数据来源和统计口径。'}</p>${r.query?.length?`<h3>查询参数</h3><p class="ig-chips">${r.query.map(v=>`<code>${e(v)}</code>`).join('')}</p>`:''}${r.idempotent?'<p>请提供稳定的 Idempotency-Key；同一次提交重试时保持键和内容一致。</p>':''}${schema?.properties&&Object.keys(schema.properties).length?`<h3>请求字段</h3><div class="ig-schema">${Object.entries(schema.properties).map(([k,v])=>`<div><code>${e(k)}</code><span>${schema.required?.includes(k)?'必填':'选填'}</span><span>${e(v.description||v.enum?.join(' / ')||v.type||'对象')}</span></div>`).join('')}</div>`:''}${r.method==='POST'?'<p class="ig-note">这是接口说明，页面不会直接执行写操作。</p>':''}${r.example?`<h3>请求示例</h3><pre class="ig-code-block">${e(JSON.stringify(r.example,null,2))}</pre>`:''}${command('node bin/north.mjs request '+r.method+' "'+r.path.slice('/api/v1'.length)+'"'+(r.method==='POST'?' --file request.json':''))}`);
  }
  function showRecord(id){
    const r=S.items.find(x=>x.id===id);if(!r)return;const deliveries=S.tab==='deliveries';
    dialog(r.title,`${badge(deliveries?statuses[r.state]:severity[r.severity],deliveries?r.state:r.severity)}<pre class="ig-message-detail">${e(r.body)}</pre><dl class="ig-detail-meta"><div><dt>记录编号</dt><dd>${e(r.id)}</dd></div><div><dt>内容类型</dt><dd>${e(r.type)}</dd></div><div><dt>入库时间</dt><dd>${time(r.created_at)}</dd></div>${deliveries?`<div><dt>发送尝试</dt><dd>${r.attempts} 次</dd></div><div><dt>飞书消息 ID</dt><dd>${e(r.provider_message_id||'尚无送达回执')}</dd></div><div><dt>处理状态</dt><dd>${e(r.last_error||'无异常记录')}</dd></div>`:`<div><dt>发生时间</dt><dd>${time(r.occurred_at)}</dd></div><div><dt>关联对象</dt><dd>${e(r.object_ref?.kind||'未提供')} ${e(r.object_ref?.id||'')}</dd></div>`}</dl>${deliveries&&r.state==='uncertain'?'<p class="ig-note">此条可能已经送达。请先核查飞书，再通过 CLI 或 API 确认结果。</p>':''}`);
  }
  async function copy(text,button){try{await navigator.clipboard.writeText(text);const old=button.textContent;button.textContent='已复制';setTimeout(()=>{if(button.isConnected)button.textContent=old;},1800);}catch{dialog('复制内容',`<p>浏览器未允许自动复制，可选中下面的内容复制。</p><textarea class="ig-copy-fallback" readonly aria-label="可复制内容">${e(text)}</textarea>`);}}
  document.addEventListener('click',event=>{
    const t=event.target.closest('button');if(!t)return;
    if(t.dataset.igTab){select(t.dataset.igTab);return;}
    if(t.dataset.igGo){select(t.dataset.igGo);return;}
    if(t.hasAttribute('data-ig-refresh')){refresh();return;}
    if(t.hasAttribute('data-ig-state')){S.deliveryState=t.dataset.igState;select('deliveries');return;}
    if(t.hasAttribute('data-ig-copy')){copy(t.dataset.igCopy,t);return;}
    if(t.hasAttribute('data-ig-copy-preview')){if(S.preview)copy(S.preview.message,t);return;}
    if(t.dataset.igRoute){showRoute(t.dataset.igRoute);return;}
    if(t.dataset.igRecord){showRecord(t.dataset.igRecord);return;}
    if(t.hasAttribute('data-ig-close')){document.querySelector('#integrationDialog').close();return;}
    if(t.id==='igMore'){loadRecords(true);return;}
    if(t.hasAttribute('data-ig-example')){
      S.draft={type:'agent.report.ready',severity:'info',title:'通知预览示例',body:'这是一条用于查看排版的示例消息。\n你可以在这里填写已核实的分析结果、数据时间和下一步。\n预览不会发送到飞书。'};S.preview=null;view();
    }
  });
  document.addEventListener('change',event=>{
    if(event.target.id==='igModule'){S.module=event.target.value;renderCatalog();}
    if(event.target.id==='igRecordFilter'){if(S.tab==='deliveries')S.deliveryState=event.target.value;else S.level=event.target.value;loadRecords();}
  });
  document.addEventListener('input',event=>{
    if(event.target.closest('#igPreviewForm')){captureDraft();S.preview=null;root().querySelector('#igBodyCount').textContent=S.draft.body.length+' / 3000';root().querySelector('#igPreviewPane').innerHTML=previewPane();}
  });
  document.addEventListener('submit',async event=>{
    if(event.target.id!=='igPreviewForm')return;event.preventDefault();if(S.previewPending)return;captureDraft();const draft=JSON.stringify(S.draft),button=event.target.querySelector('[type=submit]');button.disabled=true;S.previewPending=true;clearError();
    try{const preview=await get('preview',{method:'POST',headers:{'Content-Type':'application/json'},body:draft});if(draft===JSON.stringify(S.draft)){S.preview=preview;if(S.tab==='preview')root().querySelector('#igPreviewPane').innerHTML=previewPane();}}
    catch(err){error(err);}finally{button.disabled=false;S.previewPending=false;}
  });
  document.addEventListener('keydown',event=>{
    if(!event.target.matches('[data-ig-tab]')||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const i=tabs.findIndex(x=>x[0]===S.tab),n=event.key==='Home'?0:event.key==='End'?tabs.length-1:(i+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;select(tabs[n][0]);root().querySelector('#igTab-'+S.tab).focus();
  });
  window.Integrations={open:async()=>{S.q='';const tab=new URL(location.href).searchParams.get('ig_view');S.tab=tabs.some(x=>x[0]===tab)?tab:'overview';S.seq++;frame();await refresh();},search:q=>{S.q=q;if(S.tab==='api'){if(S.catalog)renderCatalog();}else if(['events','deliveries'].includes(S.tab))loadRecords();else if(q)select('api');}};
})();
