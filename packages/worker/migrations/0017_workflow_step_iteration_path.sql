-- 0017_workflow_step_iteration_path.sql
-- Add per-instance step identity so loop iterations, parallel branches, and
-- conditional branches don't overwrite each other in workflow_execution_steps.

ALTER TABLE workflow_execution_steps
  ADD COLUMN iteration_path TEXT NOT NULL DEFAULT '';

-- Replace the existing unique index. The old key collapsed loop iterations.
DROP INDEX IF EXISTS idx_execution_steps_unique;

CREATE UNIQUE INDEX idx_execution_steps_unique
  ON workflow_execution_steps (execution_id, step_id, attempt, iteration_path);

-- Lookup index for the timeline read path (rows for one execution,
-- ordered by created time, optionally filtered by container prefix).
CREATE INDEX idx_workflow_execution_steps_iteration
  ON workflow_execution_steps (execution_id, iteration_path);
