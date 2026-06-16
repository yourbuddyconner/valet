-- Drop the legacy workflow execution shape.
--
-- The dag/v1 runtime tracks lifecycle via status + cancelled_at +
-- cleanup_completed_at + workflow_execution_nodes (per-node trace) and
-- workflow_spawned_sessions (session links). The columns dropped below
-- were used by the pre-dag/v1 runtime and are no longer written:
--
--   - variables      : superseded by the validated `inputs` column
--   - steps          : superseded by workflow_execution_nodes trace rows
--   - workflow_hash  : audit fingerprint of the previous runtime; no readers
--   - workflow_snapshot : superseded by `definition_snapshot`
--   - attempt_count  : dispatch retry counter for the removed enqueue path
--   - session_id     : execution → session denormalization; superseded by
--                      workflow_spawned_sessions
--
-- workflow_execution_steps is also dropped — the per-step trace table
-- the old runtime wrote to. workflow_execution_nodes replaces it.

DROP INDEX IF EXISTS idx_workflow_executions_session;

ALTER TABLE workflow_executions DROP COLUMN variables;
ALTER TABLE workflow_executions DROP COLUMN steps;
ALTER TABLE workflow_executions DROP COLUMN workflow_hash;
ALTER TABLE workflow_executions DROP COLUMN workflow_snapshot;
ALTER TABLE workflow_executions DROP COLUMN attempt_count;
ALTER TABLE workflow_executions DROP COLUMN session_id;

DROP TABLE IF EXISTS workflow_execution_steps;
