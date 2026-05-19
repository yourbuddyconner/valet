CREATE TABLE user_action_policy_overrides (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  service TEXT,
  action_id TEXT,
  risk_level TEXT CHECK(risk_level IN ('low','medium','high','critical')),
  mode TEXT NOT NULL CHECK(mode IN ('allow','require_approval','deny')),
  lifetime TEXT NOT NULL DEFAULT 'persistent'
    CHECK(lifetime IN ('persistent','session','timed')),
  session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  expires_at TEXT,
  source TEXT NOT NULL DEFAULT 'settings'
    CHECK(source IN ('settings','approval_prompt')),
  source_invocation_id TEXT REFERENCES action_invocations(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),

  CHECK(action_id IS NULL OR service IS NOT NULL),
  CHECK(
    (service IS NOT NULL AND action_id IS NOT NULL AND risk_level IS NULL)
    OR (service IS NOT NULL AND action_id IS NULL AND risk_level IS NULL)
    OR (service IS NULL AND action_id IS NULL AND risk_level IS NOT NULL)
  ),
  CHECK(lifetime != 'session' OR session_id IS NOT NULL),
  CHECK(lifetime = 'session' OR session_id IS NULL),
  CHECK(lifetime != 'timed' OR expires_at IS NOT NULL)
);

CREATE INDEX idx_uapo_user ON user_action_policy_overrides(user_id);
CREATE INDEX idx_uapo_session ON user_action_policy_overrides(session_id);
CREATE INDEX idx_uapo_expires ON user_action_policy_overrides(expires_at);

CREATE UNIQUE INDEX idx_uapo_persistent_action
  ON user_action_policy_overrides(user_id, service, action_id)
  WHERE lifetime = 'persistent' AND action_id IS NOT NULL;

CREATE UNIQUE INDEX idx_uapo_persistent_service
  ON user_action_policy_overrides(user_id, service)
  WHERE lifetime = 'persistent' AND action_id IS NULL AND risk_level IS NULL AND service IS NOT NULL;

CREATE UNIQUE INDEX idx_uapo_persistent_risk
  ON user_action_policy_overrides(user_id, risk_level)
  WHERE lifetime = 'persistent' AND service IS NULL AND action_id IS NULL AND risk_level IS NOT NULL;

CREATE UNIQUE INDEX idx_uapo_session_action
  ON user_action_policy_overrides(user_id, session_id, service, action_id)
  WHERE lifetime = 'session' AND action_id IS NOT NULL;

ALTER TABLE action_invocations ADD COLUMN org_policy_id TEXT REFERENCES action_policies(id) ON DELETE SET NULL;
ALTER TABLE action_invocations ADD COLUMN base_mode TEXT;
ALTER TABLE action_invocations ADD COLUMN base_source TEXT;
ALTER TABLE action_invocations ADD COLUMN user_override_id TEXT REFERENCES user_action_policy_overrides(id) ON DELETE SET NULL;
ALTER TABLE action_invocations ADD COLUMN policy_source TEXT;
ALTER TABLE action_invocations ADD COLUMN policy_lifetime TEXT;
ALTER TABLE action_invocations ADD COLUMN policy_scope TEXT;
