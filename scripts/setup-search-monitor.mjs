import {pool,schema} from '../lib/db.mjs';
import {searchSchema} from '../lib/search-monitor/schema.mjs';
import {saveMonitor} from '../lib/search-monitor/store.mjs';
await schema();await searchSchema(pool);
for(const keyword of ['indoor security camera','2k indoor camera','indoor camera']){
  try{await saveMonitor({keyword,group_name:'室内摄像头 · 候选词',state:'draft'});}catch(e){if(e.status!==400)throw e;}
}
const known=(await pool.query(`SELECT c.name AS brand,c.role,p.name AS label,l.url FROM competitor_listings l JOIN competitor_products p ON p.id=l.product_id JOIN competitors c ON c.id=p.competitor_id`)).rows;
let mapped=0;
for(const r of known){let u;try{u=new URL(r.url);}catch{continue;}if(!['amazon.com','www.amazon.com'].includes(u.hostname))continue;const asin=u.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/)?.[1];if(!asin)continue;
  const result=await pool.query(`INSERT INTO search_asin_identities(marketplace,asin,brand,label,own,source_url) VALUES('US',$1,$2,$3,$4,$5) ON CONFLICT(marketplace,asin) DO NOTHING`,[asin,r.brand,r.label,r.role==='own',r.url]);mapped+=result.rowCount;
}
console.log(`Search monitor configured: 3 suggested draft keywords; ${mapped} existing product identities linked. No scheduled collection enabled.`);
await pool.end();
