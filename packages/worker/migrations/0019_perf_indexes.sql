-- Hot path: every GitHub webhook delivery scans `triggers` filtered by
-- (type, enabled, user_id). The existing single-column indexes on `type`
-- and `enabled` force the planner to pick one and discard the other; a
-- composite (type, enabled) lets it satisfy both predicates with one
-- index seek. The schedule cron tick uses the same shape.
CREATE INDEX IF NOT EXISTS idx_triggers_type_enabled ON triggers(type, enabled);

-- The executions list query is WHERE user_id = ? ORDER BY started_at DESC.
-- Existing indexes are on user_id alone and started_at alone — the planner
-- can only use one, so it filters by user and then sorts in memory. A
-- composite (user_id, started_at DESC) lets the index satisfy both the
-- filter and the order without a sort step.
CREATE INDEX IF NOT EXISTS idx_workflow_executions_user_started ON workflow_executions(user_id, started_at DESC);
