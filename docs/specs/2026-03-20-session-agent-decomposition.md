# SessionAgent DO Decomposition

**Date**: 2026-03-20
**Status**: Proposed
**Scope**: Phased decomposition of the ~10,000-line `session-agent.ts` monolith into focused, testable subsystems

## Problem

`session-agent.ts` is a single file containing 12 subsystems, 40+ state keys in a stringly-typed key-value table, 15+ raw SQL write paths, and a 130-case runner message handler. Every new feature touches this file, and the lack of internal boundaries means changes in one subsystem routinely break others. The file is too large to hold in context, too coupled to test, and too fragile to modify safely.

## Current Subsystem Map

| # | Subsystem | Responsibility | ~Lines | SQLite Tables |
|---|---|---|---|---|
| 1 | Message Handling | Write, stream, read, flush messages | ~800 | `messages` |
| 2 | Prompt Queue | Enqueue, dispatch, recover, collect mode | ~600 | `prompt_queue` |
| 3 | Channel Reply | Track pending replies, flush to channel | ~300 | reads `prompt_queue` |
| 4 | Session Lifecycle | Start, stop, hibernate, wake, GC | ~500 | `state` |
| 5 | Runner Management | WebSocket lifecycle, health, watchdogs | ~400 | — |
| 6 | Sandbox Management | Spawn, terminate, tunnel URLs | ~300 | `state` |
| 7 | Interactive Prompts | Questions, approvals, expiry | ~300 | `interactive_prompts` |
| 8 | Child Sessions | Spawn, terminate, forward messages | ~400 | — (D1) |
| 9 | Metrics / Analytics | Buffer events, flush to D1 | ~200 | `analytics_events` |
| 10 | Channel Routing | Per-channel OpenCode session mapping | ~150 | `channel_state` |
| 11 | Channel Followups | Reminder scheduling per channel | ~150 | `channel_followups` |
| 12 | Alarm Dispatcher | Routes alarm() to all time-based work | ~150 | reads all |

Plus the `state` table: a stringly-typed key-value store holding ~40 keys with no schema, no types, and no namespacing.

## Design Principles

1. **Extract classes, not microservices.** Each subsystem becomes a class in its own file within `durable-objects/`. The DO remains the single Durable Object — it just delegates to focused collaborators.

2. **SQLite ownership is exclusive.** Each class owns its table(s). No other class writes to another's tables. Cross-subsystem reads go through methods, not raw SQL.

3. **The DO is a thin coordinator.** It wires classes together, handles WebSocket upgrade/routing, and manages the alarm dispatcher. Business logic lives in the extracted classes.

4. **State is typed.** The `state` key-value table is replaced with typed properties on the classes that own them. Each class manages its own state persistence.

5. **Incremental delivery.** Each phase ships independently and leaves the system working. No phase depends on a future phase to be correct.

6. **Plugin extension points marked.** Each extracted class marks where future ChannelTransport lifecycle hooks would attach, per the future direction in the MessageStore spec.

## Phases

### Phase 1: MessageStore

**Spec**: `docs/specs/2026-03-20-message-persistence-design.md` (complete)

**Extracts**: All message write paths, the `activeTurns` Map, streaming text accumulation, parts assembly, D1 replication, hibernation recovery for turns.

**New file**: `durable-objects/message-store.ts`

**SQLite tables owned**: `messages`, `replication_state`

**State keys absorbed**: `lastD1FlushAt` → internal `replication_state` table

**DO surface removed**:
- 15+ raw `INSERT INTO messages` / `UPDATE messages` call sites
- `activeTurns` Map and all mutation logic
- `flushMessagesToD1()` and watermark arithmetic
- `recoverTurnFromSQLite()`
- `scheduleDebouncedFlush()`

**Blocks**: Nothing. Ships first. Fixes the persistence bugs.

---

### Phase 2: ChannelRouter + Persona

**Spec**: Included in `docs/specs/2026-03-20-message-persistence-design.md` sections 2-3 (deferred from Phase 1 implementation)

**Extracts**: Reply tracking state, reply delivery orchestration, persona resolution.

**New files**:
- `durable-objects/channel-router.ts`
- `services/channel-reply.ts`
- `services/persona.ts`

