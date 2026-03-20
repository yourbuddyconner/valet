# Message Persistence Redesign: MessageStore + ChannelRouter

**Date**: 2026-03-20
**Status**: Proposed
**Scope**: `session-agent.ts` message write paths, streaming turn state, D1 flush mechanism, channel reply orchestration, plugin ChannelContext

## Problem

Agent responses sent via Slack threads (and other channels) intermittently disappear from the web UI after refresh. The root cause is a leaky abstraction: message persistence is spread across 15+ code paths with no unified owner, streaming turn state lives in an informal `activeTurns` Map separate from persistence, and D1 replication uses a hand-rolled CDC mechanism with known failure modes.

### Current write paths

There are 15+ distinct `INSERT INTO messages` call sites in `session-agent.ts` alone, plus 2 direct D1 writes in service files. Additionally, the `activeTurns` in-memory Map manages streaming state separately from SQLite, creating two parallel representations of assistant message content.

| Path | Role | Store | Location |
|---|---|---|---|
| `handlePrompt` → raw INSERT | user | DO SQLite | session-agent.ts:1883 |
| `handleFollowupPrompt` (collect mode) | user | DO SQLite | session-agent.ts:2164 |
| `message.create` → INSERT OR IGNORE | assistant | DO SQLite | session-agent.ts:2654 |
| `message.part.text-delta` → in-memory only | assistant | `activeTurns` Map | session-agent.ts:2674 |
| `message.part.tool-update` → UPDATE | assistant | DO SQLite + `activeTurns` | session-agent.ts:2742 |
| `message.finalize` → INSERT OR REPLACE | assistant | DO SQLite | session-agent.ts:2797 |
| `workflow-chat-message` handler | user/assistant/system | DO SQLite | session-agent.ts:2424 |
| `screenshot` handler | system | DO SQLite | session-agent.ts:2532 |
| `error` handler | system | DO SQLite | session-agent.ts:2594 |
| `audio-transcript` → UPDATE parts | assistant | DO SQLite | session-agent.ts:2573 |
| `initialPrompt` dispatch | user | DO SQLite | session-agent.ts:2893 |
| `model-switched` | system | DO SQLite | session-agent.ts:2991 |
| `session-reset` visual break | system | DO SQLite | session-agent.ts:3251 |
| `forward-messages` | mixed | DO SQLite | session-agent.ts:3796 |
| sandbox spawn error | system | DO SQLite | session-agent.ts:6610 |
| `handleSystemMessage` | system | DO SQLite | session-agent.ts:6896 |
| hibernate/restore errors | system | DO SQLite | session-agent.ts:7912/8033 |
| `handleChannelReply` image message | system | DO SQLite | session-agent.ts:8882 |
| `dispatchOrchestratorPrompt` → `db.saveMessage` | user | D1 (direct) | services/orchestrator.ts:452 |
| `sendSessionMessage` → `db.saveMessage` | user | D1 (direct) | services/sessions.ts:586 |

Plus 3 D1 flush paths: `scheduleDebouncedFlush` (async), `handlePromptComplete` (sync), `handleStop` (sync).

### Known bug classes

1. **Watermark uses `>` with seconds-precision timestamps**: Messages created in the same second as the watermark are permanently skipped in D1 flushes.
2. **`INSERT OR REPLACE` in finalize resets `created_at`**: The finalized row gets a new timestamp, shifting its position in the watermark window.
3. **Duplicate user messages with different IDs**: `dispatchOrchestratorPrompt` writes to D1 with UUID-A, `handlePrompt` writes to DO SQLite with UUID-B.
4. **D1 `created_at` reset on every flush**: `batchUpsertMessages` doesn't pass `created_at`, so D1 defaults to `datetime('now')`.
5. **Debounced flush lost on isolate termination**: `setTimeout` inside `ctx.waitUntil` may never fire if the Worker isolate terminates.
6. **`activeTurns` state lost on hibernation**: In-memory streaming state is separate from SQLite persistence. On DO eviction mid-turn, text deltas accumulated in `activeTurns` are lost. The `recoverTurnFromSQLite` path reconstructs from the placeholder but loses streamed content.

### Why point fixes don't work

Every new feature must get all 15+ write paths right AND keep `activeTurns` in sync with SQLite. The invariants (thread_id consistency, watermark correctness, no duplicate IDs, activeTurns ↔ SQLite coherence) are too many to maintain manually across scattered raw SQL statements and ad-hoc Map mutations.

## Design

Two new classes extracted from the DO, plus schema changes and plugin interface updates.

### Overview

