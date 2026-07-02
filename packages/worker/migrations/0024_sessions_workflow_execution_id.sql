-- Durable attribution link from a workflow-spawned session back to the
-- execution that produced it. Prior to this, the join went through
-- workflow_spawned_sessions, which is deleted on successful terminal
-- cleanup — so usage/attribution queries lost automated sessions the
-- moment their cleanup completed.
--
-- workflow_id and trigger_id remain owned by workflow_executions;
-- attribution queries join sessions → workflow_executions → workflows/
-- triggers to disambiguate. Denormalizing only the execution id keeps
-- the single source of truth on the executions row.
--
-- Backfill from workflow_spawned_sessions covers currently-live rows;
-- older executions whose spawned-session rows have already been purged
-- will remain unattributed (there is no other source to recover them).
-- The same backfill also corrects purpose='workflow' for these rows —
-- the code path that would have set it at spawn time never did, so
-- getUsageByPurposeModel had been bucketing workflow tokens under
-- 'interactive'.
--
-- No BEGIN/COMMIT wrapper: D1 rejects bare SQL transactions; wrangler
-- applies the file atomically.

ALTER TABLE sessions ADD COLUMN workflow_execution_id TEXT;

CREATE INDEX idx_sessions_workflow_execution_id
  ON sessions(workflow_execution_id)
  WHERE workflow_execution_id IS NOT NULL;

-- Compound backfill: sets both workflow_execution_id and purpose in one
-- pass. ORDER BY created_at DESC on the correlated subquery makes the
-- pick deterministic in the (schema-allowed but never-observed) case
-- where a single session_id appears under multiple (execution_id,
-- node_id) rows. The purpose guard excludes orchestrator rows
-- defensively — no known path lets an orchestrator session end up in
-- workflow_spawned_sessions, but the update is unconditional otherwise.
UPDATE sessions
SET
  workflow_execution_id = (
    SELECT wss.execution_id
    FROM workflow_spawned_sessions wss
    WHERE wss.session_id = sessions.id
    ORDER BY wss.created_at DESC
    LIMIT 1
  ),
  purpose = 'workflow'
WHERE workflow_execution_id IS NULL
  AND COALESCE(purpose, 'interactive') != 'orchestrator'
  AND EXISTS (
    SELECT 1 FROM workflow_spawned_sessions wss
    WHERE wss.session_id = sessions.id
  );
