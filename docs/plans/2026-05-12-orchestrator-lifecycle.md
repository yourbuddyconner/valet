# Orchestrator Lifecycle Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace orchestrator session ID rotation with a stable DO (`orchestrator:{userId}`) that owns its sandbox lifecycle internally, add `sandbox_lost` recovery for all session types, and eliminate external restart races.

**Architecture:** The orchestrator DO becomes permanent — one per user, forever. It manages sandbox spawn/hibernate/restore/recover internally via a new `POST /ensure-running` endpoint. All external callers (message dispatch, slash commands, cron) call this single serialized endpoint instead of racing through `restartOrchestratorSession`. The `sandbox_lost` alarm path triggers DO-internal recovery with a circuit breaker, shared across all session types.

**Tech Stack:** Cloudflare Workers, Durable Objects (SQLite), D1, Hono, TypeScript, vitest

**Spec:** `docs/specs/2026-05-12-orchestrator-lifecycle-design.md`

**Naming note:** The spec uses `ready` to replace `running`. This plan keeps `running` as the state name to avoid a codebase-wide rename (frontend, API responses, D1 data, etc.). The spec's intent — distinguishing "sandbox exists" from "ready to accept work" — is achieved by adding `waiting_runner` as a new intermediate state. The mapping: spec `ready` = code `running`, spec `starting` = code `initializing` (kept for same reason).

---

### Task 0: Revert Uncommitted Workaround Changes

**Files:**
- Revert uncommitted changes from earlier in this session

The earlier changes to `channel-webhooks.ts`, `slack-events.ts`, `orchestrator.ts`, `index.ts`, and `do-ws-url.ts` were workarounds for the problems this redesign solves properly. They must be reverted before implementing the new design, since later tasks rewrite those same files.

- [ ] **Step 1: Revert uncommitted workaround changes**

```bash
git checkout -- packages/worker/src/routes/channel-webhooks.ts packages/worker/src/routes/slack-events.ts packages/worker/src/services/orchestrator.ts packages/worker/src/index.ts packages/worker/src/lib/do-ws-url.ts
```

Note: Keep the committed `agent-client.ts` fix (retry logic improvements) — that's still valid and complementary to this redesign.

- [ ] **Step 2: Verify clean state**

Run: `git diff --stat`
Expected: No uncommitted changes in the worker package.

---

### Task 1: Add New Lifecycle States to Type System

**Files:**
- Modify: `packages/shared/src/types/index.ts:140`
- Modify: `packages/worker/src/durable-objects/session-state.ts:11-20`

- [ ] **Step 1: Update shared SessionStatus type**

In `packages/shared/src/types/index.ts`, replace the `SessionStatus` type at line 140:

```typescript
export type SessionStatus =
  | 'initializing'
  | 'running'
  | 'idle'
  | 'waiting_runner'
  | 'recovering'
  | 'backoff'
  | 'hibernating'
  | 'hibernated'
  | 'restoring'
  | 'terminated'
  | 'archived'
  | 'error';
```

- [ ] **Step 2: Update DO SessionLifecycleStatus type**

In `packages/worker/src/durable-objects/session-state.ts`, replace the `SessionLifecycleStatus` type at line 11:

```typescript
export type SessionLifecycleStatus =
  | 'initializing'
  | 'running'
  | 'idle'
  | 'waiting_runner'
  | 'recovering'
  | 'backoff'
  | 'hibernating'
  | 'hibernated'
  | 'restoring'
  | 'terminated'
  | 'archived'
  | 'error';
```

- [ ] **Step 3: Add shared terminal status constant**

In `packages/shared/src/types/index.ts`, add after the `SessionStatus` type:

```typescript
/** Session statuses that indicate the session is no longer active. */
export const TERMINAL_SESSION_STATUSES: ReadonlySet<SessionStatus> = new Set([
  'terminated',
  'archived',
  'error',
]);
```

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck`
Expected: PASS — new types are additive, no existing code breaks.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/types/index.ts packages/worker/src/durable-objects/session-state.ts
git commit -m "feat: add waiting_runner, recovering, backoff lifecycle states"
```

---

### Task 2: Add Recovery State Management to DO

**Files:**
- Modify: `packages/worker/src/durable-objects/session-state.ts`
- Modify: `packages/worker/src/durable-objects/runner-link.ts`
- Test: `packages/worker/src/durable-objects/session-state.test.ts`

- [ ] **Step 1: Add recovery state accessors to SessionState**

In `packages/worker/src/durable-objects/session-state.ts`, add accessors using the existing `getState`/`setState` pattern (follow the pattern of `sandboxId`, `tunnelUrls`, etc.):

```typescript
// ─── Recovery State ──────────────────────────────────────────────────

get recoveryAttemptCount(): number {
  return parseInt(this.getState('recoveryAttemptCount') || '0', 10);
}

set recoveryAttemptCount(val: number) {
  this.setState('recoveryAttemptCount', String(val));
}

get lastRecoveryAt(): number {
  return parseInt(this.getState('lastRecoveryAt') || '0', 10);
}

set lastRecoveryAt(val: number) {
  this.setState('lastRecoveryAt', String(val));
}

get backoffUntil(): number {
  return parseInt(this.getState('backoffUntil') || '0', 10);
}

set backoffUntil(val: number) {
  this.setState('backoffUntil', String(val));
}

get lastFailureReason(): string | undefined {
  return this.getState('lastFailureReason') || undefined;
}

set lastFailureReason(val: string | undefined) {
  this.setState('lastFailureReason', val || '');
}

get sandboxGeneration(): number {
  return parseInt(this.getState('sandboxGeneration') || '0', 10);
}

set sandboxGeneration(val: number) {
  this.setState('sandboxGeneration', String(val));
}

/** Reset recovery counters after reaching healthy running state. */
resetRecoveryState(): void {
  this.recoveryAttemptCount = 0;
  this.lastRecoveryAt = 0;
  this.backoffUntil = 0;
  this.lastFailureReason = undefined;
}
```

