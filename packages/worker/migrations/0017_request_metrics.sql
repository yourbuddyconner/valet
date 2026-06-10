-- Request-level performance telemetry for the Worker API surface.
--
-- Captures the synchronous HTTP latency real users wait on for every /api/*
-- request (list sessions, dashboard load, etc.). This is a different grain from
-- analytics_events (which is session-scoped, agent-turn telemetry) — request
-- metrics are keyed by route, not session, so they live in their own table.
--
-- One row per sampled request, written fire-and-forget from the edge.
CREATE TABLE request_metrics (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  method TEXT NOT NULL,
  route TEXT NOT NULL,          -- matched route pattern, e.g. /api/sessions/:id (low cardinality)
  status INTEGER NOT NULL,      -- HTTP status code
  duration_ms INTEGER NOT NULL, -- wall-clock time to produce the response
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL
);

-- Time-window scans (overall percentiles) and per-route breakdowns.
CREATE INDEX idx_request_metrics_created ON request_metrics(created_at);
CREATE INDEX idx_request_metrics_route_created ON request_metrics(route, created_at);
