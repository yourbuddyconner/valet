# Unified Prompt Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the decoupled client-side staging queue with a server-authoritative single pending slot, deferring message writes to dispatch time, and adding withdraw/promote/replace primitives.

**Architecture:** The server-side `prompt_queue` becomes the sole source of truth. User messages are written to the message store only when dispatched (not when queued). The client renders a pending card from server-broadcast state. Four primitives: enqueue, withdraw, promote, replace. Channels default to steer.

**Tech Stack:** TypeScript, Cloudflare Durable Objects (DO SQLite), React, Vitest

**Spec:** `docs/specs/2026-04-04-unified-prompt-queue-design.md`

---

## File Map

| File | Changes |
|------|---------|
| `packages/worker/src/durable-objects/prompt-queue.ts` | Fix `QueueEntry`/`dequeueNext()`/`rowToEntry()` to include `authorAvatarUrl`. Add `withdrawQueued()` and `peekQueued()` methods. |
| `packages/worker/src/durable-objects/message-store.ts` | Change `INSERT INTO` to `INSERT OR IGNORE INTO` in `writeMessage()` for crash recovery idempotency. |
| `packages/worker/src/durable-objects/session-agent.ts` | Extend `ClientMessage` type. Defer message writes in `handlePrompt`. Add `queue.withdraw`/`queue.promote`/`queue.replace` handlers. Modify `handleAbort` to stop clearing queue. Modify `sendNextQueuedPrompt` to write user message at dispatch time. Modify `handleClearQueue` to broadcast `queue.withdrawn`. Add `pendingPrompt` to init payload. |
| `packages/worker/src/durable-objects/session-agent.test.ts` | Tests for all new queue primitives and deferred write behavior. |
| `packages/worker/src/routes/channel-webhooks.ts` | Default `queueMode` to `'steer'` when binding has no mode set. |
| `packages/worker/src/services/orchestrator.ts` | Pass `queueMode: 'steer'` in `dispatchOrchestratorPrompt`. |
| `packages/client/src/hooks/use-chat.ts` | Handle `queue.state` and `queue.withdrawn` WebSocket events. Add `withdraw`/`promote`/`replace` send methods. |
| `packages/client/src/components/chat/chat-container.tsx` | Delete `stagedQueuedPrompts`. Replace with server-backed `pendingFollowup`. Rewrite pending card UI. Update input behavior (Enter/Up Arrow). |

---

### Task 1: Fix `authorAvatarUrl` in prompt queue read path

**Files:**
- Modify: `packages/worker/src/durable-objects/prompt-queue.ts:45-66` (QueueEntry), `:187-203` (dequeueNext), `:513-536` (rowToEntry)
- Test: `packages/worker/src/durable-objects/session-agent.test.ts`

This is a pre-existing bug that becomes a data loss issue with deferred writes. The `author_avatar_url` column is written at enqueue time but never read back.

- [ ] **Step 1: Add `authorAvatarUrl` to `QueueEntry` interface**

In `prompt-queue.ts`, add to the `QueueEntry` interface (after `authorName` on line ~57):

```typescript
  authorAvatarUrl: string | null;
```

- [ ] **Step 2: Add `author_avatar_url` to `dequeueNext()` SELECT**

In `prompt-queue.ts` line ~190, the SELECT query is missing `author_avatar_url`. Add it after `author_name`:

```sql
SELECT id, content, attachments, model, author_id, author_email, author_name, author_avatar_url, channel_type, ...
```

- [ ] **Step 3: Add `authorAvatarUrl` to `rowToEntry()`**

In `prompt-queue.ts` line ~525, after `authorName`:

```typescript
    authorAvatarUrl: (row.author_avatar_url as string) || null,
```

- [ ] **Step 4: Run tests**

Run: `cd packages/worker && pnpm vitest run src/durable-objects/session-agent.test.ts`
Expected: PASS (existing tests should still pass; this is additive)

- [ ] **Step 5: Run typecheck**

Run: `cd packages/worker && pnpm typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/worker/src/durable-objects/prompt-queue.ts
git commit -m "fix(prompt-queue): include authorAvatarUrl in QueueEntry read path

The author_avatar_url column was written at enqueue time but never
read back by dequeueNext() or rowToEntry(). This becomes a data
loss bug when user message writes are deferred to dispatch time."
```

---

### Task 2: Add `withdrawQueued()` and `peekQueued()` methods to PromptQueue, make `writeMessage` idempotent

**Files:**
- Modify: `packages/worker/src/durable-objects/prompt-queue.ts`
- Modify: `packages/worker/src/durable-objects/message-store.ts:220-221`
- Test: `packages/worker/src/durable-objects/session-agent.test.ts`

Two new methods: `withdrawQueued()` removes and returns the single queued user-prompt entry, `peekQueued()` reads it without removing. Both scoped to `queue_type = 'prompt'` and `child_session_id IS NULL`. Also make `writeMessage` idempotent for crash recovery.

- [ ] **Step 1: Write the test**

In `session-agent.test.ts`, add a test that enqueues a user prompt, then calls `withdrawQueued()` and verifies it returns the entry and removes it from the queue:

```typescript
  it('withdrawQueued removes and returns the single queued user prompt', async () => {
    const { agent } = await createTestAgent();

    (agent as any).promptQueue.enqueue({
      id: 'withdraw-test',
      content: 'pending message',
      status: 'queued',
      channelType: 'web',
      channelId: 'default',
      channelKey: 'web:default',
      threadId: 'thread-1',
      authorId: 'user-1',
      authorEmail: 'user@test.com',
      authorName: 'Test User',
      authorAvatarUrl: 'https://example.com/avatar.png',
    });

    expect((agent as any).promptQueue.length).toBe(1);

    const withdrawn = (agent as any).promptQueue.withdrawQueued();
    expect(withdrawn).toBeTruthy();
    expect(withdrawn.id).toBe('withdraw-test');
    expect(withdrawn.content).toBe('pending message');
    expect(withdrawn.threadId).toBe('thread-1');
    expect(withdrawn.authorAvatarUrl).toBe('https://example.com/avatar.png');
    expect((agent as any).promptQueue.length).toBe(0);
  });

  it('withdrawQueued returns null when no queued user prompt exists', async () => {
    const { agent } = await createTestAgent();
    const withdrawn = (agent as any).promptQueue.withdrawQueued();
    expect(withdrawn).toBeNull();
  });

  it('withdrawQueued does not remove child session events', async () => {
    const { agent } = await createTestAgent();

    (agent as any).promptQueue.enqueue({
      id: 'child-event',
      content: 'child status update',
      status: 'queued',
      childSessionId: 'child-1',
      childStatus: 'terminated',
    });

    const withdrawn = (agent as any).promptQueue.withdrawQueued();
    expect(withdrawn).toBeNull();
    expect((agent as any).promptQueue.length).toBe(1);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/worker && pnpm vitest run src/durable-objects/session-agent.test.ts`
