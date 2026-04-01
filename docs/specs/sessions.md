# Sessions

> Manages the lifecycle of coding agent sessions — from creation through running, hibernation, and termination — including sandbox orchestration, prompt routing, message streaming, and multiplayer access control.

## Scope

This spec covers:

- Session data model and all related tables
- Session status state machine and transitions
- Session creation flow (including sandbox spawning)
- Prompt queue system (followup, steer, collect modes)
- Message streaming (V2 parts-based protocol)
- Hibernation, restore, and idle timeout
- Termination and cascade behavior
- Question/answer flow
- Multiplayer: participants, share links, connected users
- Session access control (role hierarchy, org visibility)
- Child sessions
- Audit logging

### Boundary Rules

- This spec does NOT cover sandbox boot sequence, auth gateway, Runner internals, or OpenCode lifecycle (see [sandbox-runtime.md](sandbox-runtime.md))
- This spec does NOT cover the EventBusDO or SSE/WebSocket transport layer details (see [real-time.md](real-time.md))
- This spec does NOT cover workflow execution logic (see future `workflows.md`)
- This spec does NOT cover orchestrator identity, memory system, or coordinator behavior (see future `orchestrator.md`)

## Data Model

### `sessions` table

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| `id` | text PK | — | UUID |
| `userId` | text NOT NULL | — | FK to `users.id`, CASCADE DELETE |
| `workspace` | text NOT NULL | — | Repository name or identifier |
| `status` | text NOT NULL | `'initializing'` | See [State Machine](#state-machine) |
| `containerId` | text | — | Legacy naming; holds sandbox container ID |
| `sandboxId` | text | — | Modal sandbox ID |
| `tunnelUrls` | JSON text | — | `Record<string, string>` of named tunnel URLs |
| `metadata` | JSON text | — | Arbitrary metadata |
| `snapshotImageId` | text | — | Modal filesystem snapshot ID for hibernation |
| `messageCount` | integer | `0` | Flushed periodically from DO |
| `toolCallCount` | integer | `0` | Flushed periodically from DO |
| `errorMessage` | text | — | Populated on error |
| `activeSeconds` | integer | `0` | Total active time |
| `title` | text | — | User-facing session title |
| `parentSessionId` | text | — | For child sessions |
| `personaId` | text | — | Linked agent persona |
| `isOrchestrator` | boolean | `false` | Orchestrator session flag |
| `purpose` | text NOT NULL | `'interactive'` | `'interactive'` / `'orchestrator'` / `'workflow'` |
| `createdAt` | text | `datetime('now')` | ISO datetime |
| `lastActiveAt` | text | `datetime('now')` | ISO datetime |

**Indexes:** user, status, parent, created_at, (user, created_at), (workspace, created_at), (status, lastActiveAt), (purpose, userId, status).

### `messages` table

| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | UUID |
| `sessionId` | text NOT NULL | FK to sessions |
| `role` | text NOT NULL | `user` / `assistant` / `system` / `tool` |
| `content` | text | Plain text content |
| `parts` | JSON text | Structured message parts (text, tool calls, etc.) |
| `authorId` | text | User who sent the message |
| `authorName` | text | Display name |
| `authorEmail` | text | Email |
| `channelType` | text | `web` / `telegram` / `slack` / etc. |
| `channelId` | text | Channel-specific identifier |
| `opencodeSessionId` | text | OpenCode session that produced this message |
| `messageFormat` | text | Format identifier |
| `createdAt` | text | ISO datetime |

### `session_threads` table

Tracks orchestrator conversation threads. `sessionId` identifies the owning session row in D1, while `id` is the stable conversation handle that survives orchestrator session rotation and runner restarts.

| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | Thread identifier |
| `sessionId` | text NOT NULL | Owning session row in D1 |
| `opencodeSessionId` | text | Persisted OpenCode session bound to the thread |
| `title` | text | Agent-generated thread title |
| `status` | text NOT NULL | `active` or `archived` |
| `messageCount` | integer | Message count for sidebar/UI |
| `summaryAdditions` | integer | Git diff summary additions |
| `summaryDeletions` | integer | Git diff summary deletions |
| `summaryFiles` | integer | Git diff summary file count |
| `createdAt` | text | ISO datetime |
| `lastActiveAt` | text | ISO datetime |

### `session_git_state` table

1:1 with sessions. Tracks source context and PR state.

| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | UUID |
| `sessionId` | text UNIQUE | FK to sessions |
| `sourceType` | text | `pr` / `issue` / `branch` / `manual` |
| `sourceRepoUrl` | text | Repository URL |
| `sourceRepoBranch` | text | Source branch |
| `sourcePrNumber` | integer | Source PR number |
| `sourceIssueNumber` | integer | Source issue number |
| `branch` | text | Working branch |
| `baseBranch` | text | Base branch for diff |
| `prNumber` | integer | Created PR number |
| `prState` | text | PR state (`open`/`closed`/`merged`) |
| `prUrl` | text | PR URL |
| `commitCount` | integer | `0` |

### `session_files_changed` table

Tracks files modified during a session. Unique on `(sessionId, filePath)`.

### `session_participants` table

Multiplayer support. Unique on `(sessionId, userId)`.

| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | UUID |
| `sessionId` | text NOT NULL | FK to sessions |
| `userId` | text NOT NULL | FK to users |
| `role` | text NOT NULL | `owner` / `collaborator` / `viewer` |

### `session_share_links` table

Invite links with expiry and usage limits.

| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | UUID |
| `sessionId` | text NOT NULL | FK to sessions |
| `token` | text UNIQUE | Random token for URL |
| `role` | text NOT NULL | Role granted on redemption |
| `expiresAt` | text | ISO datetime |
| `maxUses` | integer | Usage cap |
| `useCount` | integer | `0` |
| `active` | boolean | `true` |

### `session_audit_log` table

Event log per session.

| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | `{sessionId}:{localId}` format |
| `sessionId` | text NOT NULL | FK to sessions |
| `eventType` | text NOT NULL | Event category |
| `summary` | text | Human-readable description |
| `actorId` | text | User or system that triggered it |
| `metadata` | JSON text | Additional context |
| `createdAt` | text | ISO datetime |

### TypeScript Types

```typescript
type SessionStatus = 'initializing' | 'running' | 'idle' | 'hibernating'
                   | 'hibernated' | 'restoring' | 'terminated' | 'archived' | 'error';

type SessionPurpose = 'interactive' | 'orchestrator' | 'workflow';

type SessionParticipantRole = 'owner' | 'collaborator' | 'viewer';
```

**Note on `idle` and `archived`:** These statuses are defined in the type system and `idle` is counted as active for concurrency checks, but no code path currently sets either status. They are vestigial or reserved for future use.

### Constants

```typescript
const ACTIVE_SESSION_STATUSES = ['initializing', 'running', 'idle', 'restoring'];
const ROLE_HIERARCHY = { viewer: 0, collaborator: 1, owner: 2 };
const DEFAULT_MAX_ACTIVE_SESSIONS = 10;
```

## State Machine

### Session Statuses

```
INITIALIZING ──────────> RUNNING        (sandbox spawned successfully)
             ──────────> ERROR          (sandbox spawn failed)

RUNNING ───────────────> HIBERNATING    (user request or idle timeout)
        ───────────────> TERMINATED     (user/parent stop)
        ───────────────> ERROR          (runtime error)

HIBERNATING ───────────> HIBERNATED     (snapshot completed)
            ───────────> TERMINATED     (sandbox already exited; 409 from Modal)
            ───────────> ERROR          (snapshot failed)

HIBERNATED ────────────> RESTORING      (wake request, or auto-wake when prompt arrives)
           ────────────> TERMINATED     (stop called while hibernated)

RESTORING ─────────────> RUNNING        (restore completed)
          ─────────────> ERROR          (restore failed)

ERROR ─────────────────> TERMINATED     (stop can still clean up error sessions)

TERMINATED ────────────> (terminal, idempotent)
```

### Guard Implementation

Transition guards are informal — there is no centralized state machine enforcer. Guards are scattered across DO methods:

- `handleHibernate()`: Only from `running`. Returns info message for `hibernated`/`hibernating`.
- `handleWake()`: Only from `hibernated`. Returns info message for `running`/`restoring`.
- `performWake()`: Double-checks against concurrent wake (rejects if `restoring` or `running`).
- `handleStop()`: Idempotent — returns immediately if already `terminated`.
- `handlePrompt()`: Auto-wakes if status is `hibernated`.

The DB layer's `updateSessionStatus()` has **no status validation** — any status can be written at any time. The DO's `setStateValue('status', ...)` is also unguarded.

### Dual Status Authority

Status exists in two places:

1. **D1 database** (`sessions.status`): Authoritative for terminal states. Used by list views, access checks, and API responses.
2. **DO SQLite** (`state` table): Authoritative for live state. Used by real-time operations within the DO.

Status is synced from DO to D1 at transition points via `updateSessionStatus()` calls, but this is best-effort (failures are caught and logged). The `getSessionWithStatus()` service function resolves conflicts by treating D1 as authoritative for terminal states (`terminated`, `archived`, `error`).

### Derived Runtime State

The DO computes three derived state values for the `/status` endpoint:

| State | Values | Derived From |
|-------|--------|-------------|
| `sandboxState` | `starting`, `running`, `hibernating`, `hibernated`, `restoring`, `stopped`, `error` | `lifecycleStatus`, `sandboxId` |
| `agentState` | `starting`, `busy`, `idle`, `queued`, `sleeping`, `standby`, `stopped`, `error` | `runnerConnected`, `runnerBusy`, `queuedPrompts` |
| `jointState` | `starting`, `running_busy`, `running_idle`, `queued`, `waking`, `sleeping`, `standby`, `stopped`, `error` | Combination of above |

## API Contract

### REST Endpoints

All routes under `/api/sessions`, authenticated via middleware.

| Method | Path | Access | Description |
|--------|------|--------|-------------|
| GET | `/` | authed | List sessions (paginated, filterable) |
| POST | `/` | authed | Create session |
| GET | `/available-models` | authed | List available LLM models |
| POST | `/join/:token` | authed | Redeem share link |
| POST | `/bulk-delete` | authed | Delete up to 100 owned sessions |
| GET | `/:id` | viewer | Session detail + live DO status |
| PATCH | `/:id` | owner | Update title |
| DELETE | `/:id` | owner | Terminate session |
| GET | `/:id/git-state` | viewer | Git state |
| GET | `/:id/sandbox-token` | viewer | Issue 15-minute iframe JWT |
| GET | `/:id/tunnels` | viewer | Tunnel URLs |
| DELETE | `/:id/tunnels/:name` | collaborator | Delete a tunnel |
| POST | `/:id/messages` | collaborator | Send prompt via HTTP |
| POST | `/:id/clear-queue` | collaborator | Clear prompt queue |
| GET | `/:id/messages` | viewer | Message history (paginated) |
| GET | `/:id/ws` | viewer | WebSocket upgrade (proxied to DO) |
| GET | `/:id/events` | viewer | SSE stream (stub — heartbeat only) |
| POST | `/:id/hibernate` | collaborator | Hibernate session |
| POST | `/:id/wake` | collaborator | Wake session |
| GET | `/:id/children` | viewer | Child sessions (enriched) |
| GET | `/:id/audit-log` | viewer | Audit log |
| GET | `/:id/files-changed` | viewer | Changed files list |
| GET | `/:id/participants` | viewer | List participants |
| POST | `/:id/participants` | owner | Add participant |
| DELETE | `/:id/participants/:userId` | owner | Remove participant |
| POST | `/:id/share-link` | owner | Create share link |
| GET | `/:id/share-links` | owner | List share links |
| DELETE | `/:id/share-link/:linkId` | owner | Deactivate share link |

### SessionAgentDO Internal HTTP Endpoints

The DO's `fetch()` method routes to these internal endpoints (not user-facing):

| Path | Method | Description |
|------|--------|-------------|
| `/start` | POST | Initialize session, spawn sandbox |
| `/stop` | POST | Terminate session |
| `/status` | GET | Return live status + derived states |
| `/wake` | POST | Wake from hibernation |
| `/hibernate` | POST | Initiate hibernation |
| `/clear-queue` | POST | Clear prompt queue |
| `/flush-metrics` | POST | Flush metrics to D1 |
| `/messages` | GET | Return stored messages from DO SQLite |
| `/gc` | POST | Garbage collect (delete all DO storage) |
| `/prompt` | POST | HTTP-based prompt submission |
| `/system-message` | POST | Inject system message |
| `/workflow-execute` | POST | Dispatch workflow execution |
| `/tunnels` | POST | Tunnel management |
| `/models` | GET | Return available models |
| `/queue-mode` | POST | Update queue mode |
| `/proxy/*` | * | Proxy request to sandbox |

### WebSocket Protocol (Client)

Client connects via `GET /api/sessions/:id/ws?role=client&userId={userId}&token={token}`.

**Client sends:**

| Type | Purpose | Key Fields |
|------|---------|-----------|
| `prompt` | Send message | `content`, `model?`, `attachments?`, `queueMode?`, `channelType?`, `channelId?`, `threadId?`, `continuationContext?` |
| `answer` | Answer question | `questionId`, `answer` |
| `abort` | Cancel current operation | `channelType?`, `channelId?` |
| `revert` | Undo message | `messageId` |
| `diff` | Request git diff | — |
| `review` | Request code review | — |
| `command` | Execute slash command | `command`, `args?`, `channelType?`, `channelId?` |
| `ping` | Keepalive (every 30s) | — |

**Client receives:**

| Type | Purpose |
|------|---------|
| `init` | Full session state on connect (messages, users, models, audit log, questions) |
| `message` | New chat message |
| `message.updated` | Updated message (tool calls, finalized content) |
| `messages.removed` | Messages deleted (revert) |
| `chunk` | Streaming text delta for a message |
| `status` | Session/runner state changes, question lifecycle |
| `agentStatus` | Fine-grained agent activity (`idle`/`thinking`/`tool_calling`/`streaming`/`error`/`queued`) |
| `question` | Agent asking for user input |
| `error` | Error message |
| `models` | Available model list update |
| `user.joined` / `user.left` | Multiplayer presence |
| `git-state` | Branch/commit updates |
| `pr-created` | PR creation notification |
| `files-changed` | File modification list |
| `child-session` | Child session spawned |
| `title` | Session title update |
| `audit_log` | Audit log entry |
| `diff` | Git diff result |
| `review-result` | Code review result |
| `command-result` | Slash command result |
| `model-switched` | Model failover notification |
| `toast` | Server-pushed toast notification |
| `pong` | Keepalive response |

## Flows

### Session Creation

1. Generate `sessionId` (UUID) and `runnerToken`.
2. `getOrCreateUser()` — ensure user exists in D1.
3. **Concurrency check**: Count active sessions (`initializing`, `running`, `idle`, `restoring`) for user, excluding orchestrator/workflow sessions. Default limit: 10. Orchestrator child sessions skip this check.
4. **Persona validation** (optional): Fetch persona + files, validate visibility.
5. **Insert session record** in D1 with status `initializing`.
6. **Create git state record** — always created, even if no repo.
7. **Assemble environment**: provider API keys, user git credentials, custom LLM providers, GitHub env vars.
8. **Fetch user preferences**: idle timeout (default 900s), queue mode (default `followup`).
9. **Initialize SessionAgentDO** via `POST /start`:
   - DO clears any old data (for reused DO names like orchestrators).
   - DO stores configuration in its SQLite `state` table.
   - If `backendUrl` + `spawnRequest` provided: spawns sandbox in background via `waitUntil()`.
   - If `sandboxId` + `tunnelUrls` provided directly: sets status to `running` immediately.
10. **Create web channel binding** for the session.
11. **Return** session data + WebSocket URL.

On DO init failure: session status set to `error` in D1.

### Sandbox Spawning (async, inside DO)

1. POST to Modal backend's `/create-session` endpoint with `spawnRequest`.
2. On success: store `sandboxId` + `tunnelUrls`, set status to `running`, sync to D1, broadcast to clients, schedule idle alarm.
3. On failure: set status to `error`, sync to D1, store error as system message.

### Prompt Handling

Three queue modes determine how prompts are processed:

**`followup` (default):**
1. Store user message in DO SQLite, broadcast to clients.
2. If runner is idle and connected: insert as `processing`, dispatch directly.
3. If runner is busy or disconnected: insert as `queued`, broadcast `promptQueued` status.
4. If dispatch fails (runner disappeared): revert to `queued`.

**`steer` (interrupt):**
1. Abort current work — clear queued prompts, send abort to runner.
2. Then handle as `followup`.

**`collect` (batching):**
1. Accumulate messages into a collect buffer.
2. Debounce timer (default 3000ms) flushes buffer as single combined prompt.

**Queue lifecycle:** `queued` -> `processing` -> `completed` (then pruned).

**Recovery mechanisms:**
- Runner disconnect: all `processing` entries revert to `queued`.
- 5-minute watchdog alarm: detects stuck `processing` prompts when no runner connected.
- Error safety-net alarm: forces completion if runner reports error but never sends `complete`.

### Thread Resume

For orchestrator sessions, thread identity is durable across sandbox hibernation, runner restarts, and orchestrator session rotation:

1. The UI selects a historical thread by `threadId`. Loading that thread is display-only and reads messages using the thread's owning `sessionId`.
2. Sending a new prompt with `threadId` causes the DO to normalize routing to channel `thread:<threadId>`, so all resumed messages converge on one thread channel.
3. `session_threads.opencodeSessionId` is the primary resume binding for that thread. The runner adopts that persisted OpenCode session before sending the first resumed prompt.
4. If the persisted OpenCode session still exists, the prompt continues in-place with no synthetic continuation prompt.
5. If the persisted OpenCode session is verified missing and the runner recreates it, only then may the runner inject bounded continuation context as fallback.
6. `POST /api/sessions/:sessionId/threads/:threadId/continue` reopens the existing thread. It does not mint a new thread. If the thread was archived, it is reactivated first.

### Prompt Completion

1. Runner sends `complete` message.
2. DO marks all `processing` entries as `completed`, prunes them.
3. `sendNextQueuedPrompt()`: if more queued work, dispatch next (FIFO); otherwise set `runnerBusy=false`.
4. Flush messages to D1 in background.

### Hibernation

1. Guard: only from `running` status.
2. Flush active time and metrics to D1.
3. Set status to `hibernating`, sync to D1.
4. POST to Modal backend's `/hibernate-session` (snapshots filesystem, terminates sandbox).
5. Special case: if sandbox already exited (409 from Modal), set status to `terminated`.
6. On success: store `snapshotImageId`, clear sandbox info, set status to `hibernated`.
7. Revert any `processing` prompts to `queued`.
8. **Auto-wake**: if prompts arrived during hibernation, immediately trigger wake.

### Wake/Restore

1. Guard: only from `hibernated` status. Double-check against concurrent wakes.
2. Set status to `restoring`, sync to D1.
3. POST to Modal backend's `/restore-session` with original `spawnRequest` + `snapshotImageId`.
4. On success: store new `sandboxId`/`tunnelUrls`, set status to `running`.
5. On failure: set status to `error`.

### Idle Timeout

Implemented via the DO's alarm handler:
- Checks if `status === 'running'` and `(now - lastUserActivityAt) >= idleTimeoutMs`.
- Default idle timeout: 900 seconds (15 minutes), configurable per user.
- If idle: triggers `performHibernate()` in background.
- The alarm handler also manages: collect mode flush, stuck-processing watchdog, error safety-net, periodic metrics flush, question expiry, channel follow-up reminders.

### Termination

1. Idempotent: if already `terminated`, return immediately.
2. Flush active time, metrics, and messages to D1.
3. Send `stop` to runner, close runner sockets.
4. **Cascade**: fetch all child sessions from D1, send `POST /stop` to each active child's DO.
5. Terminate sandbox via Modal backend (skipped if already hibernated/hibernating).
6. Clear all state, delete prompt queue, cancel alarm.
7. Sync `terminated` status to D1.
8. Broadcast to clients, publish to EventBus, notify parent session.

### Question/Answer Flow

1. Runner sends `question` message with `questionId`, `text`, optional `options`.
2. DO stores in `questions` table with status `pending`.
3. DO broadcasts `question` event to all clients, optionally sets expiry alarm.
4. Client sends `answer` with `questionId` and `answer` text.
5. DO validates question is still `pending`, updates to `answered`.
6. DO forwards answer to runner, broadcasts `questionAnswered` status.
7. Expired questions: alarm marks as `expired`, sends `'__expired__'` to runner.

## Edge Cases & Failure Modes

### Dual Status Inconsistency

D1 and DO can disagree on status (e.g., DO hibernated but D1 still shows `running`). Resolution: `getSessionWithStatus()` makes D1 authoritative for terminal states. Non-terminal inconsistencies are not explicitly resolved.

### Runner Disconnect During Processing

All `processing` prompts revert to `queued`. When a new runner connects and signals `idle`, the queue drains automatically.

### Sandbox Exit During Hibernation

If the sandbox self-terminated (idle timeout) before the hibernate call, Modal returns 409. The DO sets status to `terminated` directly, bypassing the normal stop flow (skips parent notification, child cascade, and audit logging).

### Concurrent Wake Requests

`performWake()` checks current status before proceeding. If already `restoring` or `running`, the second wake is a no-op.

### Auto-Wake on Prompt

If a prompt arrives while the session is `hibernated`, `handlePrompt()` triggers `performWake()` in background. The prompt is enqueued and will be dispatched once the runner reconnects after restore.

### Concurrency Limits

Active sessions (`initializing`, `running`, `idle`, `restoring`) are counted per user, excluding orchestrator and workflow sessions. Default limit: 10. Orchestrator child sessions (whose `parentSessionId` starts with `'orchestrator:'`) skip the concurrency check entirely.

### Share Link Redemption

- Validates expiry, max uses, and active status.
- Blocks sharing of orchestrator and workflow sessions.
- Auto-adds the redeeming user as a participant with the link's role.

## Access Control

### Role Hierarchy

`viewer (0)` < `collaborator (1)` < `owner (2)`

### Authorization Check Order (`assertSessionAccess`)

1. Session owner always has access (any role).
2. Orchestrator and workflow sessions are **never** accessible to non-owners (throws `NotFoundError`).
3. Check `session_participants` table for explicit role grant.
4. Org visibility fallback: `org_joinable` grants full access; `org_visible` grants viewer access.
5. If none match: `NotFoundError`.

### Route-Level Access Requirements

- **viewer**: read-only endpoints (detail, messages, children, audit log, git state, tunnels, sandbox token, participants, files changed)
- **collaborator**: send messages, clear queue, hibernate, wake, delete tunnels
- **owner**: terminate, update title, manage participants, manage share links, delete

## Implementation Status

### Fully Implemented
- Session CRUD lifecycle (create, run, terminate, delete)
- Sandbox spawning via Modal backend (async)
- Hibernation with filesystem snapshot and restore
- Idle timeout auto-hibernate
- Prompt queue with three modes (followup, steer, collect)
- V2 parts-based message streaming protocol
- Multiplayer: participants, share links, connected user tracking
- WebSocket real-time (messages, chunks, status, agent status)
- Question/answer flow with expiry
- Git state tracking (branch, PR, commits, files changed)
- Audit logging (DO-local + D1 flush)
- Concurrency limits
- Channel system (web, telegram, etc.)
- Child session spawning and cascade termination
- Model discovery, preferences, and failover
- Persona support
- Same-thread orchestrator resume with persisted OpenCode session reuse

### Stubbed / Unused
- **SSE endpoint** (`GET /api/sessions/:id/events`): sends heartbeats only, no real events.
- **`idle` status**: defined in types, counted for concurrency, but never set by any code path.
- **`archived` status**: defined in types, checked in terminal guards, but never set.

### Known Issues
- The DO is very large (~7000+ lines) and handles broad responsibility (WebSocket management, prompt queue, lifecycle, sandbox proxy, channel routing, workflow dispatch, git operations, notifications).
- No centralized state machine enforcer — status transitions rely on scattered informal guards.
- The 409 path during hibernation (sandbox already exited) sets `terminated` directly, skipping parent notification, child cascade, and audit logging.
