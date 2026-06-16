-- Tracks sessions a workflow execution spawned via session-start nodes
-- so cancellation cleanup can find and abort them without parsing the
-- per-node trace.output JSON (which may be truncated or absent for
-- in-flight nodes).
CREATE TABLE workflow_spawned_sessions (
  execution_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (execution_id, node_id, session_id)
);

CREATE INDEX idx_workflow_spawned_sessions_execution_id
  ON workflow_spawned_sessions (execution_id);
