-- MCP OAuth dynamic client registrations.
-- One row per MCP service. Caches discovered endpoints + registered client_id
-- so we reuse the same client across requests instead of re-registering.
CREATE TABLE mcp_oauth_clients (
  service TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  client_secret TEXT,
  authorization_endpoint TEXT NOT NULL,
  token_endpoint TEXT NOT NULL,
  registration_endpoint TEXT,
  scopes_supported TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
