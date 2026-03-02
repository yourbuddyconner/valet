-- Action invocations: audit trail for every action execution attempt
CREATE TABLE IF NOT EXISTS action_invocations (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  service TEXT NOT NULL,
  action_id TEXT NOT NULL,
  risk_level TEXT NOT NULL,
  resolved_mode TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','approved','denied','executed','failed','expired')),
  params TEXT,
  result TEXT,
  error TEXT,
  resolved_by TEXT,
  resolved_at TEXT,
  executed_at TEXT,
  expires_at TEXT,
  policy_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_ai_session ON action_invocations(session_id, created_at);
CREATE INDEX idx_ai_user ON action_invocations(user_id, status);
CREATE INDEX idx_ai_pending ON action_invocations(status, expires_at) WHERE status = 'pending';
