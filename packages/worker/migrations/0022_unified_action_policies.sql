-- Unified action policy framework (docs/specs/2026-06-25-approval-rules-design.md).
--
-- Collapses the existing dual-table policy model — `action_policies` (admin/org)
-- plus `user_action_policy_overrides` (user durable + session-scoped) — into
-- one resolver over two purpose-built tables:
--
--   action_policies   — durable policy. Admin/org rows plus user "always
--                       approve matching" durable grants. Carries parameter
--                       matchers (Phase 2 enforces them; Phase 1 ships the
--                       column for forward compatibility).
--   runtime_grants    — ephemeral allow grants scoped to a live session or
--                       workflow execution. FK-cascaded to parent context;
--                       hard-deleted on terminal-state transition.
--
-- The legacy `user_action_policy_overrides` table is migrated row-for-row into
-- the new tables but **left in place** by this migration so the existing
-- resolver and tests keep working unchanged. A subsequent commit retires the
-- code paths that read/write it, then a later migration drops the table.
--
-- Also extends `workflow_spawned_sessions` (workflow_id, workflow_version_id)
-- so workflow-spawned sessions can match execution-scoped grants and
-- workflow-node subjects, and `action_invocations` (matched_policy_id,
-- matched_grant_id) for new-model audit metadata.
--
-- No BEGIN/COMMIT wrapper: D1 rejects bare SQL transactions; wrangler applies
-- the file atomically.

-- ───────────────────────────────────────────────────────────────────────────
-- 1. Drop legacy partial unique indexes and discriminator triggers.
-- ───────────────────────────────────────────────────────────────────────────
-- The old uniqueness model (one row per service/action, one per service,
-- one per risk) blocks the new shape where an admin policy and one or more
-- user durable grants coexist for the same target. Replaced by a scope-aware
-- unique index below.

DROP INDEX IF EXISTS idx_ap_action;
DROP INDEX IF EXISTS idx_ap_service;
DROP INDEX IF EXISTS idx_ap_risk;

-- The 0014 triggers enforced "exactly one of action_id / service / risk_level"
-- at the row level. That discriminator moves to `subject_type` in the new
-- model — and rows like `workflow_node` legitimately have all three NULL,
-- which the old triggers would reject.

DROP TRIGGER IF EXISTS validate_action_policies_target_insert;
DROP TRIGGER IF EXISTS validate_action_policies_target_update;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. Extend action_policies with ownership, target, matcher, audit columns.
-- ───────────────────────────────────────────────────────────────────────────
-- All new columns have DEFAULTs so existing rows backfill in place to a
-- valid admin/org policy shape.

ALTER TABLE action_policies ADD COLUMN org_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE action_policies ADD COLUMN managed_by TEXT NOT NULL DEFAULT 'admin';
ALTER TABLE action_policies ADD COLUMN principal_type TEXT NOT NULL DEFAULT 'org';
ALTER TABLE action_policies ADD COLUMN principal_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE action_policies ADD COLUMN subject_type TEXT NOT NULL DEFAULT 'tool_action';
ALTER TABLE action_policies ADD COLUMN subject_label TEXT;
ALTER TABLE action_policies ADD COLUMN workflow_id TEXT;
ALTER TABLE action_policies ADD COLUMN workflow_version_id TEXT;
ALTER TABLE action_policies ADD COLUMN node_id TEXT;
ALTER TABLE action_policies ADD COLUMN param_matchers TEXT NOT NULL DEFAULT '[]';
ALTER TABLE action_policies ADD COLUMN matcher_summary TEXT;
ALTER TABLE action_policies ADD COLUMN user_grant_behavior TEXT NOT NULL DEFAULT 'allowed';
ALTER TABLE action_policies ADD COLUMN origin TEXT NOT NULL DEFAULT 'settings';
ALTER TABLE action_policies ADD COLUMN source_approval_id TEXT;
ALTER TABLE action_policies ADD COLUMN last_matched_at TEXT;
ALTER TABLE action_policies ADD COLUMN expires_at TEXT;
ALTER TABLE action_policies ADD COLUMN revoked_at TEXT;

