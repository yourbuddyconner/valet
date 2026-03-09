-- Thread tracking for orchestrator sessions
CREATE TABLE session_threads (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  opencode_session_id TEXT,
  title TEXT,
  summary_additions INTEGER DEFAULT 0,
  summary_deletions INTEGER DEFAULT 0,
  summary_files INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  message_count INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_active_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_session_threads_session ON session_threads(session_id);
CREATE INDEX idx_session_threads_session_status ON session_threads(session_id, status);
CREATE INDEX idx_session_threads_last_active ON session_threads(session_id, last_active_at);

-- Add thread_id column to messages table
ALTER TABLE messages ADD COLUMN thread_id TEXT REFERENCES session_threads(id);
CREATE INDEX idx_messages_thread ON messages(thread_id);
