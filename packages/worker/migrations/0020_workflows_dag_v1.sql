-- Workflow runtime schema for the dag/v1 interpreter (docs/specs/workflows.md).
--
-- Consolidated migration that establishes the dag/v1 end-state directly,
-- replacing the legacy steps-runtime tables (which never shipped any
-- production state). action_invocations is preserved across a schema
-- relaxation (session_id becomes nullable; workflow_execution_id added)
-- because it holds real session audit data.
--
-- Also adds the trigger.webhook_token + per-trigger rate-limit table and
-- the global-uniqueness index for webhook trigger paths.
--
-- No BEGIN/COMMIT wrapper: D1's runtime rejects bare SQL transactions
-- ("use state.storage.transaction() instead"). The wrangler migrations
-- tool already applies the file atomically — a mid-file failure marks
-- the migration unapplied and the next run retries.

-- ───────────────────────────────────────────────────────────────────────────
-- 1. Drop legacy steps-runtime tables.
-- ───────────────────────────────────────────────────────────────────────────
-- The pre-dag/v1 runtime tables. Order matters for FKs:
-- workflow_execution_steps and workflow_mutation_proposals reference
-- workflow_executions, so they go first.

DROP TABLE IF EXISTS workflow_execution_steps;
DROP TABLE IF EXISTS workflow_mutation_proposals;
DROP TABLE IF EXISTS workflow_version_history;
DROP TABLE IF EXISTS pending_approvals;
DROP TABLE IF EXISTS workflow_executions;

-- Drop any leftover non-dag/v1 workflow definitions. Triggers cascade via
-- their FK to workflows(id) ON DELETE CASCADE. json_valid guards against
-- malformed `data` columns that would otherwise abort json_extract.
DELETE FROM workflows
WHERE data IS NULL
   OR data = ''
   OR json_valid(data) = 0
   OR json_extract(data, '$.version') IS NULL
   OR json_extract(data, '$.version') != 'dag/v1';

-- ───────────────────────────────────────────────────────────────────────────
-- 2. workflow_executions — final dag/v1 shape.
-- ───────────────────────────────────────────────────────────────────────────
-- New status values: waiting_time, cancelling. New columns: cancelled_at,
-- cancelled_by, definition_snapshot, definition_version_id, inputs, mode,
-- cleanup_completed_at. Eight legacy columns (variables, steps,
-- workflow_hash, workflow_snapshot, attempt_count, session_id,
-- runtime_state, resume_token) are gone.
--
-- The Cloudflare Workflows instance id is `id` directly — we register the
-- CF instance with the same identifier as the execution row. No separate
-- `cloudflare_instance_id` column; cancel-cleanup and the approve resume
-- hook both call `WORKFLOW_INTERPRETER.get(executionId)`.

CREATE TABLE workflow_executions (
  id TEXT PRIMARY KEY,
  workflow_id TEXT REFERENCES workflows(id) ON DELETE SET NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trigger_id TEXT REFERENCES triggers(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'waiting_approval', 'waiting_time', 'completed', 'failed', 'cancelling', 'cancelled', 'skipped')),
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('manual', 'webhook', 'schedule')),
  trigger_metadata TEXT,
  outputs TEXT,
  error TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  workflow_version TEXT,
  idempotency_key TEXT,
  initiator_type TEXT,
  initiator_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  cancelled_at TEXT,
  cancelled_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  -- dag/v1 runtime columns:
  definition_snapshot TEXT,
  definition_version_id TEXT,
  inputs TEXT,
  mode TEXT NOT NULL DEFAULT 'production' CHECK (mode IN ('production', 'test')),
  -- cleanup_completed_at: set when cancel-cleanup finished every pipeline
  -- step. The runtime only CASes status='cancelled' once cleanup lands;
  -- the cron sweep retries 'cancelling' rows until then.
  cleanup_completed_at TEXT
);

CREATE INDEX idx_workflow_executions_workflow ON workflow_executions(workflow_id);
CREATE INDEX idx_workflow_executions_user ON workflow_executions(user_id);
CREATE INDEX idx_workflow_executions_trigger ON workflow_executions(trigger_id);
CREATE INDEX idx_workflow_executions_status ON workflow_executions(status);
CREATE INDEX idx_workflow_executions_started ON workflow_executions(started_at DESC);
CREATE UNIQUE INDEX idx_workflow_executions_idempotency ON workflow_executions(workflow_id, idempotency_key);
CREATE INDEX idx_workflow_executions_cancelling ON workflow_executions(status, cancelled_at) WHERE status = 'cancelling';

-- ───────────────────────────────────────────────────────────────────────────
-- 3. workflow_definition_versions — append-only published-version history.
-- ───────────────────────────────────────────────────────────────────────────
-- workflows.published_version_id points at the active version; restore copies
-- an old version back into the draft. Hash + validation status are stored at
-- publish time so the UI can show "validated clean at publish" indicators.