- [ ] **Step 2: Add sandboxGeneration to RunnerLink**

In `packages/worker/src/durable-objects/runner-link.ts`, add a generation accessor (following the existing `token`, `connectedAt` pattern):

```typescript
/** Sandbox generation — incremented on each spawn/restore, used to reject stale connections. */
get generation(): number {
  const val = this.deps.getState('sandboxGeneration');
  return val ? parseInt(val, 10) : 0;
}

set generation(val: number) {
  this.deps.setState('sandboxGeneration', String(val));
}
```

- [ ] **Step 3: Write tests for recovery state**

In `packages/worker/src/durable-objects/session-state.test.ts`, add a describe block for recovery state. Follow the existing test patterns in this file — check that the test file's existing structure uses `describe`/`it` blocks with a mock state store, and match that pattern:

```typescript
describe('recovery state', () => {
  it('defaults to zero/undefined when not set', () => {
    // Create SessionState with empty state store (follow existing test setup pattern)
    expect(state.recoveryAttemptCount).toBe(0);
    expect(state.lastRecoveryAt).toBe(0);
    expect(state.backoffUntil).toBe(0);
    expect(state.lastFailureReason).toBeUndefined();
    expect(state.sandboxGeneration).toBe(0);
  });

  it('persists recovery state through getState/setState', () => {
    state.recoveryAttemptCount = 3;
    state.lastRecoveryAt = 1000;
    state.backoffUntil = 2000;
    state.lastFailureReason = 'sandbox_lost';
    state.sandboxGeneration = 5;

    expect(state.recoveryAttemptCount).toBe(3);
    expect(state.lastRecoveryAt).toBe(1000);
    expect(state.backoffUntil).toBe(2000);
    expect(state.lastFailureReason).toBe('sandbox_lost');
    expect(state.sandboxGeneration).toBe(5);
  });

  it('resetRecoveryState clears all counters', () => {
    state.recoveryAttemptCount = 3;
    state.lastRecoveryAt = 1000;
    state.backoffUntil = 2000;
    state.lastFailureReason = 'sandbox_lost';

    state.resetRecoveryState();

    expect(state.recoveryAttemptCount).toBe(0);
    expect(state.lastRecoveryAt).toBe(0);
    expect(state.backoffUntil).toBe(0);
    expect(state.lastFailureReason).toBeUndefined();
  });
});
```

- [ ] **Step 4: Run tests**

Run: `cd packages/worker && pnpm test -- session-state`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/durable-objects/session-state.ts packages/worker/src/durable-objects/runner-link.ts packages/worker/src/durable-objects/session-state.test.ts
git commit -m "feat: add recovery state fields and sandbox generation tracking"
```

---

### Task 3: Implement `sandbox_lost` Recovery in Alarm Handler

**Files:**
- Modify: `packages/worker/src/durable-objects/session-agent.ts` (alarm handler, ~line 1025)
- Test: `packages/worker/src/durable-objects/session-agent.test.ts`

This is the core behavioral change — `sandbox_lost` triggers recovery instead of termination.

- [ ] **Step 1: Add `performRecovery` method to SessionAgentDO**

Add a new private method. Place it near `performWake` and `performHibernate`. This method:
1. Transitions to `recovering`
2. Reverts in-flight prompts
3. Rotates runner token
4. Increments sandbox generation
5. Checks circuit breaker
6. Spawns fresh sandbox or transitions to `backoff`

```typescript
/**
 * Attempt to recover from an unexpected sandbox loss.
 * Reverts in-flight work, rotates credentials, and spawns a fresh sandbox.
 * If recovery fails too many times, transitions to backoff.
 */
