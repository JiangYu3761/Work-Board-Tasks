import {pool} from '../lib/db.mjs';
import {archiveSources,archiveArticles,archiveEvents} from '../data/archive-2026.mjs';
const client=await pool.connect();
try{
 await client.query('BEGIN');
 for(const s of archiveSources)await client.query("INSERT INTO sources(id,name,url,category,note) VALUES($1,$2,$3,$4,'2026 年历史记录已核实；持续自动接入尚未启用。') ON CONFLICT(id) DO NOTHING",[s.id,s.name,s.url,s.category]);
 for(const a of archiveArticles){
  if([...a.summary].length>100)throw new Error('Summary too long: '+a.id);
  if(!a.url.startsWith('https://')||(!a.published_at&&!a.effective_at))throw new Error('Missing source/date: '+a.id);
  await client.query(`INSERT INTO articles(id,source_id,title,summary,url,category,topic,region,scope,published_at,effective_at,status,priority,tags) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT(id) DO UPDATE SET title=EXCLUDED.title,summary=EXCLUDED.summary,url=EXCLUDED.url,published_at=EXCLUDED.published_at,effective_at=EXCLUDED.effective_at,updated_at=now()`,[a.id,a.source_id,a.title,a.summary,a.url,a.category,a.topic,a.region,a.scope,a.published_at,a.effective_at,a.status,a.priority,a.tags]);
 }
 for(const e of archiveEvents)await client.query('INSERT INTO policy_events(id,article_id,label,kind,start_date,end_date,color) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO UPDATE SET label=EXCLUDED.label,start_date=EXCLUDED.start_date,end_date=EXCLUDED.end_date',[e.id,e.article_id,e.label,e.kind,e.start_date||null,e.end_date,e.color]);
 await client.query('COMMIT');
 console.log(`Historical archive imported: ${archiveArticles.length} records; bookmarks preserved.`);
 console.table((await client.query("SELECT category,count(*)::int AS count FROM articles GROUP BY category ORDER BY category")).rows);
} catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();await pool.end();}
