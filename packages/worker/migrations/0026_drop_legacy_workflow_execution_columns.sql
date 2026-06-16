-- Drop unused workflow_executions columns from the pre-dag/v1 runtime.
--
-- `runtime_state` and `resume_token` were used by the runner-side step
-- engine: runtime_state held the executor's RuntimeState JSON, and
-- resume_token was the deterministic nonce that gated approval resume.
-- Neither is written by the current code path (dag/v1 tracks lifecycle
-- via status + cancelled_at + cleanup_completed_at + workflow_execution_nodes,
-- and approvals resume via instance.sendEvent against the per-row
-- workflow_approvals.event_type). The schema declaration was removed
-- in the same commit as this migration.

ALTER TABLE workflow_executions DROP COLUMN runtime_state;
ALTER TABLE workflow_executions DROP COLUMN resume_token;