private async performRecovery(reason: string): Promise<void> {
  const sessionId = this.sessionState.sessionId;
  const isOrchestrator = sessionId?.startsWith('orchestrator:');

  console.log(`[SessionAgentDO] Starting recovery for ${sessionId} (reason: ${reason})`);

  // ─── Transition to recovering ───
  this.sessionState.status = 'recovering';
  this.broadcastToClients({ type: 'status', data: { status: 'recovering' } });
  updateSessionStatus(this.appDb, sessionId!, 'recovering').catch((err) =>
    console.error('[SessionAgentDO] Failed to sync recovering status to D1:', err),
  );

  // ─── Revert in-flight prompt back to queued ───
  this.promptQueue.revertProcessingToQueued();
  this.promptQueue.runnerBusy = false;

  // ─── Rotate runner token ───
  const newToken = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
  this.runnerLink.token = newToken;
  this.runnerLink.ready = false;

  // ─── Increment sandbox generation ───
  this.sessionState.sandboxGeneration = this.sessionState.sandboxGeneration + 1;

  // ─── Update recovery counters ───
  const now = Date.now();
  this.sessionState.recoveryAttemptCount = this.sessionState.recoveryAttemptCount + 1;
  this.sessionState.lastRecoveryAt = now;
  this.sessionState.lastFailureReason = reason;

  // ─── Circuit breaker check ───
  const MAX_RECOVERY_ATTEMPTS = 3;
  const RECOVERY_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

  // Reset counter if outside the window
  if (now - this.sessionState.lastRecoveryAt > RECOVERY_WINDOW_MS) {
    this.sessionState.recoveryAttemptCount = 1; // This is the first attempt in a new window
  }

  if (this.sessionState.recoveryAttemptCount > MAX_RECOVERY_ATTEMPTS) {
    // Circuit breaker open
    const backoffDelayMs = Math.min(
      60_000 * Math.pow(2, this.sessionState.recoveryAttemptCount - MAX_RECOVERY_ATTEMPTS - 1),
      15 * 60_000, // 15 min cap
    );
    this.sessionState.backoffUntil = now + backoffDelayMs;

    if (isOrchestrator) {
      this.sessionState.status = 'backoff';
      this.broadcastToClients({ type: 'status', data: { status: 'backoff', retryAfterMs: backoffDelayMs } });
      updateSessionStatus(this.appDb, sessionId!, 'backoff').catch((err) =>
        console.error('[SessionAgentDO] Failed to sync backoff status to D1:', err),
      );

      // Write visible system message
      const retryAt = new Date(now + backoffDelayMs).toISOString();
      const msgId = crypto.randomUUID();
      this.messageStore.writeMessage({
        id: msgId,
        role: 'system',
        content: `Orchestrator failed to start ${this.sessionState.recoveryAttemptCount} times. Retrying at ${retryAt}. Last error: ${reason}`,
      });
      this.broadcastToClients({ type: 'message.create', messageId: msgId, role: 'system', content: `Orchestrator failed to start ${this.sessionState.recoveryAttemptCount} times. Retrying at ${retryAt}. Last error: ${reason}` });

      // Schedule alarm for retry
      this.ctx.storage.setAlarm(now + backoffDelayMs);
      console.log(`[SessionAgentDO] Recovery circuit breaker open — backoff until ${retryAt}`);
    } else {
      // Regular sessions terminate after exhausting retries
      console.log(`[SessionAgentDO] Recovery exhausted for regular session ${sessionId} — terminating`);
      const msgId = crypto.randomUUID();
      this.messageStore.writeMessage({
        id: msgId,
        role: 'system',
        content: `Your sandbox lost its connection and couldn't recover after ${this.sessionState.recoveryAttemptCount} attempts. Last error: ${reason}`,
      });
      this.broadcastToClients({ type: 'message.create', messageId: msgId, role: 'system', content: `Your sandbox lost its connection and couldn't recover. Last error: ${reason}` });
      await this.handleStop('recovery_exhausted');
    }
    return;
  }

  // ─── Spawn fresh sandbox ───
  console.log(`[SessionAgentDO] Recovery attempt ${this.sessionState.recoveryAttemptCount}/${MAX_RECOVERY_ATTEMPTS} — spawning fresh sandbox`);

  // Update the spawnRequest with the new runner token
  const spawnRequest = this.sessionState.spawnRequest;
  if (!spawnRequest || !this.sessionState.backendUrl) {
    console.error(`[SessionAgentDO] Cannot recover — missing spawnRequest or backendUrl`);
    await this.handleStop('recovery_no_spawn_request');
    return;
  }

  // Update token in the spawn request env vars
  if (spawnRequest.envVars && typeof spawnRequest.envVars === 'object') {
    (spawnRequest.envVars as Record<string, string>)['RUNNER_TOKEN'] = newToken;
  }
  spawnRequest.runnerToken = newToken;

  this.sessionState.status = 'initializing';
  this.broadcastToClients({ type: 'status', data: { status: 'initializing' } });
  updateSessionStatus(this.appDb, sessionId!, 'initializing').catch((err) =>
    console.error('[SessionAgentDO] Failed to sync initializing status to D1:', err),
  );

  this.ctx.waitUntil(this.spawnSandbox(this.sessionState.backendUrl!, spawnRequest));
}
```

- [ ] **Step 2: Replace `sandbox_lost` path in alarm handler**

In the alarm handler (~line 1025), replace:

```typescript
if (this.runnerDisconnectedAt && now - this.runnerDisconnectedAt >= SessionAgentDO.RUNNER_GRACE_PERIOD_MS) {
  console.log(`[SessionAgentDO] Runner did not reconnect within ${SessionAgentDO.RUNNER_GRACE_PERIOD_MS / 1000}s — terminating session`);
  this.runnerDisconnectedAt = null;
  await this.handleStop('sandbox_lost');
  return;
}
```

With:

```typescript
if (this.runnerDisconnectedAt && now - this.runnerDisconnectedAt >= SessionAgentDO.RUNNER_GRACE_PERIOD_MS) {
  console.log(`[SessionAgentDO] Runner did not reconnect within ${SessionAgentDO.RUNNER_GRACE_PERIOD_MS / 1000}s — attempting recovery`);
  this.runnerDisconnectedAt = null;
  await this.performRecovery('sandbox_lost');
  return;
}
```

- [ ] **Step 3: Handle backoff alarm trigger**

In the alarm handler, add a check for backoff state near the top (after the runner grace period check). When the backoff timer expires, retry recovery:

```typescript
// ─── Backoff retry ───
if (this.sessionState.status === 'backoff' && this.sessionState.backoffUntil > 0 && now >= this.sessionState.backoffUntil) {
  console.log(`[SessionAgentDO] Backoff cooldown elapsed — retrying recovery`);
  await this.performRecovery('backoff_retry');
  return;
}
```

- [ ] **Step 4: Reset recovery counters on successful runner ready**

Find where the DO handles the runner's first `agentStatus: idle` signal (this sets `runnerLink.ready = true` and drains the queue). Add a reset call:

```typescript
this.sessionState.resetRecoveryState();
```

Search for `runnerLink.ready = true` or the `'agentStatus'` message handler where it transitions to ready. Add the reset there.

- [ ] **Step 5: Store backendUrl and spawnRequest in session state**

Verify that `this.sessionState.backendUrl` and `this.sessionState.spawnRequest` are persisted after the initial `/start` call. Check the `handleStart` method — if `backendUrl` and `spawnRequest` are only used in `waitUntil(this.spawnSandbox(...))` and not stored, add storage:

In `handleStart`, after `this.sessionState.initialize(body)`, ensure:
```typescript
// Store spawn config for recovery/respawn
if (body.backendUrl) this.sessionState.backendUrl = body.backendUrl;
if (body.spawnRequest) this.sessionState.spawnRequest = body.spawnRequest;
```

Check if `backendUrl` and `spawnRequest` already have getters/setters on `SessionState`. If not, add them following the existing pattern. These are needed so `performRecovery` can respawn without external input.

- [ ] **Step 6: Typecheck and run existing tests**

Run: `pnpm typecheck && cd packages/worker && pnpm test`
Expected: PASS — ensure existing tests still pass. New recovery behavior will be tested in integration.

- [ ] **Step 7: Commit**

```bash
git add packages/worker/src/durable-objects/session-agent.ts packages/worker/src/durable-objects/session-state.ts
git commit -m "feat: sandbox_lost triggers DO-internal recovery with circuit breaker"
```

---

### Task 4: Add `/ensure-running` and `/refresh` DO Endpoints

**Files:**
- Modify: `packages/worker/src/durable-objects/session-agent.ts` (route dispatcher + new methods)

- [ ] **Step 1: Add route cases to the fetch dispatcher**

In the `switch (url.pathname)` block (~line 435), add:

```typescript
case '/ensure-running':
  return this.handleEnsureRunning();