-- Mark existing rows as migration-origin so downstream audit can tell
-- backfilled rows from settings-created ones. (Both still resolve identically.)
UPDATE action_policies SET origin = 'migration' WHERE origin = 'settings';

-- ───────────────────────────────────────────────────────────────────────────
-- 3. Create runtime_grants.
-- ───────────────────────────────────────────────────────────────────────────
-- Exactly one of session_id / workflow_execution_id is set. FK cascades to
-- both parent tables; explicit cleanup on terminal-state transition (added
-- in a later step) is the primary mechanism, cascade is the backstop.

CREATE TABLE runtime_grants (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL DEFAULT 'default',
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  workflow_execution_id TEXT REFERENCES workflow_executions(id) ON DELETE CASCADE,
  subject_type TEXT NOT NULL,
  service TEXT,
  action_id TEXT,
  risk_level TEXT,
  workflow_id TEXT,
  node_id TEXT,
  param_matchers TEXT NOT NULL DEFAULT '[]',
  policy_key TEXT NOT NULL,
  matcher_summary TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at TEXT,
  CHECK (
    (session_id IS NOT NULL AND workflow_execution_id IS NULL)
    OR (session_id IS NULL AND workflow_execution_id IS NOT NULL)
  )
);

-- ───────────────────────────────────────────────────────────────────────────
-- 4. Extend workflow_spawned_sessions with workflow_id / workflow_version_id.
-- ───────────────────────────────────────────────────────────────────────────
-- The reverse lookup (spawned session → parent workflow) needs these so
-- session-tool resolution can recover the execution scope and so durable
-- workflow-node grants can match against a specific version.

ALTER TABLE workflow_spawned_sessions ADD COLUMN workflow_id TEXT;
ALTER TABLE workflow_spawned_sessions ADD COLUMN workflow_version_id TEXT;

-- ───────────────────────────────────────────────────────────────────────────
-- 5. Extend action_invocations with matched_policy_id / matched_grant_id.
-- ───────────────────────────────────────────────────────────────────────────
-- Existing policy_id / org_policy_id / user_override_id columns stay for
-- historical reads. New code writes the matched_* columns instead.

ALTER TABLE action_invocations ADD COLUMN matched_policy_id TEXT
  REFERENCES action_policies(id) ON DELETE SET NULL;
ALTER TABLE action_invocations ADD COLUMN matched_grant_id TEXT
  REFERENCES runtime_grants(id) ON DELETE SET NULL;

-- ───────────────────────────────────────────────────────────────────────────
-- 6. Migrate user_action_policy_overrides (persistent / timed) → action_policies.
-- ───────────────────────────────────────────────────────────────────────────
-- Row ids are preserved so action_invocations.user_override_id can be mapped
-- straight into matched_policy_id below.
--
-- All migrated rows take subject_type='tool_action' regardless of whether the
-- override was action-scoped, service-scoped, or risk-only — preserving
-- existing data takes precedence over the spec's tighter discriminator,
-- which is enforced for new writes only.

INSERT INTO action_policies (
  id, service, action_id, risk_level, mode, created_by, created_at, updated_at,
  org_id, managed_by, principal_type, principal_id, subject_type,
  param_matchers, user_grant_behavior, origin, source_approval_id, expires_at
)
SELECT
  id, service, action_id, risk_level, mode, user_id, created_at, updated_at,
  'default', 'user', 'user', user_id, 'tool_action',
  '[]', 'allowed', 'migration', source_invocation_id,
  CASE WHEN lifetime = 'timed' THEN expires_at ELSE NULL END
FROM user_action_policy_overrides
WHERE lifetime IN ('persistent', 'timed');

-- ───────────────────────────────────────────────────────────────────────────
-- 7. Migrate user_action_policy_overrides (session) → runtime_grants.
-- ───────────────────────────────────────────────────────────────────────────
-- Row ids preserved so the user_override_id → matched_grant_id mapping
-- below is just a self-join on id.