```
Plugin route
  → POST /do/prompt { content, replyTo?, threadId, author, ... }
  → DO receives prompt
    → messageStore.writeMessage(role='user')     // single write path
    → channelRouter.trackReply(replyTo)          // if replyTo present
    → dispatch to runner

Runner streams response
  → messageStore.appendTextDelta(turnId, delta)  // in-memory accumulation
  → messageStore.updateToolCall(turnId, ...)     // persists to SQLite
  → DO broadcasts to WebSocket clients           // from store snapshots

Runner completes
  → messageStore.finalizeTurn(turnId, ...)       // persists to SQLite
  → channelRouter.consumePendingReply()          // returns reply intent
  → sendChannelReply(env, intent, ctx)           // generic dispatch
  → messageStore.flushToD1()                     // seq-based, trivially correct
```

The DO becomes a thin coordinator. It does not contain raw SQL for message writes, `activeTurns` Map management, or integration-specific reply logic. The MessageStore is the **single source of truth** for all message state — both in-memory streaming and persisted content.

---

## 1. MessageStore

A class that owns ALL message state: in-memory streaming turns, SQLite persistence, and D1 replication. Lives in its own file: `packages/worker/src/durable-objects/message-store.ts`.

The key design principle: **MessageStore decides internally what to persist and when.** Consumers don't know or care whether a given piece of state is in memory or SQLite:

- `appendTextDelta` — in-memory only (high frequency, no SQLite write per chunk)
- `updateToolCall` — persists to SQLite (important state that must survive hibernation)
- `finalizeTurn` — persists to SQLite (final content)
- `writeMessage` — persists to SQLite (write-once)

### Message taxonomy

In V2, a message has a `role` and a `parts` array. Tool calls are **parts within an assistant message**, not separate messages. The `tool` role in the current CHECK constraint is vestigial from V1 — no code path writes `role = 'tool'`. The new schema drops it.

Messages fall into two lifecycles:

#### Write-once messages

A single INSERT, never mutated after creation. One generic method handles all of these:

| Variant | Role | Parts | Source |
|---|---|---|---|
| User prompt | `user` | Attachment parts (images, files) or null | Human via web UI / Slack / Telegram |
| System notification | `system` | null | Platform (spawn errors, model switches, session reset, hibernate errors) |
| Workflow message | `user` / `assistant` / `system` | Workflow-specific JSON | Workflow engine chat message |
| Forwarded message | `assistant` (always, regardless of original) | `{ forwarded, originalRole, sourceSessionId, ... }` | Orchestrator importing from child session |
| Screenshot | `system` | null (base64 in content) | Runner sends screenshot |
| Channel reply image | `system` | null | Image sent via channel_reply |

Note: forwarded messages are stored as `role = 'assistant'` regardless of the original role (for consistent left-aligned rendering in the UI). The original role is preserved in `parts.originalRole`.

#### Streaming assistant turns

Created as a placeholder, progressively updated, then finalized. The **single** assistant message accumulates ALL structured parts — text and tool calls are interleaved:

```typescript
// A single assistant message's parts array over its lifecycle:

// After createTurn:
parts = []

// After text streaming + tool call:
parts = [
  { type: 'text', text: 'Let me check...', streaming: false },
  { type: 'tool-call', callId: 'abc', toolName: 'read_file', status: 'complete', args: {...}, result: {...} },
  { type: 'text', text: 'The file contains...', streaming: true },
]

// After finalizeTurn:
parts = [
  { type: 'text', text: 'Let me check...' },
  { type: 'tool-call', callId: 'abc', toolName: 'read_file', status: 'complete', args: {...}, result: {...} },
  { type: 'text', text: 'The file contains...' },
  { type: 'finish', reason: 'end_turn' },
]
```

A "tool call" is a **part**, not a message. Multiple tool calls can appear in a single turn, interleaved with text parts.

### DO SQLite schema

```sql
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  parts TEXT,
  author_id TEXT,
  author_email TEXT,
  author_name TEXT,
  author_avatar_url TEXT,
  channel_type TEXT,
  channel_id TEXT,
  opencode_session_id TEXT,
  message_format TEXT NOT NULL DEFAULT 'v2',
  thread_id TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_seq ON messages(seq);
```

Key changes:
- **`seq INTEGER NOT NULL`** — global write counter, incremented on every INSERT and UPDATE. Used as the D1 replication cursor.
- **`CHECK(role IN ('user', 'assistant', 'system'))`** — dropped `'tool'` (vestigial V1 role, zero write paths use it).
- **`created_at`** — immutable (set once on INSERT, never updated). Used only for display ordering.

No backwards compatibility with existing DOs — sessions can be recreated.

### Seq counter and replication watermark

Both held internally by the `MessageStore` instance:

- **`nextSeq`**: In-memory counter, initialized as `COALESCE(MAX(seq), 0) + 1` from SQLite on construction.
- **`lastReplicatedSeq`**: Persisted in a `replication_state` table in DO SQLite. Initialized on construction. Updated after each successful flush.

```sql
CREATE TABLE IF NOT EXISTS replication_state (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
```

The MessageStore fully owns its replication watermark. The DO just calls `messageStore.flushToD1(db, sessionId)` — no seq tracking exposed to the caller.