Expected: FAIL — `withdrawQueued` is not defined

- [ ] **Step 3: Implement `withdrawQueued()` and `peekQueued()`**

In `prompt-queue.ts`, add after the `clearQueued()` method (~line 263):

```typescript
  private static readonly USER_PROMPT_QUERY = "SELECT id, content, attachments, model, author_id, author_email, author_name, author_avatar_url, channel_type, channel_id, channel_key, queue_type, workflow_execution_id, workflow_payload, thread_id, continuation_context, context_prefix, reply_channel_type, reply_channel_id, child_session_id, child_status FROM prompt_queue WHERE status = 'queued' AND queue_type = 'prompt' AND child_session_id IS NULL ORDER BY created_at ASC LIMIT 1";

  /** Read the single queued user-prompt entry without removing it. Returns null if none. */
  peekQueued(): QueueEntry | null {
    const rows = this.sql.exec(PromptQueue.USER_PROMPT_QUERY).toArray();
    if (rows.length === 0) return null;
    return this.rowToEntry(rows[0]);
  }

  /** Remove and return the single queued user-prompt entry (not child events, not workflows). Returns null if none. */
  withdrawQueued(): QueueEntry | null {
    const rows = this.sql.exec(PromptQueue.USER_PROMPT_QUERY).toArray();
    if (rows.length === 0) return null;
    const row = rows[0];
    this.sql.exec("DELETE FROM prompt_queue WHERE id = ?", row.id as string);
    return this.rowToEntry(row);
  }
```

- [ ] **Step 4: Make `writeMessage` idempotent**

In `message-store.ts` line 221, change `INSERT INTO` to `INSERT OR IGNORE INTO`:

```sql
INSERT OR IGNORE INTO messages (id, seq, role, content, parts, ...)
```

This prevents duplicate message writes when `revertProcessingToQueued` re-dispatches an entry that was partially processed before a crash.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/worker && pnpm vitest run src/durable-objects/session-agent.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/durable-objects/prompt-queue.ts packages/worker/src/durable-objects/session-agent.test.ts
git commit -m "feat(prompt-queue): add withdrawQueued() for pending slot removal

