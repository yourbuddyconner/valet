-- cleanup_completed_at marks when cancel-cleanup finished ALL of its
-- pipeline steps (cancel approvals, terminate spawned sessions, write
-- skipped traces, mark action_invocations terminal). The runtime only
-- CASes workflow_executions.status='cancelled' once every step has
-- landed; the cron sweep retries 'cancelling' rows until cleanup
-- completes.
--
-- Without this column: a partial-failure cleanup that left the row in
-- 'cancelling' but the CAS happened anyway would foreclose recovery —
-- the early-exit guard on status='cancelled' would bail before
-- re-attempting the steps that failed.
ALTER TABLE workflow_executions ADD COLUMN cleanup_completed_at TEXT;

-- Backfill: any existing 'cancelled' row pre-dates this column and
-- the new atomicity contract. Treat them as completed (they're
-- terminal already; the cron sweep won't touch them because they're
-- not 'cancelling').
UPDATE workflow_executions
  SET cleanup_completed_at = COALESCE(completed_at, cancelled_at, datetime('now'))
  WHERE status = 'cancelled' AND cleanup_completed_at IS NULL;