### API

```typescript
interface AuthorInfo {
  id?: string;
  email?: string;
  name?: string;
  avatarUrl?: string;
}

interface TurnMetadata {
  channelType?: string;
  channelId?: string;
  opencodeSessionId?: string;
  threadId?: string;
}

interface TurnSnapshot {
  turnId: string;
  content: string;
  parts: Array<{ type: string; [key: string]: unknown }>;
  metadata: TurnMetadata;
}

class MessageStore {
  constructor(sql: SqlStorage);

  // ── Write-once messages (any role) ──────────────────────────

  /**
   * Write a complete message in one shot. Covers user prompts, system
   * notifications, forwarded messages, workflow messages, screenshots, etc.
   * Persists to SQLite immediately. Write-once — never updated.
   */
  writeMessage(params: {
    id: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    parts?: string | null;
    author?: AuthorInfo;
    channelType?: string;
    channelId?: string;
    opencodeSessionId?: string;
    threadId?: string;
  }): void;

  // ── Streaming turn lifecycle ────────────────────────────────

  /**
   * Create an assistant turn placeholder.
   * Persists placeholder to SQLite (content='', parts='[]').
   * Initializes in-memory turn accumulator.
   */
  createTurn(turnId: string, metadata: TurnMetadata): void;

  /**
   * Append a text delta to an active turn.
   * In-memory only — no SQLite write. High-frequency, called per chunk.
   * Updates the text accumulator and the current streaming text part.
   */
  appendTextDelta(turnId: string, delta: string): void;

  /**
   * Add or update a tool call part on an active turn.
   * Persists to SQLite (bumps seq) — tool state must survive hibernation.
   * Updates the in-memory parts array.
   */
  updateToolCall(turnId: string, callId: string, toolName: string,
    status: ToolCallStatus, args?: unknown, result?: unknown, error?: string): void;

  /**
   * Finalize a turn with completed content and parts.
   * Persists to SQLite (bumps seq). Clears in-memory turn state.
   * MUST use UPDATE (not INSERT OR REPLACE) to preserve original created_at.
   * Returns the final snapshot for broadcasting/channel reply.
   */
  finalizeTurn(turnId: string, finalText?: string, reason?: string): TurnSnapshot;

  // ── Turn snapshots (unified read interface) ─────────────────

  /** Current state of an active turn — from in-memory accumulator. */
  getTurnSnapshot(turnId: string): TurnSnapshot | null;

  /** All active turn IDs. */
  get activeTurnIds(): string[];

  /** Recover an orphaned turn from SQLite after hibernation wake. */
  recoverTurn(turnId: string): TurnSnapshot | null;

  // ── Post-write mutations ────────────────────────────────────

  /** Stamp a message with channel delivery metadata after successful send. Bumps seq. */
  stampChannelDelivery(messageId: string, channelType: string, channelId: string): void;

  // ── Persisted reads ─────────────────────────────────────────

  /** All persisted messages, ordered by created_at ASC, seq ASC. */
  getMessages(opts?: { limit?: number; afterCreatedAt?: number }): MessageRow[];

  /** Get a single persisted message by ID. */
  getMessage(id: string): MessageRow | null;

  // ── D1 Replication ──────────────────────────────────────────

  /**
   * Flush new/updated messages to D1. Uses internally-managed seq watermark.
   * Returns the number of rows flushed.
   *
   * The D1 upsert MUST explicitly include created_at in the column list
   * to prevent D1 from resetting it to datetime('now') on each flush.
   */
  async flushToD1(db: D1Database, sessionId: string): Promise<number>;
}
```

### How the DO uses MessageStore

The DO no longer has an `activeTurns` Map, raw SQL, or parts-assembly logic. All message state flows through the store:

```typescript
// Runner message handlers in the DO:

case 'message.create': {
  const threadId = this.resolveThreadId(msg);  // DO resolves from prompt_queue
  this.messageStore.createTurn(msg.turnId, {
    channelType: msg.channelType,
    channelId: msg.channelId,
    opencodeSessionId: msg.opencodeSessionId,
    threadId,
  });
  this.broadcastToClients({ type: 'message', data: { id: msg.turnId, role: 'assistant', content: '', parts: [], ... } });
  break;
}

case 'message.part.text-delta': {
  this.messageStore.appendTextDelta(msg.turnId, msg.delta);
  this.broadcastToClients({ type: 'chunk', content: msg.delta, messageId: msg.turnId });
  break;
}

case 'message.part.tool-update': {
  this.messageStore.updateToolCall(msg.turnId, msg.callId, msg.toolName, msg.status, msg.args, msg.result, msg.error);
  const snapshot = this.messageStore.getTurnSnapshot(msg.turnId);
  this.broadcastToClients({ type: 'message.updated', data: snapshot });
  break;
}

case 'message.finalize': {
  const final = this.messageStore.finalizeTurn(msg.turnId, msg.finalText, msg.reason);
  this.channelRouter.setResult(final.content, msg.turnId);
  this.broadcastToClients({ type: 'message.updated', data: final });
  break;
}

case 'complete': {
  const reply = this.channelRouter.consumePendingReply();
  if (reply) {
    const userId = this.getStateValue('userId')!;
    const persona = await resolveOrchestratorPersona(this.env, userId);
    const ctx: ChannelContext = { token, userId, persona };
    const sent = await sendChannelReply(this.env, reply, ctx);
    if (sent) {
      this.messageStore.stampChannelDelivery(reply.messageId, reply.channelType, reply.channelId);
      this.broadcastToClients({ type: 'message.updated', data: { id: reply.messageId, channelType: reply.channelType, channelId: reply.channelId } });
    }
  }
  const nudge = this.channelRouter.getFollowupNudge();
  if (nudge) {
    this.persistFollowupAndScheduleAlarm(nudge);
  }
  await this.handlePromptComplete();
  break;
}
```

