-- Add expires_at + FK to workflow_executions on workflow_spawned_sessions.
-- The base table from 0021 has no retention or ownership chain — every
-- session-start node would leave a permanent row.
--
-- SQLite can't ALTER TABLE ADD a NOT NULL column without a default, so
-- we rebuild via CREATE-INSERT-DROP-RENAME. For pre-existing rows, set
-- expires_at to 30 days from created_at (production retention default).
--
-- The migration runner (wrangler / better-sqlite3 test harness) owns
-- the PRAGMA foreign_keys state — toggling it inside the migration
-- would persist across the connection and break callers that expect
-- their preferred mode after migrations apply. The CREATE...SELECT
-- INSERT...DROP...RENAME sequence works regardless because the new
-- table is FK-target-valid (every existing execution_id satisfies the
-- new FK on workflow_executions(id)) — if a stray row points at a
-- deleted execution, the migration should fail loudly so we know.

CREATE TABLE workflow_spawned_sessions_new (
  execution_id TEXT NOT NULL REFERENCES workflow_executions(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (execution_id, node_id, session_id)
);

INSERT INTO workflow_spawned_sessions_new (execution_id, node_id, session_id, created_at, expires_at)
SELECT
  execution_id,
  node_id,
  session_id,
  created_at,
  datetime(created_at, '+30 days')
FROM workflow_spawned_sessions;

DROP TABLE workflow_spawned_sessions;
ALTER TABLE workflow_spawned_sessions_new RENAME TO workflow_spawned_sessions;

CREATE INDEX idx_workflow_spawned_sessions_execution_id
  ON workflow_spawned_sessions (execution_id);

CREATE INDEX idx_workflow_spawned_sessions_expires_at
  ON workflow_spawned_sessions (expires_at);
