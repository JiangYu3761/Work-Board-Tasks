// Verified initial configuration, 2026-10-24. Not a live feed or historical backfill.
export const observedOn='2026-10-24';
const source=(label,url)=>({label,url});
export const brands=[
 {id:'homa-us',name:'homa',role:'own',website:'',focus:'自有品牌。官网、具体型号与商品链接待补充；暂不填写未经确认的产品参数。',sources:[]},
 {id:'ring-us',name:'Ring',role:'priority',website:'https://ring.com/',focus:'Amazon 旗下重点对手：2K 室内固定机、球机／云台机与智能可视门铃。',sources:[source('官方室内摄像头','https://ring.com/products/indoor-cam-plus')]},
 {id:'blink-us',name:'Blink',role:'priority',website:'https://www.blinkforhome.com/',focus:'Amazon 旗下重点对手：Mini 2K+ 室内插电机与可视门铃。单机镜头数与 1–3 台套装分别记录。',sources:[source('Amazon 品牌店','https://www.amazon.com/stores/page/C5DECBBE-4F56-4C36-B933-E62144578691'),source('官方产品消息','https://www.aboutamazon.com/news/devices/blink-4k-long-range-security-cameras')]},
 {id:'echo-us',name:'Amazon Echo',role:'priority',website:'https://www.amazon.com/',focus:'智能音箱重点对手：Echo Dot Max、Echo Studio；按具体型号记录售价、促销和用户评价。',sources:[source('Echo Dot Max 商品页','https://www.amazon.com/dp/B0D6SX8VLQ'),source('Echo Studio 商品页','https://www.amazon.com/dp/B0DMQ1QMVV')]},
 {id:'apple-us',name:'Apple',role:'priority',website:'https://www.apple.com/',focus:'智能音箱重点对手：HomePod 与 HomePod mini 2。首批使用苹果美国官网，亚马逊商品尚未匹配。',sources:[source('HomePod 系列','https://www.apple.com/homepod/')]},
 {id:'tapo-us',name:'Tapo',role:'competitor',website:'https://us.store.tapo.com/',focus:'补充对照：2K 室内固定机、球机／云台机、双镜头 C246D；C325WB 单列为户外枪机参考。',sources:[source('官方室内摄像头','https://us.store.tapo.com/collections/indoor-cameras')]}
];
const fixed='2K 室内有线 · 固定视角',ptz='2K 室内有线 · 球机／云台',dual='2K 室内有线 · 双镜头',door='智能可视门铃',speaker='智能音箱';
const camera=(lens=1,pack=1,power='插电供电 · Wi-Fi 联网',note='')=>({lens_count:lens,pack_quantity:pack,power,note});
const amazon=(asin,price=null,list=null,rating=null,reviews=null,note='')=>({platform:'Amazon US',seller:price==null?'卖家待核实':'Amazon.com',url:`https://www.amazon.com/dp/${asin}`,asin,observation:price==null?null:{sale_price:price,list_price:list,rating,review_count:reviews,availability:'in_stock',conditions:note||'美国站，配送区域 60202；未登录普通买家页面价格。未计入订阅、信用卡和以旧换新优惠。'}});
const official=(seller,url,price,list=null,conditions='',availability='unknown')=>({platform:'品牌官网',seller,url,observation:{sale_price:price,list_price:list,rating:null,review_count:null,availability,conditions}});
export const products=[
 {id:'ring-indoor-2k-white',brand:'ring-us',line:fixed,name:'Indoor Cam 2K',variant:'白色 · 2K · 单台',specs:camera(),listings:[amazon('B0DXM9Y8J1',59.99,null,4.6,4082)]},
 {id:'ring-pan-tilt-2k-white',brand:'ring-us',line:ptz,name:'Pan-Tilt Indoor Cam 2K',variant:'白色 · 2K · 单台',specs:camera(1,1,'插电供电 · Wi-Fi 联网','360° 云台'),listings:[amazon('B0GZLRN1ST',69.99,null,4.2,42)]},
 {id:'ring-wired-doorbell-2k',brand:'ring-us',line:door,name:'Wired Doorbell 2K',variant:'Speckled Gray · 2K · 单台',specs:camera(1,1,'门铃线供电'),listings:[amazon('B0FJJ66YZ1',44.99,79.99,4.2,3021)]},
 {id:'blink-mini-2k-white-1',brand:'blink-us',line:fixed,name:'Mini 2K+',variant:'白色 · 2K · 1 台装',specs:camera(),listings:[amazon('B0F3BC8661',16.99,39.99,4.4,9099,'美国站 60202，普通买家限时售价；39.99 为 Typical Price 参照价，不代表原始 MSRP。未计入订阅、信用卡及以旧换新优惠。')]},
 {id:'blink-mini-2k-white-2',brand:'blink-us',line:fixed,name:'Mini 2K+ · 2 台装',variant:'白色 · 2K · 2 台装',specs:camera(1,2),listings:[amazon('B0F3BJJ9DJ')]},
 {id:'blink-mini-2k-white-3',brand:'blink-us',line:fixed,name:'Mini 2K+ · 3 台装',variant:'白色 · 2K · 3 台装',specs:camera(1,3),listings:[amazon('B0FM557VGT')]},
 {id:'blink-wired-doorbell-2k',brand:'blink-us',line:door,name:'Wired Doorbell 2K+',variant:'2K · 单台 · 室内响铃设备另配',specs:camera(1,1,'门铃线供电'),listings:[amazon('B0G62LKVGT',23.99,49.99,4.1,1370)]},
 {id:'echo-dot-max-graphite',brand:'echo-us',line:speaker,name:'Echo Dot Max',variant:'Graphite · 单台',specs:{pack_quantity:1,power:'插电供电',note:'Alexa 生态'},listings:[amazon('B0D6SX8VLQ',89.99,119.99,4.3,5619)]},
 {id:'echo-studio-graphite',brand:'echo-us',line:speaker,name:'Echo Studio',variant:'Graphite · 单台 · newest model',specs:{pack_quantity:1,power:'插电供电',note:'Alexa 生态'},listings:[amazon('B0DMQ1QMVV',219.99,null,4.0,1427)]},
 {id:'apple-homepod-midnight',brand:'apple-us',line:speaker,name:'HomePod（第二代）',variant:'Midnight · 美国版 · 单台',specs:{pack_quantity:1,power:'插电供电',note:'Apple 家庭生态'},listings:[official('Apple 美国官方','https://www.apple.com/shop/buy-homepod/homepod',349,null,'官网选项报价；交付日期需选择配送地点确认。')]},
 {id:'apple-homepod-mini-2-white',brand:'apple-us',line:speaker,name:'HomePod mini 2',variant:'白色 · 美国版 · 单台',status:'preorder',specs:{pack_quantity:1,power:'USB-C 供电',note:'预售 · 10 月 30 日开售'},listings:[official('Apple 美国官方','https://www.apple.com/shop/buy-homepod/homepod-mini',149,null,'官网预售报价，页面标明 10 月 30 日开售；Siri AI 功能计划通过未来软件更新提供。')]},
 {id:'tapo-c110',brand:'tapo-us',line:fixed,name:'Tapo C110',variant:'2K · 单台',specs:camera(),listings:[amazon('B09YL5G1Y8')]},
 {id:'tapo-c211-2',brand:'tapo-us',line:ptz,name:'Tapo C211 · 2 台装',variant:'黑色 · 2K · 2 台装',specs:camera(1,2,'插电供电 · Wi-Fi 联网','360° 云台'),listings:[amazon('B0D7XPXCSL',44.99,54.99,4.5,23258,'美国站 60202；全新 2 台装总价 44.99，页面折算单台 22.50；未采用二手价格。')]},
 {id:'tapo-c246d',brand:'tapo-us',line:dual,name:'Tapo C246D HybridCam Duo',variant:'2K + 2K · 单台',specs:camera(2,1,'插电供电 · Wi-Fi 联网','固定广角 + 云台长焦'),listings:[amazon('B0F5KG51QF',54.98,69.99,4.5,888),official('Tapo 美国官方','https://us.store.tapo.com/collections/indoor-cameras/products/2k-dual-lens-indoor-outdoor-security-camera-tapo-c246d',54.98,79.99,'官网单台报价；可用于室内和室外。', 'in_stock')]},
 {id:'tapo-c325wb',brand:'tapo-us',line:'家庭安防 · 户外枪机',name:'Tapo C325WB ColorPro',variant:'2K QHD · 单台 · 页面标示 PoE / Plug-In',specs:camera(1,1,'插电 / PoE','户外参考，非室内直竞'),listings:[amazon('B0C48DZJ6Y',59.98,74.99,4.3,892,'美国站 60202；当前页面标示 PoE 或 Wi-Fi，未明确硬件版本号；不与旧版 C325WB 混算。')]}
];