**SQLite tables owned**: None (stateless, turn-scoped)

**State keys absorbed**: None (pendingChannelReply is currently in-memory, not in `state` table)

**DO surface removed**:
- `pendingChannelReply` field + all tracking logic
- `requiresExplicitChannelReply()`
- `flushPendingChannelReply()`
- `getSlackPersonaOptions()`

**SDK changes**:
- `ChannelContext.persona` field added
- `PromptEnvelope.replyTo` field added

**Plugin changes**:
- Slack transport reads persona from `ctx.persona` instead of `platformOptions`
- Plugin routes pass `replyTo` explicitly

**Depends on**: Phase 1 (MessageStore.stampChannelDelivery used after reply send)

---

### Phase 3: PromptQueue

**Extracts**: Prompt enqueueing, dispatch to runner, status lifecycle (`queued → processing → completed`), collect mode buffering, stuck-queue recovery, interrupt/steer logic.

**New file**: `durable-objects/prompt-queue.ts`

**SQLite tables owned**: `prompt_queue`

**State keys absorbed**:
- `queueMode` → typed property on PromptQueue
- `collectDebounceMs` → typed property
- `collectBuffer:{channelKey}` → internal Map
- `collectFlushAt:{channelKey}` → internal timer state
- `runnerBusy` → typed boolean (shared with runner management — see below)
- `lastPromptDispatchedAt` → internal timestamp
- `currentPromptAuthorId` → internal state
- `promptReceivedAt` → internal timestamp

**API sketch**:
```typescript
class PromptQueue {
  constructor(sql: SqlStorage);

  /** Enqueue a prompt. Returns queue position. */
  enqueue(prompt: PromptEntry): number;

  /** Dispatch next queued prompt to runner. Returns false if empty/busy. */
  dispatchNext(sendToRunner: (msg: RunnerMessage) => boolean): boolean;

  /** Mark current processing entry as completed. */
  markCompleted(): void;

  /** Recover stuck processing entries back to queued. */
  recoverStuck(): number;

  /** Clear all queued entries. */
  clearQueue(): number;

  /** Get current queue length. */
  get length(): number;

  /** Get the processing entry's metadata (for thread/channel resolution). */
  get processingEntry(): QueueEntry | null;

  // Collect mode
  appendToCollectBuffer(channelKey: string, content: string): void;
  flushCollectBuffer(channelKey: string): PromptEntry | null;
  get collectFlushDue(): { channelKey: string; flushAt: number }[];
}
```

**DO surface removed**:
- `handlePrompt()` queue/dispatch logic (the thread normalization and replyTo setup stays on DO)
- `sendNextQueuedPrompt()`
- `handleClearQueue()` internals
- `getQueueLength()`
- `recoverStuckQueue()`
- All collect mode buffer management
- ~10 `getStateValue`/`setStateValue` calls

**Depends on**: Phase 1 (PromptQueue reads `thread_id` for MessageStore.writeMessage context), Phase 2 (queue stores `replyTo` for ChannelRouter recovery)

---

### Phase 4: RunnerLink

**Extracts**: Runner WebSocket lifecycle, health monitoring, message routing (the giant switch statement), watchdog timers.

**New file**: `durable-objects/runner-link.ts`

**SQLite tables owned**: None

**State keys absorbed**:
- `runnerReady` → typed boolean
- `runnerBusy` → typed boolean (shared with PromptQueue — RunnerLink is authoritative, PromptQueue reads)
- `runnerToken` → typed string
- `errorSafetyNetAt` → internal timestamp

**API sketch**:
```typescript
class RunnerLink {
  /** Whether the runner WebSocket is connected and healthy. */
  get isConnected(): boolean;
  get isReady(): boolean;
  get isBusy(): boolean;

  /** Send a message to the runner. Returns false if not connected. */
  send(msg: RunnerMessage): boolean;

  /** Mark runner as busy (prompt dispatched) or idle (turn complete). */
  setBusy(busy: boolean): void;

  /**
   * Route an incoming runner message to the appropriate handler.
   * The DO provides a handler map; RunnerLink does the dispatch.
   */
  handleMessage(msg: RunnerMessage, handlers: RunnerMessageHandlers): Promise<void>;
}

interface RunnerMessageHandlers {
  onMessageCreate(msg): void;
  onTextDelta(msg): void;
  onToolUpdate(msg): void;
  onMessageFinalize(msg): void;
  onComplete(msg): Promise<void>;
  onChannelReply(msg): Promise<void>;
  onQuestion(msg): void;
  onError(msg): void;
  onModels(msg): void;
  onSpawnChild(msg): Promise<void>;
  // ... etc for all ~40 message types
}
```