### Hibernation recovery

On DO wake, the MessageStore constructor checks for orphaned turns (rows in SQLite with `content = ''` and `parts = '[]'`). The `recoverTurn(turnId)` method reconstructs the in-memory accumulator from whatever was last persisted to SQLite. Streamed text that wasn't yet persisted (only in the old `activeTurns`) is lost — same as today, but now the recovery logic is encapsulated in the store rather than scattered across handler methods.

### Migrating all write sites

Every raw `INSERT INTO messages`, `UPDATE messages`, and `activeTurns` mutation in `session-agent.ts` MUST be replaced with a MessageStore call during implementation:

| Current code | MessageStore method |
|---|---|
| `handlePrompt` user INSERT | `writeMessage(role='user')` |
| `handleFollowupPrompt` user INSERT | `writeMessage(role='user')` |
| `initialPrompt` user INSERT | `writeMessage(role='user')` |
| `workflow-chat-message` INSERT | `writeMessage(role=<from runner>)` |
| `forward-messages` INSERTs | `writeMessage(role='assistant')` |
| `screenshot` system INSERT | `writeMessage(role='system')` |
| `error` system INSERT | `writeMessage(role='system')` |
| `model-switched` system INSERT | `writeMessage(role='system')` |
| `session-reset` system INSERT | `writeMessage(role='system')` |
| sandbox spawn error INSERT | `writeMessage(role='system')` |
| `handleSystemMessage` INSERT | `writeMessage(role='system')` |
| hibernate/restore error INSERTs | `writeMessage(role='system')` |
| `handleChannelReply` image INSERT | `writeMessage(role='system')` |
| `message.create` INSERT + `activeTurns.set()` | `createTurn()` |
| `message.part.text-delta` `activeTurns` mutation | `appendTextDelta()` |
| `message.part.tool-update` UPDATE + `activeTurns` mutation | `updateToolCall()` |
| `message.finalize` INSERT OR REPLACE + `activeTurns.delete()` | `finalizeTurn()` |
| `audio-transcript` UPDATE parts | `updateToolCall()` (or a dedicated `updateTurnParts()` if needed) |
| `recoverTurnFromSQLite()` | `recoverTurn()` |
| `dispatchOrchestratorPrompt` D1 saveMessage | **Deleted** |
| `sendSessionMessage` D1 saveMessage | **Deleted** |

### Critical correctness property

`finalizeTurn` and `updateToolCall` MUST use `UPDATE ... SET seq = ?, content = ?, parts = ? WHERE id = ?` — never `INSERT OR REPLACE`. `INSERT OR REPLACE` deletes and re-inserts the row, which resets `created_at` to `unixepoch()` and destroys the original creation timestamp. The `UPDATE` preserves `created_at` while bumping `seq` for replication.

If the row doesn't exist (hibernation recovery edge case), fall back to `INSERT OR IGNORE` which sets `created_at` via the column default.

### How seq handles updates

Every SQLite mutation bumps seq (in-memory-only operations like `appendTextDelta` do not):

```
writeMessage()          → INSERT with seq = next()
createTurn()            → INSERT with seq = next()
updateToolCall()        → UPDATE ... SET seq = next(), content = ?, parts = ?
finalizeTurn()          → UPDATE ... SET seq = next(), content = ?, parts = ?
stampChannelDelivery()  → UPDATE ... SET seq = next(), channel_type = ?, channel_id = ?
```

The flush query `WHERE seq > last_replicated_seq` always captures the latest state of every modified row. No active-turn tracking needed. No watermark arithmetic.

Verification scenario:
1. Placeholder INSERT at seq=5 → flush → watermark=5, D1 has placeholder
2. Tool update → UPDATE with seq=8 → debounced flush → watermark=8, D1 has progress
3. Finalize → UPDATE with seq=12 → handlePromptComplete flush → watermark=12, D1 has final content

No edge cases.

### What this eliminates