INSERT INTO runtime_grants (
  id, user_id, session_id, subject_type, service, action_id, risk_level,
  param_matchers, policy_key, created_at
)
SELECT
  id, user_id, session_id, 'tool_action', service, action_id, risk_level,
  '[]',
  -- Deterministic policy_key for migrated rows. Distinguishes service-only,
  -- action-level, and risk-only overrides on the same session.
  printf('session:%s:%s.%s:%s',
         session_id,
         COALESCE(service, ''),
         COALESCE(action_id, ''),
         COALESCE(risk_level, '')),
  created_at
FROM user_action_policy_overrides
WHERE lifetime = 'session' AND session_id IS NOT NULL;

-- ───────────────────────────────────────────────────────────────────────────
-- 8. Backfill action_invocations.matched_* from the user_override_id mapping.
-- ───────────────────────────────────────────────────────────────────────────
-- Since row ids were preserved in steps 6 and 7, a join on id maps each
-- user_override_id to either an action_policies row (persistent/timed) or
-- a runtime_grants row (session). The managed_by='user' / principal_type='user'
-- qualifiers ensure a vanishingly unlikely collision with a pre-existing
-- admin action_policies id can't cross-link audit rows.

UPDATE action_invocations
SET matched_policy_id = user_override_id
WHERE user_override_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM action_policies
    WHERE id = action_invocations.user_override_id
      AND managed_by = 'user'
      AND origin = 'migration'
  );

UPDATE action_invocations
SET matched_grant_id = user_override_id
WHERE user_override_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM runtime_grants
    WHERE id = action_invocations.user_override_id
  );

-- ───────────────────────────────────────────────────────────────────────────
-- 9. Scope-aware uniqueness for action_policies.
-- ───────────────────────────────────────────────────────────────────────────
-- One active row per (org, manager, principal, subject, target, matcher
-- fingerprint). COALESCE keeps NULL targets distinct from empty strings so
-- a service-scoped policy and an action-scoped policy on the same service
-- don't collide.

CREATE UNIQUE INDEX idx_ap_unique
  ON action_policies(
    org_id, managed_by, principal_type, principal_id, subject_type,
    COALESCE(service, ''), COALESCE(action_id, ''), COALESCE(risk_level, ''),
    COALESCE(workflow_id, ''), COALESCE(workflow_version_id, ''), COALESCE(node_id, ''),
    param_matchers
  )
  WHERE revoked_at IS NULL;

-- ───────────────────────────────────────────────────────────────────────────
-- 10. Lookup indexes for action_policies.
-- ───────────────────────────────────────────────────────────────────────────

CREATE INDEX idx_ap_lookup_subject
  ON action_policies(org_id, subject_type, service, action_id, risk_level)
  WHERE revoked_at IS NULL;

CREATE INDEX idx_ap_lookup_principal
  ON action_policies(org_id, managed_by, principal_type, principal_id)
  WHERE revoked_at IS NULL;

CREATE INDEX idx_ap_lookup_workflow
  ON action_policies(workflow_id, workflow_version_id, node_id)
  WHERE workflow_id IS NOT NULL AND revoked_at IS NULL;

CREATE INDEX idx_ap_expires
  ON action_policies(expires_at)
  WHERE expires_at IS NOT NULL AND revoked_at IS NULL;

-- Superseded by idx_ap_lookup_subject.
DROP INDEX IF EXISTS idx_action_policies_service_cleanup;

-- ───────────────────────────────────────────────────────────────────────────
-- 11. runtime_grants indexes.
-- ───────────────────────────────────────────────────────────────────────────

CREATE UNIQUE INDEX idx_rg_session_policy_key
  ON runtime_grants(session_id, subject_type, policy_key)
  WHERE session_id IS NOT NULL AND revoked_at IS NULL;

CREATE UNIQUE INDEX idx_rg_execution_policy_key
  ON runtime_grants(workflow_execution_id, subject_type, policy_key)
  WHERE workflow_execution_id IS NOT NULL AND revoked_at IS NULL;

CREATE INDEX idx_rg_session
  ON runtime_grants(session_id)
  WHERE session_id IS NOT NULL AND revoked_at IS NULL;

CREATE INDEX idx_rg_execution
  ON runtime_grants(workflow_execution_id)
  WHERE workflow_execution_id IS NOT NULL AND revoked_at IS NULL;

