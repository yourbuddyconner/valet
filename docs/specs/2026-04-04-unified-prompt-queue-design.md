# Unified Prompt Queue Design

**Goal:** Replace the decoupled client-side staging queue with a server-authoritative single pending slot model. All callers (web UI, Telegram, Slack) share the same dispatch semantics. The client renders server state with optimistic feedback.

**Status:** Design

**Does NOT cover:** Collect mode (separate buffer mechanism, orthogonal), workflow queue entries (`queue_type = 'workflow_execute'`, exempt from single-slot constraint), approval gates, child session events.

---

## Core Model

The server-side `prompt_queue` is conceptually simplified for user prompts to: one `processing` entry (the active turn) and at most one `queued` entry (the pending followup). The SQLite table schema does not change — the constraint is enforced at the application level in `handlePrompt`, scoped to user-initiated prompt entries only (entries where `queue_type = 'prompt'` AND `child_session_id IS NULL`). Workflow entries (`queue_type = 'workflow_execute'`) and child session events (which use `queue_type = 'prompt'` but have a non-null `child_session_id`) can still stack freely.

### Four Server Primitives

| Primitive | Client Message | Server Behavior |
|-----------|---------------|-----------------|
| **Enqueue** | `{ type: 'prompt', queueMode: 'followup', content, threadId, ... }` | If runner idle: write user message to message store, dispatch immediately. If runner busy: insert into `prompt_queue` with `status='queued'`. No message store write — deferred to dispatch time. |
| **Withdraw** | `{ type: 'queue.withdraw' }` | Remove the single `queued` user-prompt entry from `prompt_queue`. Return its content to clients via broadcast. No message store cleanup needed (nothing was written). |
| **Promote** | `{ type: 'queue.promote' }` | Atomic operation: remove the `queued` entry, abort the current turn (`handleAbort`), write the user message to message store, dispatch as `processing`. Equivalent to withdraw + steer but in a single handler — no race window, no content loss risk. |
| **Replace** | `{ type: 'queue.replace', content, threadId, ... }` | Atomic operation: withdraw existing queued entry, abort current turn, dispatch new content. Used when user types new content while a pending exists. Prevents multiplayer interleaving race. |

### Steer Semantics

Steer (`{ type: 'prompt', queueMode: 'steer', content, threadId }`) aborts the current processing turn only. It does **not** clear the pending slot. If a pending followup exists when a steer arrives — whether from the same channel or a different one — the steer dispatches first and the pending followup dispatches after the steer completes (via `sendNextQueuedPrompt`).

This applies uniformly:
- **Cross-channel:** Telegram steer while web followup is queued → web followup survives.
- **Same-channel:** Slack steer while a previous Slack followup is queued → Slack followup survives.
- The pending item represents the user's explicit intent. Steer only interrupts the active turn; it does not discard queued work. The user can cancel the pending item separately if desired.

### Queue Mode Defaults

| Caller | Default `queueMode` | Rationale |
|--------|---------------------|-----------|
| Web UI | `followup` | User expects the message to wait its turn |
| Channel integrations (Telegram, Slack, etc.) | `steer` | Channels are opaque; user expects "I said it, agent does it now" |
| Per-binding override | `channel_bindings.queueMode` column | Individual integrations opt in to `followup` if they want batching |
| Orchestrator dispatch | `steer` (change from current no-mode-specified) | Orchestrator messages should have immediate effect |

---

## Deferred Message Write

Today, `handlePrompt` writes the user message to the message store and broadcasts it to all clients immediately (before checking if the runner is busy). This causes queued messages to appear in the chat before the agent processes them.

**New behavior:** The user message write and broadcast are deferred to dispatch time.

- **Runner idle (direct dispatch):** Behavior unchanged — message is written and broadcast immediately, then dispatched to the runner.
- **Runner busy (enqueue):** The prompt content, attachments, author metadata (including `author_avatar_url` — currently missing from `prompt_queue` row mapping and must be added), threadId, and channel context are stored only in the `prompt_queue` row. No message store write, no client broadcast. The `messageId` is generated at enqueue time and stored in the queue entry.
- **At dispatch time** (`sendNextQueuedPrompt`): The user message is written to the message store using the pre-generated `messageId`, broadcast to clients, then dispatched to the runner. This brings the DO's message store into alignment with OpenCode's own history — both only contain messages that were actually processed.
- **Audit event** (`user.prompt`): Also deferred to dispatch time for consistency.
- **Thread bookkeeping** (`incrementThreadMessageCount`, `thread.created` broadcast): Also deferred to dispatch time. Today these run at enqueue time, which means a withdrawn followup permanently inflates the thread message count. With the deferred write, thread bookkeeping only runs for messages that actually dispatch.

### Implications

