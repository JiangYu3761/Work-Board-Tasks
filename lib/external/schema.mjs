export async function externalSchema(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS north_api_tokens (
      id uuid PRIMARY KEY, name text NOT NULL, token_hash text NOT NULL UNIQUE,
      scopes text[] NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL, revoked_at timestamptz
    );
    CREATE TABLE IF NOT EXISTS north_api_audit (
      id bigserial PRIMARY KEY, request_id uuid NOT NULL, token_id uuid,
      method text NOT NULL, route text NOT NULL, status integer NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS north_audit_time ON north_api_audit(created_at DESC);
    CREATE TABLE IF NOT EXISTS north_integration_state (
      id integer PRIMARY KEY CHECK(id=1), enabled_at timestamptz NOT NULL DEFAULT now(),
      heartbeat_at timestamptz, last_error text
    );
    INSERT INTO north_integration_state(id) VALUES(1) ON CONFLICT DO NOTHING;
    CREATE TABLE IF NOT EXISTS north_events (
      id bigserial PRIMARY KEY, source_key text NOT NULL UNIQUE, content_hash text NOT NULL,
      type text NOT NULL, severity text NOT NULL CHECK(severity IN ('info','important','critical')),
      title text NOT NULL, body text NOT NULL, object_ref jsonb NOT NULL DEFAULT '{}',
      actor_id text NOT NULL, occurred_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS north_deliveries (
      id uuid PRIMARY KEY, event_id bigint NOT NULL REFERENCES north_events(id) ON DELETE CASCADE,
      channel text NOT NULL DEFAULT 'feishu', destination text NOT NULL,
      state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','sending','sent','failed','uncertain','cancelled')),
      attempts integer NOT NULL DEFAULT 0, available_at timestamptz NOT NULL DEFAULT now(),
      lease_until timestamptz, provider_message_id text, last_error text,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(event_id,channel,destination)
    );
    CREATE INDEX IF NOT EXISTS north_delivery_queue ON north_deliveries(state,available_at);
  `);
}
