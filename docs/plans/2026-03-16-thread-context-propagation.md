# Thread Context Propagation for System Messages

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix orchestrator web UI hiding agent responses triggered by child session notifications, by propagating threadId through system message and child notification paths.

**Architecture:** When a child session is spawned, the parent's active threadId is stored in the child DO's state as `parentThreadId`. When the child notifies the parent (completion, idle), the threadId flows through `notifyParentEvent` → `/system-message` → `handleSystemMessage` → prompt_queue → runner dispatch. The UI's thread filter then correctly includes these messages.

**Tech Stack:** TypeScript, Cloudflare Durable Objects, SQLite (DO storage)

---

## File Map

All changes are in a single file:
- **Modify:** `packages/worker/src/durable-objects/session-agent.ts`

Five methods need changes:
1. `handleSpawnChild` (~line 3407) — resolve current threadId, pass to child `/start`
2. `handleStart` (~line 6263) — store `parentThreadId` in DO state
3. `notifyParentEvent` (~line 6719) — read `parentThreadId`, include in system-message body
4. `/system-message` route (~line 879) — parse `threadId` from body
5. `handleSystemMessage` (~line 6746) — accept + propagate `threadId` to all 4 queue INSERTs and `sendToRunner`

---

### Task 1: Add threadId to handleSystemMessage

The core fix. `handleSystemMessage` currently inserts into prompt_queue with only `(id, content, status)` across 4 code paths. Add `threadId` parameter and propagate it everywhere.

**Files:**
- Modify: `packages/worker/src/durable-objects/session-agent.ts:6746-6832`

- [ ] **Step 1: Update handleSystemMessage signature and system message storage**

Change the method signature to accept `threadId`:

```typescript
private async handleSystemMessage(content: string, parts?: Record<string, unknown>, wake?: boolean, threadId?: string) {
```

Also update the system message INSERT to include `thread_id` so the system message itself appears in the thread:

```typescript
if (serializedParts) {
  this.ctx.storage.sql.exec(
    'INSERT INTO messages (id, role, content, parts, thread_id) VALUES (?, ?, ?, ?, ?)',
    messageId, 'system', content, serializedParts, threadId || null
  );
} else {
  this.ctx.storage.sql.exec(
    'INSERT INTO messages (id, role, content, thread_id) VALUES (?, ?, ?, ?)',
    messageId, 'system', content, threadId || null
  );
}
```

And include `threadId` in the client broadcast:

```typescript
this.broadcastToClients({
  type: 'message',
  data: {
    id: messageId,
    role: 'system',
    content,
    parts: parts || undefined,
    ...(threadId ? { threadId } : {}),
    createdAt: Math.floor(Date.now() / 1000),
  },
});
```

- [ ] **Step 2: Propagate threadId to all 4 prompt_queue INSERTs**

Replace the 4 minimal INSERTs with ones that include `thread_id`:

Hibernated wake (line 6778-6781):
```typescript
this.ctx.storage.sql.exec(
  "INSERT INTO prompt_queue (id, content, status, thread_id) VALUES (?, ?, 'queued', ?)",
  messageId, content, threadId || null
);
```

Restoring queue (line 6785-6788):
```typescript
this.ctx.storage.sql.exec(
  "INSERT INTO prompt_queue (id, content, status, thread_id) VALUES (?, ?, 'queued', ?)",
  messageId, content, threadId || null
);
```

Running direct dispatch (line 6796-6798):
```typescript
this.ctx.storage.sql.exec(
  "INSERT INTO prompt_queue (id, content, status, thread_id) VALUES (?, ?, 'processing', ?)",
  messageId, content, threadId || null
);
```

Runner busy fallback (line 6825-6828):
```typescript
this.ctx.storage.sql.exec(
  "INSERT INTO prompt_queue (id, content, status, thread_id) VALUES (?, ?, 'queued', ?)",
  messageId, content, threadId || null
);
```

- [ ] **Step 3: Add threadId to the sendToRunner dispatch**

In the running + runner idle path (line 6809-6815), add `threadId` to the runner message:

```typescript
const sysDispatched = this.sendToRunner({
  type: 'prompt',
  messageId,
  content,
  threadId: threadId || undefined,
  opencodeSessionId: sysOcSessionId,
  modelPreferences: sysModelPrefs,
});
```

- [ ] **Step 4: Update /system-message route to parse threadId**

At line 879-885, update the body type and pass threadId through:

```typescript
case '/system-message': {
  const body = await request.json() as { content: string; parts?: Record<string, unknown>; wake?: boolean; threadId?: string };
  if (!body.content) {
    return new Response(JSON.stringify({ error: 'Missing content' }), { status: 400 });
  }
  await this.handleSystemMessage(body.content, body.parts, body.wake, body.threadId);
  return Response.json({ success: true });
}
```

- [ ] **Step 5: Update followup reminder call**

At line 1562, the followup reminder also calls `handleSystemMessage`. It should pass the thread context. Look up the followup's channel context to find the thread:

The followup reminder is a nudge about a specific channel conversation. The `channel_followups` table row has the channel context. For now, pass `undefined` — followup reminders are internal nudges that don't need thread routing. Leave a comment:

```typescript
// Followup reminders are internal nudges — no thread routing needed
await this.handleSystemMessage(reminderContent, undefined, true, undefined);
```