Returns and removes the single queued user-prompt entry, scoped to
queue_type='prompt' and child_session_id IS NULL so child events and
workflow entries are not affected."
```

---

### Task 3: Defer message write in `handlePrompt` — enqueue path

**Files:**
- Modify: `packages/worker/src/durable-objects/session-agent.ts:1458-1560`
- Test: `packages/worker/src/durable-objects/session-agent.test.ts`

Move the `messageStore.writeMessage`, client broadcast, `incrementThreadMessageCount`, and `thread.created` out of the top of `handlePrompt` and into a conditional that only runs on the direct-dispatch path. The enqueue paths skip these — they will happen at dispatch time in `sendNextQueuedPrompt` (Task 5).

- [ ] **Step 1: Write the test**

```typescript
  it('does not write user message to message store when prompt is queued (runner busy)', async () => {
    const runnerSocket = { send: vi.fn() };
    const { agent, broadcasts } = await createTestAgent({ sockets: [runnerSocket] });

    // Make runner busy
    (agent as any).promptQueue.runnerBusy = true;

    await (agent as any).handlePrompt(
      'queued message',
      undefined,
      { id: 'user-1', email: 'u@test.com', name: 'User' },
      undefined,
      'web',
      'default',
      undefined,
    );

    // The message should NOT be in the message store
    const messages = (agent as any).messageStore.sql
      .exec("SELECT * FROM messages WHERE content = 'queued message'")
      .toArray();
    expect(messages).toHaveLength(0);

    // The message broadcast should NOT have been sent
    const userMsgBroadcast = broadcasts.find(
      (b) => b.type === 'message' && b.data?.role === 'user' && b.data?.content === 'queued message'
    );
    expect(userMsgBroadcast).toBeUndefined();

    // But the queue entry SHOULD exist
    expect((agent as any).promptQueue.length).toBe(1);
  });

  it('writes user message to message store when prompt dispatches directly (runner idle)', async () => {
    const runnerSocket = { send: vi.fn() };
    const { agent, broadcasts } = await createTestAgent({ sockets: [runnerSocket] });

    await (agent as any).handlePrompt(
      'direct message',
      undefined,
      { id: 'user-1', email: 'u@test.com', name: 'User' },
      undefined,
      'web',
      'default',
      undefined,
    );

    // The message SHOULD be in the message store
    const messages = (agent as any).messageStore.sql
      .exec("SELECT * FROM messages WHERE content = 'direct message'")
      .toArray();
    expect(messages).toHaveLength(1);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/worker && pnpm vitest run src/durable-objects/session-agent.test.ts`
Expected: FAIL — the first test fails because `handlePrompt` still writes the message immediately

- [ ] **Step 3: Refactor `handlePrompt` to defer writes on enqueue paths**

In `session-agent.ts`, the message write block (lines 1458-1496) currently runs unconditionally. Move it into a helper method and call it only on the direct-dispatch path.

The key change: lines 1458-1496 (message write + broadcast + thread bookkeeping) should be extracted into a method like `writeAndBroadcastUserMessage(messageId, content, attachmentParts, author, channelType, channelId, threadId)`. Then:

- The two enqueue paths (lines 1527-1553 for no-runner and 1555-1575 for runner-busy) should NOT call this method.
- The direct-dispatch path (lines 1577+) should call it before dispatching.
- After enqueue, broadcast `queue.state` with the pending item instead of a user message.

The enqueue blocks should broadcast:

```typescript
this.broadcastToClients({
  type: 'queue.state',
  data: {
    pending: {
      messageId,
      content,
      attachments: normalizedAttachments.length > 0 ? normalizedAttachments : undefined,
      threadId,
    },
  },
});
```

- [ ] **Step 4: Add single-slot enforcement**

Before enqueueing on the runner-busy path, check for an existing queued user-prompt and withdraw it:

```typescript
// Single-slot enforcement: withdraw existing pending before enqueueing new
const existingPending = this.promptQueue.withdrawQueued();
if (existingPending) {
  this.broadcastToClients({
    type: 'queue.withdrawn',
    data: {
      messageId: existingPending.id,
      content: existingPending.content,
      attachments: existingPending.attachments ? JSON.parse(existingPending.attachments) : undefined,
      threadId: existingPending.threadId,
    },
  });
  this.emitAuditEvent('user.queue_withdraw', `Replaced pending prompt ${existingPending.id}`);
}
```

- [ ] **Step 5: Write test for single-slot enforcement**

```typescript
  it('single-slot enforcement: new followup replaces existing pending', async () => {
    const runnerSocket = { send: vi.fn() };
    const { agent, broadcasts } = await createTestAgent({ sockets: [runnerSocket] });

    (agent as any).promptQueue.runnerBusy = true;

    // Queue first followup
    await (agent as any).handlePrompt(
      'first followup',
      undefined, undefined, undefined,
      'web', 'default', undefined,
    );

    expect((agent as any).promptQueue.length).toBe(1);

    // Queue second followup — should replace the first
    await (agent as any).handlePrompt(
      'second followup',
      undefined, undefined, undefined,
      'web', 'default', undefined,
    );

    expect((agent as any).promptQueue.length).toBe(1);

    // First should have been withdrawn
    const withdrawn = broadcasts.find((b) => b.type === 'queue.withdrawn');
    expect(withdrawn).toBeTruthy();
    expect(withdrawn.data.content).toBe('first followup');

    // Queue should contain only the second
    const pending = (agent as any).promptQueue.peekQueued();
    expect(pending.content).toBe('second followup');
  });
```

- [ ] **Step 6: Run tests**

Run: `cd packages/worker && pnpm vitest run src/durable-objects/session-agent.test.ts`
Expected: PASS

- [ ] **Step 7: Run typecheck**

Run: `cd packages/worker && pnpm typecheck`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add packages/worker/src/durable-objects/session-agent.ts packages/worker/src/durable-objects/session-agent.test.ts
git commit -m "feat(session-agent): defer user message write to dispatch time

When the runner is busy, handlePrompt now stores prompts in
prompt_queue without writing to the message store or broadcasting
the user message. The write + broadcast + thread bookkeeping happen
at dispatch time in sendNextQueuedPrompt. Also enforces single-slot:
only one queued user prompt at a time."
```

---

### Task 4: Modify `handleAbort` to stop clearing the queue

**Files:**
- Modify: `packages/worker/src/durable-objects/session-agent.ts:1663-1685`
- Test: `packages/worker/src/durable-objects/session-agent.test.ts`

Remove all `clearQueued()` calls from `handleAbort`. Steer and abort no longer destroy the pending slot.

- [ ] **Step 1: Write the test**

```typescript
  it('handleAbort does not clear queued prompts', async () => {
    const runnerSocket = { send: vi.fn() };
    const { agent } = await createTestAgent({ sockets: [runnerSocket] });

    // Queue a pending followup
    (agent as any).promptQueue.enqueue({
      id: 'pending-1',
      content: 'pending work',
      status: 'queued',
      channelType: 'web',
      channelId: 'default',
      channelKey: 'web:default',
    });

    (agent as any).promptQueue.runnerBusy = true;

    // Abort should NOT clear the queue
    await (agent as any).handleAbort('web', 'default');

    expect((agent as any).promptQueue.length).toBe(1);
    expect(runnerSocket.send).toHaveBeenCalledWith(
      expect.stringContaining('"type":"abort"')
    );
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/worker && pnpm vitest run src/durable-objects/session-agent.test.ts`
Expected: FAIL — `handleAbort` still calls `clearQueued()`

- [ ] **Step 3: Remove `clearQueued()` from `handleAbort`**

In `session-agent.ts` lines 1663-1685, remove both `clearQueued()` calls:

```typescript
private async handleAbort(channelType?: string, channelId?: string) {
  if (channelType && channelId) {
    this.runnerLink.send({ type: 'abort', channelType, channelId });
  } else {
    this.runnerLink.send({ type: 'abort' });
  }

  // Broadcast status immediately (runner will confirm with 'aborted')
  this.broadcastToClients({
    type: 'agentStatus',
    status: 'idle',
  });

  // Clear promptReceivedAt so stale timestamps don't inflate turn_complete durations
  this.promptQueue.clearPromptReceived();

  this.emitAuditEvent('user.abort', `User aborted agent${channelType ? ` (channel: ${channelType}:${channelId})` : ''}`);
}
```

- [ ] **Step 4: Run tests**

Run: `cd packages/worker && pnpm vitest run src/durable-objects/session-agent.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/durable-objects/session-agent.ts packages/worker/src/durable-objects/session-agent.test.ts
git commit -m "fix(session-agent): abort no longer clears the pending slot

handleAbort previously called clearQueued() which destroyed the
user's pending followup. Now it only sends abort to the runner.
The pending item dispatches after the abort completes."
```

---

### Task 5: Write user message at dispatch time in `sendNextQueuedPrompt`

**Files:**
- Modify: `packages/worker/src/durable-objects/session-agent.ts:4044-4220`
- Test: `packages/worker/src/durable-objects/session-agent.test.ts`

When `sendNextQueuedPrompt` dequeues a user prompt, it must now write the user message to the message store, broadcast it to clients, call `incrementThreadMessageCount`, broadcast `thread.created`, and emit the `user.prompt` audit event — all before dispatching to the runner. The write must be idempotent (`INSERT OR IGNORE` on `messageId`) to handle crash recovery where `revertProcessingToQueued` puts an entry back that was already partially dispatched.

- [ ] **Step 1: Write the test**

```typescript
  it('sendNextQueuedPrompt writes user message to message store at dispatch time', async () => {
    const runnerSocket = { send: vi.fn() };
    const { agent, broadcasts } = await createTestAgent({ sockets: [runnerSocket] });

    // Enqueue a prompt (simulating deferred write)
    (agent as any).promptQueue.enqueue({
      id: 'deferred-msg',
      content: 'deferred content',
      status: 'queued',
      channelType: 'thread',
      channelId: 'thread-abc',
      channelKey: 'thread:thread-abc',
      threadId: 'thread-abc',
      authorId: 'user-1',
      authorEmail: 'u@test.com',
      authorName: 'Test User',
      authorAvatarUrl: 'https://example.com/avatar.png',
    });

    // Before dispatch: message should NOT be in store
    let messages = (agent as any).messageStore.sql
      .exec("SELECT * FROM messages WHERE id = 'deferred-msg'")
      .toArray();
    expect(messages).toHaveLength(0);

    // Dispatch
    const dispatched = await (agent as any).sendNextQueuedPrompt();
    expect(dispatched).toBe(true);

    // After dispatch: message SHOULD be in store
    messages = (agent as any).messageStore.sql
      .exec("SELECT * FROM messages WHERE id = 'deferred-msg'")
      .toArray();
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('user');
    expect(messages[0].content).toBe('deferred content');

    // User message should have been broadcast
    const userMsgBroadcast = broadcasts.find(
      (b) => b.type === 'message' && b.data?.id === 'deferred-msg' && b.data?.role === 'user'
    );
    expect(userMsgBroadcast).toBeTruthy();

    // queue.state should have been broadcast with pending: null
    const queueState = broadcasts.find((b) => b.type === 'queue.state');
    expect(queueState?.data?.pending).toBeNull();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/worker && pnpm vitest run src/durable-objects/session-agent.test.ts`
Expected: FAIL — `sendNextQueuedPrompt` doesn't write user messages

- [ ] **Step 3: Implement deferred write in `sendNextQueuedPrompt`**

In `session-agent.ts`, after the dequeue loop finds a valid `prompt` entry (~line 4100, the `break` at the end of the while loop), add before the dispatch logic:

```typescript
    // ─── Deferred user message write ───────────────────────────────────
    // User messages are not written to the message store at enqueue time.
    // Write + broadcast now at dispatch time. Idempotent: uses INSERT OR IGNORE
    // to handle re-dispatch after revertProcessingToQueued crash recovery.
    if (prompt.queueType === 'prompt' && !prompt.childSessionId) {
      const attachmentParts = prompt.attachments ? attachmentPartsForMessage(JSON.parse(prompt.attachments)) : [];
      this.messageStore.writeMessage({
        id: prompt.id,
        role: 'user',
        content: prompt.content,
        parts: attachmentParts.length > 0 ? JSON.stringify(attachmentParts) : null,
        author: prompt.authorId ? {
          id: prompt.authorId,
          email: prompt.authorEmail || undefined,
          name: prompt.authorName || undefined,
          avatarUrl: prompt.authorAvatarUrl || undefined,
        } : undefined,
        channelType: prompt.channelType || undefined,
        channelId: prompt.channelId || undefined,
        threadId: prompt.threadId || undefined,
      });

      // Thread bookkeeping (deferred from enqueue time)
      if (prompt.threadId) {
        this.ctx.waitUntil(incrementThreadMessageCount(this.env.DB, prompt.threadId));
        this.broadcastToClients({ type: 'thread.created', threadId: prompt.threadId });
      }

      // Broadcast user message to clients (message enters the chat at this point)
      this.broadcastToClients({
        type: 'message',
        data: {
          id: prompt.id,
          role: 'user',
          content: prompt.content,
          parts: attachmentParts.length > 0 ? attachmentParts : undefined,
          authorId: prompt.authorId,
          authorEmail: prompt.authorEmail,
          authorName: prompt.authorName,
          authorAvatarUrl: prompt.authorAvatarUrl,
          channelType: prompt.channelType,
          channelId: prompt.channelId,
          threadId: prompt.threadId,
          createdAt: Math.floor(Date.now() / 1000),
        },
      });

      this.emitAuditEvent('user.prompt', prompt.content?.slice(0, 120) || '[empty]', prompt.authorId || undefined);

      // Broadcast queue.state to clear the pending card
      this.broadcastToClients({
        type: 'queue.state',
        data: { pending: null },
      });
    }
```

Also ensure `messageStore.writeMessage` uses `INSERT OR IGNORE` (or equivalent) for idempotency. Check the current implementation — if it uses `INSERT INTO`, change to `INSERT OR IGNORE INTO`.

- [ ] **Step 4: Run tests**

Run: `cd packages/worker && pnpm vitest run src/durable-objects/session-agent.test.ts`
Expected: PASS

- [ ] **Step 5: Run typecheck**

Run: `cd packages/worker && pnpm typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/worker/src/durable-objects/session-agent.ts packages/worker/src/durable-objects/session-agent.test.ts
git commit -m "feat(session-agent): write user message at dispatch time in sendNextQueuedPrompt

When dequeuing a user prompt, write the user message to the message
store, broadcast to clients, call incrementThreadMessageCount, and
emit audit event. Message write is idempotent for crash recovery.
Broadcasts queue.state with pending:null to clear the pending card."
```

---

### Task 6: Add `queue.withdraw`, `queue.promote`, `queue.replace` handlers

**Files:**
- Modify: `packages/worker/src/durable-objects/session-agent.ts:65-83` (ClientMessage type), `:1230-1243` (WebSocket handler)
- Test: `packages/worker/src/durable-objects/session-agent.test.ts`

Add three new WebSocket message handlers. Extend `ClientMessage` type.

- [ ] **Step 1: Extend `ClientMessage` type**

In `session-agent.ts` line 66, add the new message types:

```typescript
interface ClientMessage {
  type: 'prompt' | 'answer' | 'ping' | 'abort' | 'revert' | 'diff' | 'review' | 'command' | 'approve-action' | 'deny-action' | 'queue.withdraw' | 'queue.promote' | 'queue.replace';
  // ... rest unchanged
}
```

- [ ] **Step 2: Write tests for withdraw**

```typescript
  it('queue.withdraw removes pending and broadcasts content', async () => {
    const { agent, broadcasts } = await createTestAgent();

    (agent as any).promptQueue.enqueue({
      id: 'pending-withdraw',
      content: 'withdraw me',
      status: 'queued',
      channelType: 'web',
      channelId: 'default',
      channelKey: 'web:default',
      threadId: 'thread-1',
    });

    await (agent as any).handleClientMessage({
      type: 'queue.withdraw',
    });

    expect((agent as any).promptQueue.length).toBe(0);

    const withdrawn = broadcasts.find((b) => b.type === 'queue.withdrawn');
    expect(withdrawn).toBeTruthy();
    expect(withdrawn.data.messageId).toBe('pending-withdraw');
    expect(withdrawn.data.content).toBe('withdraw me');
    expect(withdrawn.data.threadId).toBe('thread-1');
  });

  it('queue.withdraw is silent no-op when nothing is queued', async () => {
    const { agent, broadcasts } = await createTestAgent();

    await (agent as any).handleClientMessage({
      type: 'queue.withdraw',
    });

    const withdrawn = broadcasts.find((b) => b.type === 'queue.withdrawn');
    expect(withdrawn).toBeUndefined();
  });
```

- [ ] **Step 3: Write tests for promote**

```typescript
  it('queue.promote atomically withdraws, aborts, and dispatches', async () => {
    const runnerSocket = { send: vi.fn() };
    const { agent, broadcasts } = await createTestAgent({ sockets: [runnerSocket] });

    (agent as any).promptQueue.runnerBusy = true;

    (agent as any).promptQueue.enqueue({
      id: 'pending-promote',
      content: 'promote me',
      status: 'queued',
      channelType: 'web',
      channelId: 'default',
      channelKey: 'web:default',
      authorId: 'user-1',
      authorEmail: 'u@test.com',
      authorName: 'User',
    });

    await (agent as any).handleClientMessage({
      type: 'queue.promote',
    });

    // Should have sent abort
    const abortSent = runnerSocket.send.mock.calls.some(
      (call) => JSON.parse(call[0]).type === 'abort'
    );
    expect(abortSent).toBe(true);

    // The pending entry should have been re-enqueued for dispatch
    // (handleAbort + handlePrompt flow will enqueue it)
    // Queue state should have been broadcast
    const queueState = broadcasts.find((b) => b.type === 'queue.state');
    expect(queueState).toBeTruthy();
  });

  it('queue.promote dispatches directly when runner is idle', async () => {
    const runnerSocket = { send: vi.fn() };
    const { agent, broadcasts } = await createTestAgent({ sockets: [runnerSocket] });

    (agent as any).promptQueue.enqueue({
      id: 'pending-idle-promote',
      content: 'promote when idle',
      status: 'queued',
      channelType: 'web',
      channelId: 'default',
      channelKey: 'web:default',
    });

    await (agent as any).handleClientMessage({
      type: 'queue.promote',
    });

    // Should have dispatched directly (no abort needed)
    const promptSent = runnerSocket.send.mock.calls.some(
      (call) => JSON.parse(call[0]).type === 'prompt'
    );
    expect(promptSent).toBe(true);
  });
```

- [ ] **Step 4: Write test for replace**

```typescript
  it('queue.replace withdraws old, aborts, and dispatches new content', async () => {
    const runnerSocket = { send: vi.fn() };
    const { agent, broadcasts } = await createTestAgent({ sockets: [runnerSocket] });

    (agent as any).promptQueue.runnerBusy = true;

    (agent as any).promptQueue.enqueue({
      id: 'old-pending',
      content: 'old content',
      status: 'queued',
      channelType: 'web',
      channelId: 'default',
      channelKey: 'web:default',
    });

    await (agent as any).handleClientMessage({
      type: 'queue.replace',
      content: 'new replacement content',
    });

    // Old entry should have been withdrawn
    const withdrawn = broadcasts.find((b) => b.type === 'queue.withdrawn');
    expect(withdrawn).toBeTruthy();
    expect(withdrawn.data.content).toBe('old content');

    // Abort should have been sent
    const abortSent = runnerSocket.send.mock.calls.some(
      (call) => JSON.parse(call[0]).type === 'abort'
    );
    expect(abortSent).toBe(true);
  });
```

- [ ] **Step 5: Implement the three handlers**

In `session-agent.ts`, in the `handleClientMessage` WebSocket handler (around line 1230), add cases for the new message types:

```typescript
case 'queue.withdraw': {
  const withdrawn = this.promptQueue.withdrawQueued();
  if (withdrawn) {
    this.broadcastToClients({
      type: 'queue.withdrawn',
      data: {
        messageId: withdrawn.id,
        content: withdrawn.content,
        attachments: withdrawn.attachments ? JSON.parse(withdrawn.attachments) : undefined,
        threadId: withdrawn.threadId,
      },
    });
    this.broadcastToClients({
      type: 'queue.state',
      data: { pending: null },
    });
    this.emitAuditEvent('user.queue_withdraw', `Withdrew pending prompt ${withdrawn.id}`);
  }
  break;
}

case 'queue.promote': {
  const entry = this.promptQueue.withdrawQueued();
  if (!entry) break; // no-op if already dispatched

  const runnerBusy = this.promptQueue.runnerBusy;
  if (runnerBusy) {
    await this.handleAbort();
  }

  // Dispatch the withdrawn entry via handlePrompt (which will write the message
  // since the runner is now idle/aborting)
  await this.handlePrompt(
    entry.content,
    entry.model || undefined,
    entry.authorId ? { id: entry.authorId, email: entry.authorEmail || '', name: entry.authorName || undefined, avatarUrl: entry.authorAvatarUrl || undefined } : undefined,
    entry.attachments ? JSON.parse(entry.attachments) : undefined,
    entry.channelType || undefined,
    entry.channelId || undefined,
    entry.threadId || undefined,
    entry.continuationContext || undefined,
    entry.contextPrefix || undefined,
    entry.replyChannelType && entry.replyChannelId
      ? { channelType: entry.replyChannelType, channelId: entry.replyChannelId }
      : undefined,
  );
  this.emitAuditEvent('user.queue_promote', `Promoted pending prompt ${entry.id}`);
  break;
}

case 'queue.replace': {
  // Withdraw existing pending (if any)
  const existing = this.promptQueue.withdrawQueued();
  if (existing) {
    this.broadcastToClients({
      type: 'queue.withdrawn',
      data: {
        messageId: existing.id,
        content: existing.content,
        attachments: existing.attachments ? JSON.parse(existing.attachments) : undefined,
        threadId: existing.threadId,
      },
    });
    this.emitAuditEvent('user.queue_withdraw', `Replaced pending prompt ${existing.id}`);
  }

  // Abort + dispatch new content as steer
  await this.handleInterruptPrompt(
    msg.content || '',
    msg.model,
    author,
    attachments,
    (msg as any).channelType,
    (msg as any).channelId,
    (msg as any).threadId,
  );
  this.emitAuditEvent('user.queue_replace', `Replaced with new content`);
  break;
}
```

- [ ] **Step 6: Run tests**

Run: `cd packages/worker && pnpm vitest run src/durable-objects/session-agent.test.ts`
Expected: PASS

- [ ] **Step 7: Run typecheck**

Run: `cd packages/worker && pnpm typecheck`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add packages/worker/src/durable-objects/session-agent.ts packages/worker/src/durable-objects/session-agent.test.ts
git commit -m "feat(session-agent): add queue.withdraw, queue.promote, queue.replace handlers

Three new WebSocket message handlers for the unified prompt queue:
- withdraw: remove pending item, broadcast content to clients
- promote: atomic withdraw + abort + dispatch (no race window)
- replace: atomic withdraw old + steer with new content
All emit audit events for observability."
```

---

### Task 7: Add `pendingPrompt` to init payload and update `handleClearQueue`

**Files:**
- Modify: `packages/worker/src/durable-objects/session-agent.ts:573-589` (init), `:4274-4283` (handleClearQueue)

- [ ] **Step 1: Add `pendingPrompt` to init payload**

In `session-agent.ts` at the init payload construction (~line 573), use `peekQueued()` (added in Task 2) to read the pending item without removing it:

```typescript
// Read pending user prompt for the init payload
const pendingEntry = this.promptQueue.peekQueued();
const pendingPrompt = pendingEntry ? {
  messageId: pendingEntry.id,
  content: pendingEntry.content,
  attachments: pendingEntry.attachments ? JSON.parse(pendingEntry.attachments) : undefined,
  threadId: pendingEntry.threadId || undefined,
} : null;
```

Then add `pendingPrompt` to the init payload JSON:

```typescript
const initPayload = JSON.stringify({
  type: 'init',
  session: { id: sessionId, status, workspace, title },
  data: {
    sandboxRunning: !!sandboxId,
    runnerConnected: this.runnerLink.isConnected,
    runnerBusy: this.promptQueue.runnerBusy,
    promptsQueued: this.promptQueue.length,
    pendingPrompt,
    connectedClients: this.getClientSockets().length + 1,
    connectedUsers,
  },
});
```

- [ ] **Step 2: Update `handleClearQueue` to broadcast `queue.withdrawn`**

In `session-agent.ts` lines 4274-4283, update:

```typescript
private async handleClearQueue(): Promise<Response> {
  // Withdraw pending user prompt and broadcast
  const pending = this.promptQueue.withdrawQueued();
  if (pending) {
    this.broadcastToClients({
      type: 'queue.withdrawn',
      data: {
        messageId: pending.id,
        content: pending.content,
        attachments: pending.attachments ? JSON.parse(pending.attachments) : undefined,
        threadId: pending.threadId,
      },
    });
  }

  // Clear remaining queued entries (workflow events, child events)
  const cleared = this.promptQueue.clearQueued();

  this.broadcastToClients({
    type: 'queue.state',
    data: { pending: null },
  });

  // Keep legacy broadcast for backwards compatibility
  this.broadcastToClients({
    type: 'status',
    data: { queueCleared: true, cleared: cleared + (pending ? 1 : 0) },
  });

  return Response.json({ success: true, cleared: cleared + (pending ? 1 : 0) });
}
```

- [ ] **Step 3: Write test for init payload including `pendingPrompt`**

```typescript
  it('init payload includes pendingPrompt when a followup is queued', async () => {
    const { agent, broadcasts } = await createTestAgent();

    (agent as any).promptQueue.enqueue({
      id: 'init-pending',
      content: 'queued before connect',
      status: 'queued',
      channelType: 'web',
      channelId: 'default',
      channelKey: 'web:default',
      threadId: 'thread-init',
    });

    // Simulate a new client connecting (re-read init)
    // The init payload construction uses peekQueued()
    const pending = (agent as any).promptQueue.peekQueued();
    expect(pending).toBeTruthy();
    expect(pending.id).toBe('init-pending');
    expect(pending.content).toBe('queued before connect');
    expect(pending.threadId).toBe('thread-init');

    // Queue entry should still exist (peek, not withdraw)
    expect((agent as any).promptQueue.length).toBe(1);
  });
```

- [ ] **Step 4: Write test for `handleClearQueue` broadcasting `queue.withdrawn`**

```typescript
  it('handleClearQueue broadcasts queue.withdrawn for pending user prompt', async () => {
    const { agent, broadcasts } = await createTestAgent();

    (agent as any).promptQueue.enqueue({
      id: 'clear-pending',
      content: 'will be cleared',
      status: 'queued',
      channelType: 'web',
      channelId: 'default',
      channelKey: 'web:default',
    });

    await (agent as any).handleClearQueue();

    const withdrawn = broadcasts.find((b) => b.type === 'queue.withdrawn');
    expect(withdrawn).toBeTruthy();
    expect(withdrawn.data.content).toBe('will be cleared');

    const queueState = broadcasts.find((b) => b.type === 'queue.state');
    expect(queueState?.data?.pending).toBeNull();

    expect((agent as any).promptQueue.length).toBe(0);
  });
```

- [ ] **Step 5: Run tests + typecheck**

Run: `cd packages/worker && pnpm vitest run src/durable-objects/session-agent.test.ts && pnpm typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/worker/src/durable-objects/prompt-queue.ts packages/worker/src/durable-objects/session-agent.ts packages/worker/src/durable-objects/session-agent.test.ts
git commit -m "feat(session-agent): add pendingPrompt to init, update handleClearQueue

Init payload now includes the pending user prompt so connecting
clients can hydrate the pending card. handleClearQueue broadcasts
queue.withdrawn for the pending item and queue.state for cleanup."
```

---

### Task 8: Default channels to steer

**Files:**
- Modify: `packages/worker/src/routes/channel-webhooks.ts:270-273`
- Modify: `packages/worker/src/services/orchestrator.ts:443-458`

- [ ] **Step 1: Default `queueMode` to `'steer'` in channel webhooks**

In `channel-webhooks.ts` line ~273, the bound session dispatch passes `queueMode: binding.queueMode`. Change to default to steer:

```typescript
queueMode: binding.queueMode || 'steer',
```

- [ ] **Step 2: Pass `queueMode: 'steer'` in `dispatchOrchestratorPrompt`**

In `orchestrator.ts`, in the DO fetch call (~line 449), add `queueMode` to the request body:

```typescript
body: JSON.stringify({
  content,
  contextPrefix: params.contextPrefix,
  channelType: params.channelType,
  channelId: params.channelId,
  threadId: params.threadId,
  attachments: params.attachments,
  authorName: params.authorName,
  authorEmail: params.authorEmail,
  authorId: params.userId,
  replyTo: params.replyTo,
  queueMode: 'steer',
}),
```

- [ ] **Step 3: Run typecheck**

Run: `cd packages/worker && pnpm typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/worker/src/routes/channel-webhooks.ts packages/worker/src/services/orchestrator.ts
git commit -m "feat(channels): default channel integrations to steer queue mode

Channel webhooks default to queueMode='steer' when the binding has
no explicit mode. Orchestrator dispatch always uses steer. Individual
integrations can opt into followup via channel_bindings.queueMode."
```

---

### Task 9: Client — handle `queue.state` and `queue.withdrawn` events

**Files:**
- Modify: `packages/client/src/hooks/use-chat.ts:744-790` (WebSocket handler), `:1149-1180` (sendMessage)

- [ ] **Step 1: Add `pendingFollowup` to chat state**

In `use-chat.ts`, add to the state interface:

```typescript
pendingFollowup: { messageId: string; content: string; attachments?: unknown; threadId?: string } | null;
```

Initialize as `null`. Hydrate from `initPayload.data.pendingPrompt` in the init handler.

- [ ] **Step 2: Handle `queue.state` and `queue.withdrawn` WebSocket events**

In the WebSocket message handler, add cases:

```typescript
case 'queue.state': {
  setState((prev) => ({
    ...prev,
    pendingFollowup: message.data?.pending ?? null,
  }));
  break;
}

case 'queue.withdrawn': {
  setState((prev) => ({
    ...prev,
    pendingFollowup: null,
  }));
  // Store withdrawn content for the UI to decide what to do with
  if (message.data) {
    onQueueWithdrawn?.(message.data);
  }
  break;
}
```

- [ ] **Step 3: Add `withdraw`, `promote`, `replace` send methods**

```typescript
const queueWithdraw = useCallback(() => {
  if (!isConnected) return;
  send({ type: 'queue.withdraw' });
}, [isConnected, send]);

const queuePromote = useCallback(() => {
  if (!isConnected) return;
  send({ type: 'queue.promote' });
}, [isConnected, send]);

const queueReplace = useCallback((content: string, model?: string, attachments?: PromptAttachment[], threadId?: string) => {
  if (!isConnected) return;
  send({ type: 'queue.replace', content, ...(model ? { model } : {}), ...(attachments?.length ? { attachments } : {}), ...(threadId ? { threadId } : {}) });
}, [isConnected, send]);
```

Return these from the hook.

- [ ] **Step 4: Run typecheck**

Run: `cd packages/client && pnpm typecheck`
Expected: PASS (may need to fix type exports)

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/hooks/use-chat.ts
git commit -m "feat(use-chat): handle queue.state, queue.withdrawn events and add queue action methods

Add pendingFollowup to chat state, hydrated from init payload and
updated by queue.state/queue.withdrawn WebSocket events. Add
queueWithdraw, queuePromote, queueReplace send methods."
```

---

### Task 10: Client — replace `stagedQueuedPrompts` with server-backed pending card

**Files:**
- Modify: `packages/client/src/components/chat/chat-container.tsx:112-275` (state + handlers), `:515-556` (UI)

- [ ] **Step 1: Delete `stagedQueuedPrompts` state and all references**

Remove:
- `QueuedPrompt` type (lines 112-117)
- `stagedQueuedPrompts` useState (line 119)
- `steerLatestQueuedPrompt` callback (lines 246-258)
- The drain `useEffect` (lines 260-275)
- The staged queue UI rendering (lines 515-556)

- [ ] **Step 2: Rewrite `handleSendMessage`**

Replace the current `handleSendMessage` that stages locally with one that always sends to the server:

```typescript
const handleSendMessage = useCallback(
  async (content: string, model?: string, attachments?: Parameters<typeof sendMessage>[2]) => {
    if (pendingFollowup && isDispatchBusy) {
      // Already have a pending followup + user typed new content = replace
      queueReplace(content, model, attachments as any, activeThreadId ?? undefined);
      return;
    }

    if (!pendingFollowup && isDispatchBusy && queueModePreference === 'followup') {
      // No pending, agent busy, followup mode = send as followup (will be queued on server)
      // Set optimistic pending state
      setState(prev => ({
        ...prev,
        pendingFollowup: { messageId: crypto.randomUUID(), content, attachments, threadId: activeThreadId ?? undefined },
      }));
    }

    const continuation = pendingContinuationContext.current;
    pendingContinuationContext.current = undefined;
    sendMessage(content, model, attachments, undefined, undefined, queueModePreference, activeThreadId ?? undefined, continuation);
  },
  [sendMessage, queueModePreference, isDispatchBusy, activeThreadId, pendingFollowup, queueReplace]
);
```

- [ ] **Step 3: Add promote handler for Enter-when-pending**

```typescript
const handlePromotePending = useCallback(() => {
  if (!pendingFollowup) return;
  queuePromote();
}, [pendingFollowup, queuePromote]);
```

Wire this to the Enter key when the text box is empty and `pendingFollowup` exists.

- [ ] **Step 4: Add withdraw handler for editing**

```typescript
const handleEditPending = useCallback(() => {
  if (!pendingFollowup) return;
  queueWithdraw();
  // The queue.withdrawn event will set pendingFollowup to null
  // and the onQueueWithdrawn callback will populate the text box
}, [pendingFollowup, queueWithdraw]);
```

Wire this to the Up arrow key and the Edit button.

- [ ] **Step 5: Rewrite the pending card UI**

Replace the old staged queue UI with:

```tsx
{pendingFollowup && (
  <div className="border-t border-neutral-100 bg-surface-0 px-3 py-2 dark:border-neutral-800/50 dark:bg-surface-0">
    <div className="mb-1 flex items-center justify-between">
      <span className="font-mono text-[10px] text-amber-700 dark:text-amber-300">
        1 queued — Enter to dispatch now
      </span>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={handleEditPending}
          className="rounded px-1.5 py-0.5 font-mono text-[10px] text-amber-700 transition-colors hover:bg-amber-100 dark:text-amber-300 dark:hover:bg-amber-900/30"
        >
          edit
        </button>
        <button
          type="button"
          onClick={() => queueWithdraw()}
          className="rounded px-1.5 py-0.5 font-mono text-[10px] text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
        >
          cancel
        </button>
      </div>
    </div>
    <div className="rounded-md border border-amber-200 bg-amber-50/70 px-2 py-1 font-mono text-[11px] text-amber-900 dark:border-amber-800/50 dark:bg-amber-900/20 dark:text-amber-100">
      <div className="truncate">
        {pendingFollowup.content || '[attachment]'}
      </div>
    </div>
  </div>
)}
```

- [ ] **Step 6: Run typecheck**

Run: `cd packages/client && pnpm typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/client/src/components/chat/chat-container.tsx
git commit -m "feat(chat-container): replace stagedQueuedPrompts with server-backed pending card

Delete client-side staging queue. All prompts go to the server
immediately. Pending card renders from server-hydrated pendingFollowup
state. Enter promotes, Up Arrow edits, Cancel withdraws. New content
while pending triggers queue.replace."
```

---

### Task 11: Integration test — full steer lifecycle

**Files:**
- Test: `packages/worker/src/durable-objects/session-agent.test.ts`

- [ ] **Step 1: Write end-to-end test**

```typescript
  it('full steer lifecycle: followup → promote → dispatch', async () => {
    const runnerSocket = { send: vi.fn() };
    const { agent, broadcasts } = await createTestAgent({ sockets: [runnerSocket] });

    // Dispatch initial prompt (makes runner busy)
    await (agent as any).handlePrompt(
      'initial work',
      undefined,
      { id: 'user-1', email: 'u@test.com' },
      undefined,
      'web', 'default', 'thread-1',
    );

    // Queue a followup (should not write to message store)
    (agent as any).promptQueue.runnerBusy = true;
    await (agent as any).handlePrompt(
      'followup work',
      undefined,
      { id: 'user-1', email: 'u@test.com' },
      undefined,
      'web', 'default', 'thread-1',
    );

    // Followup should be in queue but NOT in message store
    expect((agent as any).promptQueue.length).toBe(1);
    const followupInStore = (agent as any).messageStore.sql
      .exec("SELECT * FROM messages WHERE content = 'followup work'")
      .toArray();
    expect(followupInStore).toHaveLength(0);

    // Promote the followup
    await (agent as any).handleClientMessage({ type: 'queue.promote' });

    // Should have sent abort + dispatched the followup
    const abortSent = runnerSocket.send.mock.calls.some(
      (call) => JSON.parse(call[0]).type === 'abort'
    );
    expect(abortSent).toBe(true);
  });

  it('channel steer preserves pending web followup', async () => {
    const runnerSocket = { send: vi.fn() };
    const { agent } = await createTestAgent({ sockets: [runnerSocket] });

    // Make runner busy
    (agent as any).promptQueue.runnerBusy = true;

    // Queue a web followup
    (agent as any).promptQueue.enqueue({
      id: 'web-followup',
      content: 'web user work',
      status: 'queued',
      channelType: 'web',
      channelId: 'default',
      channelKey: 'web:default',
    });

    // Channel steer arrives
    await (agent as any).handleInterruptPrompt(
      'telegram urgent',
      undefined,
      { id: 'user-1', email: 'u@test.com' },
      undefined,
      'telegram',
      'chat-123',
      'thread-telegram',
    );

    // Web followup should STILL be in the queue
    const remaining = (agent as any).promptQueue.withdrawQueued();
    expect(remaining).toBeTruthy();
    expect(remaining.content).toBe('web user work');
  });
```

- [ ] **Step 2: Run tests**

Run: `cd packages/worker && pnpm vitest run src/durable-objects/session-agent.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/worker/src/durable-objects/session-agent.test.ts
git commit -m "test(session-agent): integration tests for unified queue lifecycle

Tests full steer lifecycle (followup → promote → dispatch) and
verifies channel steer preserves pending web followup."
```
