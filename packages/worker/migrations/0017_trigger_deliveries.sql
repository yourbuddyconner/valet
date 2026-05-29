-- Per-trigger delivery log: every time a webhook, GitHub event, or schedule
-- tick is evaluated against a trigger we record whether it matched and
-- dispatched, or why it skipped. Powers the trigger-detail page.
CREATE TABLE trigger_deliveries (
  id TEXT PRIMARY KEY,
  trigger_id TEXT NOT NULL REFERENCES triggers(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- For github: 'pull_request.opened', etc. For schedule: 'cron'. For webhook: the path. For test: 'test'.
  event_type TEXT,
  -- The GitHub delivery ID (X-GitHub-Delivery) or a synthetic id for non-GitHub sources.
  delivery_id TEXT,
  -- 'matched' | 'no_match' | 'concurrency_cap' | 'workflow_deleted' | 'duplicate' | 'error'
  outcome TEXT NOT NULL CHECK (outcome IN ('matched', 'no_match', 'concurrency_cap', 'workflow_deleted', 'duplicate', 'error')),
  -- When outcome='matched', the execution row this delivery fired.
  execution_id TEXT REFERENCES workflow_executions(id) ON DELETE SET NULL,
  -- Human-readable reason for non-matched outcomes.
  reason TEXT,
  -- Truncated payload preview (first 8KB) for debugging.
  payload_preview TEXT,
  received_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_trigger_deliveries_trigger ON trigger_deliveries(trigger_id);
CREATE INDEX idx_trigger_deliveries_received ON trigger_deliveries(trigger_id, received_at DESC);
CREATE INDEX idx_trigger_deliveries_user ON trigger_deliveries(user_id);