(This is already the behavior, just making it explicit with the new parameter.)

- [ ] **Step 6: Run typecheck**

Run: `cd packages/worker && pnpm typecheck`
Expected: PASS (or only pre-existing errors)

- [ ] **Step 7: Commit**

```bash
git add packages/worker/src/durable-objects/session-agent.ts
git commit -m "fix: propagate threadId through handleSystemMessage to all prompt dispatch paths"
```

---

### Task 2: Store parentThreadId in child DO on spawn

When spawning a child session, resolve the parent's active threadId and pass it to the child DO so the child can include it in notifications back to the parent.

**Files:**
- Modify: `packages/worker/src/durable-objects/session-agent.ts:3407-3568` (handleSpawnChild)
- Modify: `packages/worker/src/durable-objects/session-agent.ts:6263-6320` (handleStart)

- [ ] **Step 1: Resolve current threadId in handleSpawnChild**

After line 3416 (`const parentSessionId = ...`), resolve the active thread from the currently-processing prompt (same pattern used in `message.create` handler at line 2568-2574):

```typescript
// Resolve the parent's active threadId so the child can route notifications back
let parentThreadId: string | undefined;
const processingRow = this.ctx.storage.sql
  .exec("SELECT thread_id FROM prompt_queue WHERE status = 'processing' ORDER BY created_at DESC LIMIT 1")
  .toArray();
if (processingRow.length > 0 && processingRow[0].thread_id) {
  parentThreadId = processingRow[0].thread_id as string;
}
```

- [ ] **Step 2: Pass parentThreadId to child DO /start**

In the `/start` fetch body (line 3549-3566), add `parentThreadId`:

```typescript
body: JSON.stringify({
  sessionId: childSessionId,
  userId,
  workspace: params.workspace,
  runnerToken: childRunnerToken,
  backendUrl,
  terminateUrl: terminateUrl || undefined,
  hibernateUrl: hibernateUrl || undefined,
  restoreUrl: restoreUrl || undefined,
  idleTimeoutMs,
  spawnRequest: childSpawnRequest,
  initialPrompt: params.task,
  initialModel: params.model,
  parentThreadId,
}),
```

- [ ] **Step 3: Store parentThreadId in handleStart**

In `handleStart` (line 6263), update the body type to include `parentThreadId`:

After the existing state clears (around line 6309), add:

```typescript
if (body.parentThreadId) {
  this.setStateValue('parentThreadId', body.parentThreadId);
}
```

- [ ] **Step 4: Run typecheck**

Run: `cd packages/worker && pnpm typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/durable-objects/session-agent.ts
git commit -m "feat: store parentThreadId in child DO state on spawn"
```

---

### Task 3: Include threadId in notifyParentEvent

The child DO reads its stored `parentThreadId` and includes it in the system message sent to the parent.

**Files:**
- Modify: `packages/worker/src/durable-objects/session-agent.ts:6719-6744` (notifyParentEvent)

- [ ] **Step 1: Read parentThreadId and include in system-message body**

Update `notifyParentEvent` to read `parentThreadId` from state and pass it through:

```typescript
private async notifyParentEvent(content: string, options?: { wake?: boolean }) {
  try {
    const sessionId = this.getStateValue('sessionId');
    if (!sessionId) return;
    const session = await getSession(this.appDb, sessionId);
    const parentSessionId = session?.parentSessionId;
    if (!parentSessionId) return;
    const childTitle = session?.title || session?.workspace || `Child ${sessionId.slice(0, 8)}`;
    const parentThreadId = this.getStateValue('parentThreadId') || undefined;
    const parentDoId = this.env.SESSIONS.idFromName(parentSessionId);
    const parentDO = this.env.SESSIONS.get(parentDoId);
    await parentDO.fetch(new Request('http://do/system-message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content,
        parts: {
          systemTitle: childTitle,
          systemAvatarKey: 'child-session',
        },
        wake: options?.wake ?? true,
        threadId: parentThreadId,
      }),
    }));
  } catch (err) {
    console.error('[SessionAgentDO] Failed to notify parent session:', err);
  }
}
```

- [ ] **Step 2: Run typecheck**

Run: `cd packages/worker && pnpm typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/worker/src/durable-objects/session-agent.ts
git commit -m "fix: include parentThreadId in child-to-parent system message notifications"
```

---

### Task 4: Verify end-to-end and final commit

- [ ] **Step 1: Run full typecheck from root**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 2: Run tests**

Run: `pnpm test`
Expected: PASS (or only pre-existing failures)

- [ ] **Step 3: Verify the data flow**

Trace the complete path to confirm threadId flows through:

1. Parent spawns child → `handleSpawnChild` reads `processing` prompt's `thread_id` → passes `parentThreadId` to child `/start`
2. Child DO stores `parentThreadId` in state via `handleStart`
3. Child terminates → `notifyParentEvent` reads `parentThreadId` from state → includes `threadId` in `/system-message` body
4. Parent DO `/system-message` route parses `threadId` → passes to `handleSystemMessage`
5. `handleSystemMessage` stores system message with `thread_id` → inserts prompt_queue with `thread_id` → dispatches to runner with `threadId`
6. Runner receives prompt with `threadId` → processes on correct channel → `message.create` resolves `threadId` from processing prompt_queue entry
7. Agent response messages have correct `threadId` → UI thread filter includes them ✅