case '/refresh':
  return this.handleRefresh();
```

- [ ] **Step 2: Implement `handleEnsureRunning`**

```typescript
private async handleEnsureRunning(): Promise<Response> {
  const status = this.sessionState.status;

  switch (status) {
    case 'running':
      return Response.json({ status: 'running' }, { status: 200 });

    case 'initializing':
    case 'waiting_runner':
    case 'restoring':
    case 'recovering':
      return Response.json({ status }, { status: 202 });

    case 'backoff': {
      const now = Date.now();
      const backoffUntil = this.sessionState.backoffUntil;
      if (backoffUntil > 0 && now >= backoffUntil) {
        // Cooldown elapsed — retry
        await this.performRecovery('ensure_running_after_backoff');
        return Response.json({ status: 'recovering' }, { status: 202 });
      }
      const retryAfterMs = Math.max(0, backoffUntil - now);
      return Response.json({ status: 'backoff', retryAfterMs }, { status: 503 });
    }

    case 'hibernated':
      this.ctx.waitUntil(this.performWake());
      return Response.json({ status: 'restoring' }, { status: 202 });

    case 'terminated':
    case 'error':
    case 'idle': {
      // Dead or initial state — attempt recovery/spawn
      // Check if we have the config needed to spawn
      if (!this.sessionState.spawnRequest || !this.sessionState.backendUrl) {
        return Response.json({ status: 'error', error: 'Missing spawn configuration — session needs re-initialization via /start' }, { status: 500 });
      }
      await this.performRecovery('ensure_running');
      return Response.json({ status: 'recovering' }, { status: 202 });
    }

    default:
      return Response.json({ status }, { status: 200 });
  }
}
```

- [ ] **Step 3: Implement `handleRefresh`**

```typescript
private async handleRefresh(): Promise<Response> {
  const sessionId = this.sessionState.sessionId;
  console.log(`[SessionAgentDO] Refresh requested for ${sessionId}`);

  // Terminate existing sandbox (if any)
  const currentStatus = this.sessionState.status;
  if (currentStatus === 'running' || currentStatus === 'waiting_runner' || currentStatus === 'initializing') {
    this.runnerLink.send({ type: 'stop' });
    const runnerSockets = this.ctx.getWebSockets('runner');
    for (const ws of runnerSockets) {
      try { ws.close(1000, 'Session refreshing'); } catch { /* ignore */ }
    }
    await this.lifecycle.terminateSandbox();
  }

  // Clear state for fresh start
  this.sessionState.sandboxId = undefined;
  this.sessionState.tunnelUrls = null;
  this.sessionState.tunnels = [];
  this.sessionState.snapshotImageId = undefined;
  this.promptQueue.runnerBusy = false;
  this.runnerLink.ready = false;

  // Spawn fresh via recovery path (handles token rotation, generation increment)
  await this.performRecovery('refresh');

  return Response.json({ status: 'recovering' }, { status: 202 });
}
```

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/durable-objects/session-agent.ts
git commit -m "feat: add /ensure-running and /refresh DO endpoints"
```

---

### Task 5: D1 Migration for Stable Orchestrator Session IDs

**Files:**
- Create: `packages/worker/migrations/0010_stable_orchestrator_ids.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Migrate orchestrator sessions to stable IDs (orchestrator:{userId})
-- For each user with an orchestrator identity, find their newest orchestrator session
-- and create/update a stable-ID row. Old rotated sessions are archived.

-- Step 1: Create stable session rows from existing orchestrator sessions.
-- Uses INSERT OR IGNORE so this migration is idempotent.
INSERT OR IGNORE INTO sessions (id, user_id, workspace, title, status, purpose, is_orchestrator, created_at, updated_at)
SELECT
  'orchestrator:' || oi.user_id,
  oi.user_id,
  COALESCE(s.workspace, 'orchestrator'),
  COALESCE(s.title, oi.name || ' (Orchestrator)'),
  COALESCE(s.status, 'terminated'),
  'orchestrator',
  1,
  COALESCE(s.created_at, datetime('now')),
  datetime('now')
FROM orchestrator_identities oi
LEFT JOIN sessions s ON s.id = (
  SELECT s2.id FROM sessions s2
  WHERE s2.user_id = oi.user_id
    AND s2.is_orchestrator = 1
    AND s2.status NOT IN ('archived')
  ORDER BY s2.created_at DESC
  LIMIT 1
)
WHERE NOT EXISTS (
  SELECT 1 FROM sessions WHERE id = 'orchestrator:' || oi.user_id
);

-- Step 2: Migrate channel_bindings to stable IDs
UPDATE channel_bindings
SET session_id = 'orchestrator:' || user_id
WHERE session_id != 'orchestrator:' || user_id
  AND session_id IN (
    SELECT id FROM sessions WHERE is_orchestrator = 1
  );

-- Step 3: Migrate channel_thread_mappings to stable IDs
UPDATE channel_thread_mappings
SET session_id = 'orchestrator:' || user_id
WHERE session_id != 'orchestrator:' || user_id
  AND session_id IN (
    SELECT id FROM sessions WHERE is_orchestrator = 1
  );

-- Step 4: Migrate session_threads to stable IDs
UPDATE session_threads
SET session_id = 'orchestrator:' || (
  SELECT user_id FROM sessions WHERE sessions.id = session_threads.session_id
)
WHERE session_id IN (
  SELECT id FROM sessions WHERE is_orchestrator = 1
)
AND session_id NOT LIKE 'orchestrator:________-____-____-____-____________';
-- The NOT LIKE pattern excludes rows that are already a simple orchestrator:{uuid} format

-- Step 5: Archive old rotated orchestrator sessions
UPDATE sessions
SET status = 'archived', updated_at = datetime('now')
WHERE is_orchestrator = 1
  AND id != 'orchestrator:' || user_id
  AND status != 'archived';
```

