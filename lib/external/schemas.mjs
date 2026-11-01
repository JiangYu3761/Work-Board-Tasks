const string={type:'string'},boolean={type:'boolean'},uuid={type:'string',format:'uuid'},date={type:['string','null'],format:'date'};
const obj=(properties,required=[])=>({type:'object',properties,required,additionalProperties:true});
const choice=values=>({type:'string',enum:values}),integer=(min,max)=>({type:'integer',minimum:min,maximum:max});
const str=max=>({type:'string',maxLength:max});
const searchProfile=obj({marketplace:{const:'US'},postal_code:{type:'string',pattern:'^\\d{5}$',default:'60202'},timezone:choice(['America/Chicago','America/New_York','America/Los_Angeles','America/Denver']),pages:integer(1,3)});
const monitor=obj({keyword:{...str(160),minLength:1},group_name:str(60),profile:searchProfile,hours:{type:'array',minItems:1,maxItems:6,items:integer(0,23)},targets:{type:'array',maxItems:30,items:obj({asin:{type:'string',pattern:'^[A-Z0-9]{10}$'},label:str(100),goal_rank:integer(1,300)},['asin'])},state:choice(['draft','active','paused','archived']),priority:integer(1,3)},['keyword']);
const asinProfile=obj({zip:{type:'string',pattern:'^\\d{5}$'},country:{const:'US'},language:{const:'en-US'},currency:{const:'USD'},login:{const:'guest'},prime:{const:false},viewport:{const:'1440x1000'},reviews:{const:'pdp-default'},offer:{const:'featured-new'}});
const asinRules=obj({price_hours:{type:'integer',enum:[1,4,12,24]},content_hours:{type:'integer',enum:[4,12,24,48]},price_percent:{type:'number',minimum:0,maximum:100}});
const target=obj({input:{type:'string',description:'ASIN 或 Amazon US 商品 URL；与 asin 至少提供一个'},asin:string,marketplace:{const:'US'},name:str(240),tags:str(200),brand_id:{type:['string','null']},listing_id:{type:['string','null']},profile:asinProfile,rules:asinRules,status:choice(['active','paused'])});
const competitor=obj({name:str(80),market:str(60),currency:choice(['USD','EUR','GBP','CAD','AUD','JPY','CNY']),website:string,sources:{type:'array',maxItems:20,items:obj({label:str(50),url:string},['label','url'])},role:choice(['own','priority','competitor']),focus:str(160),paused:boolean,archived:boolean},['name','market','currency','sources']);
export const EventInput=obj({type:{type:'string',pattern:'^(agent|external)\\.[a-z0-9_.-]+$',maxLength:100},severity:choice(['info','important','critical']),title:{...str(120),minLength:1},body:{...str(3000),minLength:1},object_ref:obj({kind:str(120),id:str(120)}),occurred_at:{type:'string',format:'date-time',description:'实际发生时间，省略时用服务器入库时间；必须带时区'},notify:{...boolean,default:false,description:'true 还需 notify:write 以及已配置的飞书通道'}},['type','title','body']);
export function inputSchema(path){
  const fixed={
    '/articles/{id}/saved':obj({saved:boolean},['saved']),
    '/competitors':competitor,'/competitors/{id}':competitor,
    '/competitors/{id}/products':obj({line:str(80),name:str(100),variant:str(120),launched_at:date,status:choice(['onsale','preorder','discontinued']),lens_count:integer(1,20),pack_quantity:integer(1,100),power:str(60)},['line','name','variant']),
    '/competitors/{id}/listings':obj({product_id:string,platform:str(60),seller:str(100),url:string},['product_id','platform','seller','url']),
    '/competitors/{id}/observations':obj({listing_id:string,observed_on:{type:'string',format:'date'},sale_price:{type:'number',minimum:0},list_price:{type:['number','null'],minimum:0},coupon_type:choice(['none','amount','percent']),coupon_value:{type:['number','null'],minimum:0},coupon_public:boolean,conditions:str(300),rating:{type:['number','null'],minimum:0,maximum:5},review_count:{type:['integer','null'],minimum:0},availability:choice(['in_stock','out_of_stock','unknown']),source_url:string},['listing_id','observed_on','sale_price','coupon_type','availability']),
    '/competitors/{id}/events':obj({kind:choice(['launch','promotion','important','guide','story']),title:str(100),summary:str(100),published_on:{type:'string',format:'date'},starts_on:date,ends_on:date,source_url:string},['kind','title','summary','published_on','source_url']),
    '/search/monitors':monitor,'/search/monitors/{id}/update':monitor,
    '/search/identities':obj({marketplace:{const:'US'},asin:{type:'string',pattern:'^[A-Z0-9]{10}$'},brand:str(80),label:str(120),parent_asin:{type:['string','null']},own:boolean,source_url:{type:'string',format:'uri'}},['asin','brand','own','source_url']),
    '/search/cohorts':obj({snapshot_id:uuid,name:str(80)},['snapshot_id','name']),
    '/search/sales-preview':obj({content:{type:'string',description:'UTF-8 CSV 文本；完整 JSON 请求不超过 4 MiB'},filename:str(200)},['content']),
    '/search/alerts/{id}':obj({state:choice(['new','acknowledged','investigating','resolved','closed']),note:str(2000),owner:str(80),review_on:date},['state']),
    '/asin-monitors':target,'/asin-monitors/import':obj({items:{type:'array',minItems:1,maxItems:50,items:target},defaults:target},['items']),
    '/asin-monitors/{id}':obj({name:str(240),tags:str(200),profile:asinProfile,rules:asinRules,status:choice(['active','paused','archived'])}),
    '/asin-monitors/settings':obj({daily_limit:integer(1,1000)},['daily_limit']),
    '/asin-monitors/{id}/check':obj({module:choice(['all','price','content'])}),
    '/asin-monitors/{id}/snapshots':obj({asin:string,marketplace:{const:'US'},profile:asinProfile,observed_at:{type:'string',format:'date-time'},fields:{type:'object',description:'键名及字段结构见 GET /asin-monitors/{id}/template；必须用真实观察数据，unknown 不等于 absent',additionalProperties:obj({state:choice(['observed','unknown','absent']),value:{},raw:string,reason:string,currency:string,precision:choice(['exact','approximate'])},['state'])}},['asin','marketplace','profile','observed_at','fields']),
    '/asin-monitors/{id}/events/{event_id}':obj({status:choice(['confirmed','ignored']),note:str(1000),starred:boolean}),
    '/events':EventInput,'/notifications/preview':EventInput,
    '/notifications/{id}/resolve':obj({action:choice(['cancel','confirmed_sent','confirmed_not_sent']),note:{...str(500),minLength:1},provider_message_id:{...str(200),description:'confirmed_sent 时必填，来自已核实的飞书消息'}},['action','note'])
  };
  return fixed[path]||obj({});
}
