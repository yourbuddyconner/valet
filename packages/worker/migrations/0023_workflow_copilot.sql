-- Workflow Copilot — per-workflow chat threads backed by the Vercel AI SDK.
--
-- Distinct from the orchestrator session model: copilot threads are
-- stateless conversations scoped to one workflow, persisted only as
-- their message history. The system prompt is snapshotted at thread
-- creation (so the cache prefix stays stable) and never rewritten.
--
-- No BEGIN/COMMIT wrapper: D1 rejects bare SQL transactions; wrangler
-- applies the file atomically.

CREATE TABLE copilot_threads (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  -- System prompt frozen at thread-create time. Includes the workflow
  -- definition snapshot so the model has full context without paying
  -- a getWorkflow tool round trip on the first turn. The model can
  -- still call getWorkflow later if it suspects drift.
  system_prompt TEXT NOT NULL,
  -- Chosen model id (e.g. "claude-sonnet-4-6"); nullable so we can
  -- fall back to a workspace default.
  model TEXT,
  title TEXT,
  message_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_copilot_threads_workflow ON copilot_threads(workflow_id);
CREATE INDEX idx_copilot_threads_user ON copilot_threads(user_id);
CREATE INDEX idx_copilot_threads_updated ON copilot_threads(workflow_id, user_id, updated_at DESC);

CREATE TABLE copilot_messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  -- One of 'user' | 'assistant' | 'tool'. Vercel AI SDK message roles.
  role TEXT NOT NULL,
  -- Plain-text content for simple messages. For assistant turns with
  -- structured parts, `parts` carries the JSON payload and `content`
  -- can be the concatenated text representation (or empty).
  content TEXT NOT NULL DEFAULT '',
  -- JSON-encoded message parts (tool calls, tool results, text). For
  -- assistant + tool roles, the canonical content lives here.
  parts TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (thread_id) REFERENCES copilot_threads(id) ON DELETE CASCADE
);

CREATE INDEX idx_copilot_messages_thread ON copilot_messages(thread_id, created_at);
