export async function searchSchema(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS search_monitors (
      id uuid PRIMARY KEY, keyword text NOT NULL, group_name text NOT NULL DEFAULT '',
      profile jsonb NOT NULL, environment_key text NOT NULL, hours integer[] NOT NULL DEFAULT '{8,14,20}',
      state text NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','active','paused','archived')),
      targets jsonb NOT NULL DEFAULT '[]', priority integer NOT NULL DEFAULT 2,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      scheduled_through timestamptz NOT NULL DEFAULT now(),
      UNIQUE(keyword, environment_key)
    );
    CREATE TABLE IF NOT EXISTS search_jobs (
      id uuid PRIMARY KEY, monitor_id uuid NOT NULL REFERENCES search_monitors(id) ON DELETE CASCADE,
      kind text NOT NULL CHECK(kind IN ('scheduled','manual','import')), slot_key text,
      scheduled_at timestamptz NOT NULL, status text NOT NULL DEFAULT 'queued',
      attempts integer NOT NULL DEFAULT 0, available_at timestamptz NOT NULL DEFAULT now(),
      started_at timestamptz, finished_at timestamptz, lease_until timestamptz,
      error_code text, error_message text, snapshot_id uuid, created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(monitor_id, slot_key)
    );
    CREATE INDEX IF NOT EXISTS search_job_queue ON search_jobs(status, available_at);
    CREATE TABLE IF NOT EXISTS search_snapshots (
      id uuid PRIMARY KEY, job_id uuid NOT NULL UNIQUE REFERENCES search_jobs(id) ON DELETE CASCADE,
      monitor_id uuid NOT NULL REFERENCES search_monitors(id) ON DELETE CASCADE,
      observed_at timestamptz NOT NULL, environment_key text NOT NULL, source_version text NOT NULL,
      source text NOT NULL, status text NOT NULL, quality jsonb NOT NULL,
      summary jsonb NOT NULL, data jsonb NOT NULL, evidence_dir text, source_hash text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS search_snapshots_history ON search_snapshots(monitor_id, observed_at DESC);
    CREATE TABLE IF NOT EXISTS search_asin_identities (
      marketplace text NOT NULL, asin text NOT NULL, brand text NOT NULL, label text NOT NULL DEFAULT '',
      parent_asin text, own boolean NOT NULL DEFAULT false, source_url text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(marketplace,asin)
    );
    CREATE TABLE IF NOT EXISTS search_sales_batches (
      id uuid PRIMARY KEY, file_hash text NOT NULL UNIQUE, filename text NOT NULL,
      rows jsonb NOT NULL, status text NOT NULL DEFAULT 'preview',
      created_at timestamptz NOT NULL DEFAULT now(), committed_at timestamptz, reverted_at timestamptz
    );
    CREATE TABLE IF NOT EXISTS search_sales (
      id bigserial PRIMARY KEY, batch_id uuid NOT NULL REFERENCES search_sales_batches(id),
      source text NOT NULL, kind text NOT NULL, marketplace text NOT NULL, entity_type text NOT NULL,
      entity_id text NOT NULL, period_start date NOT NULL, period_end date NOT NULL,
      window_type text NOT NULL, units numeric NOT NULL CHECK(units>=0), revenue numeric,
      currency text NOT NULL, as_of timestamptz NOT NULL,
      UNIQUE(batch_id,source,marketplace,entity_type,entity_id,period_start,period_end,window_type,kind)
    );
    CREATE TABLE IF NOT EXISTS search_cohorts (
      id uuid PRIMARY KEY, monitor_id uuid NOT NULL REFERENCES search_monitors(id) ON DELETE CASCADE,
      name text NOT NULL, members jsonb NOT NULL, snapshot_id uuid NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS search_alerts (
      id uuid PRIMARY KEY, monitor_id uuid NOT NULL REFERENCES search_monitors(id) ON DELETE CASCADE,
      object_key text NOT NULL, rule text NOT NULL, title text NOT NULL, details jsonb NOT NULL,
      state text NOT NULL DEFAULT 'new' CHECK(state IN ('new','acknowledged','investigating','resolved','closed')),
      first_seen timestamptz NOT NULL DEFAULT now(), last_seen timestamptz NOT NULL DEFAULT now(),
      note text NOT NULL DEFAULT '', owner text NOT NULL DEFAULT '', review_on date, updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS search_alert_scope ON search_alerts(monitor_id,object_key,rule,state);
    CREATE TABLE IF NOT EXISTS search_audit_log (
      id bigserial PRIMARY KEY, action text NOT NULL, object_id text NOT NULL,
      details jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS search_worker_state (
      id integer PRIMARY KEY DEFAULT 1 CHECK(id=1), heartbeat_at timestamptz,
      state text NOT NULL DEFAULT 'starting', job_id uuid, detail text
    );
  `);
}
