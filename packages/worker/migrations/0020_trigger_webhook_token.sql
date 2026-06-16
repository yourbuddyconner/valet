-- Webhook trigger authentication + per-trigger rate limiting
-- (docs/specs/workflows.md).
--
-- The legacy /webhooks/:path route accepted any caller (only checked
-- header *presence* if config.secret was set). The spec mandates a
-- server-generated X-Valet-Trigger-Token validated against the trigger
-- row, plus a per-trigger rate limit (default 60/min).
--
-- Existing webhook triggers are grandfathered: SQLite generates a token
-- for every type='webhook' row so the new /api/triggers/:id/webhook
-- endpoint works without re-creating triggers. Operators must surface
-- those tokens out-of-band (the API only echoes the token on create).

-- ─── triggers: add webhook_token column ─────────────────────────────────────

ALTER TABLE triggers ADD COLUMN webhook_token TEXT;

-- Backfill: 32 hex chars (16 random bytes) for every existing webhook
-- trigger. lower(hex(randomblob(16))) is the SQLite equivalent of the
-- server-side crypto.randomUUID().replaceAll('-','').
UPDATE triggers
SET webhook_token = lower(hex(randomblob(16)))
WHERE type = 'webhook' AND webhook_token IS NULL;

-- Unique by trigger id is sufficient; we index for the auth lookup path
-- which goes id -> token but a partial index on the token side helps
-- defend against accidental cross-trigger collisions if a future audit
-- needs it.
CREATE UNIQUE INDEX IF NOT EXISTS idx_triggers_webhook_token
  ON triggers(webhook_token)
  WHERE webhook_token IS NOT NULL;

-- ─── trigger_webhook_rate: per-trigger sliding-minute counter ───────────────
--
-- Sliding 60-second buckets keyed by trigger_id + window_start_ts (unix
-- seconds, truncated to a minute boundary). Each request UPSERTs into
-- the current bucket; the handler reads the count back and returns 429
-- when it exceeds the configured limit (default 60). Buckets older than
-- a few minutes are dead weight — a periodic cron can sweep them, but
-- they're cheap enough we don't need that on day one.

CREATE TABLE IF NOT EXISTS trigger_webhook_rate (
  trigger_id TEXT NOT NULL REFERENCES triggers(id) ON DELETE CASCADE,
  window_start_ts INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (trigger_id, window_start_ts)
);

CREATE INDEX IF NOT EXISTS idx_twr_lookup
  ON trigger_webhook_rate(trigger_id, window_start_ts);
