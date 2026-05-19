# Real-Time Communication

> Defines the real-time messaging architecture — WebSocket connections, event broadcasting, streaming protocols, and client reconnection — that powers live chat, agent activity, and cross-session notifications.

## Scope

This spec covers:

- SessionAgentDO WebSocket handling (client and runner connections)
- Client-to-DO message types and broadcasting
- V2 parts-based streaming protocol (message creation, text deltas, tool updates, finalization)
- EventBusDO design and event fan-out
- Event types and emission patterns
- Client WebSocket hook (connection, reconnection, stale socket handling)
- Client chat state machine (`useChat`)
- Message deduplication
- Keepalive protocol
- Multiplayer presence tracking

### Boundary Rules

- This spec does NOT cover session lifecycle or state machine transitions (see [sessions.md](sessions.md))
- This spec does NOT cover Runner-to-DO WebSocket protocol details or sandbox internals (see [sandbox-runtime.md](sandbox-runtime.md))
- This spec does NOT cover business logic (prompt queue modes, hibernation, etc.) — only the transport and broadcasting layer

## Data Model

The real-time subsystem does not own any D1 tables. Its state is transient:

- **SessionAgentDO SQLite**: `connected_users` table tracks currently connected user IDs per session. `messages` table serves as real-time message store (separate from D1).
- **EventBusDO**: stateless — no persistent storage. Uses Cloudflare hibernation-aware WebSocket tags for connection routing.
- **Client**: React state managed by `useChat` hook via `useState`.

### Event Types

```typescript
type EventBusEventType =
  | 'session.update'
  | 'session.started'
  | 'session.completed'
  | 'session.errored'
  | 'sandbox.status'    // Defined but never emitted
  | 'question.asked'
  | 'question.answered'
  | 'notification';

interface EventBusEvent {
  type: EventBusEventType;
  sessionId?: string;
  userId?: string;
  data: Record<string, unknown>;
  timestamp: string;
}
```

## Architecture Overview

Two independent real-time channels operate in parallel:

### Channel 1: SessionAgentDO WebSocket (Primary)

Per-session. All chat messages, agent status, tool calls, streaming text, multiplayer presence, and interactive features flow through this channel. This is the **only channel actively consumed by the client**.

```
Browser  <-- WS -->  CF Worker Route  <-- proxied -->  SessionAgentDO
                                                              |
                                                   Runner <-- WS --> DO
```

### Channel 2: EventBusDO WebSocket (Secondary)

Global singleton. Receives fire-and-forget notifications from SessionAgentDOs and WorkflowExecutorDO. Designed for cross-session notifications (dashboard updates, workflow status). **Server-side is fully implemented but has no client-side consumer.**

```
SessionAgentDO  -- POST /publish -->  EventBusDO  -- WS -->  (no client consumer)
```

## SessionAgentDO WebSocket Handling

### Connection Types

The DO distinguishes two WebSocket roles via the `role` query parameter:

**Client (`role=client`):**
- URL: `GET /api/sessions/:id/ws?role=client&userId={userId}&token={token}`
- Tagged: `client:{userId}` (enables per-user socket lookup)
- Multiple connections per user allowed
- Multiple users per session allowed (multiplayer)

**Runner (`role=runner`):**
- URL: `wss://<worker>/ws?role=runner&token={runnerToken}`
- Tagged: `runner`
- Only one runner connection at a time (new replaces old)
- Auth: token validated against stored `runnerToken`

### Client Connection Lifecycle

**On connect:**
1. Accept WebSocket with tag `client:{userId}`.
2. Insert into `connected_users` table.
3. Fetch user profile from D1 (name, email, avatar) — cached in-memory.
4. Send `init` message with complete session state.
5. Send any pending `question` messages individually.
6. Broadcast `user.joined` to all other clients.
7. Fire-and-forget `session.update` to EventBusDO.

**On disconnect:**
1. Check if user has other open connections to this session.
2. If last connection: remove from `connected_users`, broadcast `user.left`, notify EventBusDO.
3. Clean up user details cache.

### Runner Connection Lifecycle

