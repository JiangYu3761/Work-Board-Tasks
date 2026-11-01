import {inputSchema} from './schemas.mjs';
// This registry is both the permission allowlist and the OpenAPI source.
const routes=[];
function add(method,path,scope,summary,options={}) {
  routes.push({method,path,scope,summary,...options,pattern:new RegExp('^'+path.replace(/[.*+?^$()|[\]\\]/g,'\\$&').replace(/\{[^}]+\}/g,'[^/]+')+'$')});
}
for(const p of ['health','capabilities','openapi.json','integration-status'])add('GET','/'+p,null,({health:'检查服务',capabilities:'发现能力与权限','openapi.json':'获取 OpenAPI 3.1 协议','integration-status':'检查通知通道'})[p],{native:true});
add('GET','/dashboard','news:read','资讯总览');add('GET','/articles','news:read','查询资讯',{query:['category','q','saved','official','focus','year','month','days','sort','week']});
add('GET','/news-weeks','news:read','已核实的每周重点新闻归档');
add('GET','/sources','news:read','来源与同步状态');add('POST','/articles/{id}/saved','news:write','收藏或取消收藏',{example:{saved:true}});add('POST','/sync','news:write','同步资讯来源');
add('GET','/competitors','competitors:read','品牌列表');add('GET','/competitors/{id}','competitors:read','品牌产品、价格与动态');
const competitorExample={name:'品牌名称',market:'US',currency:'USD',website:'https://example.com',sources:[],role:'competitor',focus:''};
add('POST','/competitors','competitors:write','新建品牌',{example:competitorExample});add('POST','/competitors/{id}','competitors:write','修改品牌',{example:competitorExample});
for(const [p,s,e]of [
  ['products','添加型号',{line:'Camera',name:'型号',variant:'单台',status:'onsale'}],
  ['listings','添加商品链接',{product_id:'产品 ID',platform:'Amazon',seller:'卖家',url:'https://www.amazon.com/dp/B000000000'}],
  ['observations','追加真实价格观察',{listing_id:'链接 ID',observed_on:'2026-10-25',sale_price:29.99,coupon_type:'none',coupon_public:false,availability:'in_stock'}],
  ['events','追加品牌动态',{kind:'important',title:'标题',summary:'已核实的简要事实',published_on:'2026-10-25',source_url:'https://example.com/news'}]
])add('POST','/competitors/{id}/'+p,'competitors:write',s,{example:e});
for(const [p,s,q]of [
  ['overview','搜索监控总览',[]],['monitors/{id}','关键词历史与任务',['days']],['snapshots/{id}','搜索快照',[]],
  ['snapshots/{id}/evidence','原页截图',['page']],['ranks','自然位趋势',['monitor','asin','days']],['sales','有来源的销量汇总',['period','snapshot','cohort']],
  ['sales-template','销量 CSV 模板',[]],['sales-batches','销量导入批次',[]],['sales-batches/{id}','批次预览',[]],['export','快照 CSV 导出',['snapshot']]
])add('GET','/search/'+p,'search:read',s,{query:q,binary:p.endsWith('evidence')?'image/png':['export','sales-template'].includes(p)?'text/csv':undefined});
const monitorExample={keyword:'indoor security camera',group_name:'室内摄像头',profile:{marketplace:'US',postal_code:'60202',timezone:'America/Chicago',pages:3},hours:[8,14,20],targets:[],state:'draft',priority:2};
for(const [p,s,e]of [
  ['monitors','创建搜索词监控',monitorExample],['monitors/{id}/update','更新监控条件（完整配置，非局部 PATCH）',monitorExample],['monitors/{id}/run','排队采集当前页面',{}],
  ['identities','维护品牌与自有 ASIN 身份',{marketplace:'US',asin:'B000000000',brand:'HOMA',label:'实际型号',own:true,source_url:'https://www.amazon.com/dp/B000000000'}],
  ['snapshots/{id}/recalculate','按当前身份重算快照',{}],['cohorts','冻结商品集合',{snapshot_id:'快照 UUID',name:'固定样本'}],
  ['sales-preview','校验并预览销量 CSV',{filename:'sales.csv',content:'CSV 内容'}],['sales-batches/{id}/commit','提交已校验销量',{}],['sales-batches/{id}/revert','撤销销量批次',{}],
  ['alerts/{id}','处理搜索异常',{state:'acknowledged',note:'已开始核查',owner:'负责人',review_on:null}]
])add('POST','/search/'+p,'search:write',s,{example:e,async:p.endsWith('/run')});
for(const [p,s,q]of [
  ['','商品监控列表',[]],['/catalog','已知 ASIN 目录',[]],['/notifications','商品变化提醒',[]],['/digest','商品变化日报',['day']],
  ['/{id}','商品详情与历史',[]],['/{id}/template','手工观察模板',[]],['/{id}/snapshots/{snapshot_id}','单份商品快照',[]],
  ['/{id}/compare','比较同条件商品快照',['before','after']],['/{id}/evidence/{evidence_id}','商品原始证据',[]],['/{id}/export','商品历史导出',['format']]
])add('GET','/asin-monitors'+p,'asin:read',s,{query:q,binary:p.endsWith('/export')?'text/csv':p.includes('/evidence/')?'application/octet-stream':undefined});
for(const [p,s,e]of [
  ['','添加商品监控',{input:'https://www.amazon.com/dp/B000000000',name:'实际产品名称'}],['/import','批量添加 ASIN',{items:[{input:'B000000000'}],defaults:{}}],
  ['/notifications/read','标记商品提醒已读',{}],['/settings','设置商品采集额度',{daily_limit:350}],['/{id}','修改或暂停商品监控',undefined],
  ['/{id}/check','排队商品采集',{module:'all'}],['/{id}/snapshots','导入真实商品观察',undefined],['/{id}/events/{event_id}','处理商品变化',{status:'confirmed',note:'已核查',starred:false}]
])add('POST','/asin-monitors'+p,'asin:write',s,{example:e,async:p.endsWith('/check')});
add('GET','/jobs/search/{id}','search:read','查询搜索采集任务',{native:true});add('GET','/jobs/asin/{id}','asin:read','查询商品采集任务',{native:true});
add('GET','/events','events:read','按持久化游标读取事件',{native:true,query:['after','limit','type']});
add('POST','/events','events:write','发布自定义事件，可同时请求飞书通知',{native:true,idempotent:true,example:{type:'agent.report.ready',severity:'info',title:'分析已完成',body:'报告内容摘要',object_ref:{kind:'report',id:'report-001'},notify:false}});
add('POST','/notifications/preview','events:write','预览飞书纯文本，不写入或发送',{native:true,example:{type:'agent.report.ready',severity:'info',title:'分析已完成',body:'报告内容摘要'}});
add('GET','/notifications','events:read','查询发送队列与结果',{native:true,query:['state','limit','before']});
add('POST','/notifications/{id}/retry','notify:write','重试明确失败的投递',{native:true});
add('POST','/notifications/{id}/resolve','notify:write','核查不确定投递、取消排队',{native:true,example:{action:'cancel'}});
export {routes};
export const matchRoute=(method,pathname)=>routes.find(r=>r.method===method&&r.pattern.test(pathname));
export function capabilities(actor) {
  return {name:'NORTH',api_version:'v1',agent:actor.name,scopes:actor.scopes,expires_at:actor.expires_at,
    openapi:'/api/v1/openapi.json',event_cursor:'Opaque decimal string; persist next_cursor after successful processing.',
    errors:{shape:'{error:{code,message,request_id},request_id}',request_id_header:'X-Request-Id'},
    limits:{read_per_minute:120,write_per_minute:30},
    operations:routes.map(({pattern,...r})=>({...r,path:'/api/v1'+r.path,allowed:!r.scope||actor.scopes.includes(r.scope)}))};
}
export function openapi() {
  const paths={};
  for(const r of routes){
    const parameters=[...r.path.matchAll(/\{([^}]+)\}/g)].map(m=>({name:m[1],in:'path',required:true,schema:{type:'string'}}));
    for(const name of r.query||[])parameters.push({name,in:'query',schema:{type:'string'}});
    if(r.idempotent)parameters.push({name:'Idempotency-Key',in:'header',required:true,schema:{type:'string',minLength:1,maxLength:120}});
    const operation={summary:r.summary,operationId:r.method.toLowerCase()+r.path.replace(/[^a-zA-Z0-9]+/g,'_'),tags:[r.path.split('/')[1]],parameters,'x-required-scope':r.scope||'authenticated',
      description:r.native?'稳定对外协议。':'与网页调用同一领域服务；校验、数据口径与采集限制一致。请求字段见项目接入说明与现有界面。',
      responses:{[r.async?'202':'200']:{description:r.async?'已排队；用任务查询接口检查最终结果':'成功。业务 JSON 保留原结构；文件保持原始媒体类型。',content:{[r.binary||'application/json']:{schema:r.binary?{type:'string',format:'binary'}:{type:'object',additionalProperties:true}}}},default:{description:'调用失败',content:{'application/json':{schema:{$ref:'#/components/schemas/Error'}}}}}};
    if(r.path==='/events'&&r.method==='POST')operation.responses['201']={...operation.responses['200'],description:'事件已持久化；不等于飞书已发送'};
    if(r.method==='POST'&&['/asin-monitors','/asin-monitors/import','/asin-monitors/{id}/snapshots'].includes(r.path)){operation.responses['201']=operation.responses['200'];delete operation.responses['200'];}
    if(r.path==='/asin-monitors/{id}/export'&&r.method==='GET')operation.responses['200'].content['application/json']={schema:{type:'object',additionalProperties:true}};
    if(r.method==='POST'){const schema=inputSchema(r.path);operation.requestBody={required:!!schema.required?.length,content:{'application/json':{schema,...(r.example?{example:r.example}:{})}}};}
    (paths[r.path]??={})[r.method.toLowerCase()]=operation;
  }
  return {openapi:'3.1.0',info:{title:'NORTH External API',version:'1.0.0',description:'Agent-neutral local API. Loopback HTTP or authenticated HTTPS reverse proxy. All v1 endpoints require a scoped Bearer token.'},servers:[{url:'/api/v1'}],security:[{bearerAuth:[]}],paths,components:{securitySchemes:{bearerAuth:{type:'http',scheme:'bearer',bearerFormat:'north token'}},schemas:{Error:{type:'object',required:['error','request_id'],properties:{request_id:{type:'string',format:'uuid'},error:{type:'object',required:['code','message','request_id'],properties:{code:{type:'string'},message:{type:'string'},request_id:{type:'string',format:'uuid'}}}}}}}};
}
