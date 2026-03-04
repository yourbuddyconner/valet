---
# valet-wh8d
title: Durable Webhook Inbox
status: todo
type: epic
priority: high
tags:
    - integrations
    - architecture
    - reliability
    - webhooks
created_at: 2026-02-24T00:00:00Z
updated_at: 2026-02-24T00:00:00Z
---

Replace synchronous in-request webhook processing with a durable inbox pattern: persist the raw webhook payload to D1 immediately, return HTTP 200/202, then process asynchronously. The fast-ack pattern is standard in event-driven systems: acknowledge receipt before processing so that transient failures don't cause event loss.

## Problem

Agent-ops processes webhooks **synchronously within the HTTP request handler**. If processing fails — D1 write error, DO fetch timeout, session lookup miss — the event is silently lost. There is no retry, no dead-letter queue, no way to know it happened.

### Current webhook processing paths

**GitHub webhooks** (`routes/webhooks.ts` → `services/webhooks.ts`):
```
POST /webhooks/github
  → verify X-Hub-Signature-256
  → parse event type from X-GitHub-Event header
  → pull_request: handlePullRequestWebhook()
    → db.findSessionsByPR() → db.updateSessionGitState() → DO stub fetch
  → push: handlePushWebhook()
    → db.findSessionsByRepoBranch() → db.updateSessionGitState() → DO stub fetch
```

All of this happens in the request. If the DO fetch on line 256 throws (e.g., DO is hibernating and slow to wake), the webhook is lost. GitHub will retry (up to 3 times with backoff), but we have no visibility into which events were lost.

**Telegram webhooks** (`routes/telegram.ts`):
```
POST /telegram/webhook/:userId
  → decrypt bot token from D1
  → create Grammy bot instance
  → process message (text/photo/voice/audio)
  → route to session DO or orchestrator
```

If the orchestrator is overloaded or the session DO is unavailable, the Telegram message is dropped. Telegram does NOT retry failed webhooks.

**Generic webhooks** (`services/webhooks.ts:handleGenericWebhook()`):
```
POST /webhooks/*
  → lookup trigger by path
  → verify signature
  → parse body, extract variables
  → checkWorkflowConcurrency()
  → createExecution()
  → enqueueWorkflowExecution()
```

This is the most robust path — it writes to D1 before dispatching. But it still does all the work in-request: if `createExecution()` succeeds but `enqueueWorkflowExecution()` fails, we have an orphaned execution row.

### Failure modes that cause data loss today