- The `messageId` generated at enqueue time is used as both the queue entry ID and the eventual message store row ID. No change to the runner protocol.
- D1 replication (`flushToD1`) only sees messages that were dispatched. Queued-then-withdrawn messages never touch D1.
- Multiplayer observers don't see queued messages in the chat — only in the pending card (via `queue.state` broadcasts). This is an improvement: today, observers see user messages that may never get a response if they're cleared from the queue.

---

## Server Protocol

### New WebSocket Messages (Client → Server)

**`queue.withdraw`**
- Removes the single `queued` user-prompt entry from `prompt_queue`.
- Broadcasts `{ type: 'queue.withdrawn', data: { messageId, content, attachments, threadId } }` to all clients.
- If no queued entry exists, this is a silent no-op — no broadcast is sent. This prevents double-withdraw races in multiplayer from producing confusing `null` broadcasts that could clear a client's text box.

**`queue.promote`**
- Atomically: removes the `queued` entry, calls `handleAbort` to abort the current turn, writes the user message to the message store, dispatches the prompt to the runner.
- Broadcasts `{ type: 'queue.state', data: { pending: null } }` followed by the normal dispatch flow (message broadcast, status updates).
- If no queued entry exists, this is a no-op — the item was already dispatched naturally by `sendNextQueuedPrompt`.
- If the runner is not busy (turn completed between queue and promote), skips abort and dispatches directly.

**`queue.replace`**
- Wire format: `{ type: 'queue.replace', content: string, threadId?: string, model?: string, attachments?: Attachment[], channelType?: string, channelId?: string }`.
- Atomic operation for "new content while pending exists": removes the existing `queued` entry (broadcasts `queue.withdrawn`), aborts the current turn, writes the new user message to the message store, dispatches the new prompt. This avoids the race window that would exist if withdraw and steer were sent as two separate messages (relevant in multiplayer where another client could enqueue between them).
- If no queued entry exists, behaves identically to a steer prompt.

### Modified WebSocket Messages

**`prompt` (with `queueMode: 'followup'`)**
- When runner is busy: enqueues without message store write. Broadcasts `{ type: 'queue.state', data: { pending: { messageId, content, attachments, threadId } } }`.
- Single-slot enforcement: if a `queued` user-prompt entry already exists, the new prompt **replaces** it. The old entry is removed and broadcast as `{ type: 'queue.withdrawn', data: { messageId, content, ... } }` before the new entry is queued. This handles the "user sends again while pending exists" case — the newest message wins.

**`prompt` (with `queueMode: 'steer'`)**
- Calls `handleAbort` to abort the current turn. Does **not** call `clearQueued()`. The pending followup (if any) survives.
- Writes user message to message store and dispatches immediately when the runner is available.
- **Edge case — runner disconnects mid-abort:** If the runner is not connected when the steer tries to dispatch, the steer prompt is enqueued with `status='queued'` like any other prompt. The deferred message write applies — the user message is written at dispatch time when the runner reconnects. The steer is not "always direct dispatch" — it follows the same enqueue-if-unavailable path as followup.
- After the steer completes, `handlePromptComplete` → `sendNextQueuedPrompt` dispatches the surviving pending item.

### Queue State Broadcast

After any queue mutation (enqueue, withdraw, promote, dispatch, completion), the server broadcasts:

```typescript
{ type: 'queue.state', data: {
    pending: { messageId: string; content: string; attachments?: Attachment[]; threadId?: string } | null
}}
```

### Init Payload

The existing WebSocket `init` message is extended to include the pending item:

```typescript
{
  // ... existing fields ...
  pendingPrompt: { messageId: string; content: string; attachments?: Attachment[]; threadId?: string } | null
}
```

This replaces the current `promptsQueued: number` field (or supplements it — `promptsQueued` can remain for backwards compatibility but the client should prefer `pendingPrompt`).

---

## Client UI

### State Model

**Delete `stagedQueuedPrompts`** (`chat-container.tsx`). Replace with:

```typescript
pendingFollowup: { messageId: string; content: string; attachments?: Attachment[]; threadId?: string } | null
```

Hydrated from `pendingPrompt` in the init payload, updated by:
- `queue.state` → set `pendingFollowup` to `data.pending`
- `queue.withdrawn` → set `pendingFollowup` to null (client decides whether to populate text box)

### Chat Input Behavior

| Agent State | Text Box | Enter | Up Arrow |
|-------------|----------|-------|----------|
| Idle | Has content | Send normally (`followup`, dispatches immediately) | Edit last own message (standard) |
| Idle | Empty | No-op | Edit last own message (standard) |
| Idle | Pending exists (transient) | No user action needed — server is dispatching the pending item via `sendNextQueuedPrompt`. Pending card disappears when `queue.state` arrives with `pending: null`. | No-op |
| Busy | Has content, no pending | Send as `followup` (queued on server) | No-op |
| Busy | Empty, pending exists | Send `queue.promote` (abort + dispatch pending) | Send `queue.withdraw`, populate text box with pending content |
| Busy | Has content, pending exists | Send `queue.replace` (atomic: withdraw old + enqueue new as steer — abort current turn, discard old pending, dispatch new content) | Send `queue.withdraw`, populate text box with pending content |

