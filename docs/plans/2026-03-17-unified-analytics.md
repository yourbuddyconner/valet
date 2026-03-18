# Unified Analytics Events Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `usage_events` and `session_audit_log` with a single `analytics_events` table, instrument core performance events, expose an `Analytics.emit()` SDK interface for plugins, and build a tabbed admin dashboard with Billing, Performance, and Events views.

**Architecture:** One D1 table (`analytics_events`) stores all billing, perf, audit, and plugin events. SessionAgentDO writes events to a local SQLite table and flushes to D1 on a 30s alarm cycle. The SDK provides a minimal `Analytics` interface that plugins use to emit custom events. Two new API endpoints power the Performance and Events dashboard tabs.

**Tech Stack:** D1 (SQLite), Drizzle ORM, Cloudflare Workers (Hono), Durable Objects, React + Recharts + TanStack Query

---

## Chunk 1: Schema, Data Layer, and Core Emitter

### Task 1: D1 Migration — Create `analytics_events` and Migrate Data

**Files:**
- Create: `packages/worker/migrations/0070_analytics_events.sql`

- [ ] **Step 1: Write the migration SQL**

```sql
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

-- Migrate usage_events → analytics_events as 'llm_call' events
INSERT INTO analytics_events (id, event_type, session_id, turn_id, model, input_tokens, output_tokens, created_at, properties)
SELECT
  id,
  'llm_call',
  session_id,
  turn_id,
  model,
  input_tokens,
  output_tokens,
  created_at,
  json_object('oc_message_id', oc_message_id)
FROM usage_events;

-- Migrate session_audit_log → analytics_events
INSERT INTO analytics_events (id, event_type, session_id, summary, actor_id, properties, created_at)
SELECT
  id,
  event_type,
  session_id,
  summary,
  actor_id,
  metadata,
  created_at
FROM session_audit_log;

-- Drop old tables
DROP TABLE IF EXISTS usage_events;
DROP TABLE IF EXISTS session_audit_log;

-- Drop old indexes (created in earlier migrations)
DROP INDEX IF EXISTS idx_usage_events_session;
DROP INDEX IF EXISTS idx_usage_events_model;
DROP INDEX IF EXISTS idx_usage_events_created_at;
DROP INDEX IF EXISTS idx_usage_events_session_created;
DROP INDEX IF EXISTS idx_usage_events_model_created;
DROP INDEX IF EXISTS idx_session_audit_log_session_id;
DROP INDEX IF EXISTS idx_session_audit_log_event_type;
```

- [ ] **Step 2: Verify migration SQL is syntactically valid**

Run: `cd /Users/conner/code/valet && sqlite3 :memory: < packages/worker/migrations/0070_analytics_events.sql 2>&1 || echo "Syntax check only — foreign key errors expected"`

The migration references `sessions(id)` which won't exist in `:memory:`, but SQLite will parse the rest. Verify no syntax errors in the CREATE/INSERT/DROP statements.

- [ ] **Step 3: Commit**

```bash
git add packages/worker/migrations/0070_analytics_events.sql
git commit -m "feat: add analytics_events migration replacing usage_events + session_audit_log"
```

---

### Task 2: Drizzle Schema for `analytics_events`

**Files:**
- Create: `packages/worker/src/lib/schema/analytics.ts`
- Modify: `packages/worker/src/lib/schema/index.ts:19` (replace usage export)
- Modify: `packages/worker/src/lib/schema/usage.ts` (delete file)

- [ ] **Step 1: Create the Drizzle schema**

Create `packages/worker/src/lib/schema/analytics.ts`:

```typescript
import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { sessions } from './sessions.js';

export const analyticsEvents = sqliteTable('analytics_events', {
  id: text().primaryKey(),
  eventType: text().notNull(),
  sessionId: text().notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  userId: text(),
  turnId: text(),
  durationMs: integer(),
  createdAt: text().default(sql`(datetime('now'))`),
  channel: text(),
  model: text(),
  queueMode: text(),
  inputTokens: integer(),
  outputTokens: integer(),
  toolName: text(),
  errorCode: text(),
  summary: text(),
  actorId: text(),
  properties: text(),
}, (table) => [
  index('idx_analytics_events_type_created').on(table.eventType, table.createdAt),
  index('idx_analytics_events_session_created').on(table.sessionId, table.createdAt),
  index('idx_analytics_events_session_type').on(table.sessionId, table.eventType),
  index('idx_analytics_events_user_type_created').on(table.userId, table.eventType, table.createdAt),
  index('idx_analytics_events_model_created').on(table.model, table.createdAt),
]);
```

- [ ] **Step 2: Update schema barrel export**

In `packages/worker/src/lib/schema/index.ts`, replace line 19:
```
export * from './usage.js';
```
with:
```
export * from './analytics.js';
```

- [ ] **Step 3: Delete the old usage schema**

Delete `packages/worker/src/lib/schema/usage.ts`.

- [ ] **Step 4: Typecheck**

Run: `cd /Users/conner/code/valet/packages/worker && pnpm typecheck`

This will fail — `usage.ts` exports are referenced in `db/usage.ts` and the usage route. That's expected; we fix those in the next tasks.

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/lib/schema/analytics.ts packages/worker/src/lib/schema/index.ts
git rm packages/worker/src/lib/schema/usage.ts
git commit -m "feat: add analyticsEvents Drizzle schema, remove usage schema"
```

---

### Task 3: DB Query Helpers — `analytics.ts`

**Files:**
- Create: `packages/worker/src/lib/db/analytics.ts`
- Modify: `packages/worker/src/lib/db.ts:30` (replace usage re-export)
- Modify: `packages/worker/src/lib/db/usage.ts` (delete file)

- [ ] **Step 1: Create analytics DB helpers**

Create `packages/worker/src/lib/db/analytics.ts`:

```typescript
import type { D1Database } from '@cloudflare/workers-types';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface AnalyticsEventInsert {
  id: string;
  eventType: string;
  sessionId: string;
  userId?: string;
  turnId?: string;
  durationMs?: number;
  channel?: string;
  model?: string;
  queueMode?: string;
  inputTokens?: number;
  outputTokens?: number;
  toolName?: string;
  errorCode?: string;
  summary?: string;
  actorId?: string;
  properties?: string; // JSON string
  createdAt?: number;  // unix epoch from local SQLite
}

// ─── Batch Insert (DO flush → D1) ──────────────────────────────────────────

export async function batchInsertAnalyticsEvents(
  db: D1Database,
  sessionId: string,
  userId: string | null,
  entries: AnalyticsEventInsert[],
): Promise<void> {
  if (entries.length === 0) return;

  const stmts = entries.map((e) =>
    db.prepare(
      `INSERT OR IGNORE INTO analytics_events
        (id, event_type, session_id, user_id, turn_id, duration_ms, channel, model, queue_mode,
         input_tokens, output_tokens, tool_name, error_code, summary, actor_id, properties, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime(?, 'unixepoch'))`
    ).bind(
      e.id,
      e.eventType,
      sessionId,
      e.userId ?? userId,
      e.turnId ?? null,
      e.durationMs ?? null,
      e.channel ?? null,
      e.model ?? null,
      e.queueMode ?? null,
      e.inputTokens ?? null,
      e.outputTokens ?? null,
      e.toolName ?? null,
      e.errorCode ?? null,
      e.summary ?? null,
      e.actorId ?? null,
      e.properties ?? null,
      e.createdAt ?? Math.floor(Date.now() / 1000),
    )
  );

  await db.batch(stmts);
}

