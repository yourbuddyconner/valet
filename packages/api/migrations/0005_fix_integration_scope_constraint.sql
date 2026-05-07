-- Fix: migration 0004 added a new UNIQUE(user_id, service, scope) index but
-- the original table-level UNIQUE(user_id, service) constraint (created as
-- sqlite_autoindex_integrations_1) was never removed. This prevents having
-- both a user-scoped and org-scoped integration for the same service.
--
-- SQLite cannot ALTER TABLE to drop a table-level constraint, so we
-- recreate the table without it.

-- 1. Drop named indexes (recreated after the swap)
DROP INDEX IF EXISTS idx_integrations_user_service;
DROP INDEX IF EXISTS idx_integrations_user;
DROP INDEX IF EXISTS idx_integrations_service;

-- 2. Recreate without the table-level UNIQUE(user_id, service)
CREATE TABLE integrations_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  service TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  error_message TEXT,
  last_synced_at TEXT,
  scope TEXT NOT NULL DEFAULT 'user',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 3. Copy data
INSERT INTO integrations_new SELECT * FROM integrations;

-- 4. Swap
DROP TABLE integrations;
ALTER TABLE integrations_new RENAME TO integrations;

-- 5. Recreate indexes — only the 3-column unique constraint
CREATE UNIQUE INDEX idx_integrations_user_service ON integrations(user_id, service, scope);
CREATE INDEX idx_integrations_user ON integrations(user_id);
CREATE INDEX idx_integrations_service ON integrations(service);