- [ ] **Step 2: Verify migration locally**

Run: `make db-migrate`
Expected: Migration applies without errors.

- [ ] **Step 3: Commit**

```bash
git add packages/worker/migrations/0010_stable_orchestrator_ids.sql
git commit -m "feat: D1 migration for stable orchestrator session IDs"
```

---

### Task 6: Update Orchestrator Onboarding for Stable Session ID

**Files:**
- Modify: `packages/worker/src/services/orchestrator.ts`
- Modify: `packages/worker/src/lib/db/orchestrator.ts`

- [ ] **Step 1: Change session ID generation in `restartOrchestratorSession`**

In `packages/worker/src/services/orchestrator.ts`, find line 125:

```typescript
const sessionId = `orchestrator:${userId}:${crypto.randomUUID()}`;
```

Replace with:

```typescript
const sessionId = `orchestrator:${userId}`;
```

- [ ] **Step 2: Use INSERT OR IGNORE for session creation**

The stable session ID means the row may already exist. Find the `db.createSession` call (~line 128) and change it to use upsert semantics. Check `packages/worker/src/lib/db/sessions.ts` for the `createSession` function — if it doesn't support upsert, add an `upsertOrchestratorSession` function or use `INSERT OR IGNORE` directly.

The key fields to update on re-initialization: `status` (to 'initializing'), `updated_at`, `title`. The `id`, `user_id`, `workspace`, `purpose`, `is_orchestrator` should not change.

- [ ] **Step 3: Remove channel binding and thread migration**

In `restartOrchestratorSession`, find and remove the channel binding migration block (~lines 138-175). With stable IDs, bindings already point to the right session. Remove:
- The `UPDATE channel_bindings` query
- The `UPDATE channel_thread_mappings` query
- The `UPDATE session_threads` query
- The surrounding try/catch blocks

- [ ] **Step 4: Simplify `getOrchestratorSession`**

In `packages/worker/src/lib/db/orchestrator.ts`, the `getOrchestratorSession` function (~line 132) currently finds the newest orchestrator session by ordering by `created_at DESC`. Simplify to a direct lookup:

```typescript
export async function getOrchestratorSession(db: D1Database, userId: string): Promise<AgentSession | null> {
  const result = await db.prepare(
    `SELECT * FROM sessions WHERE id = ? LIMIT 1`
  ).bind(`orchestrator:${userId}`).first();
  return result ? (result as AgentSession) : null;
}
```

Keep the old function as `getOrchestratorSessionLegacy` temporarily for the migration period, or just replace it — the migration in Task 5 ensures the stable row exists.

- [ ] **Step 5: Typecheck and run tests**

Run: `pnpm typecheck && cd packages/worker && pnpm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/worker/src/services/orchestrator.ts packages/worker/src/lib/db/orchestrator.ts
git commit -m "feat: stable orchestrator session IDs, remove binding migration"
```

---

### Task 7: Simplify `dispatchOrchestratorPrompt`

**Files:**
- Modify: `packages/worker/src/services/orchestrator.ts`

- [ ] **Step 1: Replace restart logic with `ensureRunning` call**

Replace the current `needsRestart` / identity-lookup / `restartOrchestratorSession` block in `dispatchOrchestratorPrompt` with a simple `ensureRunning` call:

```typescript
export async function dispatchOrchestratorPrompt(
  env: Env,
  params: { /* unchanged */ }
): Promise<OrchestratorPromptDispatchResult> {
  // ... content validation (unchanged) ...

  // Check if orchestrator identity exists
  const appDb = getDb(env.DB);
  const identity = await db.getOrchestratorIdentity(appDb, params.userId);
  if (!identity) {
    return { dispatched: false, sessionId: `orchestrator:${params.userId}`, reason: 'orchestrator_not_configured' };
  }

  const sessionId = `orchestrator:${params.userId}`;

  // Ensure the DO is running (wakes from hibernation, triggers recovery, etc.)
  const doId = env.SESSIONS.idFromName(sessionId);
  const sessionDO = env.SESSIONS.get(doId);

  const ensureRes = await sessionDO.fetch(new Request('http://do/ensure-running', { method: 'POST' }));
  if (ensureRes.status === 503) {
    const body = await ensureRes.json() as { status: string; retryAfterMs?: number };
    return { dispatched: false, sessionId, reason: `backoff`, retryAfterMs: body.retryAfterMs };
  }
  if (ensureRes.status === 500) {
    // DO has no spawn config — needs initial setup
    // This happens if the DO was never initialized. Initialize it now.
    // (This path handles the case where the D1 row exists but the DO is fresh/evicted)
    try {
      await initializeOrchestratorDO(env, params.userId, identity, sessionId);
    } catch (err) {
      console.error(`[OrchestratorDispatch] Failed to initialize DO:`, err);
      return { dispatched: false, sessionId, reason: 'initialization_failed' };
    }
  }

  // ... thread resolution (unchanged, but using stable sessionId) ...
  // ... channel binding (unchanged) ...
  // ... DO /prompt dispatch (unchanged) ...
}
```

- [ ] **Step 2: Extract DO initialization helper**

Create a helper function that performs the initial `/start` call on the DO — this is what `restartOrchestratorSession` does today minus the session rotation and migration. Keep it in the same file:

```typescript
/** Initialize an orchestrator DO with spawn configuration.
 *  Called during onboarding and when a DO has lost its state (eviction). */
async function initializeOrchestratorDO(
  env: Env,
  userId: string,
  identity: { id: string; name: string; handle: string; customInstructions?: string | null; personaId?: string | null },
  sessionId: string,
): Promise<void> {
  // ... assemble provider env, credentials, persona files, etc.
  // (extract from restartOrchestratorSession — the env var assembly, persona building,
  //  memory snapshot loading, DO /start call. Remove session creation and binding migration.)
}
```