**On connect:**
1. Validate `token` against stored `runnerToken`.
2. Close any existing runner connection.
3. Accept WebSocket with tag `runner`.
4. Send `{ type: 'init' }`.
5. Send `opencode-config` with provider keys, persona files, custom providers.
6. Broadcast `runnerConnected: true` to all clients.
7. **Do NOT drain queue** — wait for runner to signal readiness via `agentStatus: idle`.

**On disconnect:**
1. Revert all `processing` prompts to `queued`.
2. Set `runnerBusy = false`.
3. Broadcast `runnerConnected: false` to all clients.

### Broadcasting

```typescript
broadcastToClients(message: ClientOutbound): void
```

Sends to **all** client sockets — no per-user filtering within a session. Every connected user receives every message.

Exception: `sendToastToUser(userId, toast)` uses tag-based lookup (`client:{userId}`) to send only to a specific user's sockets.

### Init Message

On client connect, the DO sends a single comprehensive `init` message:

```typescript
{
  type: 'init',
  messages: Message[],         // All messages from DO SQLite
  status: SessionStatus,
  workspace: string,
  title?: string,
  sandboxId?: string,
  tunnelUrls?: Record<string, string>,
  runnerConnected: boolean,
  runnerBusy: boolean,
  connectedUsers: ConnectedUser[],
  availableModels: ProviderModels[],
  auditLog: AuditLogEntry[],
  queueLength: number,
}
```

This replaces any stale client state with the authoritative server state. Pending questions are sent as separate `question` messages after init.

### Client Outbound Message Types

| Type | Purpose | Broadcast Target |
|------|---------|-----------------|
| `init` | Full state on connect | Single client |
| `message` | New chat message | All clients |
| `message.updated` | Updated message content/parts | All clients |
| `messages.removed` | Messages deleted (revert) | All clients |
| `chunk` | Streaming text delta | All clients |
| `status` | Session/runner state changes | All clients |
| `agentStatus` | Agent activity indicator | All clients |
| `question` | Agent asking for input | All clients |
| `error` | Error message | All clients |
| `models` | Available model list | All clients |
| `user.joined` / `user.left` | Presence changes | All clients |
| `git-state` | Branch/commit updates | All clients |
| `pr-created` | PR creation | All clients |
| `files-changed` | File modification list | All clients |
| `child-session` | Child session spawned; includes `threadId` when spawned from an orchestrator thread so cards can be scoped to that thread | All clients |
| `title` | Title update | All clients |
| `audit_log` | Audit entry | All clients |
| `diff` | Git diff result | All clients |
| `review-result` | Code review result | All clients |
| `command-result` | Slash command result | All clients |
| `model-switched` | Model failover | All clients |
| `toast` | Server-pushed notification | Per-user |
| `pong` | Keepalive response | Single client |

### Client Inbound Message Types

| Type | Purpose |
|------|---------|
| `prompt` | Send message (content, model, attachments, queueMode, channel) |
| `answer` | Answer question (questionId, answer) |
| `abort` | Cancel current operation |
| `revert` | Undo message (messageId) |
| `diff` | Request git diff |
| `review` | Request code review |
| `command` | Execute slash command |
| `ping` | Keepalive |

## V2 Parts-Based Streaming Protocol

The primary protocol for streaming assistant responses from Runner through the DO to clients.

### Message Lifecycle

```
Runner                          SessionAgentDO                    Client
  |                                  |                              |
  |-- message.create {turnId} ----->|                              |
  |                                  |-- stores placeholder msg    |
  |                                  |-- broadcast: message {} --->|
  |                                  |                              |
  |-- message.part.text-delta ----->|                              |
  |   {turnId, delta}               |-- broadcast: chunk -------->|
  |                                  |   {id, content, delta}      |
  |   (repeats for each chunk)       |                              |
  |                                  |                              |
  |-- message.part.tool-update ---->|                              |
  |   {turnId, callId, status,      |-- updates parts in SQLite   |
  |    toolName, args?, result?}     |-- broadcast: message.updated|
  |                                  |                              |
  |-- message.finalize ------------>|                              |
  |   {turnId, reason, finalText}    |-- stores final content      |
  |                                  |-- broadcast: message.updated|
  |                                  |                              |
```

### Hibernation Recovery

If the DO hibernates mid-turn, `recoverTurnFromSQLite` reconstructs the turn state from the placeholder message row. This allows the V2 protocol to resume streaming after wake without message loss.

