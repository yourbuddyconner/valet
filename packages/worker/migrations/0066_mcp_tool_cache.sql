-- Cache of MCP tool metadata discovered at runtime.
-- Populated by SessionAgentDO when tools are listed with valid credentials.
-- Read by the catalog endpoint to surface MCP tools in the policy editor UI.

CREATE TABLE IF NOT EXISTS mcp_tool_cache (
  service     TEXT NOT NULL,
  action_id   TEXT NOT NULL,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  risk_level  TEXT NOT NULL DEFAULT 'medium',
  discovered_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (service, action_id)
);

CREATE INDEX idx_mcp_tool_cache_service ON mcp_tool_cache(service);