-- ───────────────────────────────────────────────────────────────────────────
-- user_action_policy_overrides remains populated and indexed after this
-- migration. The next commit updates resolution + write call sites to use
-- action_policies + runtime_grants exclusively; a follow-up migration then
-- drops the legacy table.
-- ───────────────────────────────────────────────────────────────────────────

-- ───────────────────────────────────────────────────────────────────────────
-- 12. Workflow-runtime context on action_invocations + retire workflow_approvals.
-- ───────────────────────────────────────────────────────────────────────────
-- `workflow_approvals` is retired here as part of the unified-approval
-- consolidation (docs/specs/2026-06-25-approval-rules-design.md
-- §"Relationship to `workflow_approvals` and `action_invocations`").
-- Every workflow approval gate — both the `tool` node's policy-blocked
-- invocations and the `approval` node's explicit human gates — lives in
-- `action_invocations` after this migration. The DAG `approval` node stays
-- as authoring sugar; at runtime it executes as a `workflows.request_approval`
-- built-in action call.
--
-- nodeId / iterationIndex are captured on action_invocations so the resume
-- hook can derive the Workflows event type (`approval_<nodeId>[_i_<index>]`)
-- without parsing the deterministic invocation id, and so the resolver can
-- do nodeId-aware grant matching (e.g. a "Approve remaining rows" grant on
-- a foreach body must not auto-approve unrelated approval nodes that share
-- the same service+actionId).

ALTER TABLE action_invocations ADD COLUMN node_id TEXT;
ALTER TABLE action_invocations ADD COLUMN iteration_index INTEGER;

CREATE INDEX idx_ai_workflow_node
  ON action_invocations(workflow_execution_id, node_id, iteration_index);

-- Migrate kind='explicit' workflow_approvals into action_invocations. These
-- are human-gate rows from `approval` nodes; the corresponding Cloudflare
-- Workflows instance is still waiting on `step.waitForEvent('approval_<nodeId>')`,
-- and the new resume hook fires when the migrated row transitions.
--
-- userId is recovered from workflow_executions.user_id. Status maps mostly
-- 1:1; 'cancelled' lands as 'failed' with error='workflow execution
-- cancelled' (action_invocations has no 'cancelled' enum value). risk_level
-- is 'medium' so the resolver's system default is require_approval — matches
-- the semantics of an explicit gate.

INSERT INTO action_invocations (
  id,
  workflow_execution_id,
  user_id,
  service,
  action_id,
  risk_level,
  resolved_mode,
  status,
  params,
  expires_at,
  node_id,
  resolved_by,
  resolved_at,
  error,
  created_at,
  updated_at
)
SELECT
  wa.id,
  wa.execution_id,
  COALESCE(we.user_id, wa.resolved_by, '__system__'),
  'workflows',
  'request_approval',
  'medium',
  'require_approval',
  CASE wa.status
    WHEN 'cancelled' THEN 'failed'
    ELSE wa.status
  END,
  json_object('prompt', wa.prompt, 'summary', wa.summary, 'details', wa.details),
  wa.timeout_at,
  wa.node_id,
  wa.resolved_by,
  wa.resolved_at,
  CASE WHEN wa.status = 'cancelled' THEN 'workflow execution cancelled' ELSE NULL END,
  COALESCE(wa.created_at, datetime('now')),
  COALESCE(wa.updated_at, datetime('now'))
FROM workflow_approvals wa
LEFT JOIN workflow_executions we ON wa.execution_id = we.id
WHERE wa.kind = 'explicit'
  AND NOT EXISTS (SELECT 1 FROM action_invocations ai WHERE ai.id = wa.id);

-- Drop the workflow_approvals table. kind='tool_policy' rows were pure
-- duplicates of their corresponding action_invocations entries; the
-- Workflow instance keeps waiting on the same derived event name, which
-- the new resume hook fires on action_invocations transitions.

DROP INDEX IF EXISTS idx_wa_execution;
DROP INDEX IF EXISTS idx_wa_pending;
DROP TABLE workflow_approvals;

DROP TABLE user_action_policy_overrides;
