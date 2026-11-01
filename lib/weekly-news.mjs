import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

const DAY=86400000;
export function validDay(value){return typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;}
export function weekStart(day){assert.ok(validDay(day),'Invalid calendar date');const d=new Date(day+'T00:00:00Z');d.setUTCDate(d.getUTCDate()-(d.getUTCDay()+6)%7);return d.toISOString().slice(0,10);}
const plus=(day,n)=>new Date(Date.parse(day+'T00:00:00Z')+n*DAY).toISOString().slice(0,10);
export function weeksBetween(start,end){assert.ok(validDay(start)&&validDay(end)&&start<=end);const weeks=[];for(let s=weekStart(start);s<=end;s=plus(s,7)){const e=plus(s,6);weeks.push({week_start:s,week_end:e,coverage_start:s<start?start:s,coverage_end:e>end?end:e,partial:s<start||e>end});}return weeks;}
export function canonicalNewsUrl(value){const u=new URL(value);assert.equal(u.protocol,'https:');for(const key of [...u.searchParams.keys()])if(/^(utm_|trk$|ref$|fbclid$|gclid$)/i.test(key))u.searchParams.delete(key);u.hash='';u.pathname=u.pathname.replace(/\/+$/,'')||'/';u.searchParams.sort();return u.href;}
export function validateBatch(batch){
 assert.ok(/^[a-z0-9-]+$/.test(batch.id));assert.ok(validDay(batch.period_start)&&validDay(batch.period_end)&&batch.period_start<=batch.period_end);
 const seen=new Set(),urls=new Set(),sources=new Map(batch.sources.map(s=>[s.id,s]));assert.equal(sources.size,batch.sources.length);
 for(const a of batch.articles){
  assert.ok(!seen.has(a.event_key),'Duplicate event: '+a.event_key);seen.add(a.event_key);
  const url=canonicalNewsUrl(a.url),urlDate=a.published_at+'|'+url;assert.ok(!urls.has(urlDate),'Duplicate source URL and date: '+url);urls.add(urlDate);
  assert.ok(sources.has(a.source_id),'Unknown publisher');assert.ok(validDay(a.published_at)&&a.published_at>=batch.period_start&&a.published_at<=batch.period_end,'Outside period: '+a.event_key);
  assert.ok(a.title&&a.summary&&[...a.summary].length<=100,'Invalid summary: '+a.event_key);
  assert.ok(['ai','commerce','amazon','policy'].includes(a.category));assert.ok(a.sector&&a.importance_reason&&a.topic);
  assert.ok(Number.isInteger(a.priority)&&a.priority>=0&&a.priority<=100);
  assert.ok(['published','updated'].includes(a.date_basis));assert.ok(a.evidence?.date_evidence&&a.evidence?.verification_method&&a.evidence?.source_title);
  assert.ok(Number.isFinite(Date.parse(a.evidence.retrieved_at)),'Missing capture time');assert.equal(canonicalNewsUrl(a.evidence.url),url);
  assert.ok(a.evidence.publisher_type==='primary','This batch admits primary publishers only');
 }
 const weeks=weeksBetween(batch.period_start,batch.period_end);for(const w of weeks)assert.ok(batch.articles.some(a=>weekStart(a.published_at)===w.week_start)||batch.gaps?.[w.week_start],'Unexplained weekly gap');
 return weeks;
}
export async function weeklyNewsSchema(db){await db.query(`
 CREATE TABLE IF NOT EXISTS weekly_news_batches(
  id text PRIMARY KEY,period_start date NOT NULL,period_end date NOT NULL,
  timezone text NOT NULL,methodology text NOT NULL,source_audits jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(period_end>=period_start)
 );
 CREATE TABLE IF NOT EXISTS weekly_news_weeks(
  batch_id text NOT NULL REFERENCES weekly_news_batches(id),week_start date NOT NULL,week_end date NOT NULL,
  coverage_start date NOT NULL,coverage_end date NOT NULL,partial boolean NOT NULL,note text NOT NULL DEFAULT '',
  PRIMARY KEY(batch_id,week_start),CHECK(week_end=week_start+6),CHECK(extract(isodow FROM week_start)=1),
  CHECK(coverage_start>=week_start AND coverage_end<=week_end AND coverage_end>=coverage_start)
 );
 CREATE TABLE IF NOT EXISTS weekly_news_items(
  batch_id text NOT NULL,week_start date NOT NULL,article_id text NOT NULL REFERENCES articles(id),
  event_key text NOT NULL,published_on date NOT NULL,sector text NOT NULL,importance_reason text NOT NULL,
  priority integer NOT NULL CHECK(priority BETWEEN 0 AND 100),date_basis text NOT NULL CHECK(date_basis IN ('published','updated')),
  evidence jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(batch_id,event_key),UNIQUE(batch_id,article_id),
  FOREIGN KEY(batch_id,week_start) REFERENCES weekly_news_weeks(batch_id,week_start),
  CHECK(published_on BETWEEN week_start AND week_start+6)
 );
 CREATE INDEX IF NOT EXISTS weekly_news_items_week ON weekly_news_items(week_start,priority DESC);
 CREATE OR REPLACE VIEW weekly_news_archive AS
 SELECT w.batch_id,w.week_start,w.week_end,w.coverage_start,w.coverage_end,w.partial,w.note,
  i.event_key,i.published_on,i.sector,i.importance_reason,i.priority AS weekly_priority,i.date_basis AS weekly_date_basis,i.evidence,
  a.*,s.name AS source_name
 FROM weekly_news_weeks w JOIN weekly_news_items i USING(batch_id,week_start)
 JOIN articles a ON a.id=i.article_id JOIN sources s ON s.id=a.source_id;
 `);}

