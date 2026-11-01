export async function asinSchema(db){
  await db.query(`
    CREATE TABLE IF NOT EXISTS asin_targets (
      id uuid PRIMARY KEY, asin text NOT NULL, marketplace text NOT NULL DEFAULT 'US', url text NOT NULL,
      name text NOT NULL DEFAULT '', brand_id text REFERENCES competitors(id) ON DELETE SET NULL,
      listing_id text REFERENCES competitor_listings(id) ON DELETE SET NULL, tags text NOT NULL DEFAULT '',
      status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','archived')),
      profile_version integer NOT NULL DEFAULT 1, profile jsonb NOT NULL, rules jsonb NOT NULL,
      next_price_at timestamptz NOT NULL DEFAULT now(), next_content_at timestamptz NOT NULL DEFAULT now(),
      blocked_reason text, failure_count integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(marketplace,asin)
    );
    CREATE TABLE IF NOT EXISTS asin_runs (
      id uuid PRIMARY KEY, target_id uuid NOT NULL REFERENCES asin_targets(id) ON DELETE CASCADE,
      profile_version integer NOT NULL, profile jsonb NOT NULL, module text NOT NULL,
      source text NOT NULL DEFAULT 'browser', state text NOT NULL DEFAULT 'queued',
      scheduled_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz, finished_at timestamptz,
      lease_until timestamptz, attempts integer NOT NULL DEFAULT 0, reason text, evidence_id uuid,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS asin_one_pending ON asin_runs(target_id) WHERE state IN ('queued','running');
    CREATE INDEX IF NOT EXISTS asin_runs_due ON asin_runs(state,scheduled_at);
    CREATE TABLE IF NOT EXISTS asin_attempts (
      run_id uuid NOT NULL REFERENCES asin_runs(id) ON DELETE CASCADE, attempt integer NOT NULL,
      started_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(run_id,attempt)
    );
    INSERT INTO asin_attempts(run_id,attempt,started_at) SELECT id,attempts,started_at FROM asin_runs WHERE started_at IS NOT NULL AND attempts>0 ON CONFLICT DO NOTHING;
    CREATE TABLE IF NOT EXISTS asin_snapshots (
      id uuid PRIMARY KEY, target_id uuid NOT NULL REFERENCES asin_targets(id) ON DELETE CASCADE,
      run_id uuid REFERENCES asin_runs(id) ON DELETE SET NULL, profile_version integer NOT NULL, profile jsonb NOT NULL,
      source text NOT NULL, observed_at timestamptz NOT NULL, received_at timestamptz NOT NULL DEFAULT now(),
      fields jsonb NOT NULL, coverage jsonb NOT NULL DEFAULT '{}', evidence_id uuid,
      fingerprint text NOT NULL, parser_version text NOT NULL DEFAULT '1',
      UNIQUE(target_id,profile_version,source,observed_at,fingerprint)
    );
    CREATE INDEX IF NOT EXISTS asin_snapshot_history ON asin_snapshots(target_id,profile_version,observed_at DESC);
    CREATE TABLE IF NOT EXISTS asin_field_heads (
      target_id uuid NOT NULL REFERENCES asin_targets(id) ON DELETE CASCADE, profile_version integer NOT NULL,
      source text NOT NULL, field text NOT NULL, snapshot_id uuid NOT NULL REFERENCES asin_snapshots(id) ON DELETE CASCADE,
      observed_at timestamptz NOT NULL, data jsonb NOT NULL,
      PRIMARY KEY(target_id,profile_version,source,field)
    );
    CREATE TABLE IF NOT EXISTS asin_events (
      id uuid PRIMARY KEY, target_id uuid NOT NULL REFERENCES asin_targets(id) ON DELETE CASCADE,
      profile_version integer NOT NULL, source text NOT NULL, field text NOT NULL, kind text NOT NULL,
      before_snapshot_id uuid NOT NULL REFERENCES asin_snapshots(id) ON DELETE CASCADE,
      after_snapshot_id uuid NOT NULL REFERENCES asin_snapshots(id) ON DELETE CASCADE,
      before_value jsonb NOT NULL, after_value jsonb NOT NULL, details jsonb NOT NULL DEFAULT '[]',
      delta numeric, percent numeric, severity text NOT NULL, status text NOT NULL,
      window_start timestamptz NOT NULL, window_end timestamptz NOT NULL,
      confirmed_at timestamptz, read_at timestamptz, starred boolean NOT NULL DEFAULT false,
      note text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(target_id,field,before_snapshot_id,after_snapshot_id)
    );
    CREATE INDEX IF NOT EXISTS asin_event_history ON asin_events(target_id,window_end DESC);
    CREATE TABLE IF NOT EXISTS asin_evidence (
      id uuid PRIMARY KEY, target_id uuid NOT NULL REFERENCES asin_targets(id) ON DELETE CASCADE,
      run_id uuid REFERENCES asin_runs(id) ON DELETE SET NULL, path text NOT NULL, mime text NOT NULL,
      sha256 text NOT NULL, size integer NOT NULL, source_url text, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS asin_notifications (
      id uuid PRIMARY KEY, event_id uuid UNIQUE REFERENCES asin_events(id) ON DELETE CASCADE,
      target_id uuid REFERENCES asin_targets(id) ON DELETE CASCADE, type text NOT NULL DEFAULT 'change',
      title text NOT NULL, read_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS asin_worker_status (
      id integer PRIMARY KEY CHECK(id=1), heartbeat timestamptz, current_run uuid, last_error text,
      daily_limit integer NOT NULL DEFAULT 350 CHECK(daily_limit BETWEEN 1 AND 10000)
    );
    INSERT INTO asin_worker_status(id) VALUES(1) ON CONFLICT DO NOTHING;
  `);
}
