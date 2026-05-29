-- 0018_drop_legacy_step_unique.sql
-- The original CREATE TABLE for workflow_execution_steps had an inline
-- `UNIQUE(execution_id, step_id, attempt)` constraint. Migration 0017
-- dropped the named index of the same shape and recreated it on the
-- 4-tuple including iteration_path, but the inline constraint persists
-- as `sqlite_autoindex_workflow_execution_steps_2` and still collapses
-- loop iterations into a single row.
--
-- SQLite doesn't support DROP CONSTRAINT, so we rebuild the table.

PRAGMA foreign_keys = OFF;

CREATE TABLE workflow_execution_steps_new (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES workflow_executions(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  iteration_path TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'waiting_approval', 'completed', 'failed', 'cancelled', 'skipped')),
  input_json TEXT,
  output_json TEXT,
  error TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO workflow_execution_steps_new
  (id, execution_id, step_id, attempt, iteration_path, status, input_json, output_json, error, started_at, completed_at, created_at)
SELECT
  id, execution_id, step_id, attempt, iteration_path, status, input_json, output_json, error, started_at, completed_at, created_at
FROM workflow_execution_steps;

DROP TABLE workflow_execution_steps;
ALTER TABLE workflow_execution_steps_new RENAME TO workflow_execution_steps;

-- Recreate the indexes that lived on the old table.
CREATE UNIQUE INDEX idx_execution_steps_unique
  ON workflow_execution_steps (execution_id, step_id, attempt, iteration_path);

CREATE INDEX idx_workflow_execution_steps_execution
  ON workflow_execution_steps (execution_id);

CREATE INDEX idx_workflow_execution_steps_status
  ON workflow_execution_steps (status);

CREATE INDEX idx_workflow_execution_steps_iteration
  ON workflow_execution_steps (execution_id, iteration_path);

PRAGMA foreign_keys = ON;