- **Timestamp precision bugs**: seq is unique and monotonic.
- **INSERT OR REPLACE timestamp drift**: finalize uses UPDATE, preserving `created_at`.
- **Duplicate user messages**: single write path through DO, no direct D1 writes.
- **Active turn watermark logic**: unnecessary with seq-per-write.
- **Debounced flush as correctness requirement**: flush is now pure optimization. `handlePromptComplete` sync flush is the correctness guarantee.
- **`activeTurns` / SQLite split**: unified in one class. No more parallel state representations.
- **Scattered `recoverTurnFromSQLite` calls**: recovery is internal to the store.

### D1 schema change

Add `created_at_epoch INTEGER` column to the D1 `messages` table. Update `batchUpsertMessages` to accept and pass through `created_at` from DO SQLite. Requires a D1 migration.

D1 read queries that must be updated to use `created_at_epoch`:
- `getSessionMessages` in `lib/db/messages.ts` — sort clause
- Thread detail query in `routes/threads.ts` — sort clause
- Drizzle schema in `lib/schema/sessions.ts` — column definition

---

## 2. ChannelRouter

A class that owns reply tracking and delivery orchestration. Extracted from the DO's `pendingChannelReply` state, `requiresExplicitChannelReply()`, `flushPendingChannelReply()`, and `insertChannelFollowup()`. Lives in `packages/worker/src/durable-objects/channel-router.ts`.

### What moves out of the DO

| Current DO code | Destination |
|---|---|
| `pendingChannelReply` state + tracking | `ChannelRouter` |
| `requiresExplicitChannelReply()` | **Deleted.** Plugin route includes `replyTo` in prompt envelope. |
| `flushPendingChannelReply()` | `ChannelRouter.consumePendingReply()` returns intent. |
| `insertChannelFollowup()` | Followup scheduling stays in the DO (see below). |
| `getSlackPersonaOptions()` | **Deleted.** Replaced by generic persona resolution. |

### Followup nudge scheduling

The current followup mechanism (`insertChannelFollowup`) writes to a `channel_followups` SQLite table and uses an alarm-based scheduler to nudge the agent after a delay. This persistent state + alarm scheduling is a DO concern, not a ChannelRouter concern. The ChannelRouter handles only the **one-shot turn-complete** case:

- `ChannelRouter.getFollowupNudge()` returns the nudge prompt content if the agent didn't send a substantive reply during this turn. Pure logic, no persistence.
- The DO is responsible for persisting the followup to `channel_followups` and scheduling the alarm. This keeps ChannelRouter stateless and testable.

### Hibernation recovery

The ChannelRouter is in-memory and ephemeral — its state is scoped to a single turn. On DO hibernation + wake, the ChannelRouter starts empty. The DO is responsible for recovering the `replyTo` context from the `prompt_queue` table's `reply_channel_type`/`reply_channel_id` columns and re-calling `channelRouter.trackReply()`. This mirrors the current `recoverPendingChannelReply()` pattern, which stays in the DO.

### The `/prompt` envelope

The `/prompt` endpoint gains an explicit `replyTo` field. The **caller** (plugin route) decides whether a reply is needed — the DO does not check channel types.

```typescript
// POST /do/prompt body
interface PromptEnvelope {
  content: string;
  threadId?: string;
  channelType?: string;
  channelId?: string;
  author?: AuthorInfo;
  model?: string;
  attachments?: PromptAttachment[];
  contextPrefix?: string;
  continuationContext?: string;
  queueMode?: string;
  // NEW: explicit reply target. If present, ChannelRouter tracks it.
  // If absent, no auto-reply. The plugin route makes this decision.
  replyTo?: {
    channelType: string;
    channelId: string;
  };
}
```

The `replyTo` field is persisted in the `prompt_queue` table (in the existing `reply_channel_type`/`reply_channel_id` columns) for hibernation recovery.

Example — Slack plugin route sets `replyTo`:
```typescript
await dispatchOrchestratorPrompt(env, {
  content: message.text,
  channelType: 'slack',
  channelId: dispatchChannelId,
  threadId: orchestratorThreadId,
  replyTo: { channelType: 'slack', channelId: dispatchChannelId },
});
```

Web UI route omits it — no auto-reply needed.

**Thread origin recovery for web UI steering**: When a web UI prompt targets a thread that originally came from Slack, the web UI doesn't know the origin channel. The DO resolves this via `getThreadOriginChannel(threadId)` and sets `replyTo` itself before passing to the ChannelRouter. This lookup stays in the DO's `handlePrompt` — it's session state, not plugin logic.

### Composite channel IDs

The current code uses composite `channelId` values (e.g., `C123:thread_ts` for Slack) that the DO decomposes via `parseSlackChannelId`. With the `replyTo` design, the plugin route constructs the composite `channelId` and passes it as-is. The transport that created the composite knows how to decompose it when sending. No parsing logic needed in the DO or ChannelRouter.

