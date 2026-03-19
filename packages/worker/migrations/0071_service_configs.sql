-- Create generic service config table
CREATE TABLE org_service_configs (
  service TEXT PRIMARY KEY,
  encrypted_config TEXT NOT NULL,
  metadata TEXT,
  configured_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
