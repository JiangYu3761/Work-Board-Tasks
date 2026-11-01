import {pool,schema} from '../lib/db.mjs';
import {brands,products,observedOn} from '../data/competitors-2026-10.mjs';
// Stable IDs and DO NOTHING preserve subsequent user edits and make reruns safe.
const client=await pool.connect();
try{
 await client.query('BEGIN');await schema(client);
 for(const b of brands)await client.query(`INSERT INTO competitors(id,name,market,currency,website,sources,role,focus) VALUES($1,$2,'美国','USD',$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING`,[b.id,b.name,b.website,JSON.stringify(b.sources),b.role,b.focus]);
 for(const p of products){
  await client.query(`INSERT INTO competitor_products(id,competitor_id,line,name,variant,status,specs) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING`,[p.id,p.brand,p.line,p.name,p.variant,p.status||'onsale',JSON.stringify(p.specs)]);
  for(const [i,l] of p.listings.entries()){
   const id=p.id+'-listing-'+i;
   await client.query(`INSERT INTO competitor_listings(id,product_id,platform,seller,url) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING`,[id,p.id,l.platform,l.seller,l.url]);
   if(l.observation){const o=l.observation;
    await client.query(`INSERT INTO competitor_observations(id,listing_id,observed_on,list_price,sale_price,coupon_type,coupon_public,conditions,rating,review_count,availability,source_url) VALUES($1,$2,$3,$4,$5,'none',false,$6,$7,$8,$9,$10) ON CONFLICT(id) DO NOTHING`,[id+'-'+observedOn,id,observedOn,o.list_price,o.sale_price,o.conditions,o.rating,o.review_count,o.availability,l.url]);
   }
  }
 }
 await client.query('COMMIT');
 console.log(JSON.stringify({brands:brands.length,productVariants:products.length,listings:products.reduce((n,p)=>n+p.listings.length,0),observations:products.flatMap(p=>p.listings).filter(l=>l.observation).length,observedOn}));
}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();await pool.end();}
