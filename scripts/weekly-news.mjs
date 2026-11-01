import {readFile} from 'node:fs/promises';
import {pool} from '../lib/db.mjs';
import {importWeeklyNews,validateBatch,weeksBetween} from '../lib/weekly-news.mjs';
const file=process.argv.find(a=>a.endsWith('.json'))||new URL('../data/weekly-news/2026-07-25_2026-10-25.json',import.meta.url);
try{const batch=JSON.parse(await readFile(file,'utf8'));validateBatch(batch);
 if(process.argv.includes('--check'))console.log(JSON.stringify({valid:true,articles:batch.articles.length,weeks:weeksBetween(batch.period_start,batch.period_end).length}));
 else{const {articles,...result}=await importWeeklyNews(pool,batch);console.log(JSON.stringify(result));console.table((await pool.query(`SELECT week_start::text,coverage_start::text,coverage_end::text,count(i.article_id)::int AS stories FROM weekly_news_weeks w LEFT JOIN weekly_news_items i USING(batch_id,week_start) WHERE batch_id=$1 GROUP BY w.week_start,coverage_start,coverage_end ORDER BY week_start`,[batch.id])).rows);}
}finally{await pool.end();}
