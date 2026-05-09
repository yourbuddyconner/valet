-- Tracks GitHub App installations (both org and personal).
-- github_installation_id and account_id stored as TEXT to avoid JS number
-- precision issues — Octokit returns them as JS numbers, we cast at the boundary.
-- cached_token_encrypted / cached_token_expires_at: short-TTL cache of the
-- installation access token to avoid re-minting on every resolver call.
CREATE TABLE github_installations (
  id TEXT PRIMARY KEY,
  github_installation_id TEXT NOT NULL UNIQUE,
  account_login TEXT NOT NULL,
  account_id TEXT NOT NULL,
  account_type TEXT NOT NULL CHECK(account_type IN ('Organization', 'User')),
  linked_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'suspended', 'removed')),
  repository_selection TEXT NOT NULL CHECK(repository_selection IN ('all', 'selected')),
  permissions TEXT,
  cached_token_encrypted TEXT,
  cached_token_expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_github_installations_account_login ON github_installations(account_login);
CREATE INDEX idx_github_installations_account_id ON github_installations(account_id);
CREATE INDEX idx_github_installations_linked_user ON github_installations(linked_user_id)
  WHERE linked_user_id IS NOT NULL;