1. **DO hibernation wake timeout.** SessionAgentDO takes >30s to wake → CF Workers 30s CPU limit hit → 500 error → event lost.
2. **D1 transient write failure.** D1 has documented transient errors under load → partial state updates (e.g., git state updated but DO not notified).
3. **Telegram bot token decryption failure.** If `ENCRYPTION_KEY` rotates or config row is corrupted → entire webhook handler throws → message lost forever (Telegram won't retry).
4. **Rate limiting.** The concurrency check in `handleGenericWebhook()` returns 429 → webhook payload discarded. The webhook source may not retry.
5. **Signature verification on re-serialized body.** GitHub webhook signature is verified against `JSON.stringify(payload)` (re-serialized), not the raw body. If JSON serialization differs, legit webhooks are rejected and lost.

## Design

### Core: `webhook_inbox` D1 Table

```sql
CREATE TABLE webhook_inbox (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,               -- 'github', 'telegram', 'generic', 'slack', etc.
  event_type TEXT,                       -- 'pull_request', 'push', 'message', etc.
  raw_headers TEXT NOT NULL,             -- JSON: relevant headers (signature, delivery ID, event type)
  raw_body TEXT NOT NULL,                -- Raw request body as received (NOT re-serialized)
  routing_metadata TEXT,                 -- JSON: { userId, webhookPath, etc. } — provider-specific routing hints
  status TEXT NOT NULL DEFAULT 'pending',-- 'pending' | 'processing' | 'completed' | 'failed' | 'dead_letter'
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  claimed_at TEXT,                       -- ISO timestamp when a worker claimed this row
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_webhook_inbox_status ON webhook_inbox(status, created_at);
CREATE INDEX idx_webhook_inbox_provider ON webhook_inbox(provider, status);
```

### Ingestion Path (Fast-Ack)

Every webhook endpoint does the same three things:

1. **Minimal validation** — verify the request is structurally valid (has a body, provider is recognized). Do NOT verify signatures here — that's processing work.
2. **Persist to inbox** — write raw headers + raw body + routing metadata to `webhook_inbox`.
3. **Return immediately** — HTTP 200 (GitHub/Telegram) or 202 (generic).

```typescript
// packages/worker/src/services/webhook-inbox.ts

export async function ingestWebhook(
  db: D1Database,
  params: {
    provider: string;
    eventType?: string;
    rawHeaders: Record<string, string>;
    rawBody: string;
    routingMetadata?: Record<string, unknown>;
  }
): Promise<{ id: string }> {
  const id = crypto.randomUUID();
  await db.prepare(`
    INSERT INTO webhook_inbox (id, provider, event_type, raw_headers, raw_body, routing_metadata, status)
    VALUES (?, ?, ?, ?, ?, ?, 'pending')
  `).bind(
    id,
    params.provider,
    params.eventType ?? null,
    JSON.stringify(params.rawHeaders),
    params.rawBody,
    params.routingMetadata ? JSON.stringify(params.routingMetadata) : null,
  ).run();

  return { id };
}
```

### Processing Path (Async Worker)

A background processor claims pending inbox rows and processes them. Two options for the processing trigger:

**Option A: `ctx.waitUntil()` (simpler, immediate)**

After ingesting, fire-and-forget the processing in `ctx.waitUntil()`. This processes immediately but doesn't survive worker restarts.

```typescript
ctx.waitUntil(processWebhookInbox(env, inboxId));
```

**Option B: Cron-based sweep (more durable)**

Add a cron job (e.g., every 30 seconds) that claims and processes pending inbox rows. This handles the case where `waitUntil` processing fails — the cron sweep picks up unclaimed rows.

**Recommended: Both.** Use `waitUntil` for immediate processing. Use a cron sweep as a safety net for anything that wasn't processed or failed.

### Claim-and-Process Pattern

```typescript
export async function claimAndProcessBatch(
  env: Env,
  batchSize: number = 10,
): Promise<{ processed: number; failed: number }> {
  // Claim rows atomically — only rows that are:
  // - status = 'pending', or
  // - status = 'processing' AND claimed_at is older than 60s (stale claim)
  // - attempts < 5
  const claimId = crypto.randomUUID();
  const staleThreshold = new Date(Date.now() - 60_000).toISOString();

  const claimed = await env.DB.prepare(`
    UPDATE webhook_inbox
    SET status = 'processing', claimed_at = datetime('now'), attempts = attempts + 1
    WHERE id IN (
      SELECT id FROM webhook_inbox
      WHERE (status = 'pending' OR (status = 'processing' AND claimed_at < ?))
        AND attempts < 5
      ORDER BY created_at ASC
      LIMIT ?
    )
    RETURNING *
  `).bind(staleThreshold, batchSize).all();

  let processed = 0;
  let failed = 0;

  for (const row of claimed.results) {
    try {
      await processInboxRow(env, row);
      await markCompleted(env.DB, row.id);
      processed++;
    } catch (error) {
      await markFailed(env.DB, row.id, String(error));
      failed++;
    }
  }

  return { processed, failed };
}
```

### Per-Provider Processing

`processInboxRow()` dispatches to provider-specific handlers. These are the existing handler functions, refactored to accept raw headers + body instead of pre-parsed request objects:

```typescript
async function processInboxRow(env: Env, row: WebhookInboxRow): Promise<void> {
  const headers = JSON.parse(row.raw_headers);
  const routingMetadata = row.routing_metadata ? JSON.parse(row.routing_metadata) : {};

  switch (row.provider) {
    case 'github':
      await processGitHubWebhook(env, headers, row.raw_body, row.event_type);
      break;
    case 'telegram':
      await processTelegramWebhook(env, headers, row.raw_body, routingMetadata.userId);
      break;
    case 'generic':
      await processGenericWebhook(env, headers, row.raw_body, routingMetadata);
      break;
    default:
      throw new Error(`Unknown provider: ${row.provider}`);
  }
}
```

### Signature Verification Fix

Moving verification to the processing step also fixes the GitHub signature bug. Currently, `routes/webhooks.ts` verifies the signature against `JSON.stringify(payload)` (re-serialized). By storing the raw body and verifying against it during processing, we get correct signature verification:

```typescript
async function processGitHubWebhook(env: Env, headers: Record<string, string>, rawBody: string, eventType: string): Promise<void> {
  // Verify against the ACTUAL raw body, not re-serialized JSON
  const signature = headers['x-hub-signature-256'];
  if (env.GITHUB_WEBHOOK_SECRET && signature) {
    const valid = await verifyGitHubSignature(rawBody, signature, env.GITHUB_WEBHOOK_SECRET);
    if (!valid) throw new Error('Invalid GitHub webhook signature');
  }

  const payload = JSON.parse(rawBody);

  switch (eventType) {
    case 'pull_request':
      await handlePullRequestWebhook(env, payload);
      break;
    case 'push':
      await handlePushWebhook(env, payload);
      break;
  }
}
```

### Dead Letter and Observability

After 5 failed attempts, rows move to `dead_letter` status:

```typescript
async function markFailed(db: D1Database, id: string, error: string): Promise<void> {
  const row = await db.prepare(
    'SELECT attempts FROM webhook_inbox WHERE id = ?'
  ).bind(id).first();

  const newStatus = (row?.attempts ?? 0) >= 5 ? 'dead_letter' : 'pending';

  await db.prepare(`
    UPDATE webhook_inbox
    SET status = ?, last_error = ?, updated_at = datetime('now')
    WHERE id = ?
  `).bind(newStatus, error, id).run();
}
```

Add an admin endpoint to inspect and replay dead-lettered webhooks:

```
GET  /api/admin/webhooks/inbox          — list inbox rows with status filter
POST /api/admin/webhooks/inbox/:id/retry — reset status to 'pending', clear attempts
```

### Cron Sweep

Add to the existing cron handler in `index.ts`:

```typescript
// Every 30 seconds (or piggyback on existing 1-minute cron)
if (shouldRunWebhookSweep(event)) {
  ctx.waitUntil(claimAndProcessBatch(env, 20));
}
```

### Cleanup

Old completed/dead-letter rows should be pruned. Add to cron:

```typescript
// Daily: delete completed rows older than 7 days, dead_letter older than 30 days
await env.DB.prepare(`
  DELETE FROM webhook_inbox
  WHERE (status = 'completed' AND created_at < datetime('now', '-7 days'))
     OR (status = 'dead_letter' AND created_at < datetime('now', '-30 days'))
`).run();
```

## Migration Plan

### Phase 1: Add inbox table and ingestion

1. Create D1 migration for `webhook_inbox` table
2. Create `services/webhook-inbox.ts` with `ingestWebhook()`, `claimAndProcessBatch()`, `processInboxRow()`
3. Do NOT change existing webhook routes yet

### Phase 2: Migrate GitHub webhooks

1. Update `routes/webhooks.ts` GitHub handler:
   - Extract raw body and relevant headers
   - Call `ingestWebhook()` with provider='github'
   - Return 200 immediately
   - Fire `ctx.waitUntil(processWebhookInbox(env, id))` for immediate processing
2. Move `services/webhooks.ts` `handlePullRequestWebhook()` and `handlePushWebhook()` to be called from `processInboxRow()` instead of the route
3. Fix signature verification to use raw body

### Phase 3: Migrate Telegram webhooks

1. Update `routes/telegram.ts` webhook handler:
   - Store raw body + `{ userId }` as routing metadata
   - Return 200 immediately
   - Fire background processing
2. Refactor Telegram processing to work from stored raw body

### Phase 4: Migrate generic webhooks

1. Update `routes/webhooks.ts` catch-all handler:
   - Store raw body + `{ webhookPath, method, query }` as routing metadata
   - Return 202 immediately
   - The generic handler already writes to D1 before dispatching, so this is mainly for resilience

### Phase 5: Add cron sweep and admin endpoints

1. Add cron-based `claimAndProcessBatch()` sweep
2. Add admin API endpoints for inbox inspection and replay
3. Add cleanup cron for old rows

## Files to Create

| File | Purpose |
|---|---|
| `packages/worker/migrations/NNNN_webhook_inbox.sql` | D1 migration for inbox table |
| `packages/worker/src/services/webhook-inbox.ts` | Ingestion, claim-and-process, per-provider dispatch |
| `packages/worker/src/lib/db/webhook-inbox.ts` | DB helpers for inbox CRUD |

## Files to Modify

| File | Change |
|---|---|
| `packages/worker/src/routes/webhooks.ts` | Replace synchronous processing with ingest + waitUntil |
| `packages/worker/src/routes/telegram.ts` | Replace synchronous processing with ingest + waitUntil |
| `packages/worker/src/services/webhooks.ts` | Refactor handlers to accept raw headers/body (no Request object) |
| `packages/worker/src/services/telegram.ts` | Refactor message processing to work from stored payload |
| `packages/worker/src/index.ts` | Add cron sweep trigger for webhook inbox |
| `packages/worker/src/routes/admin.ts` | Add inbox inspection and replay endpoints |
| `packages/worker/src/lib/schema/` | Add Drizzle schema for webhook_inbox |

## Relationship to Other Beans

- **valet-cp7w (Control Plane / Execution Plane Split)** — The inbox is part of the execution plane. Webhook processing triggers actions, which go through the action service.
- **valet-pg9a (Policy-Gated Actions)** — Webhook-triggered actions (e.g., "auto-respond to PR review") should flow through the action approval pipeline, not bypass it.
- **valet-ch4t (Pluggable Channel Transports)** — Inbound channel webhooks (Telegram messages, Slack events) flow through the inbox. The inbox processor uses `channelRegistry.getTransport()` to dispatch to the correct channel transport for parsing and routing, instead of hardcoded per-platform handlers.

## Open Questions

1. **Inbox size under load.** If a busy GitHub org sends 1000 webhooks/minute, the inbox table grows fast. Is a 7-day retention sufficient, or do we need shorter TTLs for completed rows?

2. **Ordering guarantees.** The current synchronous model processes webhooks in order of arrival. The async model with batch claiming may process out of order. For PR state updates, this could cause a `closed` event to process before an `opened` event if they arrive in the same batch. Do we need per-session ordering? (Probably not — last-write-wins on git state is fine.)

3. **`waitUntil` vs. separate DO.** A Durable Object could serve as the inbox processor (single-writer, alarm-based). This is more complex but gives stronger exactly-once guarantees via DO transactions. Worth it?

## Acceptance Criteria

- [ ] `webhook_inbox` D1 table exists with migration
- [ ] GitHub webhooks persisted to inbox before processing, HTTP 200 returned immediately
- [ ] Telegram webhooks persisted to inbox before processing, HTTP 200 returned immediately
- [ ] Generic webhooks persisted to inbox before processing, HTTP 202 returned immediately
- [ ] Background processing via `ctx.waitUntil()` runs after ingestion
- [ ] Cron sweep picks up unprocessed/failed rows
- [ ] Failed rows retry up to 5 times before moving to `dead_letter`
- [ ] GitHub signature verification uses raw body (not re-serialized JSON)
- [ ] Admin endpoints for inbox inspection and replay exist
- [ ] Old completed rows pruned by cron (7-day retention)
- [ ] `pnpm typecheck` passes
- [ ] Existing webhook behavior unchanged from the perspective of external callers