// ─── Billing Queries (replaces usage.ts) ────────────────────────────────────

export interface UsageHeroStats {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalSessions: number;
  totalUsers: number;
}

export async function getUsageHeroStats(
  db: D1Database,
  periodStart: string,
): Promise<UsageHeroStats> {
  const row = await db
    .prepare(`
      SELECT
        COALESCE(SUM(ae.input_tokens), 0) as total_input_tokens,
        COALESCE(SUM(ae.output_tokens), 0) as total_output_tokens,
        COUNT(DISTINCT ae.session_id) as total_sessions,
        COUNT(DISTINCT ae.user_id) as total_users
      FROM analytics_events ae
      WHERE ae.event_type = 'llm_call'
        AND ae.created_at >= ?
    `)
    .bind(periodStart)
    .first<{
      total_input_tokens: number;
      total_output_tokens: number;
      total_sessions: number;
      total_users: number;
    }>();

  return {
    totalInputTokens: row?.total_input_tokens ?? 0,
    totalOutputTokens: row?.total_output_tokens ?? 0,
    totalSessions: row?.total_sessions ?? 0,
    totalUsers: row?.total_users ?? 0,
  };
}

export interface UsageByDayRow {
  date: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export async function getUsageByDay(
  db: D1Database,
  periodStart: string,
): Promise<UsageByDayRow[]> {
  const result = await db
    .prepare(`
      SELECT
        date(ae.created_at) as date,
        ae.model,
        SUM(ae.input_tokens) as input_tokens,
        SUM(ae.output_tokens) as output_tokens
      FROM analytics_events ae
      WHERE ae.event_type = 'llm_call'
        AND ae.created_at >= ?
      GROUP BY date(ae.created_at), ae.model
      ORDER BY date ASC
    `)
    .bind(periodStart)
    .all();

  return (result.results ?? []).map((r: Record<string, unknown>) => ({
    date: String(r.date),
    model: String(r.model),
    inputTokens: Number(r.input_tokens),
    outputTokens: Number(r.output_tokens),
  }));
}

export interface UsageByUserRow {
  userId: string;
  email: string;
  name: string | null;
  inputTokens: number;
  outputTokens: number;
  sessionCount: number;
}

export async function getUsageByUser(
  db: D1Database,
  periodStart: string,
): Promise<UsageByUserRow[]> {
  const result = await db
    .prepare(`
      SELECT
        ae.user_id,
        u.email,
        u.name,
        SUM(ae.input_tokens) as input_tokens,
        SUM(ae.output_tokens) as output_tokens,
        COUNT(DISTINCT ae.session_id) as session_count
      FROM analytics_events ae
      LEFT JOIN users u ON u.id = ae.user_id
      WHERE ae.event_type = 'llm_call'
        AND ae.created_at >= ?
        AND ae.user_id IS NOT NULL
      GROUP BY ae.user_id
      ORDER BY (SUM(ae.input_tokens) + SUM(ae.output_tokens)) DESC
    `)
    .bind(periodStart)
    .all();

  return (result.results ?? []).map((r: Record<string, unknown>) => ({
    userId: String(r.user_id),
    email: r.email ? String(r.email) : 'Unknown',
    name: r.name ? String(r.name) : null,
    inputTokens: Number(r.input_tokens),
    outputTokens: Number(r.output_tokens),
    sessionCount: Number(r.session_count),
  }));
}

export interface UsageByUserModelRow {
  userId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export async function getUsageByUserModel(
  db: D1Database,
  periodStart: string,
): Promise<UsageByUserModelRow[]> {
  const result = await db
    .prepare(`
      SELECT
        ae.user_id,
        ae.model,
        SUM(ae.input_tokens) as input_tokens,
        SUM(ae.output_tokens) as output_tokens
      FROM analytics_events ae
      WHERE ae.event_type = 'llm_call'
        AND ae.created_at >= ?
        AND ae.user_id IS NOT NULL
      GROUP BY ae.user_id, ae.model
    `)
    .bind(periodStart)
    .all();

  return (result.results ?? []).map((r: Record<string, unknown>) => ({
    userId: String(r.user_id),
    model: String(r.model),
    inputTokens: Number(r.input_tokens),
    outputTokens: Number(r.output_tokens),
  }));
}

export interface UsageByModelRow {
  model: string;
  inputTokens: number;
  outputTokens: number;
  callCount: number;
}

export async function getUsageByModel(
  db: D1Database,
  periodStart: string,
): Promise<UsageByModelRow[]> {
  const result = await db
    .prepare(`
      SELECT
        model,
        SUM(input_tokens) as input_tokens,
        SUM(output_tokens) as output_tokens,
        COUNT(*) as call_count
      FROM analytics_events
      WHERE event_type = 'llm_call'
        AND created_at >= ?
      GROUP BY model
      ORDER BY (SUM(input_tokens) + SUM(output_tokens)) DESC
    `)
    .bind(periodStart)
    .all();

  return (result.results ?? []).map((r: Record<string, unknown>) => ({
    model: String(r.model),
    inputTokens: Number(r.input_tokens),
    outputTokens: Number(r.output_tokens),
    callCount: Number(r.call_count),
  }));
}

// ─── Sandbox Usage Queries (unchanged — reads from sessions table) ─────────

export interface SandboxHeroStats {
  totalActiveSeconds: number;
}

export async function getSandboxHeroStats(
  db: D1Database,
  periodStart: string,
): Promise<SandboxHeroStats> {
  const row = await db
    .prepare(`
      SELECT COALESCE(SUM(active_seconds), 0) as total_active_seconds
      FROM sessions
      WHERE created_at >= ?
    `)
    .bind(periodStart)
    .first<{ total_active_seconds: number }>();

  return {
    totalActiveSeconds: row?.total_active_seconds ?? 0,
  };
}

export interface SandboxByDayRow {
  date: string;
  activeSeconds: number;
}

export async function getSandboxByDay(
  db: D1Database,
  periodStart: string,
): Promise<SandboxByDayRow[]> {
  const result = await db
    .prepare(`
      SELECT
        date(created_at) as date,
        SUM(active_seconds) as active_seconds
      FROM sessions
      WHERE created_at >= ?
      GROUP BY date(created_at)
      ORDER BY date ASC
    `)
    .bind(periodStart)
    .all();

  return (result.results ?? []).map((r: Record<string, unknown>) => ({
    date: String(r.date),
    activeSeconds: Number(r.active_seconds),
  }));
}

export interface SandboxByUserRow {
  userId: string;
  activeSeconds: number;
  sandboxCpuCores: number | null;
  sandboxMemoryMib: number | null;
}

export async function getSandboxByUser(
  db: D1Database,
  periodStart: string,
): Promise<SandboxByUserRow[]> {
  const result = await db
    .prepare(`
      SELECT
        s.user_id,
        SUM(s.active_seconds) as active_seconds,
        u.sandbox_cpu_cores,
        u.sandbox_memory_mib
      FROM sessions s
      LEFT JOIN users u ON u.id = s.user_id
      WHERE s.created_at >= ?
        AND s.user_id IS NOT NULL
      GROUP BY s.user_id
    `)
    .bind(periodStart)
    .all();

  return (result.results ?? []).map((r: Record<string, unknown>) => ({
    userId: String(r.user_id),
    activeSeconds: Number(r.active_seconds),
    sandboxCpuCores: r.sandbox_cpu_cores != null ? Number(r.sandbox_cpu_cores) : null,
    sandboxMemoryMib: r.sandbox_memory_mib != null ? Number(r.sandbox_memory_mib) : null,
  }));
}

// ─── Performance Queries ────────────────────────────────────────────────────

export interface PerfPercentile {
  p50: number | null;
  p95: number | null;
  count: number;
}

/**
 * Compute P50 and P95 for a given event type's duration_ms using SQL OFFSET.
 * Returns null percentiles if no data.
 */
export async function getPercentiles(
  db: D1Database,
  eventType: string,
  periodStart: string,
): Promise<PerfPercentile> {
  const countRow = await db
    .prepare(`
      SELECT COUNT(*) as cnt
      FROM analytics_events
      WHERE event_type = ? AND created_at >= ? AND duration_ms IS NOT NULL
    `)
    .bind(eventType, periodStart)
    .first<{ cnt: number }>();

  const count = countRow?.cnt ?? 0;
  if (count === 0) return { p50: null, p95: null, count: 0 };

  const p50Offset = Math.floor(count * 0.5);
  const p95Offset = Math.floor(count * 0.95);

  const [p50Row, p95Row] = await Promise.all([
    db.prepare(`
      SELECT duration_ms FROM analytics_events
      WHERE event_type = ? AND created_at >= ? AND duration_ms IS NOT NULL
      ORDER BY duration_ms
      LIMIT 1 OFFSET ?
    `).bind(eventType, periodStart, p50Offset).first<{ duration_ms: number }>(),
    db.prepare(`
      SELECT duration_ms FROM analytics_events
      WHERE event_type = ? AND created_at >= ? AND duration_ms IS NOT NULL
      ORDER BY duration_ms
      LIMIT 1 OFFSET ?
    `).bind(eventType, periodStart, p95Offset).first<{ duration_ms: number }>(),
  ]);

  return {
    p50: p50Row?.duration_ms ?? null,
    p95: p95Row?.duration_ms ?? null,
    count,
  };
}

export interface PerfTrendRow {
  date: string;
  p50: number | null;
  p95: number | null;
  count: number;
}

/**
 * Daily P50/P95 for a given event type. Uses a subquery approach to get
 * approximate percentiles per day.
 */
export async function getPerfTrend(
  db: D1Database,
  eventType: string,
  periodStart: string,
): Promise<PerfTrendRow[]> {
  // Get daily data with sorted durations — compute percentiles in JS per day
  // since SQLite OFFSET-per-group is unwieldy. Bound to period so data is manageable.
  const result = await db
    .prepare(`
      SELECT
        date(created_at) as date,
        duration_ms
      FROM analytics_events
      WHERE event_type = ? AND created_at >= ? AND duration_ms IS NOT NULL
      ORDER BY date(created_at), duration_ms
    `)
    .bind(eventType, periodStart)
    .all();

  const rows = result.results ?? [];
  const byDay = new Map<string, number[]>();
  for (const r of rows) {
    const date = String(r.date);
    const arr = byDay.get(date) ?? [];
    arr.push(Number(r.duration_ms));
    byDay.set(date, arr);
  }

  return Array.from(byDay.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, durations]) => ({
      date,
      p50: durations[Math.floor(durations.length * 0.5)] ?? null,
      p95: durations[Math.floor(durations.length * 0.95)] ?? null,
      count: durations.length,
    }));
}

