# Unified Analytics Events — Design Spec

**Date:** 2026-03-17
**Status:** Approved
**Issue:** [#33 — MVP performance telemetry](https://github.com/yourbuddyconner/valet/issues/33)

## Overview

Replace `usage_events` and `session_audit_log` with a single `analytics_events` table that serves billing, performance telemetry, audit logging, and plugin analytics through one schema, one flush path, and one SDK interface.

## Goals

1. Unified event model — one table for all observability (billing, perf, audit, plugins)
2. Baseline real-user performance — P50/P95 turn latency, stage breakdown, error rates
3. Plugin analytics interface — plugins can emit arbitrary events via `Analytics.emit()`
4. Admin dashboard — tabbed UI with Billing, Performance, and Events views

## Non-Goals

- Full distributed tracing
- Long-term BI / data warehouse export
- Daily rollup tables (deferred — MVP uses raw event queries)
- Sandbox-side tool analytics emission (deferred — MVP covers code plugins only)

---

## Data Model

### D1 Table: `analytics_events`

Replaces both `usage_events` and `session_audit_log`.

```sql
CREATE TABLE analytics_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id TEXT,
  turn_id TEXT,

  -- Timing
  duration_ms INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),

  -- Dimensions (primary GROUP BY targets)
  channel TEXT,
  model TEXT,
  queue_mode TEXT,

  -- Typed hot-path fields
  input_tokens INTEGER,
  output_tokens INTEGER,
  tool_name TEXT,
  error_code TEXT,

  -- Audit fields (nullable — only for audit-worthy events)
  summary TEXT,
  actor_id TEXT,

  -- Overflow
  properties TEXT  -- JSON
);
```

**Indexes:**
- `(event_type, created_at)` — dashboard queries filtered by type + time range
- `(session_id, created_at)` — per-session timeline
- `(session_id, event_type)` — "all LLM calls for session X"
- `(user_id, event_type, created_at)` — per-user breakdown queries
- `(model, created_at)` — model breakdown queries

### Local SQLite Table (DO)

One `analytics_events` table in SessionAgentDO local storage, replacing both `audit_log` and `usage_events`:

```sql
CREATE TABLE IF NOT EXISTS analytics_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  turn_id TEXT,
  duration_ms INTEGER,
  channel TEXT,
  model TEXT,
  queue_mode TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  tool_name TEXT,
  error_code TEXT,
  summary TEXT,
  actor_id TEXT,
  properties TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  flushed INTEGER NOT NULL DEFAULT 0
);
```

### Migration

Migration `0070_analytics_events.sql`:

1. Create `analytics_events` table with indexes
2. Migrate `usage_events` rows as `event_type = 'llm_call'`, moving `oc_message_id` to properties JSON
3. Migrate `session_audit_log` rows, preserving event_type, summary, actor_id, metadata → properties
4. Drop `usage_events` and `session_audit_log` tables
5. Drop associated indexes

---

## Event Types

### Core Events

| Event Type | Source | Duration | Key Fields |
|---|---|---|---|
| `llm_call` | DO (existing flush) | — | `model`, `input_tokens`, `output_tokens`, `properties.oc_message_id` |
| `llm_response` | Runner → DO | `duration_ms` | `model`, `properties.input_tokens`, `properties.output_tokens` |
| `turn_complete` | DO | `duration_ms` | `channel`, `queue_mode`, `model` |
| `queue_wait` | DO | `duration_ms` | `channel`, `queue_mode` |
| `sandbox_wake` | DO | `duration_ms` | — |
| `sandbox_restore` | DO | `duration_ms` | `properties.snapshot_id` |
| `tool_exec` | DO | `duration_ms` | `tool_name` |
| `turn_error` | DO | — | `error_code`, `properties.stage` |
| `runner_connect` | DO | `duration_ms` | — |

### Audit Events (existing, now with optional timing)

All existing `appendAuditLog` call sites become `emitAuditEvent` calls. These include:

- `user.joined`, `user.left`, `user.prompt`, `user.abort`, `user.answer`
- `prompt.queued`, `prompt.dispatch_failed`
- `agent.turn_complete`, `agent.error`, `agent.tool_call`, `agent.question`
- `session.started`, `session.terminated`, `session.hibernated`, `session.restored`
- `watchdog.recovery`, `watchdog.queue_recovery`, `error.safety_net`
- `workflow.dispatch`, `workflow.dispatch_queued`, `workflow.dispatch_failed`
- `channel.followup_resolved`
- `opencode.config_error`, `opencode.config_applied`
- `git.pr_created`, `tunnel.disabled`

### Plugin Events

Namespaced `{plugin}.{event}`: `github.pr_created`, `slack.message_sent`, `linear.issue_created`, etc. No registry — plugins emit whatever they want.

---

## Emitter Architecture

### Two-tier emitter (same local table, different interfaces)

**Core emitter** — private method on SessionAgentDO:

```typescript
private emitEvent(type: string, fields?: {
  turnId?: string;
  durationMs?: number;
  channel?: string;
  model?: string;
  queueMode?: string;
  inputTokens?: number;
  outputTokens?: number;
  toolName?: string;
  errorCode?: string;
  properties?: Record<string, unknown>;
}): void
```

Full access to all typed columns. Writes to local SQLite. No broadcast.

**Audit emitter** — thin wrapper:

```typescript
private emitAuditEvent(
  type: string,
  summary: string,
  actorId?: string,
  fields?: { /* same as emitEvent fields */ }
): void
```

Calls `emitEvent` with `summary` and `actorId` set, then broadcasts to connected WebSocket clients (same real-time behavior as today's `appendAuditLog`).

### Plugin SDK interface (`@valet/sdk`)

```typescript
interface Analytics {
  emit(eventType: string, data?: {
    durationMs?: number;
    properties?: Record<string, unknown>;
  }): void;
}
```

- Synchronous, fire-and-forget, never throws, never blocks
- System injects `session_id`, `user_id`, `turn_id`, `channel`, `created_at` automatically
- Plugins only specify what they uniquely know

### Delivery paths

**Code plugins (actions — run in worker):**

Action execution context gets `analytics: Analytics`. Emitter collects events in an array during execution. After action completes, DO writes collected events to local SQLite. Flushed to D1 on next cycle.

**Runner → DO (for `llm_response` and future sandbox events):**

New WebSocket message type:
```typescript
{ type: 'analytics:emit', events: Array<{ eventType: string; durationMs?: number; properties?: Record<string, unknown> }> }
```

DO receives, writes to local SQLite, flushed to D1 normally.

### Flush path

Single path in `flushMetrics()`:

```
Local analytics_events (SQLite)
  → SELECT WHERE flushed = 0 ORDER BY id ASC LIMIT 100
  → batchInsertAnalyticsEvents() → D1 analytics_events
  → UPDATE SET flushed = 1
```

Replaces the current two-path flush (audit_log + usage_events).

### Timing capture

Timestamp markers stored as DO state values (same pattern as existing `runningStartedAt`):

- `promptReceivedAt` — set when prompt enters the queue
- `dispatchStartedAt` — set when sandbox dispatch begins
- `runnerConnectedAt` — set when runner WebSocket opens

Duration computed as diff when stage completes. No new timers or alarms.

---

## Dashboard UI

### Route: `/settings/usage` (existing, retitled "Analytics")

Tabbed layout using existing `PeriodSelector`. Three tabs:

### Billing tab (existing, re-pointed)

Same UI as today. Queries change from `usage_events` to `analytics_events WHERE event_type = 'llm_call'`. Same hero metrics, cost chart, model breakdown, user breakdown.

### Performance tab (new)

**Hero metrics (4 cards):**
- Turn Latency P50 / P95 — from `turn_complete` duration_ms
- Queue Wait P50 — from `queue_wait` duration_ms
- Sandbox Wake P50 — from `sandbox_wake` + `sandbox_restore` duration_ms
- Error Rate — count(`turn_error`) / count(`turn_complete`)

**Latency trend chart:**
- Recharts area chart (same style as cost chart)
- X: date, Y: P50 and P95 duration for `turn_complete`

**Stage breakdown table:**
- Rows: `queue_wait`, `sandbox_wake`, `sandbox_restore`, `llm_response`, `tool_exec`, `runner_connect`, "Model + Other" (residual)
- Columns: count, P50 duration, P95 duration
- "Model + Other" derived as `turn_complete.duration - sum(measured stages)`

**Slow paths table:**
- `turn_complete` grouped by channel, model, queue_mode
- P50/P95 per group

### Events tab (new)

**Paginated event feed:**
- Table of recent `analytics_events` across all sessions
- Columns: timestamp, event type, session (linked), duration, summary, properties preview
- Filterable by event type prefix (core, `github.*`, `slack.*`, etc.)
- Replaces the need for a separate audit log viewer

### Percentile computation

SQL OFFSET approach — one row returned per percentile:

```sql
SELECT duration_ms FROM analytics_events
WHERE event_type = ? AND created_at >= ? AND duration_ms IS NOT NULL
ORDER BY duration_ms
LIMIT 1 OFFSET (
  SELECT CAST(COUNT(*) * 0.95 AS INTEGER)
  FROM analytics_events
  WHERE event_type = ? AND created_at >= ? AND duration_ms IS NOT NULL
)
```

### API endpoints

**Existing (rewritten):**
- `GET /api/usage/stats?period=720` — billing data, queries `analytics_events` instead of `usage_events`

**New:**
- `GET /api/analytics/performance?period=720` — perf hero stats, latency trends, stage breakdown
- `GET /api/analytics/events?period=720&type=github.*&limit=50&offset=0` — paginated event feed

---

## Retention

Daily cron trigger (worker already has cron infrastructure in `wrangler.toml`):

```sql
DELETE FROM analytics_events WHERE created_at < datetime('now', '-90 days')
```

90 days uniform retention for MVP. Differentiate by event type later if needed.

---

## Boundary

This spec covers:
- `analytics_events` D1 table and migration
- Local SQLite table in SessionAgentDO
- Core event emission and audit event refactor
- Plugin SDK `Analytics` interface (code plugins only)
- Runner `analytics:emit` WebSocket message type
- Flush path consolidation
- Dashboard UI (Billing, Performance, Events tabs)
- API endpoints
- Retention cron

This spec does NOT cover:
- Sandbox-side tool analytics emission
- Daily/hourly rollup tables
- Alerting or SLO monitoring
- Custom plugin dashboard panels
- Data export or BI integration
