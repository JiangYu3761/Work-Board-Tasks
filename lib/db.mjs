import pg from 'pg';
export const connection = {
  host: process.env.PGHOST || '127.0.0.1',
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || process.env.USER,
  database: process.env.PGDATABASE || 'personal_radar',
  ...(process.env.PGPASSWORD ? { password: process.env.PGPASSWORD } : {}),
  connectionTimeoutMillis: 5000,
  application_name: 'north_personal_radar',
};
export const pool = new pg.Pool({ ...connection, max: 6 });
pool.on('error', () => console.error('PostgreSQL connection interrupted.'));

export async function schema(client = pool) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS sources (
      id text PRIMARY KEY, name text NOT NULL, url text NOT NULL,
      kind text NOT NULL DEFAULT 'manual', feed_url text,
      category text NOT NULL, enabled boolean NOT NULL DEFAULT false,
      last_checked_at timestamptz, last_success_at timestamptz,
      last_error text, note text NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS articles (
      id text PRIMARY KEY, source_id text NOT NULL REFERENCES sources(id),
      title text NOT NULL, summary text NOT NULL CHECK (char_length(summary) <= 100),
      url text NOT NULL, category text NOT NULL,
      topic text NOT NULL, region text NOT NULL DEFAULT '全球',
      scope text, published_at date, effective_at date,
      status text NOT NULL DEFAULT 'news', priority integer NOT NULL DEFAULT 50,
      tags text[] NOT NULL DEFAULT '{}', saved boolean NOT NULL DEFAULT false,
      checked_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS articles_category_date ON articles(category, published_at DESC);
    CREATE TABLE IF NOT EXISTS policy_events (
      id text PRIMARY KEY, article_id text NOT NULL REFERENCES articles(id),
      label text NOT NULL, kind text NOT NULL, start_date date,
      end_date date NOT NULL, color text NOT NULL DEFAULT 'mint'
    );
    CREATE TABLE IF NOT EXISTS metrics (
      id text PRIMARY KEY, title text NOT NULL, subtitle text NOT NULL,
      source_url text NOT NULL, period text NOT NULL, unit text NOT NULL,
      points jsonb NOT NULL, checked_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS candidates (
      id text PRIMARY KEY, source_id text NOT NULL REFERENCES sources(id),
      title text NOT NULL, excerpt text NOT NULL, url text NOT NULL,
      published_at date, state text NOT NULL DEFAULT 'pending',
      created_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz,
      error text
    );
    CREATE TABLE IF NOT EXISTS sync_runs (
      id bigserial PRIMARY KEY, started_at timestamptz NOT NULL DEFAULT now(),
      finished_at timestamptz, status text NOT NULL DEFAULT 'running',
      discovered integer NOT NULL DEFAULT 0, published integer NOT NULL DEFAULT 0,
      errors jsonb NOT NULL DEFAULT '[]'
    );
    CREATE TABLE IF NOT EXISTS competitors (
      id text PRIMARY KEY, name text NOT NULL, market text NOT NULL,
      currency text NOT NULL DEFAULT 'USD', website text NOT NULL DEFAULT '',
      sources jsonb NOT NULL DEFAULT '[]', paused boolean NOT NULL DEFAULT false,
      archived boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS competitor_products (
      id text PRIMARY KEY, competitor_id text NOT NULL REFERENCES competitors(id) ON DELETE CASCADE,
      line text NOT NULL, name text NOT NULL, variant text NOT NULL,
      launched_at date, status text NOT NULL DEFAULT 'onsale'
    );
    CREATE TABLE IF NOT EXISTS competitor_listings (
      id text PRIMARY KEY, product_id text NOT NULL REFERENCES competitor_products(id) ON DELETE CASCADE,
      platform text NOT NULL, seller text NOT NULL, url text NOT NULL
    );
    CREATE TABLE IF NOT EXISTS competitor_observations (
      id text PRIMARY KEY, listing_id text NOT NULL REFERENCES competitor_listings(id) ON DELETE CASCADE,
      observed_on date NOT NULL, list_price numeric(12,2), sale_price numeric(12,2) NOT NULL CHECK(sale_price>=0),
      coupon_type text NOT NULL DEFAULT 'none', coupon_value numeric(12,2),
      coupon_public boolean NOT NULL DEFAULT false, conditions text NOT NULL DEFAULT '',
      rating numeric(2,1), review_count integer, availability text NOT NULL DEFAULT 'unknown',
      source_url text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
      CHECK(list_price IS NULL OR list_price>=0), CHECK(rating IS NULL OR rating BETWEEN 0 AND 5),
      CHECK(review_count IS NULL OR review_count>=0)
    );
    CREATE INDEX IF NOT EXISTS competitor_history ON competitor_observations(listing_id, observed_on DESC, created_at DESC);
    CREATE TABLE IF NOT EXISTS competitor_events (
      id text PRIMARY KEY, competitor_id text NOT NULL REFERENCES competitors(id) ON DELETE CASCADE,
      kind text NOT NULL, title text NOT NULL, summary text NOT NULL CHECK(char_length(summary)<=100),
      published_on date NOT NULL, starts_on date, ends_on date, source_url text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(), CHECK(ends_on IS NULL OR starts_on IS NULL OR ends_on>=starts_on)
    );
    ALTER TABLE competitors ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'competitor';
    ALTER TABLE competitors ADD COLUMN IF NOT EXISTS focus text NOT NULL DEFAULT '';
    ALTER TABLE competitor_products ADD COLUMN IF NOT EXISTS specs jsonb NOT NULL DEFAULT '{}';
    ALTER TABLE competitor_events ADD COLUMN IF NOT EXISTS date_basis text NOT NULL DEFAULT 'published';
    ALTER TABLE competitor_events ADD COLUMN IF NOT EXISTS source_meta jsonb NOT NULL DEFAULT '{}';
    CREATE TABLE IF NOT EXISTS competitor_source_audits (
      id text PRIMARY KEY, competitor_id text NOT NULL REFERENCES competitors(id) ON DELETE CASCADE,
      label text NOT NULL, url text NOT NULL DEFAULT '', status text NOT NULL,
      period_start date NOT NULL, period_end date NOT NULL, checked_on date NOT NULL,
      found integer, detail text NOT NULL
    );
  `);
}