export async function importWeeklyNews(pool,batch){
 const weeks=validateBatch(batch),client=await pool.connect();let inserted=0,reused=0;
 try{await client.query('BEGIN');await client.query("SELECT pg_advisory_xact_lock(hashtext('north-weekly-news-import'))");await weeklyNewsSchema(client);
  await client.query(`INSERT INTO weekly_news_batches(id,period_start,period_end,timezone,methodology,source_audits) VALUES($1,$2,$3,$4,$5,$6)
   ON CONFLICT(id) DO UPDATE SET methodology=EXCLUDED.methodology,source_audits=EXCLUDED.source_audits,updated_at=now()`,[batch.id,batch.period_start,batch.period_end,batch.timezone,batch.methodology,JSON.stringify(batch.source_audits||[])]);
  for(const w of weeks)await client.query(`INSERT INTO weekly_news_weeks(batch_id,week_start,week_end,coverage_start,coverage_end,partial,note) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(batch_id,week_start) DO UPDATE SET note=EXCLUDED.note`,[batch.id,w.week_start,w.week_end,w.coverage_start,w.coverage_end,w.partial,batch.gaps?.[w.week_start]||'经过来源核实的重点精选，不代表全网穷尽覆盖。']);
  for(const s of batch.sources)await client.query(`INSERT INTO sources(id,name,url,category,note) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING`,[s.id,s.name,s.url,s.category,'历史周报来源；本次补录不代表已启用持续自动采集。']);
  const existing=(await client.query('SELECT id,url,published_at::text,source_id FROM articles')).rows;
  const byId=new Map(existing.map(a=>[a.id,a])),byUrl=new Map(existing.map(a=>[a.published_at+'|'+canonicalNewsUrl(a.url),a]));
  const pairs=[];
  for(const a of batch.articles){
   const normalized=a.published_at+'|'+canonicalNewsUrl(a.url);let row=a.existing_id?byId.get(a.existing_id):byUrl.get(normalized);
   if(a.existing_id)assert.ok(row,'Missing existing article '+a.existing_id);
   if(row){assert.equal(row.published_at,a.published_at,'Existing publication date conflicts: '+row.id);assert.equal(row.source_id,a.source_id,'Publisher conflict: '+row.id);reused++;}
   else{const id='weekly-'+createHash('sha256').update(a.event_key).digest('hex').slice(0,20);
    await client.query(`INSERT INTO articles(id,source_id,title,summary,url,category,topic,region,published_at,status,priority,tags) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'news',$10,$11)`,[id,a.source_id,a.title,a.summary,a.url,a.category,a.topic,a.region||'全球',a.published_at,a.priority,a.tags||[a.sector,a.source_id]]);
    row={id,url:a.url,published_at:a.published_at,source_id:a.source_id};byId.set(id,row);byUrl.set(normalized,row);inserted++;
   }
   await client.query(`INSERT INTO weekly_news_items(batch_id,week_start,article_id,event_key,published_on,sector,importance_reason,priority,date_basis,evidence) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    ON CONFLICT(batch_id,event_key) DO UPDATE SET sector=EXCLUDED.sector,importance_reason=EXCLUDED.importance_reason,priority=EXCLUDED.priority,evidence=EXCLUDED.evidence`,[batch.id,weekStart(a.published_at),row.id,a.event_key,a.published_at,a.sector,a.importance_reason,a.priority,a.date_basis,JSON.stringify(a.evidence)]);
   pairs.push({event_key:a.event_key,article_id:row.id});
  }
  await client.query('COMMIT');return {batch_id:batch.id,reviewed:batch.articles.length,inserted,reused,weeks:weeks.length,articles:pairs};
 }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}
