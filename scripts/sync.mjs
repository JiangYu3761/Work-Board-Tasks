import { syncAll } from '../lib/sync.mjs';
import { pool } from '../lib/db.mjs';
try { console.log(JSON.stringify(await syncAll(),null,2)); } finally {await pool.end();}
