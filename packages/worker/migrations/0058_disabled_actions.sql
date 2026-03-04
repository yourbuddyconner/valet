-- Org-level action enablement toggle: blocklist model
-- Absence of a row = enabled; presence = disabled
CREATE TABLE IF NOT EXISTS disabled_actions (
  id TEXT PRIMARY KEY,
  service TEXT NOT NULL,
  action_id TEXT,
  disabled_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Service-level disable (action_id IS NULL)
CREATE UNIQUE INDEX IF NOT EXISTS idx_da_service ON disabled_actions(service) WHERE action_id IS NULL;

-- Action-level disable (action_id IS NOT NULL)
CREATE UNIQUE INDEX IF NOT EXISTS idx_da_action ON disabled_actions(service, action_id) WHERE action_id IS NOT NULL;