- [ ] **Step 3: Update `OrchestratorPromptDispatchResult` type**

Add optional `retryAfterMs` field:

```typescript
type OrchestratorPromptDispatchResult = {
  dispatched: boolean;
  sessionId: string;
  reason?: string;
  retryAfterMs?: number;
};
```

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/services/orchestrator.ts
git commit -m "feat: simplify dispatchOrchestratorPrompt to use ensureRunning"
```

---

### Task 8: Simplify Slash Commands

**Files:**
- Modify: `packages/worker/src/routes/channel-webhooks.ts`

- [ ] **Step 1: Simplify `handleChannelCommand`**

Replace the current `handleChannelCommand` function. The key changes:
- Remove `tryRestart` helper, `getIdentity` helper, `isDead` check, `TERMINAL` set
- Remove `restartOrchestratorSession` import
- `/start` and `/refresh` call `ensureRunning` / `/refresh` on the DO
- `/status` reports sandbox ID
- `/stop` only interrupts agent, doesn't touch lifecycle
- All commands that need a running orchestrator call `ensureRunning` first or show appropriate message

```typescript
export async function handleChannelCommand(
  env: Env,
  transport: ChannelTransport,
  target: ChannelTarget,
  ctx: ChannelContext,
  message: InboundMessage,
  userId: string,
): Promise<void> {
  const command = message.command!;
  const sessionId = `orchestrator:${userId}`;

  // Check if user has an orchestrator configured
  const identity = await db.getOrchestratorIdentity(getDb(env.DB), userId);
  const NOT_CONFIGURED_MSG = 'Your orchestrator is not configured. Set it up from the Valet dashboard.';

  // Helper: call ensureRunning on the DO, return response
  const callEnsureRunning = async () => {
    const doId = env.SESSIONS.idFromName(sessionId);
    const sessionDO = env.SESSIONS.get(doId);
    return sessionDO.fetch(new Request('http://do/ensure-running', { method: 'POST' }));
  };

  switch (command) {
    case 'start': {
      if (message.senderId && target.channelType === 'telegram') {
        try {
          await db.updateTelegramOwner(getDb(env.DB), userId, message.senderId);
        } catch (err) {
          console.error(`[Channel:${target.channelType}] Failed to capture owner:`, err);
        }
      }
      if (!identity) {
        await transport.sendMessage(target, { markdown: NOT_CONFIGURED_MSG }, ctx);
        break;
      }
      const res = await callEnsureRunning();
      if (res.status === 200) {
        await transport.sendMessage(target, { markdown: 'Connected to Valet! Your orchestrator is running.' }, ctx);
      } else if (res.status === 503) {
        const body = await res.json() as { retryAfterMs?: number };
        const retryMin = Math.ceil((body.retryAfterMs || 60000) / 60000);
        await transport.sendMessage(target, { markdown: `Your orchestrator is in backoff. Retrying in ~${retryMin} min.` }, ctx);
      } else {
        await transport.sendMessage(target, { markdown: 'Connected to Valet! Starting your orchestrator...' }, ctx);
      }
      break;
    }

    case 'help': {
      const commands = SLASH_COMMANDS.filter((cmd) => cmd.availableIn.includes(transport.channelType as any));
      const text = commands.map((cmd) => `/${cmd.name} — ${cmd.description}`).join('\n');
      await transport.sendMessage(target, { markdown: `Available commands:\n${text}` }, ctx);
      break;
    }

    case 'status': {
      if (!identity) {
        await transport.sendMessage(target, { markdown: NOT_CONFIGURED_MSG }, ctx);
        break;
      }
      try {
        const doId = env.SESSIONS.idFromName(sessionId);
        const sessionDO = env.SESSIONS.get(doId);
        const resp = await sessionDO.fetch(new Request('http://do/status'));
        if (!resp.ok) {
          await transport.sendMessage(target, { markdown: 'Could not get orchestrator status.' }, ctx);
          break;
        }
        const status = (await resp.json()) as Record<string, unknown>;
        let text = `*Orchestrator Status*\nStatus: ${status.status || 'unknown'}`;
        if (status.runnerConnected) text += '\nRunner: connected';
        if (status.promptsQueued) text += `\nQueued prompts: ${status.promptsQueued}`;
        if (status.sandboxId) text += `\nSandbox: \`${status.sandboxId}\``;
        await transport.sendMessage(target, { markdown: text }, ctx);
      } catch {
        await transport.sendMessage(target, { markdown: 'Could not reach orchestrator.' }, ctx);
      }
      break;
    }

    case 'stop': {
      if (!identity) {
        await transport.sendMessage(target, { markdown: NOT_CONFIGURED_MSG }, ctx);
        break;
      }
      try {
        const doId = env.SESSIONS.idFromName(sessionId);
        const sessionDO = env.SESSIONS.get(doId);
        await sessionDO.fetch(new Request('http://do/prompt', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ interrupt: true, content: '' }),
        }));
        await sessionDO.fetch(new Request('http://do/clear-queue', { method: 'POST' }));
        await transport.sendMessage(target, { markdown: 'Stopped current work and cleared queue.' }, ctx);
      } catch {
        await transport.sendMessage(target, { markdown: 'Could not stop — orchestrator may not be running.' }, ctx);
      }
      break;
    }

    case 'clear': {
      if (!identity) {
        await transport.sendMessage(target, { markdown: NOT_CONFIGURED_MSG }, ctx);
        break;
      }
      try {
        const doId = env.SESSIONS.idFromName(sessionId);
        const sessionDO = env.SESSIONS.get(doId);
        await sessionDO.fetch(new Request('http://do/clear-queue', { method: 'POST' }));
        await transport.sendMessage(target, { markdown: 'Prompt queue cleared.' }, ctx);
      } catch {
        await transport.sendMessage(target, { markdown: 'Could not clear queue.' }, ctx);
      }
      break;
    }

    case 'refresh': {
      if (!identity) {
        await transport.sendMessage(target, { markdown: NOT_CONFIGURED_MSG }, ctx);
        break;
      }
      try {
        const doId = env.SESSIONS.idFromName(sessionId);
        const sessionDO = env.SESSIONS.get(doId);
        await sessionDO.fetch(new Request('http://do/refresh', { method: 'POST' }));
        await transport.sendMessage(target, { markdown: 'Restarting your orchestrator...' }, ctx);
      } catch {
        await transport.sendMessage(target, { markdown: 'Could not refresh — try again in a moment.' }, ctx);
      }
      break;
    }

    case 'sessions': {
      if (!identity) {
        await transport.sendMessage(target, { markdown: NOT_CONFIGURED_MSG }, ctx);
        break;
      }
      try {
        const doId = env.SESSIONS.idFromName(sessionId);
        const sessionDO = env.SESSIONS.get(doId);
        const resp = await sessionDO.fetch(new Request('http://do/children'));
        if (!resp.ok) {
          await transport.sendMessage(target, { markdown: 'Could not list sessions.' }, ctx);
          break;
        }
        const data = (await resp.json()) as {
          children?: Array<{ id: string; title?: string; status: string; workspace?: string }>;
        };
        const list = data.children || [];
        if (list.length === 0) {
          await transport.sendMessage(target, { markdown: 'No child sessions.' }, ctx);
          break;
        }
        const lines = list.map(
          (child) => `• ${child.title || child.workspace || child.id.slice(0, 8)} — ${child.status}`,
        );
        await transport.sendMessage(target, {
          markdown: `Child sessions (${list.length}):\n${lines.join('\n')}`,
        }, ctx);
      } catch {
        await transport.sendMessage(target, { markdown: 'Could not list sessions.' }, ctx);
      }
      break;
    }

    default: {
      await transport.sendMessage(target, {
        markdown: `Unknown command: /${command}. Try /help for available commands.`,
      }, ctx);
    }
  }
}
```

- [ ] **Step 2: Update imports**

Remove `restartOrchestratorSession` import. Keep `db` and `getDb` imports.

- [ ] **Step 3: Update Slack events handler dispatch failure messages**

In `packages/worker/src/routes/slack-events.ts`, update the `!result.dispatched` block to handle the new `backoff` reason:

```typescript
if (!result.dispatched) {
  const ctx: ChannelContext = { token: botToken, userId };
  const target: ChannelTarget = { channelType: 'slack', channelId: message.channelId, threadId };
  let msg: string;
  if (result.reason === 'orchestrator_not_configured') {
    msg = 'Your orchestrator is not configured. Set it up from the Valet dashboard.';
  } else if (result.reason === 'backoff') {
    const retryMin = Math.ceil((result.retryAfterMs || 60000) / 60000);
    msg = `Your orchestrator is temporarily unavailable. Retrying in ~${retryMin} min.`;
  } else {
    msg = `Failed to reach your orchestrator (${result.reason ?? 'unknown'}). Try again in a moment.`;
  }
  await transport.sendMessage(target, { markdown: msg }, ctx);
}
```

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/routes/channel-webhooks.ts packages/worker/src/routes/slack-events.ts
git commit -m "feat: simplify slash commands to use ensureRunning and /refresh DO endpoints"
```

