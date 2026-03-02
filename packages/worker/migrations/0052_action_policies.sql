-- Action policies: configurable rules for how actions are gated (allow/require_approval/deny)
CREATE TABLE IF NOT EXISTS action_policies (
  id TEXT PRIMARY KEY,
  service TEXT,
  action_id TEXT,
  risk_level TEXT CHECK(risk_level IN ('low','medium','high','critical')),
  mode TEXT NOT NULL CHECK(mode IN ('allow','require_approval','deny')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Unique constraints via partial indexes for the cascade hierarchy
-- Most specific: a particular action on a particular service
CREATE UNIQUE INDEX idx_ap_action ON action_policies(service, action_id)
  WHERE action_id IS NOT NULL;
-- Service-level: all actions on a service
CREATE UNIQUE INDEX idx_ap_service ON action_policies(service)
  WHERE action_id IS NULL AND risk_level IS NULL AND service IS NOT NULL;
-- Risk-level: all actions with a given risk level
CREATE UNIQUE INDEX idx_ap_risk ON action_policies(risk_level)
  WHERE service IS NULL AND action_id IS NULL AND risk_level IS NOT NULL;
