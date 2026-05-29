-- D1 / SQLite supports partial indexes. The existing UNIQUE(workflow_id, idempotency_key)
-- can't dedupe rows where workflow_id IS NULL because SQLite treats NULL as distinct
-- from NULL in unique constraints. Test/dry runs persist with workflow_id = NULL, so
-- without this index a concurrent race could double-insert. Cover the null-workflow
-- case with a partial unique index on idempotency_key alone.
CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_executions_idempotency_null_workflow
  ON workflow_executions(idempotency_key)
  WHERE workflow_id IS NULL;
