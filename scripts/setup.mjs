import pg from 'pg';
import { connection, pool, schema } from '../lib/db.mjs';
import { sources, articles, events, metrics } from '../data/seed.mjs';
const admin = new pg.Client({...connection,database:'postgres'});
try {
  await admin.connect();
  if (!/^[a-z][a-z0-9_]*$/.test(connection.database)) throw new Error('Invalid database name');
  const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[connection.database]);
  if (!exists.rowCount) await admin.query(`CREATE DATABASE "${connection.database}"`);
} finally { await admin.end(); }
const client = await pool.connect();
try {
  await client.query('BEGIN');
  await schema(client);
  for (const s of sources) await client.query(`INSERT INTO sources(id,name,url,kind,feed_url,category,enabled,note) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO NOTHING`,[s.id,s.name,s.url,s.kind||'manual',s.feed_url||null,s.category,s.enabled||false,s.note]);
  for (const a of articles) {
    if (Array.from(a.summary).length > 100) throw new Error(`Summary exceeds 100 characters: ${a.id}`);
    await client.query(`INSERT INTO articles(id,source_id,title,summary,url,category,topic,region,scope,published_at,effective_at,status,priority,tags,checked_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT(id) DO NOTHING`,[a.id,a.source_id,a.title,a.summary,a.url,a.category,a.topic,a.region,a.scope||null,a.published_at||null,a.effective_at||null,a.status||'news',a.priority,a.tags,'2026-10-24T06:00:00Z']);
  }
  for (const e of events) await client.query(`INSERT INTO policy_events(id,article_id,label,kind,start_date,end_date,color) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING`,[e.id,e.article_id,e.label,e.kind,e.start_date||null,e.end_date,e.color]);
  for (const m of metrics) await client.query(`INSERT INTO metrics(id,title,subtitle,source_url,period,unit,points) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING`,[m.id,m.title,m.subtitle,m.source_url,m.period,m.unit,JSON.stringify(m.points)]);
  await client.query('COMMIT');
  console.log(`Database ${connection.database} ready. ${articles.length} verified summaries initialized.`);
} catch(error) { await client.query('ROLLBACK'); throw error; }
finally { client.release(); await pool.end(); }