The DO implements `RunnerMessageHandlers` — each handler is a short method that calls MessageStore, ChannelRouter, PromptQueue, etc. This eliminates the 130-case switch statement from the DO, replacing it with a typed handler interface.

**DO surface removed**:
- The `webSocketMessage` method's runner message switch (~2000 lines)
- `sendToRunner()`
- Watchdog methods

**Depends on**: Phases 1-3 (handlers call into MessageStore, ChannelRouter, PromptQueue)

**Note**: RunnerLink does NOT own the WebSocket primitive (`ctx.acceptWebSocket`, `webSocketMessage`). Those are DO APIs that can't be delegated. The DO still accepts the WebSocket and routes messages — RunnerLink provides `handleMessage()` which does the dispatch.

---

### Phase 5: Typed State

**Extracts**: The `state` key-value table, replacing it with typed properties on a `SessionState` class (or distributed across the owning classes from Phases 1-4).

**Approach**: By the time Phases 1-4 are complete, most state keys have been absorbed by their owning classes. The remaining keys are session-level scalars:

| Remaining key | Type | Owner |
|---|---|---|
| `sessionId` | string | SessionState |
| `userId` | string | SessionState |
| `workspace` | string | SessionState |
| `title` | string | SessionState |
| `status` | SessionLifecycleStatus | SessionState |
| `sandboxId` | string | SessionState |
| `tunnelUrls` | JSON string | SessionState |
| `tunnels` | JSON string | SessionState |
| `backendUrl` | string | SessionState |
| `terminateUrl` | string | SessionState |
| `hibernateUrl` | string | SessionState |
| `restoreUrl` | string | SessionState |
| `spawnRequest` | JSON string | SessionState |
| `snapshotImageId` | string | SessionState |
| `idleTimeoutMs` | number | SessionState |
| `lastUserActivityAt` | number | SessionState |
| `availableModels` | JSON string | SessionState |
| `parentThreadId` | string | SessionState |
| `isOrchestrator` | boolean | SessionState |

**New file**: `durable-objects/session-state.ts`

**API sketch**:
```typescript
class SessionState {
  constructor(sql: SqlStorage);

  // Typed accessors — no more getStateValue/setStateValue
  get sessionId(): string;
  get userId(): string;
  get status(): SessionLifecycleStatus;
  set status(s: SessionLifecycleStatus);
  get sandboxId(): string | null;
  set sandboxId(id: string | null);
  // ... etc

  /** Bulk-set during handleStart. */
  initialize(params: SessionStartParams): void;
}
```

**Storage**: Can use either:
- A typed SQLite table with one row and named columns (most correct)
- The existing `state` table with typed accessors that parse/validate (least migration)
- Cloudflare `ctx.storage.get`/`put` API (typed natively, but different from SQLite)

**DO surface removed**:
- `getStateValue()` / `setStateValue()` — deleted entirely
- All stringly-typed state access replaced with typed properties

**Depends on**: Phases 1-4 (most keys already absorbed)

---

### Phase 6: Lifecycle + Sandbox + Alarm

**Extracts**: Session lifecycle state machine (start → running → idle → hibernating → hibernated → terminated), sandbox spawn/terminate/hibernate/wake via Modal backend, idle timeout, and the alarm dispatcher.

**New files**:
- `durable-objects/session-lifecycle.ts` — state machine + sandbox operations
- `durable-objects/alarm-scheduler.ts` — alarm routing (or merged into lifecycle)

**SQLite tables owned**: None (uses SessionState for persistence)