export interface StageBreakdownRow {
  eventType: string;
  count: number;
  p50: number | null;
  p95: number | null;
}

/**
 * Stage breakdown: P50/P95 duration for each perf event type.
 */
export async function getStageBreakdown(
  db: D1Database,
  periodStart: string,
): Promise<StageBreakdownRow[]> {
  const stageTypes = [
    'queue_wait', 'sandbox_wake', 'sandbox_restore',
    'llm_response', 'tool_exec', 'runner_connect',
  ];

  const results = await Promise.all(
    stageTypes.map(async (eventType) => {
      const p = await getPercentiles(db, eventType, periodStart);
      return { eventType, ...p };
    })
  );

  return results.filter((r) => r.count > 0);
}

/**
 * Error rate: count of turn_error / count of turn_complete.
 */
export async function getErrorRate(
  db: D1Database,
  periodStart: string,
): Promise<{ errors: number; turns: number; rate: number }> {
  const row = await db
    .prepare(`
      SELECT
        SUM(CASE WHEN event_type = 'turn_error' THEN 1 ELSE 0 END) as errors,
        SUM(CASE WHEN event_type = 'turn_complete' THEN 1 ELSE 0 END) as turns
      FROM analytics_events
      WHERE event_type IN ('turn_error', 'turn_complete')
        AND created_at >= ?
    `)
    .bind(periodStart)
    .first<{ errors: number; turns: number }>();

  const errors = row?.errors ?? 0;
  const turns = row?.turns ?? 0;
  return { errors, turns, rate: turns > 0 ? errors / turns : 0 };
}

// ─── Events Feed Query ──────────────────────────────────────────────────────

export interface EventFeedRow {
  id: string;
  eventType: string;
  sessionId: string;
  userId: string | null;
  turnId: string | null;
  durationMs: number | null;
  channel: string | null;
  model: string | null;
  summary: string | null;
  properties: string | null;
  createdAt: string;
}

export async function getEventFeed(
  db: D1Database,
  periodStart: string,
  options: { typePrefix?: string; limit?: number; offset?: number },
): Promise<EventFeedRow[]> {
  const limit = Math.min(options.limit ?? 50, 200);
  const offset = options.offset ?? 0;

  let query: string;
  const binds: unknown[] = [];

  if (options.typePrefix) {
    query = `
      SELECT id, event_type, session_id, user_id, turn_id, duration_ms,
             channel, model, summary, properties, created_at
      FROM analytics_events
      WHERE created_at >= ? AND event_type LIKE ?
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `;
    binds.push(periodStart, `${options.typePrefix}%`, limit, offset);
  } else {
    query = `
      SELECT id, event_type, session_id, user_id, turn_id, duration_ms,
             channel, model, summary, properties, created_at
      FROM analytics_events
      WHERE created_at >= ?
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `;
    binds.push(periodStart, limit, offset);
  }

  const result = await db.prepare(query).bind(...binds).all();

  return (result.results ?? []).map((r: Record<string, unknown>) => ({
    id: String(r.id),
    eventType: String(r.event_type),
    sessionId: String(r.session_id),
    userId: r.user_id ? String(r.user_id) : null,
    turnId: r.turn_id ? String(r.turn_id) : null,
    durationMs: r.duration_ms != null ? Number(r.duration_ms) : null,
    channel: r.channel ? String(r.channel) : null,
    model: r.model ? String(r.model) : null,
    summary: r.summary ? String(r.summary) : null,
    properties: r.properties ? String(r.properties) : null,
    createdAt: String(r.created_at),
  }));
}

/**
 * Slow paths: group turn_complete by dimension and compute percentiles.
 */