### Pending Card

Rendered above the text box (the current amber banner area). Visible only when `pendingFollowup` is non-null.

**Contents:**
- The queued message content (truncated if long)
- **Edit** button: sends `queue.withdraw`, on `queue.withdrawn` populates text box with returned content
- **Cancel** button: sends `queue.withdraw`, on `queue.withdrawn` discards content
- Keyboard shortcut: Up arrow = Edit

**Not in the chat flow.** The pending message does not appear in the message list. It enters the chat only when dispatched (at which point the server writes and broadcasts the user message).

### Optimistic Client State

Between the user pressing Enter and the server confirming via `queue.state`, there is a 10-100ms window where no pending card is visible. The client should:
1. Clear the text box immediately on Enter.
2. Set an optimistic `pendingFollowup` from the content just sent (before server confirmation).
3. Reconcile when `queue.state` arrives — replace the optimistic entry with the server-confirmed one (which includes the `messageId`).
4. If the server rejects (e.g., WebSocket disconnected), restore the content to the text box and show an error.

### Cancelled/Withdrawn Message Rendering

Messages that are withdrawn do not need cancelled rendering in the chat because they were never in the chat. The pending card simply disappears. This is simpler than today's model.

---

## Channel Integration Behavior

### Default to Steer

Channel integrations (Telegram, Slack, etc.) send prompts with `queueMode: 'steer'` by default. This means:

1. Channel message arrives at the DO.
2. If runner is busy: abort current turn, dispatch channel message immediately.
3. If a pending followup exists: it **survives** (steer does not clear the pending slot). After the channel's steer turn completes, `sendNextQueuedPrompt` dispatches the pending followup.

### Opt-In to Followup

Individual integrations can set `queueMode: 'followup'` on their `channel_bindings` row to use followup semantics instead. In this case, channel messages queue behind the current turn like web UI messages.

### Channel Steer + Pending Followup Interaction

When a channel steer arrives while a web UI followup is pending:

1. Channel message aborts the current turn and dispatches immediately.
2. The web followup remains in the `prompt_queue` as `queued`.
3. After the channel turn completes, `sendNextQueuedPrompt` dispatches the web followup.
4. The web UI's pending card disappears when the followup dispatches (server broadcasts `queue.state` with `pending: null`).

The user's queued work is never silently destroyed.

---

## Server-Side Implementation Notes

### `handlePrompt` Changes

1. Move user message write (`messageStore.writeMessage`) and client broadcast into a conditional block that only runs when dispatching directly (runner idle).
2. When enqueueing (runner busy), store all metadata in the `prompt_queue` row only.
3. Enforce single-slot: before enqueueing, check for existing `queued` user-prompt entries. If one exists, withdraw it (broadcast `queue.withdrawn`) before inserting the new one.
4. Broadcast `queue.state` after enqueueing.

### `prompt_queue` Read Path Fix

The `QueueEntry` interface, `dequeueNext()` SELECT query, and `rowToEntry()` mapping in `prompt-queue.ts` are all missing `author_avatar_url`. This column is written at enqueue time but never read back. With deferred writes this becomes a data loss bug — the avatar URL must be available at dispatch time for the message store write. Add `authorAvatarUrl` to `QueueEntry`, the `dequeueNext()` SELECT, and `rowToEntry()`.

### `sendNextQueuedPrompt` Changes

1. After dequeuing, write the user message to the message store using the queue entry's `messageId`, including all author metadata (`authorId`, `authorEmail`, `authorName`, `authorAvatarUrl`).
2. Call `incrementThreadMessageCount` and broadcast `thread.created` if the entry has a `threadId` (deferred from enqueue time).
3. Broadcast the user message to clients (the message enters the chat at this point).
4. Emit `user.prompt` audit event.
5. Dispatch to runner as before.

### `handleAbort` Changes

1. Remove all `clearQueued()` calls — both the global path (`clearQueued()`) and the channel-scoped path (`clearQueued(channelKey)`). Steer and abort no longer clear the pending slot.
2. Only send abort to runner and clear dispatch timers.
3. The standalone abort/stop button in the UI calls `handleAbort` directly. With this change, the pending followup **survives** an abort — the user explicitly queued it, and aborting the current turn doesn't imply discarding queued work. The user can cancel the pending item separately via the pending card's Cancel button.

### New Handlers

