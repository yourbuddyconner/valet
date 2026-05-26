CREATE TABLE custom_mcp_connectors (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL DEFAULT 'default',
  service_slug TEXT NOT NULL,
  display_name TEXT NOT NULL,
  server_url TEXT NOT NULL,
  auth_type TEXT NOT NULL DEFAULT 'none'
    CHECK(auth_type IN ('none', 'oauth', 'api_key', 'bearer')),

  oauth_client_id TEXT,
  encrypted_oauth_client_secret TEXT,
  oauth_token_endpoint_auth_method TEXT NOT NULL DEFAULT 'none'
    CHECK(oauth_token_endpoint_auth_method IN ('none', 'client_secret_basic', 'client_secret_post')),
  oauth_scopes TEXT,
  oauth_authorization_endpoint TEXT,
  oauth_token_endpoint TEXT,

  encrypted_api_key TEXT,
  api_key_header_name TEXT DEFAULT 'Authorization',
  api_key_prefix TEXT DEFAULT 'Bearer',

  encrypted_additional_headers TEXT,

  status TEXT NOT NULL DEFAULT 'active'
    CHECK(status IN ('active', 'disabled', 'error')),
  last_discovered_at TEXT,
  last_error TEXT,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),

  UNIQUE(service_slug)
);

CREATE INDEX idx_custom_mcp_connectors_org_status
  ON custom_mcp_connectors(org_id, status);

CREATE INDEX idx_disabled_actions_service_cleanup
  ON disabled_actions(service);

CREATE INDEX idx_action_policies_service_cleanup
  ON action_policies(service);

CREATE INDEX idx_uapo_service_cleanup
  ON user_action_policy_overrides(service);

CREATE INDEX idx_ai_policy_id
  ON action_invocations(policy_id);

CREATE INDEX idx_ai_org_policy_id
  ON action_invocations(org_policy_id);

CREATE INDEX idx_ai_user_override_id
  ON action_invocations(user_override_id);