CREATE TABLE workflow_definition_versions (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  definition TEXT NOT NULL,
  definition_hash TEXT NOT NULL,
  validation_status TEXT NOT NULL DEFAULT 'ok' CHECK (validation_status IN ('ok', 'warning')),
  publish_note TEXT,
  -- Editor layout snapshot captured at publish time. Restore copies this
  -- back into workflows.ui so node positions don't drift relative to the
  -- restored definition.
  ui TEXT,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX idx_wdv_workflow_version ON workflow_definition_versions(workflow_id, version);
CREATE INDEX idx_wdv_workflow_created ON workflow_definition_versions(workflow_id, created_at);

-- ───────────────────────────────────────────────────────────────────────────
-- 4. workflows: dag/v1 editor columns.
-- ───────────────────────────────────────────────────────────────────────────
-- workflows.data continues to hold the live (currently-effective) definition.
-- For dag/v1:
--   - draft_definition holds the mutable in-progress draft
--   - published_version_id points at the active workflow_definition_versions row
--   - ui holds editor layout metadata (React Flow positions, viewport, etc.)

ALTER TABLE workflows ADD COLUMN draft_definition TEXT;
ALTER TABLE workflows ADD COLUMN published_version_id TEXT REFERENCES workflow_definition_versions(id) ON DELETE SET NULL;
ALTER TABLE workflows ADD COLUMN ui TEXT;

-- ───────────────────────────────────────────────────────────────────────────
-- 5. action_invocations — relax session_id NOT NULL + add workflow link.
-- ───────────────────────────────────────────────────────────────────────────
-- Old shape required session_id (every invocation was a session tool call).
-- dag/v1 tool nodes insert rows without a session, so session_id becomes
-- nullable and workflow_execution_id links workflow-originated rows back
-- to their execution.
--
-- Real session audit data lives here, so we rebuild via the standard
-- rename + recreate + copy dance. workflow_execution_id is NULL for all
-- pre-existing rows (legacy invocations had no workflow link).

CREATE TABLE action_invocations_new (
  id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  workflow_execution_id TEXT REFERENCES workflow_executions(id) ON DELETE SET NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  service TEXT NOT NULL,
  action_id TEXT NOT NULL,
  risk_level TEXT NOT NULL,
  resolved_mode TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','approved','denied','executed','failed','expired')),
  params TEXT,
  result TEXT,
  error TEXT,
  resolved_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  resolved_at TEXT,
  executed_at TEXT,
  expires_at TEXT,
  policy_id TEXT REFERENCES action_policies(id) ON DELETE SET NULL,
  org_policy_id TEXT REFERENCES action_policies(id) ON DELETE SET NULL,
  base_mode TEXT,
  base_source TEXT,
  user_override_id TEXT,
  policy_source TEXT,
  policy_lifetime TEXT,
  policy_scope TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO action_invocations_new (
  id, session_id, user_id, service, action_id, risk_level, resolved_mode, status,
  params, result, error, resolved_by, resolved_at, executed_at, expires_at,
  policy_id, org_policy_id, base_mode, base_source, user_override_id,
  policy_source, policy_lifetime, policy_scope, created_at, updated_at
)
SELECT
  id, session_id, user_id, service, action_id, risk_level, resolved_mode, status,
  params, result, error, resolved_by, resolved_at, executed_at, expires_at,
  policy_id, org_policy_id, base_mode, base_source, user_override_id,
  policy_source, policy_lifetime, policy_scope, created_at, updated_at
FROM action_invocations;

DROP TABLE action_invocations;
ALTER TABLE action_invocations_new RENAME TO action_invocations;

CREATE INDEX idx_ai_session ON action_invocations(session_id, created_at);
CREATE INDEX idx_ai_user ON action_invocations(user_id, status);
CREATE INDEX idx_ai_pending ON action_invocations(status, expires_at) WHERE status = 'pending';
CREATE INDEX idx_ai_workflow ON action_invocations(workflow_execution_id, created_at);

-- ───────────────────────────────────────────────────────────────────────────
-- 6. workflow_approvals.
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE workflow_approvals (
  id TEXT PRIMARY KEY,
  execution_id TEXT REFERENCES workflow_executions(id) ON DELETE SET NULL,
  node_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('explicit', 'tool_policy')),
  workflow_instance_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  prompt TEXT NOT NULL,
  summary TEXT,
  details TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending', 'approved', 'denied', 'expired', 'cancelled')),
  timeout_at TEXT,
  resolved_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  resolved_at TEXT,
  cancelled_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_wa_execution ON workflow_approvals(execution_id, created_at);
CREATE INDEX idx_wa_pending ON workflow_approvals(status, timeout_at) WHERE status = 'pending';

-- ───────────────────────────────────────────────────────────────────────────
-- 7. workflow_execution_nodes — per-node trace.
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE workflow_execution_nodes (
  id TEXT PRIMARY KEY,
  execution_id TEXT REFERENCES workflow_executions(id) ON DELETE SET NULL,
  node_id TEXT NOT NULL,
  node_type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'waiting_approval', 'waiting_time', 'skipped', 'completed', 'failed')),
  input_preview TEXT,
  input_truncated INTEGER NOT NULL DEFAULT 0,
  output TEXT,
  output_truncated INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  reason TEXT,
  retry_attempts INTEGER NOT NULL DEFAULT 0,
  approval_id TEXT,
  invocation_id TEXT,
  started_at TEXT,
  completed_at TEXT,
  duration_ms INTEGER,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_wen_execution ON workflow_execution_nodes(execution_id, created_at);
CREATE INDEX idx_wen_node ON workflow_execution_nodes(execution_id, node_id);
CREATE INDEX idx_wen_expires ON workflow_execution_nodes(expires_at);

-- ───────────────────────────────────────────────────────────────────────────
-- 8. workflow_spawned_sessions — link executions to spawned sessions.
-- ───────────────────────────────────────────────────────────────────────────
-- Used by cancellation cleanup to find sessions to abort without parsing
-- per-node trace.output JSON. expires_at carries the 30-day retention default.

CREATE TABLE workflow_spawned_sessions (
  execution_id TEXT NOT NULL REFERENCES workflow_executions(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (execution_id, node_id, session_id)
);

CREATE INDEX idx_workflow_spawned_sessions_execution_id ON workflow_spawned_sessions(execution_id);
CREATE INDEX idx_workflow_spawned_sessions_expires_at ON workflow_spawned_sessions(expires_at);

-- ───────────────────────────────────────────────────────────────────────────
-- 9. Webhook trigger auth: per-trigger token + rate-limit bucket table.
-- ───────────────────────────────────────────────────────────────────────────
-- The legacy /webhooks/:path route accepted any caller. The spec mandates a
-- server-generated X-Valet-Trigger-Token validated against the trigger row,
-- plus a per-trigger rate limit (default 60/min). Existing webhook triggers
-- are grandfathered: SQLite generates a token for every type='webhook' row.
-- Operators must surface those tokens out-of-band (the API echoes the token
-- only on create).

ALTER TABLE triggers ADD COLUMN webhook_token TEXT;

-- Backfill: 32 hex chars (16 random bytes) for every existing webhook
-- trigger. lower(hex(randomblob(16))) is the SQLite equivalent of the
-- server-side crypto.randomUUID().replaceAll('-','').
UPDATE triggers
  SET webhook_token = lower(hex(randomblob(16)))
  WHERE type = 'webhook' AND webhook_token IS NULL;

CREATE UNIQUE INDEX idx_triggers_webhook_token
  ON triggers(webhook_token)
  WHERE webhook_token IS NOT NULL;

-- Sliding 60-second buckets keyed by trigger_id + window_start_ts (unix
-- seconds, truncated to a minute boundary). Each request UPSERTs into the
-- current bucket; the handler reads the count back and returns 429 when it
-- exceeds the configured limit (default 60). Old buckets are cheap enough
-- we don't sweep on day one.

CREATE TABLE trigger_webhook_rate (
  trigger_id TEXT NOT NULL REFERENCES triggers(id) ON DELETE CASCADE,
  window_start_ts INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (trigger_id, window_start_ts)
);

CREATE INDEX idx_twr_lookup ON trigger_webhook_rate(trigger_id, window_start_ts);

-- ───────────────────────────────────────────────────────────────────────────
-- 10. Webhook path global uniqueness.
-- ───────────────────────────────────────────────────────────────────────────
-- The legacy /webhooks/:path lookup has no user_id scope and resolves a
-- path non-deterministically when two tenants register the same value —
-- an unauthenticated request could dispatch into the wrong tenant's
-- workflow.
--
-- Dedup by renaming all-but-the-oldest copy with a `-conflict-<id>` suffix
-- and disabling them (enabled=0) so external services hitting the renamed
-- URL get a clean 404 instead of silently sending payloads into the void.
-- Then enforce a partial unique index covering only webhook triggers.

WITH dupes AS (
  SELECT
    id,
    json_extract(config, '$.path') AS path,
    ROW_NUMBER() OVER (
      PARTITION BY json_extract(config, '$.path')
      ORDER BY created_at ASC, id ASC
    ) AS row_num
  FROM triggers
  WHERE type = 'webhook'
)
UPDATE triggers
  SET
    config = json_set(config, '$.path', json_extract(config, '$.path') || '-conflict-' || id),
    enabled = 0,
    updated_at = datetime('now')
  WHERE id IN (SELECT id FROM dupes WHERE row_num > 1);

CREATE UNIQUE INDEX idx_triggers_webhook_path_unique
  ON triggers(json_extract(config, '$.path'))
  WHERE type = 'webhook';
