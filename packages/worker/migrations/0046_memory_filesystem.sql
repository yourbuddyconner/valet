-- Migration: Memory File System Facade
-- Replaces orchestrator_memories (UUID + category) with orchestrator_memory_files (path-based virtual FS)

-- 1. Create new table
CREATE TABLE orchestrator_memory_files (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  org_id TEXT NOT NULL DEFAULT 'default',
  path TEXT NOT NULL,
  content TEXT NOT NULL,
  relevance REAL NOT NULL DEFAULT 1.0,
  pinned INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_accessed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX idx_memory_files_user_path ON orchestrator_memory_files(user_id, path);
CREATE INDEX idx_memory_files_user ON orchestrator_memory_files(user_id);
CREATE INDEX idx_memory_files_pinned ON orchestrator_memory_files(user_id, pinned);

-- 2. Migrate existing memories: category becomes top-level directory
-- Path format: category/short-id.md (agent will reorganize over time)
-- On a fresh DB, orchestrator_memories won't exist. We CREATE TABLE IF NOT EXISTS with the
-- same schema so the INSERT...SELECT always has a valid source (0 rows on fresh DB).

DROP TABLE IF EXISTS orchestrator_memories_fts;

CREATE TABLE IF NOT EXISTS orchestrator_memories (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  org_id TEXT NOT NULL DEFAULT 'default',
  category TEXT NOT NULL DEFAULT 'general',
  content TEXT NOT NULL,
  relevance REAL NOT NULL DEFAULT 1.0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_accessed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO orchestrator_memory_files (id, user_id, org_id, path, content, relevance, pinned, version, created_at, updated_at, last_accessed_at)
SELECT
  id, user_id, org_id,
  category || '/' || SUBSTR(id, 1, 8) || '.md',
  content, relevance, 0, 1, created_at, created_at, last_accessed_at
FROM orchestrator_memories;

-- 3. Drop old memories table
DROP TABLE IF EXISTS orchestrator_memories;

-- 4. Create FTS5 index (indexes both path and content)
CREATE VIRTUAL TABLE orchestrator_memory_files_fts USING fts5(
  path,
  content,
  content_rowid='rowid',
  tokenize='porter unicode61'
);

-- 5. Populate FTS index from migrated data
INSERT INTO orchestrator_memory_files_fts(rowid, path, content)
  SELECT rowid, path, content FROM orchestrator_memory_files;