### Content-Wins Rule

When the client receives `message.updated`, it uses a length comparison to avoid clobbering:

```typescript
const newContent = (update.content?.length ?? 0) >= (existing.content?.length ?? 0)
    ? update.content : existing.content;
```

This prevents tool-update broadcasts (which may not include the latest text) from overwriting text accumulated from `chunk` messages during streaming.

## EventBusDO

### Design

Singleton Durable Object accessed via `EVENT_BUS.idFromName('global')`. Uses Cloudflare's hibernation-aware WebSocket API.

### Interfaces

**WebSocket upgrade** (`/api/events/ws`):
- Requires `userId` query parameter.
- Tags socket with `user:{userId}`.
- Currently has **no client-side consumer**.

**HTTP publish** (`POST /publish`):
- Body: `{ userId?, event: EventBusEvent }`
- If `userId` present: targeted broadcast to that user's sockets.
- If absent: broadcast to all connected sockets.

### Fan-Out Logic

```typescript
// Targeted: only sockets tagged for this user
broadcast(userId, event) {
    const sockets = this.ctx.getWebSockets(`user:${userId}`);
    // send to each
}

// Global: all connected sockets
broadcastAll(event) {
    const sockets = this.ctx.getWebSockets();
    // send to each
}
```

### Subscription Filtering

The `subscribe` message type is parsed but explicitly not implemented. All events are broadcast to all of a user's connections regardless of subscription preferences. Comment in code: "The actual filtering happens in a future iteration if needed."

### Event Emission Sources

**SessionAgentDO** (7 call sites):

| Event Type | Trigger |
|------------|---------|
| `session.update` | Client connects (user.joined) |
| `session.update` | Client disconnects (user.left) |
| `session.started` | Session `/start` called |
| `session.completed` | Session terminated |
| `session.errored` | Agent error or sandbox spawn failure |
| `question.asked` | Agent asks a question |
| `question.answered` | User answers a question |

**WorkflowExecutorDO** (2 call sites):

| Event Type | Category | Trigger |
|------------|----------|---------|
| `notification` | `workflow.execution.enqueued` | Workflow execution dispatched |
| `notification` | `workflow.execution.{resumed\|denied\|cancelled}` | Workflow lifecycle action |

All emissions are fire-and-forget with catch blocks — EventBus failures never affect session or workflow operation.

## Client Implementation

### WebSocket Hook (`useWebSocket`)

Core transport layer for all client WebSocket connections.

**Connection setup:**
```typescript
const wsUrl = new URL(getWebSocketUrl(url));
wsUrl.searchParams.set('userId', userId);
wsUrl.searchParams.set('token', token);
const ws = new WebSocket(wsUrl.toString());
```

**Reconnection:** exponential backoff with 20% random jitter.
- Schedule: 1s, 2s, 4s, 8s, 16s, 30s (capped).
- Max attempts: 10 (default).
- **Stale socket guard**: if a newer WebSocket replaced this one during reconnect, the old socket's `onclose` is a no-op.

**Callback stability:** callbacks stored in refs and updated without triggering reconnection, preventing WebSocket churn on parent re-renders.

**Disconnect:** sets reconnect attempts to max to prevent further reconnection, then closes socket.

### Chat Hook (`useChat`)

Central orchestrator of client-side real-time. Manages 18+ state fields.

**State shape:**

```typescript
interface ChatState {
  messages: Message[];
  status: SessionStatus;
  pendingQuestions: PendingQuestion[];
  connectedUsers: ConnectedUser[];
  logEntries: LogEntry[];
  isAgentThinking: boolean;
  agentStatus: AgentStatus;   // idle | thinking | tool_calling | streaming | error | queued
  agentStatusDetail?: string;
  availableModels: ProviderModels[];
  diffData: DiffFile[] | null;
  runnerConnected: boolean;
  sessionTitle?: string;
  childSessionEvents: ChildSessionEvent[]; // each event may carry threadId for thread-scoped cards
  reviewResult: ReviewResultData | null;
  // ...
}
```

**Key message handlers:**

