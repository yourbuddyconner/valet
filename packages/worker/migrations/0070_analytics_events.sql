-- Unified analytics events table (replaces usage_events + session_audit_log)
CREATE TABLE IF NOT EXISTS analytics_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id TEXT,
  turn_id TEXT,
  duration_ms INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  channel TEXT,
  model TEXT,
  queue_mode TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  tool_name TEXT,
  error_code TEXT,
  summary TEXT,
  actor_id TEXT,
  properties TEXT
);

CREATE INDEX IF NOT EXISTS idx_analytics_events_type_created
  ON analytics_events(event_type, created_at);
CREATE INDEX IF NOT EXISTS idx_analytics_events_session_created
  ON analytics_events(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_analytics_events_session_type
  ON analytics_events(session_id, event_type);
CREATE INDEX IF NOT EXISTS idx_analytics_events_user_type_created
  ON analytics_events(user_id, event_type, created_at);
CREATE INDEX IF NOT EXISTS idx_analytics_events_model_created
  ON analytics_events(model, created_at);

-- Migrate usage_events → analytics_events as 'llm_call' events (backfill user_id from sessions)
INSERT INTO analytics_events (id, event_type, session_id, user_id, turn_id, model, input_tokens, output_tokens, created_at, properties)
SELECT
  ue.id,
  'llm_call',
  ue.session_id,
  s.user_id,
  ue.turn_id,
  ue.model,
  ue.input_tokens,
  ue.output_tokens,
  ue.created_at,
  json_object('oc_message_id', ue.oc_message_id)
FROM usage_events ue
LEFT JOIN sessions s ON s.id = ue.session_id;

-- Migrate session_audit_log → analytics_events (backfill user_id from sessions)
INSERT INTO analytics_events (id, event_type, session_id, user_id, summary, actor_id, properties, created_at)
SELECT
  sal.id,
  sal.event_type,
  sal.session_id,
  s.user_id,
  sal.summary,
  sal.actor_id,
  sal.metadata,
  sal.created_at
FROM session_audit_log sal
LEFT JOIN sessions s ON s.id = sal.session_id;

-- Drop old tables
DROP TABLE IF EXISTS usage_events;
DROP TABLE IF EXISTS session_audit_log;

-- Drop old indexes
DROP INDEX IF EXISTS idx_usage_events_session;
DROP INDEX IF EXISTS idx_usage_events_model;
DROP INDEX IF EXISTS idx_usage_events_created_at;
DROP INDEX IF EXISTS idx_usage_events_session_created;
DROP INDEX IF EXISTS idx_usage_events_model_created;
DROP INDEX IF EXISTS idx_session_audit_log_session_id;
DROP INDEX IF EXISTS idx_session_audit_log_event_type;