1. `queue.withdraw` WebSocket handler: read and delete the single `queued` user-prompt entry (scoped to `queue_type = 'prompt'` AND `child_session_id IS NULL`), broadcast `queue.withdrawn` with content.
2. `queue.promote` WebSocket handler: read and delete the `queued` entry, call `handleAbort` if runner is busy, write user message, dispatch to runner. Handle edge case where runner became idle between queue and promote (skip abort, dispatch directly).
3. `queue.replace` WebSocket handler: withdraw existing queued entry (broadcast `queue.withdrawn`), then abort current turn and dispatch the new content. Combines withdraw + steer atomically to prevent multiplayer interleaving.

### HTTP `/prompt` Endpoint

No protocol change needed. The endpoint already accepts `queueMode` in the request body. Channel webhooks pass `queueMode: 'steer'` (new default) or `binding.queueMode`. The deferred message write applies to the HTTP path identically.

### `/clear-queue` Endpoint

The existing `/clear-queue` HTTP endpoint (`handleClearQueue`) clears all queued entries and broadcasts `{ type: 'status', data: { queueCleared: true, cleared } }`. Under the new semantics:

1. For each cleared user-prompt entry, broadcast `{ type: 'queue.withdrawn', data: { messageId, content, ... } }` so clients can update the pending card.
2. Follow with `{ type: 'queue.state', data: { pending: null } }`.
3. Keep the existing `queueCleared` broadcast for backwards compatibility.

The Slack `/stop` command flow (abort + clear-queue) continues to work: abort interrupts the current turn, clear-queue removes the pending followup.

### `ClientMessage` Type Update

The `ClientMessage` type in `session-agent.ts` (currently `type: 'prompt' | 'answer' | 'ping' | 'abort' | ...`) must be extended with the new message types: `'queue.withdraw'`, `'queue.promote'`, `'queue.replace'`.

### Crash Recovery and Idempotency

With deferred writes, the user message is written to the message store during `sendNextQueuedPrompt`. If the DO crashes between `dequeueNext()` (which marks the entry as `processing`) and the `messageStore.writeMessage` call:

1. On recovery, `revertProcessingToQueued()` puts the entry back to `queued`.
2. `sendNextQueuedPrompt` dequeues it again and attempts the message write.
3. The message write must be **idempotent** — use `INSERT OR IGNORE` or check for existing `messageId` before writing, since the entry may have been partially processed before the crash.

For entries that were dispatched to the runner before the crash (message already written, runner was processing), `revertProcessingToQueued` will re-dispatch them. The message write must not create a duplicate — the idempotency guard handles this.

### Collect Mode Interaction

Collect mode is out of scope but interacts with steer. Today, `handleAbort` clears queued entries which could include a pending collect flush that was already inserted into `prompt_queue`. With the new semantics (abort does not clear the queue), a collect-mode flush that was queued before a steer will dispatch after the steer completes. This is correct behavior — the collected messages represent user intent and should not be silently discarded.

### Observability

New primitives should emit audit events for debuggability:
- `queue.withdraw` → `emitAuditEvent('user.queue_withdraw', ...)`
- `queue.promote` → `emitAuditEvent('user.queue_promote', ...)`
- `queue.replace` → `emitAuditEvent('user.queue_replace', ...)`

The health monitor / idle queue watchdog does not need changes — it triggers `sendNextQueuedPrompt` which now includes the deferred message write. The idempotency guard (above) prevents duplicate messages from watchdog-triggered re-dispatches.

---

## Migration / Backwards Compatibility

- The `prompt_queue` SQLite schema does not change.
- The `queue.state` and `queue.withdrawn` WebSocket messages are new — old clients that don't handle them will simply not show the pending card. They'll still receive user message broadcasts at dispatch time (when the message enters the chat).
- The `promptsQueued` field in the init payload is preserved for backwards compatibility.
- `stagedQueuedPrompts` is deleted from the client. No migration needed — it was ephemeral React state.
- The `QueuedPrompt` type is replaced by the `pendingFollowup` server-hydrated state.
- **Behavioral change for old clients:** Old clients previously saw queued user messages in the chat immediately. With deferred writes, they see them at dispatch time instead. In multiplayer, an old client and new client will see different timing. This is an acceptable improvement — messages should only appear in the chat when the agent will process them.

---

## Boundary

This spec covers the prompt queue dispatch model for user prompts. It does NOT cover:

- **Collect mode** — separate buffer mechanism in the `state` table, orthogonal to the pending slot.
- **Workflow entries** — `queue_type = 'workflow_execute'`, exempt from single-slot constraint, can stack freely.
- **Approval gates / proposals** — separate system, not affected by queue changes.
- **Child session events** — routed through the queue with `queue_type = 'prompt'` but identified by non-null `child_session_id`. Exempt from single-slot constraint — they can stack alongside user prompts.
- **Message editing after dispatch** — once a message enters the chat (at dispatch time), editing is a separate concern.