### Explicit `channel-reply` from the runner

When the runner sends a `channel-reply` message (agent explicitly called the `channel_reply` tool), the DO:
1. Calls `channelRouter.markHandled(channelType, channelId)` to prevent auto-reply
2. Resolves persona via the generic `resolveOrchestratorPersona()` utility
3. Sends the reply via the transport

The `handleChannelReply` method stays in the DO because it handles file/image attachments, credential resolution per channel type, and Slack shimmer status clearing — logic that is beyond the scope of the text-only `sendChannelReply` auto-reply path. But it loses its Slack-specific persona code, replaced by generic persona resolution via `ChannelContext.persona`.

Note: The Slack transport's `sendMessage` implementation must be updated to read persona from `ctx.persona` instead of `message.platformOptions`.

### API

```typescript
class ChannelRouter {
  /** Track that the current prompt expects a reply to this channel. */
  trackReply(
    replyTo: { channelType: string; channelId: string },
    promptContent: string,
  ): void;

  /** Mark a channel as handled (agent explicitly called channel_reply). */
  markHandled(channelType: string, channelId: string): void;

  /** Attach the agent's response content to the pending reply. Called on finalizeTurn. */
  setResult(content: string, messageId: string): void;

  /**
   * Consume the pending reply on turn complete.
   * Returns the reply intent if the agent didn't handle it, or null.
   * Clears internal state. No-ops if no reply is tracked.
   */
  consumePendingReply(): {
    channelType: string;
    channelId: string;
    content: string;
    messageId: string;
  } | null;

  /**
   * If the agent didn't send a substantive reply during this turn,
   * return a followup nudge prompt to queue. Returns null if no nudge needed.
   * Stateless — the DO handles persistence and alarm scheduling.
   */
  getFollowupNudge(): { content: string } | null;

  /** Reset all state. */
  clear(): void;
}
```

### `sendChannelReply` — the generic auto-reply dispatch function

A standalone function for the **auto-reply** path (text-only). The explicit `handleChannelReply` path (which supports file/image attachments, credential variations, and Slack shimmer clearing) remains separate in the DO.

```typescript
// packages/worker/src/services/channel-reply.ts
async function sendChannelReply(
  env: Env,
  reply: { channelType: string; channelId: string; content: string; messageId: string },
  ctx: ChannelContext,
): Promise<boolean> {
  // 1. Resolve the ChannelTransport from the action registry by channelType
  // 2. Build the ChannelTarget (channelId may be composite, e.g. "C123:thread_ts")
  //    — the transport that created the composite knows how to decompose it
  // 3. Call transport.sendMessage(target, { markdown: reply.content }, ctx)
  //    — persona is already on ctx, transport maps to wire format
  // 4. Return true on success, false on failure (caller handles stamping/broadcast)
}
```

This function does NOT:
- Stamp the assistant message with delivery metadata (caller does via `MessageStore.stampChannelDelivery`)
- Broadcast `message.updated` to WebSocket clients (caller does)
- Persist followup state (caller does)
- Resolve persona (caller passes via `ctx`)
- Handle file/image attachments (explicit `handleChannelReply` does)

---

## 3. Persona Resolution via ChannelContext