**API sketch**:
```typescript
class SessionLifecycle {
  constructor(state: SessionState, env: Env);

  get status(): SessionLifecycleStatus;

  /** Transition the session through its lifecycle. */
  async start(params: StartParams): Promise<void>;
  async stop(reason: string): Promise<void>;
  async hibernate(): Promise<void>;
  async wake(): Promise<void>;
  async restore(): Promise<void>;
  async garbageCollect(): Promise<void>;

  /** Idle timeout check — called from alarm. */
  checkIdleTimeout(): boolean;

  /** Register subsystems that need alarm-driven work. */
  registerAlarmWork(name: string, check: () => { needed: boolean; nextAt?: number }): void;
}
```

The alarm dispatcher becomes a loop over registered alarm work items. Each subsystem (PromptQueue watchdog, channel followups, metrics flush, interactive prompt expiry, idle timeout) registers its alarm check at construction time. No more hardcoded alarm routing.

**DO surface removed**:
- `handleStart()`, `handleStop()`, `handleHibernate()`, `handleWake()`
- `handleGarbageCollect()`
- `alarm()` method body
- `maybeIdleTimeout()`
- `spawnSandbox()`, sandbox error handling
- `rescheduleIdleAlarm()`

**Depends on**: Phase 5 (uses SessionState for typed state access)

---

## Phase Dependencies

```
Phase 1: MessageStore          ──────────────────────┐
Phase 2: ChannelRouter         ← depends on Phase 1  │
Phase 3: PromptQueue           ← depends on Phase 1  │ can parallelize
Phase 4: RunnerLink            ← depends on 1, 2, 3  │
Phase 5: Typed State           ← depends on 1-4      ┘
Phase 6: Lifecycle + Alarm     ← depends on 5
```

Phases 2 and 3 can be done in parallel after Phase 1 ships.

## End State

After all phases, `session-agent.ts` becomes a coordinator:

```typescript
export class SessionAgentDO {
  private messageStore: MessageStore;
  private channelRouter: ChannelRouter;
  private promptQueue: PromptQueue;
  private runnerLink: RunnerLink;
  private state: SessionState;
  private lifecycle: SessionLifecycle;

  constructor(ctx: DurableObjectState, env: Env) {
    const sql = ctx.storage.sql;
    this.state = new SessionState(sql);
    this.messageStore = new MessageStore(sql);
    this.channelRouter = new ChannelRouter();
    this.promptQueue = new PromptQueue(sql);
    this.runnerLink = new RunnerLink();
    this.lifecycle = new SessionLifecycle(this.state, env);
  }

  async fetch(request: Request): Promise<Response> {
    // Route HTTP endpoints to the appropriate subsystem
  }

  async webSocketMessage(ws: WebSocket, msg: string): Promise<void> {
    // Route to runnerLink.handleMessage() or client handler
  }

  async alarm(): Promise<void> {
    // lifecycle.runAlarmChecks()
  }
}
```

The DO file shrinks from ~10,000 lines to ~500-800 lines of routing and wiring. Each extracted class is 200-600 lines, independently testable, and owns its state.

## File Layout (End State)

```
packages/worker/src/durable-objects/
  session-agent.ts          # ~500-800 lines: coordinator, HTTP routing, WS routing, alarm
  message-store.ts          # Phase 1: messages, streaming, D1 replication
  channel-router.ts         # Phase 2: reply tracking
  prompt-queue.ts           # Phase 3: queue state machine, collect mode
  runner-link.ts            # Phase 4: runner WebSocket, health, message dispatch
  session-state.ts          # Phase 5: typed state accessors
  session-lifecycle.ts      # Phase 6: lifecycle state machine, sandbox ops, alarm scheduler
  event-bus.ts              # Unchanged
  workflow-executor.ts      # Unchanged

packages/worker/src/services/
  channel-reply.ts          # Phase 2: generic auto-reply dispatch
  persona.ts                # Phase 2: orchestrator persona resolution
```

## What This Does NOT Cover

- **EventBusDO** — separate DO, already clean
- **WorkflowExecutorDO** — separate DO, already clean
- **Runner-side changes** — Runner protocol is unchanged throughout
- **Client-side changes** — WebSocket protocol is unchanged throughout
- **D1 schema redesign** — only the `created_at_epoch` addition in Phase 1
- **Plugin SDK redesign** — only the `ChannelContext.persona` addition in Phase 2
- **ChannelTransport lifecycle hooks** — marked as future extension points in Phases 1-2
