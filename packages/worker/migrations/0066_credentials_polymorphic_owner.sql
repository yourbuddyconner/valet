-- Recreate credentials table with polymorphic owner (owner_type + owner_id)
-- SQLite does not support ALTER COLUMN, so we use the table-recreation pattern.

CREATE TABLE credentials_new (
  id TEXT PRIMARY KEY,
  owner_type TEXT NOT NULL DEFAULT 'user',
  owner_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  credential_type TEXT NOT NULL DEFAULT 'oauth2',
  encrypted_data TEXT NOT NULL,
  metadata TEXT,
  scopes TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO credentials_new (id, owner_type, owner_id, provider, credential_type, encrypted_data, scopes, expires_at, created_at, updated_at)
  SELECT id, 'user', user_id, provider, COALESCE(credential_type, 'oauth2'), encrypted_data, scopes, expires_at, created_at, updated_at
  FROM credentials;

DROP TABLE credentials;
ALTER TABLE credentials_new RENAME TO credentials;

CREATE UNIQUE INDEX credentials_owner_unique ON credentials(owner_type, owner_id, provider, credential_type);
CREATE INDEX credentials_owner_lookup ON credentials(owner_type, owner_id);
CREATE INDEX credentials_provider ON credentials(provider);
