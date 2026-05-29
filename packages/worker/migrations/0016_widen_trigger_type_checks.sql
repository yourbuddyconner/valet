-- Widen CHECK constraints on `triggers.type` and `workflow_executions.trigger_type`
-- to include 'github', 'retry', and 'test' — values the code already produces but
-- which the original CHECK constraints reject, breaking inserts in production.
--
-- SQLite cannot modify CHECK constraints in place; we recreate the affected tables
-- by copying rows into a new table with the updated schema and renaming.

PRAGMA foreign_keys = OFF;

-- ─── triggers ──────────────────────────────────────────────────────────────────
-- Original: CHECK (type IN ('webhook', 'schedule', 'manual'))
-- New:      CHECK (type IN ('webhook', 'schedule', 'manual', 'github'))

CREATE TABLE triggers_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workflow_id TEXT REFERENCES workflows(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  enabled INTEGER DEFAULT 1,
  type TEXT NOT NULL CHECK (type IN ('webhook', 'schedule', 'manual', 'github')),
  config TEXT NOT NULL,
  variable_mapping TEXT,
  last_run_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

INSERT INTO triggers_new
SELECT id, user_id, workflow_id, name, enabled, type, config, variable_mapping,
       last_run_at, created_at, updated_at
FROM triggers;

DROP TABLE triggers;
ALTER TABLE triggers_new RENAME TO triggers;

CREATE INDEX idx_triggers_user ON triggers(user_id);
CREATE INDEX idx_triggers_workflow ON triggers(workflow_id);
CREATE INDEX idx_triggers_type ON triggers(type);
CREATE INDEX idx_triggers_enabled ON triggers(enabled);
-- Migration 0011 added a case-insensitive uniqueness index — recreate it.
CREATE UNIQUE INDEX idx_triggers_user_name ON triggers(user_id, name COLLATE NOCASE);

-- ─── workflow_executions ───────────────────────────────────────────────────────
-- Original: CHECK (trigger_type IN ('manual', 'webhook', 'schedule'))
-- New:      CHECK (trigger_type IN ('manual', 'webhook', 'schedule', 'github', 'retry', 'test'))

CREATE TABLE workflow_executions_new (
  id TEXT PRIMARY KEY,
  workflow_id TEXT REFERENCES workflows(id) ON DELETE SET NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trigger_id TEXT REFERENCES triggers(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'waiting_approval', 'completed', 'failed', 'cancelled', 'skipped')),
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('manual', 'webhook', 'schedule', 'github', 'retry', 'test')),
  trigger_metadata TEXT,
  variables TEXT,
  outputs TEXT,
  steps TEXT,
  error TEXT,
  started_at TEXT NOT NULL,
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
  initiator_user_id TEXT REFERENCES users(id) ON DELETE SET NULL
);

INSERT INTO workflow_executions_new
SELECT id, workflow_id, user_id, trigger_id, status, trigger_type, trigger_metadata,
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

PRAGMA foreign_keys = ON;