Persona resolution (looking up the orchestrator's name and avatar) is a platform concern, not a plugin concern. Plugin transports receive the persona through the existing `ChannelContext` interface and map it to their wire format.

### SDK change

The `ChannelContext` interface gains a `persona` field. Existing fields (`orgId`, `platformCache`) are preserved.

```typescript
// packages/sdk/src/channels/index.ts
interface ChannelContext {
  token: string;
  userId: string;
  orgId?: string;
  platformCache?: Map<string, unknown>;
  persona?: {
    name?: string;
    avatar?: string;
    // Extensible: transports can read additional fields if needed.
    // e.g., Slack may need attribution metadata for compliance.
    metadata?: Record<string, unknown>;
  };
}
```

The `metadata` field allows transports to access platform-specific persona data (e.g., Slack user ID for attribution) without polluting the core interface.

### Platform utility

```typescript
// packages/worker/src/services/persona.ts
async function resolveOrchestratorPersona(
  env: Env,
  userId: string,
): Promise<{ name?: string; avatar?: string; metadata?: Record<string, unknown> }> {
  // Query D1 for orchestrator identity via getOrchestratorIdentity(appDb, userId).
  // Same data as current getSlackPersonaOptions() but returns generic shape.
  // metadata may include slackUserId for Slack attribution compliance.
}
```

The DO has `userId` readily available in state. Called once before dispatching to any transport. Each transport maps persona to its own wire format:

```typescript
// Slack transport — uses persona for username/icon
// NOTE: Must be updated to read from ctx.persona instead of message.platformOptions
sendMessage(target, content, ctx) {
  await postMessage({
    channel: target.channelId,
    text: content.markdown,
    ...(ctx.persona?.name ? { username: ctx.persona.name } : {}),
    ...(ctx.persona?.avatar ? { icon_url: ctx.persona.avatar } : {}),
  });
}

// Telegram transport — persona not applicable to bot API
sendMessage(target, content, ctx) {
  await sendTelegramMessage(target.channelId, content.markdown);
}
```

Plugin authors never query D1 for identities. They just read `ctx.persona` if their channel supports it.

---

## 4. Elimination of Direct D1 Message Writes

### Removed paths

1. **`dispatchOrchestratorPrompt`** (services/orchestrator.ts:452): Remove `db.saveMessage()` call. The DO's `handlePrompt` → `MessageStore.writeMessage()` is the sole write path. D1 gets the message via `flushToD1()`.

2. **`sendSessionMessage`** (services/sessions.ts:586): Remove the `db.saveMessage()` call after the DO accepts the prompt. Same reasoning.

### Consequence

- No more duplicate user messages with different IDs.
- D1 is always populated by the flush, so `session_id`, `thread_id`, `channel_type` etc. are always consistent between DO SQLite and D1.
- The `GET /api/sessions/:id/messages` endpoint continues to proxy to the DO (reads from DO SQLite). D1 is a read replica used by:
  - `GET /api/sessions/:sessionId/threads/:threadId` (thread detail page)
  - Cross-session queries (search, if added later)

### User-visible D1 delay

With direct D1 writes eliminated, there is now a delay between when a user message enters the DO and when it appears in D1. The flush happens at `handlePromptComplete` (turn end) or via debounced timer. For the primary message-reading path (`GET /api/sessions/:id/messages`), this is invisible — it reads from DO SQLite. The thread detail page (`GET /api/sessions/:sessionId/threads/:threadId`) reads from D1 and may show stale data during an active turn. This is an acceptable tradeoff.

### `batchUpsertMessages` contract change

The `batchUpsertMessages` function in `lib/db/messages.ts` MUST be updated to:
1. Accept `createdAt: number` (integer seconds) in each message row.
2. Include `created_at_epoch` explicitly in the `INSERT OR REPLACE` column list.
3. Accept `messageFormat: string` (default `'v2'`) — already required by the current function.

D1 read queries that must be updated to sort by `created_at_epoch`:
- `getSessionMessages` in `lib/db/messages.ts`
- Thread detail query in `routes/threads.ts`
- Drizzle schema in `lib/schema/sessions.ts` — add `createdAtEpoch` column definition

---

## 5. What Stays in the DO

The DO (`session-agent.ts`) retains:

- **Prompt queue management**: enqueue, dequeue, status transitions. Persists `replyTo` as `reply_channel_type`/`reply_channel_id` for ChannelRouter hibernation recovery.
- **Runner WebSocket lifecycle**: connect, disconnect, send/receive
- **Per-channel OpenCode session routing**: `channelKeyFrom`, `getChannelOcSessionId`
- **Thread normalization**: `if (threadId) { channelType = 'thread'; channelId = threadId; }` — generic, not plugin-specific
- **Thread origin recovery**: `getThreadOriginChannel(threadId)` for web UI thread steering → sets `replyTo`
- **WebSocket broadcasting to clients**: `broadcastToClients()` after MessageStore calls — the DO reads snapshots from the store and formats them for the WebSocket protocol
- **Debounce timer**: DO decides when to call `messageStore.flushToD1()`, timer logic stays on DO
- **Followup persistence + alarm scheduling**: `channel_followups` table + alarm handler
- **Session lifecycle**: start, stop, hibernate, wake, GC
- **`handleChannelReply`**: explicit channel_reply path with file/image attachment support. Stays in DO, uses generic persona resolution + `channelRouter.markHandled()`.
- **ChannelRouter hibernation recovery**: on DO wake, recover `replyTo` from `prompt_queue` and re-call `channelRouter.trackReply()`.

The DO does **NOT** retain:
- Raw `INSERT INTO messages` or `UPDATE messages` SQL
- The `activeTurns` Map
- `recoverTurnFromSQLite()`
- `flushMessagesToD1()` or watermark tracking
- `pendingChannelReply` state
- `requiresExplicitChannelReply()`
- `getSlackPersonaOptions()`
- Any Slack/Telegram-specific reply logic

---

## 6. File Layout

```
packages/worker/src/durable-objects/
  session-agent.ts              # Thin coordinator: prompt routing, WebSocket, runner mgmt
  message-store.ts              # NEW: MessageStore class (persistence + streaming state)
  channel-router.ts             # NEW: ChannelRouter class
  event-bus.ts                  # Unchanged
  workflow-executor.ts          # Unchanged

packages/worker/src/services/
  persona.ts                    # NEW: resolveOrchestratorPersona()
  channel-reply.ts              # NEW: sendChannelReply() auto-reply dispatch

packages/worker/src/lib/db/
  messages.ts                   # UPDATED: batchUpsertMessages accepts created_at

packages/worker/src/lib/schema/
  sessions.ts                   # UPDATED: add createdAtEpoch column to messages schema

packages/sdk/src/channels/
  index.ts                      # UPDATED: persona field on ChannelContext

packages/plugin-slack/src/channels/
  transport.ts                  # UPDATED: read persona from ctx.persona instead of platformOptions
```

---

## 7. Migration

### D1 migration

New migration to add `created_at_epoch INTEGER` column:

```sql
ALTER TABLE messages ADD COLUMN created_at_epoch INTEGER;
UPDATE messages SET created_at_epoch = CAST(strftime('%s', created_at) AS INTEGER)
  WHERE created_at IS NOT NULL;
```

The updated `batchUpsertMessages` writes to `created_at_epoch`. D1 read queries use `created_at_epoch` with fallback to `created_at` for old rows.

### DO SQLite

Existing DOs that wake up with the old schema (no `seq` column) need an `ALTER TABLE` migration in the constructor:

```typescript
// In blockConcurrencyWhile
this.ctx.storage.sql.exec(SCHEMA_SQL);  // CREATE TABLE IF NOT EXISTS — no-op for existing tables
try {
  this.ctx.storage.sql.exec('ALTER TABLE messages ADD COLUMN seq INTEGER DEFAULT NULL');
} catch { /* already exists */ }
```

Note: `ALTER TABLE ADD COLUMN` cannot use `NOT NULL` without a default, so the migration adds it as nullable. The `NOT NULL` constraint in `CREATE TABLE` only applies to fresh DOs. Old rows have `seq = NULL` — this is safe because:
1. They were already flushed to D1 under the old watermark scheme.
2. The `MessageStore` initializes `nextSeq` from `COALESCE(MAX(seq), 0) + 1`, so new messages get valid seq values.
3. The flush query `WHERE seq > ?` excludes NULL rows (`NULL > 0` is falsy in SQLite).
4. The `UNIQUE INDEX` on seq allows multiple NULLs per SQL standard.

### Rollout

Deploy as a single release. All new sessions use the new code. Existing terminated/archived sessions are unaffected (read-only). Running sessions will reconnect to a DO with the new schema and migration. The constructor handles both fresh DOs (CREATE TABLE) and existing DOs (ALTER TABLE).

---

## Boundaries

This spec covers:
- MessageStore class (in-memory streaming state + DO SQLite persistence + D1 replication)
- ChannelRouter class (reply tracking + delivery orchestration)
- `sendChannelReply` auto-reply dispatch function
- Persona resolution via ChannelContext
- Elimination of direct D1 message writes and the `activeTurns` Map
- Schema changes (DO SQLite + D1)
- `batchUpsertMessages` contract change
- Slack transport persona migration

This spec does NOT cover:
- Per-channel OpenCode session routing (stays in DO, separate concern)
- Prompt queue redesign (orthogonal)
- WebSocket protocol changes (unchanged)
- Runner protocol changes (unchanged — Runner still sends message.create/text-delta/tool-update/finalize/complete)
- Workflow executor changes (unchanged)
- EventBus changes (unchanged)
- ChannelTransport lifecycle hooks (see below)

---

## Future Direction: ChannelTransport Lifecycle Hooks

The current plugin system is designed around the worker's request-response model (inbound webhooks, outbound sends). The DO's real-time message lifecycle — streaming, turn accumulation, routing — is opaque to plugins. This creates tension: the DO has channel-specific logic (Slack shimmer, credential variations, handleChannelReply attachment handling) that ideally would live in the plugin.

The MessageStore's methods (`createTurn`, `appendTextDelta`, `updateToolCall`, `finalizeTurn`) are natural extension points for channel transport lifecycle hooks:

```typescript
// Future SDK extension (backward-compatible — all hooks optional)
interface ChannelTransport {
  // Existing
  sendMessage(target, content, ctx): Promise<void>;
  parseInbound(headers, body, ctx): Promise<InboundMessage>;

  // Future: lifecycle hooks for real-time participation
  onTurnStarted?(target: ChannelTarget, ctx: ChannelContext): Promise<void>;
  onTextDelta?(target: ChannelTarget, delta: string, accumulated: string, ctx: ChannelContext): Promise<void>;
  onTurnFinalized?(target: ChannelTarget, content: string, ctx: ChannelContext): Promise<void>;
}
```

This would enable Slack edit-based streaming, custom routing logic, and moving the remaining channel-specific code out of the DO into plugins. The MessageStore and ChannelRouter are designed so these hooks can be added without restructuring — the hook dispatch points are the existing method boundaries.

**Implementation note**: When implementing MessageStore and ChannelRouter, add `// FUTURE: dispatch channel transport lifecycle hook here` comments at `createTurn`, `appendTextDelta`, `finalizeTurn`, and `consumePendingReply` to mark the intended extension points. This ensures the future hook system can be added without refactoring the core message flow.