---

### Task 9: Replace Cron Auto-Restart with Reconciliation

**Files:**
- Modify: `packages/worker/src/index.ts`

- [ ] **Step 1: Replace `autoRestartDeadOrchestrators` with `reconcileOrchestrators`**

```typescript
/**
 * Reconciliation: detect and fix orchestrator state inconsistencies.
 * Pings ensureRunning for stuck sessions, logs all anomalies for alerting.
 * Does NOT create new sessions or call restartOrchestratorSession.
 */
async function reconcileOrchestrators(env: Env): Promise<void> {
  const appDb = getDb(env.DB);

  // Find orchestrator sessions stuck in transient states for too long
  const stuckSessions = await env.DB.prepare(`
    SELECT s.id, s.user_id, s.status, s.updated_at
    FROM sessions s
    JOIN orchestrator_identities oi ON oi.user_id = s.user_id
    WHERE s.id = 'orchestrator:' || s.user_id
      AND s.status IN ('initializing', 'recovering', 'waiting_runner')
      AND s.updated_at < datetime('now', '-5 minutes')
  `).all();

  if (stuckSessions.results && stuckSessions.results.length > 0) {
    for (const row of stuckSessions.results) {
      console.error(`[OrchestratorReconcile] Session ${row.id} stuck in ${row.status} since ${row.updated_at}`);
      try {
        const doId = env.SESSIONS.idFromName(row.id as string);
        const sessionDO = env.SESSIONS.get(doId);
        await sessionDO.fetch(new Request('http://do/ensure-running', { method: 'POST' }));
      } catch (err) {
        console.error(`[OrchestratorReconcile] Failed to ping ensureRunning for ${row.id}:`, err);
      }
    }
  }

  // Find orchestrators with identities but no session row (shouldn't happen post-migration)
  const orphanedIdentities = await env.DB.prepare(`
    SELECT oi.user_id, oi.name
    FROM orchestrator_identities oi
    WHERE NOT EXISTS (
      SELECT 1 FROM sessions s WHERE s.id = 'orchestrator:' || oi.user_id
    )
  `).all();

  if (orphanedIdentities.results && orphanedIdentities.results.length > 0) {
    for (const row of orphanedIdentities.results) {
      console.error(`[OrchestratorReconcile] Orchestrator identity for user ${row.user_id} (${row.name}) has no session row`);
    }
  }
}
```

- [ ] **Step 2: Update the scheduled handler**

Replace the `autoRestartDeadOrchestrators` call (~line 282):