| Message Type | Behavior |
|-------------|----------|
| `init` | Complete state replacement. Reconstructs child sessions from message history, preserving message `threadId` for thread-scoped cards. Normalizes connected users. Seeds audit log. Auto-selects model. |
| `message` | Adds new message. **Deduplicates by ID** — skips if message already exists. |
| `message.updated` | Updates existing message in-place with content-wins rule. |
| `chunk` | Appends text delta to message content and parts. Sets `streaming: true` on text part. |
| `agentStatus` | Updates agent activity indicator. |
| `status` | Handles question lifecycle, connected users, runner state, terminal detection. |
| `user.joined` / `user.left` | Updates `connectedUsers` array. |

**React Query cache sync:** when WebSocket reports a status change, the hook writes it directly to React Query cache and invalidates session lists. This keeps list views fresh without polling.

**Session navigation:** when `sessionId` changes, state resets to `createInitialState()` before the new connection's `init` arrives.

### Keepalive Protocol

Both client and runner send `ping` messages every 30 seconds:

**Client** (`useChat`):
```typescript
useEffect(() => {
    if (!isConnected) return;
    const interval = setInterval(() => send({ type: 'ping' }), 30000);
    return () => clearInterval(interval);
}, [isConnected, send]);
```

**Runner** (`AgentClient`): 30-second interval, expects `pong` response.

**DO**: responds to `ping` with `pong` for both client and runner sockets.

## Message Deduplication

**Client-side only.** The `message` handler in `useChat` checks:

```typescript
if (prev.messages.some((existing) => existing.id === msg.id)) {
    return prev;  // Skip duplicate
}
```

There is **no server-side deduplication** in `broadcastToClients`. The same message is sent to all client sockets, including multiple connections from the same user. The client is responsible for dedup.

## Edge Cases & Failure Modes

### Multiple Connections from Same User

A user with two browser tabs will have two WebSocket connections to the same SessionAgentDO. Both receive all messages (no server-side dedup). The `connected_users` table tracks distinct user IDs, not connection count, so `user.left` only fires when the user's **last** connection closes.

### Client Reconnection State Recovery

On reconnect, the DO sends a fresh `init` message with complete state. This eliminates the need for event replay, missed event recovery, or state reconciliation. The tradeoff is potentially large init messages for sessions with many messages.

### WebSocket Close During Streaming

If a client WebSocket closes mid-stream, the DO continues broadcasting to remaining clients. The disconnected client's `chunk` messages are lost. On reconnect, the `init` message includes the finalized message content, so no data is permanently lost — just the streaming experience for that client.

### EventBus Failures

All EventBus emissions use fire-and-forget with error suppression. EventBus downtime has zero impact on session functionality.

### Runner Replacement

When a new runner connects, the old runner's WebSocket is closed with code 1000 and reason "Replaced by new runner connection". Clients are notified of the reconnection via `runnerConnected` status messages.

### Stale Socket Guard

The `useWebSocket` hook protects against stale socket close handlers:

```typescript
ws.onclose = () => {
    if (wsRef.current !== null && wsRef.current !== ws) return; // stale
    // ... handle close
};
```

This prevents a race where an old socket's close handler fires after a new socket has already been established, which would incorrectly set state to disconnected.

## Implementation Status

### Fully Implemented
- SessionAgentDO dual-role WebSocket management (client + runner)
- Full init-on-connect state hydration
- V2 parts-based streaming protocol with hibernation recovery
- Multiplayer presence tracking (join/leave/connected users)
- EventBusDO with user-tagged broadcasting
- Event emission from SessionAgentDO (7 event types) and WorkflowExecutorDO (notifications)
- Client WebSocket hook with exponential backoff reconnection
- Client chat state machine handling 23+ message types
- Client-side message deduplication
- 30-second keepalive protocol
- React Query cache sync from WebSocket events
- Toast notifications (per-user targeted)

### Stubbed / Unused
- **`useSSE` hook** (`use-sse.ts`): defined but never imported anywhere. Dead code.
- **Per-session SSE endpoint** (`GET /api/sessions/:id/events`): sends heartbeat only, no real events.
- **EventBusDO client consumer**: the `/api/events/ws` route works server-side but no client component connects to it. Events are emitted but not consumed.
- **EventBus subscription filtering**: `subscribe` message type is parsed but not acted upon.
- **`sandbox.status` event type**: defined in shared types but never emitted.
