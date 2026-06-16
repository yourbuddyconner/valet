-- Workflow runtime schema for the dag/v1 interpreter
-- (docs/specs/workflows.md).
--
-- This migration is additive: existing workflow_executions and
-- action_invocations rows are preserved across the schema change so
-- dev deploys don't lose execution history or the durable action audit
-- log. The CHECK constraint on workflow_executions.status can't be
-- altered in place by SQLite — we use the standard "rename + recreate +
-- copy" dance.
--
-- New tables introduced (workflow_approvals, workflow_execution_nodes,
-- workflow_definition_versions) are plain CREATE TABLE.
--
-- Three new columns on workflows (draft_definition, published_version_id,
-- ui) for the dag/v1 editor's draft/publish/restore flow.
--
-- No BEGIN/COMMIT wrapper: D1's runtime rejects bare SQL transactions
-- ("use state.storage.transaction() instead"). The wrangler migrations
-- tool already applies the file atomically — a mid-file failure marks
-- the migration unapplied and the next run retries.

-- ─── workflow_executions: relax status CHECK, add dag/v1 columns ────────────
--
-- Old status enum: pending, running, waiting_approval, completed, failed,
-- cancelled, skipped.
-- New enum adds: waiting_time, cancelling.
--
-- New columns: cancelled_at, cancelled_by, definition_snapshot,
-- definition_version_id, inputs, mode, cloudflare_instance_id.
--
-- Existing rows are migrated as-is; new columns get NULL / DEFAULT.

CREATE TABLE workflow_executions_new (
  id TEXT PRIMARY KEY,
  workflow_id TEXT REFERENCES workflows(id) ON DELETE SET NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trigger_id TEXT REFERENCES triggers(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'waiting_approval', 'waiting_time', 'completed', 'failed', 'cancelling', 'cancelled', 'skipped')),
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('manual', 'webhook', 'schedule')),
  trigger_metadata TEXT,
  variables TEXT,
  outputs TEXT,
  steps TEXT,
  error TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  workflow_version TEXT,
  workflow_hash TEXT,
  workflow_snapshot TEXT,
  idempotency_key TEXT,
  runtime_state TEXT,
  resume_token TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  initiator_type TEXT,
  initiator_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  cancelled_at TEXT,
  cancelled_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  -- dag/v1 runtime columns:
  definition_snapshot TEXT,
  definition_version_id TEXT,
  inputs TEXT,
  mode TEXT NOT NULL DEFAULT 'production' CHECK (mode IN ('production', 'test')),
  cloudflare_instance_id TEXT
);

INSERT INTO workflow_executions_new (
  id, workflow_id, user_id, trigger_id, status, trigger_type, trigger_metadata,
  variables, outputs, steps, error, started_at, completed_at, workflow_version,
  workflow_hash, workflow_snapshot, idempotency_key, runtime_state, resume_token,
  attempt_count, session_id, initiator_type, initiator_user_id
)
SELECT
  id, workflow_id, user_id, trigger_id, status, trigger_type, trigger_metadata,
  variables, outputs, steps, error, started_at, completed_at, workflow_version,
  workflow_hash, workflow_snapshot, idempotency_key, runtime_state, resume_token,
  attempt_count, session_id, initiator_type, initiator_user_id
FROM workflow_executions;

DROP TABLE workflow_executions;
ALTER TABLE workflow_executions_new RENAME TO workflow_executions;

CREATE INDEX idx_workflow_executions_workflow ON workflow_executions(workflow_id);
CREATE INDEX idx_workflow_executions_user ON workflow_executions(user_id);
CREATE INDEX idx_workflow_executions_trigger ON workflow_executions(trigger_id);
CREATE INDEX idx_workflow_executions_status ON workflow_executions(status);
CREATE INDEX idx_workflow_executions_started ON workflow_executions(started_at DESC);
CREATE UNIQUE INDEX idx_workflow_executions_idempotency ON workflow_executions(workflow_id, idempotency_key);
CREATE INDEX idx_workflow_executions_session ON workflow_executions(session_id);
CREATE INDEX idx_workflow_executions_cancelling ON workflow_executions(status, cancelled_at) WHERE status = 'cancelling';

-- ─── action_invocations: relax session_id NOT NULL + add workflow link ──────
--
-- Old shape required session_id (every invocation was a session tool
-- call). dag/v1 tool nodes need to insert rows without a session, so
-- session_id becomes nullable and we add workflow_execution_id to link
-- workflow-originated rows back to their execution.
--
-- All other columns (added by migrations through 0013) are preserved.

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
  user_override_id TEXT REFERENCES user_action_policy_overrides(id) ON DELETE SET NULL,
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

-- ─── workflow_approvals (new table) ─────────────────────────────────────────

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

-- ─── workflow_execution_nodes (new table — per-node trace) ──────────────────

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

-- ─── workflow_definition_versions (new table — published-version history) ───
-- Append-only history of published workflow definitions. workflows.published_version_id
-- points at the active version; restore copies an old version back into the
-- draft. Hash + validation status are stored at publish time so the UI can
-- show "validated clean at publish" indicators.

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

-- ─── workflows draft + published-version columns ────────────────────────────
-- workflows.data continues to hold the live (currently-effective) definition
-- for legacy steps workflows. For dag/v1:
--   - draft_definition holds the mutable in-progress draft
--   - published_version_id points at the active workflow_definition_versions row
--   - ui holds editor layout metadata (React Flow positions, viewport, etc.)

ALTER TABLE workflows ADD COLUMN draft_definition TEXT;
ALTER TABLE workflows ADD COLUMN published_version_id TEXT REFERENCES workflow_definition_versions(id) ON DELETE SET NULL;
ALTER TABLE workflows ADD COLUMN ui TEXT;