export async function getSlowPaths(
  db: D1Database,
  periodStart: string,
  dimension: 'channel' | 'model' | 'queue_mode',
): Promise<Array<{ value: string; count: number; p50: number | null; p95: number | null }>> {
  const col = dimension === 'queue_mode' ? 'queue_mode' : dimension;

  const result = await db
    .prepare(`
      SELECT ${col} as dim_value, duration_ms
      FROM analytics_events
      WHERE event_type = 'turn_complete'
        AND created_at >= ?
        AND duration_ms IS NOT NULL
        AND ${col} IS NOT NULL
      ORDER BY ${col}, duration_ms
    `)
    .bind(periodStart)
    .all();

  const rows = result.results ?? [];
  const byGroup = new Map<string, number[]>();
  for (const r of rows) {
    const key = String(r.dim_value);
    const arr = byGroup.get(key) ?? [];
    arr.push(Number(r.duration_ms));
    byGroup.set(key, arr);
  }

  return Array.from(byGroup.entries()).map(([value, durations]) => ({
    value,
    count: durations.length,
    p50: durations[Math.floor(durations.length * 0.5)] ?? null,
    p95: durations[Math.floor(durations.length * 0.95)] ?? null,
  }));
}
```

- [ ] **Step 2: Update barrel export**

In `packages/worker/src/lib/db.ts`, replace line 30:
```
export * from './db/usage.js';
```
with:
```
export * from './db/analytics.js';
```

- [ ] **Step 3: Delete old usage DB helpers**

Delete `packages/worker/src/lib/db/usage.ts`.

- [ ] **Step 4: Commit**

```bash
git add packages/worker/src/lib/db/analytics.ts packages/worker/src/lib/db.ts
git rm packages/worker/src/lib/db/usage.ts
git commit -m "feat: add analytics DB helpers replacing usage queries"
```

---

### Task 4: Update Usage Route to Use New Queries

**Files:**
- Modify: `packages/worker/src/routes/usage.ts:4` (update imports)

- [ ] **Step 1: Update the imports**

In `packages/worker/src/routes/usage.ts`, replace line 4:
```typescript
import { getUsageHeroStats, getUsageByDay, getUsageByUser, getUsageByModel, getUsageByUserModel, getSandboxHeroStats, getSandboxByDay, getSandboxByUser } from '../lib/db/usage.js';
```
with:
```typescript
import { getUsageHeroStats, getUsageByDay, getUsageByUser, getUsageByModel, getUsageByUserModel, getSandboxHeroStats, getSandboxByDay, getSandboxByUser } from '../lib/db/analytics.js';
```

- [ ] **Step 2: Typecheck**

Run: `cd /Users/conner/code/valet/packages/worker && pnpm typecheck`

Should pass — the function signatures are identical.

- [ ] **Step 3: Commit**

```bash
git add packages/worker/src/routes/usage.ts
git commit -m "refactor: point usage route at analytics DB helpers"
```

---

### Task 5: SessionAgentDO — Replace Local Tables and Add Emitter

**Files:**
- Modify: `packages/worker/src/durable-objects/session-agent.ts`
  - Lines 541-577: Replace `audit_log` + `usage_events` local tables with `analytics_events`
  - Lines 8322-8344: Replace `appendAuditLog` with `emitAuditEvent`
  - Lines 8241-8320: Rewrite `flushMetrics` for single flush path
  - Lines 2317-2335: Update `usage-report` handler
  - Line 4: Update imports (remove `batchInsertAuditLog`, `batchInsertUsageEvents`; add `batchInsertAnalyticsEvents`)
  - Line 6308: Update `DELETE FROM audit_log` to `DELETE FROM analytics_events`

- [ ] **Step 1: Replace local SQLite table definitions**

In `session-agent.ts`, replace lines 541-577 (the `audit_log` and `usage_events` CREATE TABLE statements):

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

- [ ] **Step 2: Add `emitEvent` and `emitAuditEvent` methods**

Replace the `appendAuditLog` method (lines 8322-8344) with:

```typescript
  /**
   * Emit a core analytics event to local SQLite. Fire-and-forget, never throws.
   */
  private emitEvent(
    eventType: string,
    fields?: {
      turnId?: string;
      durationMs?: number;
      channel?: string;
      model?: string;
      queueMode?: string;
      inputTokens?: number;
      outputTokens?: number;
      toolName?: string;
      errorCode?: string;
      summary?: string;
      actorId?: string;
      properties?: Record<string, unknown>;
    },
  ): void {
    try {
      this.ctx.storage.sql.exec(
        `INSERT INTO analytics_events
          (event_type, turn_id, duration_ms, channel, model, queue_mode,
           input_tokens, output_tokens, tool_name, error_code, summary, actor_id, properties)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        eventType,
        fields?.turnId ?? null,
        fields?.durationMs ?? null,
        fields?.channel ?? null,
        fields?.model ?? null,
        fields?.queueMode ?? null,
        fields?.inputTokens ?? null,
        fields?.outputTokens ?? null,
        fields?.toolName ?? null,
        fields?.errorCode ?? null,
        fields?.summary ?? null,
        fields?.actorId ?? null,
        fields?.properties ? JSON.stringify(fields.properties) : null,
      );
    } catch (err) {
      console.error('[SessionAgentDO] Failed to emit analytics event:', err);
    }
  }

  /**
   * Emit an audit event — writes to local SQLite AND broadcasts to connected clients.
   * Drop-in replacement for the old appendAuditLog method.
   */
  private emitAuditEvent(
    eventType: string,
    summary: string,
    actorId?: string,
    metadata?: Record<string, unknown>,
  ): void {
    this.emitEvent(eventType, {
      summary,
      actorId,
      properties: metadata,
    });
    // Broadcast to connected clients in real-time
    this.broadcastToClients({
      type: 'audit_log',
      entry: {
        eventType,
        summary,
        actorId: actorId || null,
        metadata: metadata || null,
        createdAt: new Date().toISOString(),
      },
    });
  }
```

- [ ] **Step 3: Rename all `appendAuditLog` calls to `emitAuditEvent`**

Global find-and-replace within `session-agent.ts`:
- `this.appendAuditLog(` → `this.emitAuditEvent(`

There are approximately 30 call sites. The method signature is identical (eventType, summary, actorId?, metadata?), so this is a safe rename.

- [ ] **Step 4: Update `usage-report` handler**

Replace lines 2317-2335 (the `case 'usage-report'` handler):

```typescript
      case 'usage-report': {
        const entries = msg.entries;
        if (Array.isArray(entries)) {
          for (const entry of entries) {
            this.emitEvent('llm_call', {
              turnId: msg.turnId,
              model: entry.model ?? 'unknown',
              inputTokens: entry.inputTokens ?? 0,
              outputTokens: entry.outputTokens ?? 0,
              properties: { oc_message_id: entry.ocMessageId },
            });
          }
        }
        break;
      }
```

- [ ] **Step 5: Rewrite `flushMetrics` for single flush path**

Replace the `flushMetrics` method (lines 8241-8320) with:

```typescript
  private async flushMetrics(): Promise<void> {
    const sessionId = this.getStateValue('sessionId');
    if (!sessionId) return;

    try {
      // Count messages and tool calls for session-level denormalized counters
      const msgCount = this.ctx.storage.sql
        .exec('SELECT COUNT(*) as cnt FROM messages')
        .toArray()[0]?.cnt as number ?? 0;
      const toolCount = this.ctx.storage.sql
        .exec("SELECT COUNT(*) as cnt FROM messages WHERE role = 'tool'")
        .toArray()[0]?.cnt as number ?? 0;
      const lastMsg = this.ctx.storage.sql
        .exec('SELECT MAX(created_at) as ts FROM messages')
        .toArray()[0]?.ts as number | null;

      await updateSessionMetrics(this.env.DB, sessionId, msgCount, toolCount, lastMsg ? new Date(lastMsg * 1000).toISOString() : null);

      // Flush active seconds if currently running
      const status = this.getStateValue('status');
      if (status === 'running') {
        await this.flushActiveSeconds();
      }

      // Flush unflushed analytics events to D1
      const unflushed = this.ctx.storage.sql
        .exec('SELECT id, event_type, turn_id, duration_ms, channel, model, queue_mode, input_tokens, output_tokens, tool_name, error_code, summary, actor_id, properties, created_at FROM analytics_events WHERE flushed = 0 ORDER BY id ASC LIMIT 100')
        .toArray();

      if (unflushed.length > 0) {
        const userId = this.getStateValue('userId') || null;
        try {
          await batchInsertAnalyticsEvents(this.env.DB, sessionId, userId, unflushed.map((row) => ({
            id: `${sessionId}:${row.id as number}`,
            eventType: row.event_type as string,
            turnId: row.turn_id as string | undefined,
            durationMs: row.duration_ms as number | undefined,
            channel: row.channel as string | undefined,
            model: row.model as string | undefined,
            queueMode: row.queue_mode as string | undefined,
            inputTokens: row.input_tokens as number | undefined,
            outputTokens: row.output_tokens as number | undefined,
            toolName: row.tool_name as string | undefined,
            errorCode: row.error_code as string | undefined,
            summary: row.summary as string | undefined,
            actorId: row.actor_id as string | undefined,
            properties: row.properties as string | undefined,
            createdAt: row.created_at as number,
          })));
          const flushedIds = unflushed.map((r) => r.id as number);
          const placeholders = flushedIds.map(() => '?').join(',');
          this.ctx.storage.sql.exec(
            `UPDATE analytics_events SET flushed = 1 WHERE id IN (${placeholders})`,
            ...flushedIds,
          );
        } catch (flushErr) {
          console.error('[SessionAgentDO] Failed to flush analytics events to D1:', flushErr);
        }
      }
    } catch (err) {
      console.error('[SessionAgentDO] flushMetrics failed:', err);
    }
  }
```

- [ ] **Step 6: Update session reset to clear the new table**

Replace the line `this.ctx.storage.sql.exec('DELETE FROM audit_log');` (line 6308) with:
```typescript
this.ctx.storage.sql.exec('DELETE FROM analytics_events');
```

- [ ] **Step 7: Update imports**

At line 4 in `session-agent.ts`, update the import from `'../lib/db.js'`:
- Remove: `batchInsertAuditLog`, `batchInsertUsageEvents`
- Add: `batchInsertAnalyticsEvents`

- [ ] **Step 8: Update the audit log loading for late joiners**

Find line 1033 where audit log is loaded for WebSocket init. Replace the query:
```typescript
.exec('SELECT event_type, summary, actor_id, metadata, created_at FROM audit_log ORDER BY id ASC')
```
with:
```typescript
.exec("SELECT event_type, summary, actor_id, properties as metadata, created_at FROM analytics_events WHERE summary IS NOT NULL ORDER BY id ASC")
```

- [ ] **Step 9: Typecheck**

Run: `cd /Users/conner/code/valet/packages/worker && pnpm typecheck`

- [ ] **Step 10: Commit**

```bash
git add packages/worker/src/durable-objects/session-agent.ts
git commit -m "feat: replace audit_log + usage_events with unified analytics_events in SessionAgentDO"
```

---

### Task 6: Shared Types for Analytics Responses

**Files:**
- Modify: `packages/shared/src/types/index.ts:989-1029` (add new types alongside existing UsageStatsResponse)

- [ ] **Step 1: Add analytics response types**

After the `UsageStatsResponse` type (around line 1029), add:

```typescript
// ─── Analytics Performance Types ─────────────────────────────────────────────

export interface AnalyticsPerformanceResponse {
  hero: {
    turnLatencyP50: number | null;
    turnLatencyP95: number | null;
    queueWaitP50: number | null;
    sandboxWakeP50: number | null;
    errorRate: number;
    turnCount: number;
    errorCount: number;
  };
  trend: Array<{
    date: string;
    p50: number | null;
    p95: number | null;
    count: number;
  }>;
  stages: Array<{
    eventType: string;
    count: number;
    p50: number | null;
    p95: number | null;
  }>;
  slowPaths: Array<{
    dimension: string;
    value: string;
    count: number;
    p50: number | null;
    p95: number | null;
  }>;
  period: number;
}

export interface AnalyticsEventsResponse {
  events: Array<{
    id: string;
    eventType: string;
    sessionId: string;
    userId: string | null;
    turnId: string | null;
    durationMs: number | null;
    channel: string | null;
    model: string | null;
    summary: string | null;
    properties: Record<string, unknown> | null;
    createdAt: string;
  }>;
  total: number;
  period: number;
}
```

- [ ] **Step 2: Typecheck**

Run: `cd /Users/conner/code/valet/packages/shared && pnpm typecheck`

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/types/index.ts
git commit -m "feat: add AnalyticsPerformanceResponse and AnalyticsEventsResponse types"
```

---

## Chunk 2: Performance Instrumentation & Runner Protocol

### Task 7: Add Timing Instrumentation to SessionAgentDO

**Files:**
- Modify: `packages/worker/src/durable-objects/session-agent.ts`

This task adds `emitEvent` calls at core lifecycle points. Each instrumentation point uses timestamp markers stored as DO state values.

- [ ] **Step 1: Add timing markers and perf events**

Add these instrumentations throughout `session-agent.ts`:

**a) Queue wait timing** — in the prompt dispatch path, when a prompt is dequeued and dispatched:

Find where prompts transition from queued → processing. When a prompt is received (search for `'prompt.queued'` audit events near line 1917), record `promptReceivedAt`:
```typescript
this.setStateValue('promptReceivedAt', String(Date.now()));
```

When the prompt is dispatched to the runner (the point where it leaves the queue), emit:
```typescript
const queuedAt = parseInt(this.getStateValue('promptReceivedAt') || '0', 10);
if (queuedAt > 0) {
  this.emitEvent('queue_wait', {
    durationMs: Date.now() - queuedAt,
    channel: channelType || undefined,
    queueMode: queueType || undefined,
  });
}
```

**b) Sandbox wake timing** — in `dispatchSandbox()`:

Before the sandbox dispatch call, record start time. After completion, emit:
```typescript
this.emitEvent('sandbox_wake', { durationMs: elapsed });
```

**c) Sandbox restore timing** — in the restore-from-hibernation path (near line 7781):

Wrap the restore call with timing:
```typescript
this.emitEvent('sandbox_restore', {
  durationMs: elapsed,
  properties: { snapshot_id: snapshotImageId },
});
```

**d) Turn complete timing** — in `handlePromptComplete()` (line 6235):

Compute duration from `promptReceivedAt`:
```typescript
const promptStart = parseInt(this.getStateValue('promptReceivedAt') || '0', 10);
if (promptStart > 0) {
  this.emitEvent('turn_complete', {
    durationMs: Date.now() - promptStart,
    channel: this.activeChannel?.channelType || undefined,
    model: this.getStateValue('currentModel') || undefined,
  });
  this.setStateValue('promptReceivedAt', '');
}
```

**e) Turn error** — in error paths (near the `agent.error` audit events):

```typescript
this.emitEvent('turn_error', {
  errorCode: 'runner_error',
  properties: { stage: 'dispatch', message: errorText.slice(0, 200) },
});
```

**f) Runner connect timing** — when runner WebSocket connects:

Record time when sandbox starts, emit when runner sends first message:
```typescript
this.emitEvent('runner_connect', { durationMs: elapsed });
```

- [ ] **Step 2: Typecheck**

Run: `cd /Users/conner/code/valet/packages/worker && pnpm typecheck`

- [ ] **Step 3: Commit**

```bash
git add packages/worker/src/durable-objects/session-agent.ts
git commit -m "feat: add core performance instrumentation to SessionAgentDO"
```

---

### Task 8: Runner `analytics:emit` Protocol and `llm_response` Event

**Files:**
- Modify: `packages/runner/src/types.ts:148-246` (add `analytics:emit` to RunnerToDOMessage)
- Modify: `packages/runner/src/agent-client.ts` (emit `llm_response` events)
- Modify: `packages/worker/src/durable-objects/session-agent.ts` (handle `analytics:emit` message)

- [ ] **Step 1: Add `analytics:emit` message type to Runner → DO protocol**

In `packages/runner/src/types.ts`, add to the `RunnerToDOMessage` union (after line 236):

```typescript
  | {
      type: 'analytics:emit';
      events: Array<{
        eventType: string;
        durationMs?: number;
        properties?: Record<string, unknown>;
      }>;
    }
```

- [ ] **Step 2: Emit `llm_response` events from the Runner**

In `packages/runner/src/agent-client.ts`, find where the Runner receives completion/usage data from OpenCode and sends the `usage-report` message. Add timing around the OpenCode prompt submission:

Before sending the prompt to OpenCode, record `const promptSentAt = Date.now();`. When the response comes back (completion or usage report), emit:

```typescript
this.send({
  type: 'analytics:emit',
  events: [{
    eventType: 'llm_response',
    durationMs: Date.now() - promptSentAt,
    properties: {
      model: entry.model,
      input_tokens: entry.inputTokens,
      output_tokens: entry.outputTokens,
    },
  }],
});
```

- [ ] **Step 3: Handle `analytics:emit` in SessionAgentDO**

In `session-agent.ts`, in the `handleRunnerMessage` switch statement, add a case:

```typescript
      case 'analytics:emit': {
        const events = (msg as any).events;
        if (Array.isArray(events)) {
          for (const event of events) {
            this.emitEvent(event.eventType, {
              durationMs: event.durationMs,
              properties: event.properties,
            });
          }
        }
        break;
      }
```

- [ ] **Step 4: Typecheck both packages**

Run: `cd /Users/conner/code/valet/packages/runner && pnpm typecheck`
Run: `cd /Users/conner/code/valet/packages/worker && pnpm typecheck`

- [ ] **Step 5: Commit**

```bash
git add packages/runner/src/types.ts packages/runner/src/agent-client.ts packages/worker/src/durable-objects/session-agent.ts
git commit -m "feat: add analytics:emit WebSocket protocol and llm_response event"
```

---

### Task 9: SDK Analytics Interface

**Files:**
- Create: `packages/sdk/src/analytics/index.ts`
- Modify: `packages/sdk/package.json` (add `./analytics` export)

- [ ] **Step 1: Create the Analytics interface**

Create `packages/sdk/src/analytics/index.ts`:

```typescript
/**
 * Analytics interface for plugins to emit custom events.
 *
 * Events are fire-and-forget — emit() never throws or blocks.
 * The system automatically injects session_id, user_id, turn_id,
 * channel, and created_at. Plugins only specify what they uniquely know.
 *
 * Convention: namespace event types as `{plugin}.{event}`:
 *   analytics.emit('github.pr_created', { durationMs: 340 })
 *   analytics.emit('slack.message_sent', { properties: { channel: '#general' } })
 */
export interface Analytics {
  emit(eventType: string, data?: {
    durationMs?: number;
    properties?: Record<string, unknown>;
  }): void;
}

/**
 * No-op analytics implementation for contexts where analytics is not available.
 */
export const noopAnalytics: Analytics = {
  emit() {},
};
```

- [ ] **Step 2: Add export to SDK package.json**

In `packages/sdk/package.json`, add to the `exports` field:
```json
"./analytics": {
  "import": "./src/analytics/index.ts",
  "types": "./src/analytics/index.ts"
}
```

- [ ] **Step 3: Commit**

```bash
git add packages/sdk/src/analytics/index.ts packages/sdk/package.json
git commit -m "feat: add Analytics SDK interface for plugin event emission"
```

---

### Task 10: Inject Analytics into Action Execution Context

**Files:**
- Modify: `packages/sdk/src/integrations/index.ts:38-44` (add `analytics` to ActionContext)
- Modify: `packages/worker/src/durable-objects/session-agent.ts` (pass analytics to executeAction)

- [ ] **Step 1: Add `analytics` to ActionContext**

In `packages/sdk/src/integrations/index.ts`, add to the `ActionContext` interface (line 38):

```typescript
import type { Analytics } from '../analytics/index.js';
```

And add the field to `ActionContext`:
```typescript
export interface ActionContext {
  credentials: IntegrationCredentials;
  userId: string;
  orgId?: string;
  callerIdentity?: CallerIdentity;
  analytics?: Analytics;
}
```

Optional (`analytics?`) so existing plugins don't break.

- [ ] **Step 2: Create analytics collector in executeAction**

In `session-agent.ts`, in the `executeAction` method (line 9109), before the `actionSource.execute` call (line 9177), create a collecting analytics instance:

```typescript
    // Create analytics collector for this action execution
    const collectedEvents: Array<{ eventType: string; durationMs?: number; properties?: Record<string, unknown> }> = [];
    const actionAnalytics = {
      emit: (eventType: string, data?: { durationMs?: number; properties?: Record<string, unknown> }) => {
        collectedEvents.push({ eventType, ...data });
      },
    };
```

Pass it to the execute call:
```typescript
    let actionResult = await actionSource.execute(actionId, params, { credentials, userId, callerIdentity, analytics: actionAnalytics });
```

After execution, flush collected events:
```typescript
    // Flush plugin analytics events
    for (const event of collectedEvents) {
      this.emitEvent(event.eventType, {
        durationMs: event.durationMs,
        properties: event.properties,
      });
    }
```

- [ ] **Step 3: Typecheck**

Run: `cd /Users/conner/code/valet && pnpm typecheck`

- [ ] **Step 4: Commit**

```bash
git add packages/sdk/src/integrations/index.ts packages/worker/src/durable-objects/session-agent.ts
git commit -m "feat: inject Analytics into plugin action execution context"
```

---

## Chunk 3: API Endpoints and Dashboard UI

### Task 11: Analytics API Endpoints

**Files:**
- Create: `packages/worker/src/routes/analytics.ts`
- Modify: `packages/worker/src/index.ts` (mount new router)

- [ ] **Step 1: Create the analytics router**

Create `packages/worker/src/routes/analytics.ts`:

```typescript
import { Hono } from 'hono';
import type { Env, Variables } from '../env.js';
import type { AnalyticsPerformanceResponse, AnalyticsEventsResponse } from '@valet/shared';
import {
  getPercentiles,
  getPerfTrend,
  getStageBreakdown,
  getErrorRate,
  getSlowPaths,
  getEventFeed,
} from '../lib/db/analytics.js';

export const analyticsRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

// GET /api/analytics/performance?period=720
analyticsRouter.get('/performance', async (c) => {
  const user = c.get('user');
  if (!user || user.role !== 'admin') {
    return c.json({ error: 'Admin access required', code: 'FORBIDDEN' }, 403);
  }

  const rawPeriod = parseInt(c.req.query('period') || '720', 10);
  const periodHours = Number.isFinite(rawPeriod) ? Math.min(Math.max(rawPeriod, 1), 8760) : 720;
  const periodStart = new Date(Date.now() - periodHours * 60 * 60 * 1000).toISOString();

  const db = c.env.DB;

  const [turnPercentiles, queuePercentiles, wakePercentiles, errorRate, trend, stages, slowByChannel, slowByModel] = await Promise.all([
    getPercentiles(db, 'turn_complete', periodStart),
    getPercentiles(db, 'queue_wait', periodStart),
    getPercentiles(db, 'sandbox_wake', periodStart),
    getErrorRate(db, periodStart),
    getPerfTrend(db, 'turn_complete', periodStart),
    getStageBreakdown(db, periodStart),
    getSlowPaths(db, periodStart, 'channel'),
    getSlowPaths(db, periodStart, 'model'),
  ]);

  const slowPaths = [
    ...slowByChannel.map((r) => ({ dimension: 'channel', ...r })),
    ...slowByModel.map((r) => ({ dimension: 'model', ...r })),
  ];

  const response: AnalyticsPerformanceResponse = {
    hero: {
      turnLatencyP50: turnPercentiles.p50,
      turnLatencyP95: turnPercentiles.p95,
      queueWaitP50: queuePercentiles.p50,
      sandboxWakeP50: wakePercentiles.p50,
      errorRate: errorRate.rate,
      turnCount: errorRate.turns,
      errorCount: errorRate.errors,
    },
    trend,
    stages,
    slowPaths,
    period: periodHours,
  };

  return c.json(response);
});

// GET /api/analytics/events?period=720&type=github.&limit=50&offset=0
analyticsRouter.get('/events', async (c) => {
  const user = c.get('user');
  if (!user || user.role !== 'admin') {
    return c.json({ error: 'Admin access required', code: 'FORBIDDEN' }, 403);
  }

  const rawPeriod = parseInt(c.req.query('period') || '720', 10);
  const periodHours = Number.isFinite(rawPeriod) ? Math.min(Math.max(rawPeriod, 1), 8760) : 720;
  const periodStart = new Date(Date.now() - periodHours * 60 * 60 * 1000).toISOString();
  const typePrefix = c.req.query('type') || undefined;
  const limit = parseInt(c.req.query('limit') || '50', 10);
  const offset = parseInt(c.req.query('offset') || '0', 10);

  const db = c.env.DB;
  const events = await getEventFeed(db, periodStart, { typePrefix, limit, offset });

  // Parse properties JSON for the response
  const parsed = events.map((e) => ({
    ...e,
    properties: e.properties ? JSON.parse(e.properties) : null,
  }));

  const response: AnalyticsEventsResponse = {
    events: parsed,
    total: parsed.length,
    period: periodHours,
  };

  return c.json(response);
});
```

- [ ] **Step 2: Mount the router**

In `packages/worker/src/index.ts`, add the import and mount:

```typescript
import { analyticsRouter } from './routes/analytics.js';
```

Mount alongside the other routes:
```typescript
app.route('/api/analytics', analyticsRouter);
```

- [ ] **Step 3: Typecheck**

Run: `cd /Users/conner/code/valet/packages/worker && pnpm typecheck`

- [ ] **Step 4: Commit**

```bash
git add packages/worker/src/routes/analytics.ts packages/worker/src/index.ts
git commit -m "feat: add analytics performance and events API endpoints"
```

---

### Task 12: Client API Hooks

**Files:**
- Create: `packages/client/src/api/analytics.ts`

- [ ] **Step 1: Create analytics API hooks**

Create `packages/client/src/api/analytics.ts`:

```typescript
import { useQuery } from '@tanstack/react-query';
import type { AnalyticsPerformanceResponse, AnalyticsEventsResponse } from '@valet/shared';
import { apiClient } from './client';

const analyticsKeys = {
  all: ['analytics'] as const,
  performance: (period: number) => [...analyticsKeys.all, 'performance', period] as const,
  events: (period: number, type?: string) => [...analyticsKeys.all, 'events', period, type] as const,
};

export function useAnalyticsPerformance(periodHours: number = 720) {
  return useQuery({
    queryKey: analyticsKeys.performance(periodHours),
    queryFn: async () => {
      const res = await apiClient(`/api/analytics/performance?period=${periodHours}`);
      if (!res.ok) throw new Error('Failed to fetch performance data');
      return res.json() as Promise<AnalyticsPerformanceResponse>;
    },
    refetchInterval: 60_000,
  });
}

export function useAnalyticsEvents(periodHours: number = 720, typePrefix?: string, limit = 50, offset = 0) {
  return useQuery({
    queryKey: [...analyticsKeys.events(periodHours, typePrefix), limit, offset],
    queryFn: async () => {
      const params = new URLSearchParams({ period: String(periodHours), limit: String(limit), offset: String(offset) });
      if (typePrefix) params.set('type', typePrefix);
      const res = await apiClient(`/api/analytics/events?${params}`);
      if (!res.ok) throw new Error('Failed to fetch events');
      return res.json() as Promise<AnalyticsEventsResponse>;
    },
    refetchInterval: 30_000,
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/client/src/api/analytics.ts
git commit -m "feat: add analytics React Query hooks"
```

---

### Task 13: Dashboard UI — Tabbed Layout

**Files:**
- Modify: `packages/client/src/routes/settings/usage.tsx` (add tabs, wrap existing content in Billing tab)

- [ ] **Step 1: Add tab state and tab navigation**

Rewrite `packages/client/src/routes/settings/usage.tsx` to add a tab system. The existing billing content stays exactly as-is inside the Billing tab. Add placeholder tabs for Performance and Events.

Key changes:
- Add `tab` state: `'billing' | 'performance' | 'events'`, default `'billing'`
- Update page title from "Usage & Cost" to "Analytics"
- Wrap existing `UsageHeroMetrics`, `CostChart`, `ModelBreakdownTable`, `UserBreakdownTable` inside the billing tab content
- Add tab bar UI (simple underline tabs matching the existing design system)
- Performance and Events tabs render placeholder components (built in next tasks)

```typescript
const [tab, setTab] = React.useState<'billing' | 'performance' | 'events'>('billing');
```

Tab bar:
```tsx
<div className="flex gap-1 border-b border-neutral-200 dark:border-neutral-800">
  {(['billing', 'performance', 'events'] as const).map((t) => (
    <button
      key={t}
      onClick={() => setTab(t)}
      className={`px-4 py-2 text-sm font-medium capitalize transition-colors ${
        tab === t
          ? 'border-b-2 border-neutral-900 text-neutral-900 dark:border-neutral-100 dark:text-neutral-100'
          : 'text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200'
      }`}
    >
      {t}
    </button>
  ))}
</div>
```

- [ ] **Step 2: Typecheck**

Run: `cd /Users/conner/code/valet/packages/client && pnpm typecheck`

- [ ] **Step 3: Commit**

```bash
git add packages/client/src/routes/settings/usage.tsx
git commit -m "feat: add tabbed layout to analytics dashboard"
```

---

### Task 14: Performance Tab Components

**Files:**
- Create: `packages/client/src/components/analytics/perf-hero-metrics.tsx`
- Create: `packages/client/src/components/analytics/latency-trend-chart.tsx`
- Create: `packages/client/src/components/analytics/stage-breakdown-table.tsx`
- Create: `packages/client/src/components/analytics/slow-paths-table.tsx`
- Create: `packages/client/src/components/analytics/performance-tab.tsx`

- [ ] **Step 1: Create PerfHeroMetrics**

Create `packages/client/src/components/analytics/perf-hero-metrics.tsx`:

4 metric cards in the same style as `UsageHeroMetrics`:
- Turn Latency P50/P95 (format as ms or seconds)
- Queue Wait P50
- Sandbox Wake P50
- Error Rate (as percentage)

Follow the existing `UsageHeroMetrics` component pattern for card layout and styling.

- [ ] **Step 2: Create LatencyTrendChart**

Create `packages/client/src/components/analytics/latency-trend-chart.tsx`:

Recharts area chart following the `CostChart` pattern:
- X-axis: date
- Two areas: P50 (primary color) and P95 (secondary/lighter color)
- Custom tooltip showing date, P50, P95, count
- Same responsive container and styling as CostChart

- [ ] **Step 3: Create StageBreakdownTable**

Create `packages/client/src/components/analytics/stage-breakdown-table.tsx`:

Table with columns: Stage, Count, P50 (ms), P95 (ms)
- Rows from the `stages` API response
- Format stage names: `queue_wait` → "Queue Wait", `llm_response` → "LLM Response", etc.

- [ ] **Step 4: Create SlowPathsTable**

Create `packages/client/src/components/analytics/slow-paths-table.tsx`:

Table with columns: Dimension, Value, Count, P50 (ms), P95 (ms)
- Groups by dimension (channel, model)
- Sorted by P95 descending

- [ ] **Step 5: Create PerformanceTab composition component**

Create `packages/client/src/components/analytics/performance-tab.tsx`:

```typescript
import { useAnalyticsPerformance } from '@/api/analytics';
import { PerfHeroMetrics } from './perf-hero-metrics';
import { LatencyTrendChart } from './latency-trend-chart';
import { StageBreakdownTable } from './stage-breakdown-table';
import { SlowPathsTable } from './slow-paths-table';

export function PerformanceTab({ period }: { period: number }) {
  const { data, isLoading } = useAnalyticsPerformance(period);

  if (isLoading) return <PerformanceSkeleton />;
  if (!data) return <div className="flex h-64 items-center justify-center text-sm text-neutral-400">No performance data available</div>;

  return (
    <div className="space-y-6">
      <PerfHeroMetrics hero={data.hero} />
      <LatencyTrendChart data={data.trend} />
      <div className="grid gap-6 lg:grid-cols-2">
        <StageBreakdownTable data={data.stages} />
        <SlowPathsTable data={data.slowPaths} />
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Wire PerformanceTab into the usage page**

In `packages/client/src/routes/settings/usage.tsx`, import and render `PerformanceTab` in the performance tab:

```typescript
import { PerformanceTab } from '@/components/analytics/performance-tab';
```

```tsx
{tab === 'performance' && <PerformanceTab period={period} />}
```

- [ ] **Step 7: Typecheck**

Run: `cd /Users/conner/code/valet/packages/client && pnpm typecheck`

- [ ] **Step 8: Commit**

```bash
git add packages/client/src/components/analytics/
git add packages/client/src/routes/settings/usage.tsx
git commit -m "feat: add performance tab with latency metrics, trends, and breakdowns"
```

---

### Task 15: Events Tab Component

**Files:**
- Create: `packages/client/src/components/analytics/events-tab.tsx`

- [ ] **Step 1: Create EventsTab**

Create `packages/client/src/components/analytics/events-tab.tsx`:

Paginated event feed table:
- Type filter dropdown (All, Core, github.*, slack.*, etc.)
- Table columns: Timestamp, Event Type, Session (linked to `/sessions/:id`), Duration, Summary, Properties
- Pagination controls (Previous / Next)
- Format timestamps as relative ("2m ago") with tooltip for absolute
- Format duration_ms as human-readable
- Truncate summary and properties with expand on click

```typescript
import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { useAnalyticsEvents } from '@/api/analytics';

const TYPE_FILTERS = [
  { label: 'All', value: undefined },
  { label: 'Core', value: 'turn_' },
  { label: 'LLM', value: 'llm_' },
  { label: 'Queue', value: 'queue_' },
  { label: 'Sandbox', value: 'sandbox_' },
  { label: 'Session', value: 'session.' },
  { label: 'Agent', value: 'agent.' },
  { label: 'Workflow', value: 'workflow.' },
];

export function EventsTab({ period }: { period: number }) {
  const [typeFilter, setTypeFilter] = React.useState<string | undefined>(undefined);
  const [offset, setOffset] = React.useState(0);
  const limit = 50;

  const { data, isLoading } = useAnalyticsEvents(period, typeFilter, limit, offset);

  // ... render filter bar, table, pagination
}
```

- [ ] **Step 2: Wire EventsTab into the usage page**

In `packages/client/src/routes/settings/usage.tsx`:

```typescript
import { EventsTab } from '@/components/analytics/events-tab';
```

```tsx
{tab === 'events' && <EventsTab period={period} />}
```

- [ ] **Step 3: Typecheck**

Run: `cd /Users/conner/code/valet/packages/client && pnpm typecheck`

- [ ] **Step 4: Commit**

```bash
git add packages/client/src/components/analytics/events-tab.tsx packages/client/src/routes/settings/usage.tsx
git commit -m "feat: add events tab with filterable paginated event feed"
```

---

### Task 16: Retention Cron

**Files:**
- Modify: `packages/worker/src/index.ts` (add retention logic to existing cron handler)

- [ ] **Step 1: Add retention cleanup to the nightly cron**

The worker already has a cron trigger at `0 3 * * *` (3am UTC nightly). Find the existing cron handler in `packages/worker/src/index.ts` and add analytics event retention:

```typescript
// In the cron handler (scheduled event):
// Delete analytics events older than 90 days
if (event.cron === '0 3 * * *') {
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  await env.DB.prepare('DELETE FROM analytics_events WHERE created_at < ?').bind(cutoff).run();
}
```

- [ ] **Step 2: Typecheck**

Run: `cd /Users/conner/code/valet/packages/worker && pnpm typecheck`

- [ ] **Step 3: Commit**

```bash
git add packages/worker/src/index.ts
git commit -m "feat: add 90-day retention cleanup for analytics_events"
```

---

### Task 17: Remove Old DB Helpers from SessionAgentDO Imports

**Files:**
- Modify: `packages/worker/src/durable-objects/session-agent.ts:4` (verify clean imports)

- [ ] **Step 1: Verify no remaining references to old functions**

Search `session-agent.ts` for any remaining references to:
- `batchInsertAuditLog`
- `batchInsertUsageEvents`
- `appendAuditLog`
- `audit_log` (as SQL table name, except in the `type: 'audit_log'` WebSocket message)
- `usage_events` (as SQL table name)

All should have been replaced in Task 5. Fix any stragglers.

- [ ] **Step 2: Full typecheck**

Run: `cd /Users/conner/code/valet && pnpm typecheck`

All packages should pass.

- [ ] **Step 3: Commit (if any fixes needed)**

```bash
git add -A
git commit -m "fix: clean up remaining references to old audit_log and usage_events"
```

---

### Task 18: End-to-End Verification

- [ ] **Step 1: Run all tests**

Run: `cd /Users/conner/code/valet && pnpm test`

- [ ] **Step 2: Run full typecheck**

Run: `cd /Users/conner/code/valet && pnpm typecheck`

- [ ] **Step 3: Verify the migration applies cleanly**

Run: `make db-migrate`

- [ ] **Step 4: Manual smoke test (if dev environment available)**

1. Start dev: `make dev-all`
2. Navigate to Settings > Analytics (formerly Usage & Cost)
3. Verify Billing tab shows existing data
4. Verify Performance tab renders (may be empty if no events yet)
5. Verify Events tab shows migrated audit log entries
6. Send a message in a session, wait for flush, verify events appear

- [ ] **Step 5: Final commit with any fixes**

```bash
git add -A
git commit -m "fix: end-to-end verification fixes for unified analytics"
```