```typescript
// Reconcile orchestrator state (replaces autoRestartDeadOrchestrators)
try {
  await reconcileOrchestrators(env);
} catch (error) {
  console.error('[OrchestratorReconcile] Reconciliation error:', error);
}
```

- [ ] **Step 3: Remove old `autoRestartDeadOrchestrators` function and its imports**

Delete the `autoRestartDeadOrchestrators` function (~line 1122-1156). Remove the `restartOrchestratorSession` import if no longer used elsewhere in this file. Remove `getTerminatedOrchestratorSessions` import if only used by the old function.

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/index.ts
git commit -m "feat: replace orchestrator auto-restart with reconciliation cron"
```

---

### Task 10: Update Runtime State Derivation and Status Response

**Files:**
- Modify: `packages/worker/src/lib/utils/runtime.ts`
- Modify: `packages/worker/src/durable-objects/session-agent.ts` (handleStatus)

- [ ] **Step 1: Update `deriveRuntimeStates` for new lifecycle states**

Read `packages/worker/src/lib/utils/runtime.ts` and add branches for the new states in the derivation function. The new states should map to sensible runtime states:

- `waiting_runner` → sandbox state: `booting`, agent state: `waiting`
- `recovering` → sandbox state: `recovering`, agent state: `offline`
- `backoff` → sandbox state: `backoff`, agent state: `offline`

Follow the existing pattern in the file for how states are derived.

- [ ] **Step 2: Add `sandboxId` to status response**

In `handleStatus` in `session-agent.ts`, find the status response object and add `sandboxId`:

```typescript
sandboxId: this.sessionState.sandboxId || null,
```

Also add recovery state info:

```typescript
recoveryAttemptCount: this.sessionState.recoveryAttemptCount,
backoffUntil: this.sessionState.backoffUntil > 0 ? this.sessionState.backoffUntil : null,
lastFailureReason: this.sessionState.lastFailureReason || null,
sandboxGeneration: this.sessionState.sandboxGeneration,
```

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/worker/src/lib/utils/runtime.ts packages/worker/src/durable-objects/session-agent.ts
git commit -m "feat: derive runtime states for new lifecycle statuses, surface sandboxId in status"
```

---

### Task 11: Update Admin Route and Cleanup

**Files:**
- Modify: `packages/worker/src/routes/admin.ts`
- Modify: `packages/worker/src/services/orchestrator.ts`

- [ ] **Step 1: Update admin restart endpoint**

In `packages/worker/src/routes/admin.ts`, find the orchestrator restart endpoint (~line 452). Replace the `restartOrchestratorSession` call with a simpler flow:

```typescript
// Call ensureRunning on the stable DO
const sessionId = `orchestrator:${session.user_id}`;
const doId = c.env.SESSIONS.idFromName(sessionId);
const sessionDO = c.env.SESSIONS.get(doId);
const res = await sessionDO.fetch(new Request('http://do/refresh', { method: 'POST' }));

return c.json({ ok: true, newSessionId: sessionId });
```

- [ ] **Step 2: Remove `ORCHESTRATOR_UNAVAILABLE_STATUSES`**

In `packages/worker/src/services/orchestrator.ts`, remove the duplicate constant. There's `TERMINAL_STATUSES` and `ORCHESTRATOR_UNAVAILABLE_STATUSES` (identical). Remove `ORCHESTRATOR_UNAVAILABLE_STATUSES` and use `TERMINAL_SESSION_STATUSES` from `@valet/shared` instead.

- [ ] **Step 3: Remove old `restartOrchestratorSession` if no longer used**

Check all remaining callers. If the `onboardOrchestrator` flow is the only remaining user, consider inlining its logic there or keeping it as `initializeOrchestratorDO` (the helper from Task 7).

Search: `grep -rn "restartOrchestratorSession" packages/worker/src/`

Remove the function if all callers have been migrated. Update exports and imports.

- [ ] **Step 4: Clean up orchestrator route exports**

In `packages/worker/src/routes/orchestrator.ts`, check if `restartOrchestratorSession` is re-exported. Remove if so.

- [ ] **Step 5: Full typecheck and test suite**

Run: `pnpm typecheck && cd packages/worker && pnpm test`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add packages/worker/src/routes/admin.ts packages/worker/src/services/orchestrator.ts packages/worker/src/routes/orchestrator.ts
git commit -m "feat: clean up admin route, remove restartOrchestratorSession"
```

---

### Task 12: End-to-End Verification

**Files:** None (testing only)

- [ ] **Step 1: Full typecheck**

Run: `pnpm typecheck`
Expected: PASS across all packages

- [ ] **Step 2: Full test suite**

Run: `pnpm test`
Expected: ALL PASS

- [ ] **Step 3: Manual smoke test plan**

Verify these scenarios work (locally or in dev environment):

1. **Fresh orchestrator onboarding**: Create new orchestrator → session ID is `orchestrator:{userId}` → sandbox spawns → Runner connects → ready
2. **Message to dead orchestrator**: Send Slack message when orchestrator is terminated → `ensureRunning` triggers recovery → prompt queued → processed when ready
3. **`/start` when dead**: Slash command → `ensureRunning` → "Starting your orchestrator..."
4. **`/stop`**: Interrupts agent, does NOT terminate sandbox
5. **`/refresh`**: Terminates sandbox, spawns fresh
6. **`/status`**: Shows sandbox ID, lifecycle state, recovery info
7. **Hibernation cycle**: Wait for idle timeout → hibernates → send message → restores from snapshot
8. **`sandbox_lost` recovery**: Kill the sandbox externally → Runner disconnects → 60s grace period → recovery fires → fresh sandbox spawns
9. **Circuit breaker**: Force 3 consecutive sandbox failures → transitions to `backoff` → system message visible → retries after cooldown
10. **Cron reconciliation**: Check Worker logs for `[OrchestratorReconcile]` entries

- [ ] **Step 4: Deploy to dev**

Run: `ENVIRONMENT=dev make deploy`
Expected: Migration applies, worker deploys, existing orchestrators migrate to stable IDs.
