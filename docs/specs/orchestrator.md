# Orchestrator

> Defines the persistent per-user AI coordinator agent — its identity, memory system, child session spawning, inter-session messaging, channel routing, task management, and auto-restart behavior.

## Scope

This spec covers:

- Orchestrator identity model and session lifecycle
- Session ID rotation and auto-restart (three layers)
- Orchestrator system prompt construction
- Child session spawning and cascade management
- Inter-session messaging (mailbox/notification queue)
- Channel binding system and prompt routing
- Memory system (FTS5, relevance scoring, auto-pruning)
- Task board (hierarchical tasks with dependencies)
- Identity links (external platform accounts)
- OpenCode tools available to the orchestrator

### Boundary Rules

- This spec does NOT cover individual session behavior, prompt queue, or sandbox lifecycle (see [sessions.md](sessions.md))
- This spec does NOT cover sandbox boot sequence, Runner internals, or auth gateway (see [sandbox-runtime.md](sandbox-runtime.md))
- This spec does NOT cover WebSocket transport or event broadcasting (see [real-time.md](real-time.md))
- This spec does NOT cover workflow execution logic (see [workflows.md](workflows.md))

## Data Model

### `orchestrator_identities` table

One identity per user per org.

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| `id` | text PK | — | UUID |
| `userId` | text | — | FK-like (no constraint) |
| `orgId` | text NOT NULL | `'default'` | Org scope |
| `type` | text NOT NULL | `'personal'` | `'personal'` or `'org'` (only `personal` is ever written) |
| `name` | text NOT NULL | `'Agent'` | Display name |
| `handle` | text NOT NULL | — | Unique within org |
| `avatar` | text | — | Avatar URL |
| `customInstructions` | text | — | Free-form text injected into system prompt |
| `createdAt` / `updatedAt` | text | `datetime('now')` | ISO datetime |

**Indexes:** unique on `(orgId, handle)`, unique on `(orgId, userId)`.

### `orchestrator_memories` table

User-global memories with FTS5 search and relevance scoring.

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| `id` | text PK | — | UUID |
| `userId` | text NOT NULL | — | Owner |
| `orgId` | text NOT NULL | `'default'` | Org scope |
| `category` | text NOT NULL | — | See categories below |
| `content` | text NOT NULL | — | Memory content |
| `relevance` | real NOT NULL | `1.0` | Relevance score (0.0–2.0) |
| `createdAt` | text | `datetime('now')` | ISO datetime |
| `lastAccessedAt` | text | `datetime('now')` | Updated on search hit |

**Indexes:** on `userId`, on `(userId, category)`.

**FTS5 companion table:** `orchestrator_memories_fts` (virtual table, not representable in Drizzle). Used for full-text search with BM25 ranking. Inserts/deletes are done alongside regular table operations via raw SQL.

**Memory categories:** `preference`, `workflow`, `context`, `project`, `decision`, `general`.

**Memory cap:** 200 per user. When creating a memory exceeds the cap, the lowest-relevance, least-recently-accessed memories are pruned automatically.

**Relevance boosting:** `boostMemoryRelevance()` adds 0.1 per access, capped at 2.0. The function exists but is not currently wired to any route or tool — relevance boosting on access is described in the system prompt but not implemented.

### `agent_memories` table (separate, older system)

```
agent_memories: id, userId, sessionId, workspace, content, category
```

A separate, older table scoped to individual sessions and workspaces. Has a FK to users and includes `sessionId`/`workspace` columns. **Not connected to the orchestrator memory system.** The orchestrator exclusively uses `orchestrator_memories`.

### `mailbox_messages` table

Cross-session and cross-user messaging.

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| `id` | text PK | — | UUID |
| `fromSessionId` | text | — | Sender session |
| `fromUserId` | text | — | Sender user |
| `toSessionId` | text | — | Target session |
| `toUserId` | text | — | Target user |
| `messageType` | text NOT NULL | `'message'` | `'message'` / `'notification'` / `'question'` / `'escalation'` / `'approval'` |
| `content` | text NOT NULL | — | Message content |
| `contextSessionId` | text | — | Related session context |
| `contextTaskId` | text | — | Related task context |
| `replyToId` | text | — | Thread parent |
| `read` | boolean NOT NULL | `false` | Read status |

**Indexes:** on `(toSessionId, read, createdAt)`, `(toUserId, read, createdAt)`, `(fromSessionId, createdAt)`, `(replyToId)`.

Two views of the same table:
1. **Session inbox** (by `toSessionId`): used by the runner inside the sandbox.
2. **User inbox** (by `toUserId`): used by the web UI with thread grouping.

### `channel_bindings` table

Maps external channel interactions to sessions.

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| `id` | text PK | — | UUID |
| `sessionId` | text NOT NULL | — | FK to sessions, CASCADE DELETE |
| `channelType` | text NOT NULL | — | `'web'` / `'slack'` / `'github'` / `'api'` / `'telegram'` |
| `channelId` | text NOT NULL | — | Channel-specific identifier |
| `scopeKey` | text NOT NULL | — | Routing key for prompt dispatch |
| `userId` | text | — | Owner |
| `orgId` | text NOT NULL | — | Org scope |
| `queueMode` | text NOT NULL | `'followup'` | Prompt queue mode |
| `collectDebounceMs` | integer NOT NULL | `3000` | Collect mode debounce |
| `slackChannelId` / `slackThreadTs` / `slackInitialMessageTs` | text | — | Slack-specific |
| `githubRepoFullName` / `githubPrNumber` / `githubCommentId` | text/integer | — | GitHub-specific |

**Indexes:** unique on `(channelType, channelId)`, on `scopeKey`.

## Personal Orchestrator Channel Access

Personal orchestrators are intentionally limited to private user-controlled surfaces:

- Web UI session chat
- Slack DMs (`channel_type === 'im'`)

Shared Slack surfaces are explicitly out of scope for personal orchestrators:

- Public channels
- Private channels
- Multi-person group chats
- Threads attached to any of the above

Inbound Slack events from shared surfaces must return `200 OK` without identity resolution, thread-context pull, memory-backed prompt dispatch, or explanatory reply. This is a temporary risk-reduction measure to prevent personal-scope data, including indirectly surfaced memory/context, from leaking into shared channels before org orchestrators and their permission model exist.

### `user_identity_links` table

Links user accounts to external platform identities.

| Column | Type | Notes |
|--------|------|-------|
| `userId` | text NOT NULL | FK to users, CASCADE DELETE |
| `provider` | text NOT NULL | Platform name (e.g., `'telegram'`) |
| `externalId` | text NOT NULL | Platform-specific user ID |
| `externalName` | text | Display name |
| `teamId` | text | Platform team/org context |

Used by `resolveUserByExternalId` to map incoming channel messages to internal users.

### `session_tasks` table

Hierarchical task board scoped to an orchestrator session.

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| `id` | text PK | — | UUID |
| `orchestratorSessionId` | text NOT NULL | — | Scoping key |
| `sessionId` | text | — | Child session assigned to this task (nullable) |
| `title` | text NOT NULL | — | Task title |
| `description` | text | — | Task details |
| `status` | text NOT NULL | `'pending'` | `'pending'` / `'in_progress'` / `'completed'` / `'failed'` / `'blocked'` |
| `result` | text | — | Completion result |
| `parentTaskId` | text | — | Hierarchical parent |

### `session_task_dependencies` table

| Column | Type | Notes |
|--------|------|-------|
| `taskId` | text NOT NULL | Task that is blocked |
| `blockedByTaskId` | text NOT NULL | Task that blocks it |

**Primary key:** `(taskId, blockedByTaskId)`.

## Orchestrator Session Lifecycle

### Session ID Format

```
orchestrator:{userId}:{uuid}
```

Each restart generates a fresh UUID suffix. This means each restart gets a **new Durable Object** (no stale state from previous incarnation).

**Workspace volume naming:** Modal volumes use `workspace-orchestrator-{userId}` (strips the UUID suffix). This means the filesystem persists across restarts — the orchestrator keeps its cloned repos, installed deps, and generated files.

### Creation (`onboardOrchestrator`)

1. Check if identity exists. If yes AND a healthy session exists, return `already_exists`.
2. Ensure user record exists in D1.
3. If no identity: validate handle uniqueness, create `orchestratorIdentity`.
4. If identity exists but session is terminal: update identity with new params.
5. Call `restartOrchestratorSession`.
6. Return session ID, identity, and session record.

### Restart (`restartOrchestratorSession`)

1. Build persona files via `buildOrchestratorPersonaFiles`.
2. Generate new session ID: `orchestrator:{userId}:{uuid}`.
3. Create session record in D1 with `isOrchestrator: true`, `purpose: 'orchestrator'`, workspace `'orchestrator'`.
4. Assemble environment: provider API keys, user credential keys, `IS_ORCHESTRATOR: 'true'`.
5. Build DO WebSocket URL.
6. Fetch user preferences: idle timeout, queue mode, model preferences.
7. Initialize SessionAgent DO via `POST http://do/start`.

The DO's `/start` handler explicitly clears old session data (messages, queue, audit log) for orchestrator DOs that get reused.

### Querying the Active Orchestrator

```sql
SELECT * FROM sessions
WHERE user_id = ? AND is_orchestrator = 1
  AND status NOT IN ('terminated', 'archived', 'error')
ORDER BY created_at DESC LIMIT 1
```

Returns the most recent non-terminal orchestrator session. Supports ID rotation by always picking the newest.

### Canonical Web Chat Route

The authenticated user's own web UI canonicalizes orchestrator chat at `/sessions/orchestrator`.

- This route is a stable alias for "the current orchestrator" for the authenticated user only.
- The browser URL must remain `/sessions/orchestrator` and must not be rewritten to the rotated session ID.
- Worker session/thread routes resolve the alias to the latest non-terminal orchestrator session before access checks, DO routing, and thread/history lookups.
- Rotated IDs such as `orchestrator:{userId}:{uuid}` remain internal implementation details used for D1 rows, Durable Objects, and historical references.
- Admin and cross-user views may continue to use concrete rotated session IDs where a specific persisted orchestrator session is being inspected.

### Concurrency Bypass

Sessions spawned by the orchestrator (with `parentSessionId` starting with `orchestrator:`) **skip the user's active session concurrency limit**. The orchestrator needs to freely spawn children.

## Auto-Restart (Three Layers)

### Layer 1: Server-Side Cron

Runs on every Cloudflare Workers cron tick. `autoRestartDeadOrchestrators()` finds orchestrator sessions that have been in `terminated` or `error` status for >2 minutes (to avoid racing with manual refresh). Only restarts if no healthy session exists for the same user.

### Layer 2: Client-Side Hook (`useAutoRestartOrchestrator`)

When `useOrchestratorInfo()` returns `needsRestart: true`, the hook automatically calls `POST /api/me/orchestrator` once. Uses a ref to prevent retry loops. Resets when `needsRestart` clears.

### Layer 3: Manual Refresh

User can explicitly restart via the UI, which calls `POST /api/me/orchestrator` with the existing identity's name and handle.

### `needsRestart` Flag

`getOrchestratorInfo()` returns `needsRestart: true` when the identity exists but the session is missing or in a terminal status. This flag drives both client-side auto-restart and the cron check.

## System Prompt

Built by `buildOrchestratorPersonaFiles()` as an array of persona files:

**File `00-ORCHESTRATOR-SYSTEM.md`** (hardcoded): Comprehensive system prompt defining:
- Role as a task router and coordinator
- Decision flow for when to spawn vs. answer directly
- Spawning child sessions with required parameters (`repo_url` is critical)
- Monitoring strategies: event-driven (`wait_for_event`, preferred) vs. polling with `sleep`
- Forwarding policy: prefer verbatim `forward_messages` over summarizing
- Completion checklist before reporting success
- Memory read/write guidelines with categories
- Channel reply behavior: acknowledge before working, check in during long tasks
- Error handling patterns
- Housekeeping: terminating finished children

**File `01-IDENTITY.md`** (dynamic): Injects `identity.name`, `identity.handle`, and `identity.customInstructions`.

These files are serialized to `PERSONA_FILES_JSON` and injected into the sandbox via `start.sh` at boot.

## Child Session Management

### Spawning

When the orchestrator's OpenCode agent calls `spawn_session`, the tool sends `POST http://localhost:9000/api/spawn-child` to the gateway, which routes through the Runner's WebSocket to the SessionAgent DO.

The DO's `handleSpawnChild()`:
1. Reads parent's `spawnRequest`, backend URLs from DO state.
2. Queries parent's git state for default repo/branch values.
3. Merges explicit params with parent defaults (explicit wins).
4. Generates child session ID and runner token.
5. Creates child session in D1 with `parentSessionId` set to orchestrator's session ID.
6. Creates git state record for child.
7. Builds child spawn request inheriting parent env vars + `PARENT_SESSION_ID`.
8. **Injects GitHub token** from OAuth tokens if missing.
9. **Injects git user identity** from user profile if missing.
10. Initializes child SessionAgent DO via `POST http://do/start`.
11. Returns `spawn-child-result` with `childSessionId`.

### Recursive Spawning Prevention

The `spawn_session` tool checks `process.env.PARENT_SESSION_ID`:
```typescript
if (process.env.PARENT_SESSION_ID) {
  return "Error: spawning child sessions is disabled for child agents."
}
```

Children cannot spawn their own children. Only the orchestrator (which has no `PARENT_SESSION_ID`) can spawn.

### Communication

| Direction | Mechanism | Tool/Route |
|-----------|-----------|------------|
| Orchestrator → Child | Prompt dispatch via DO | `send_message` tool → `POST http://do/prompt` on child DO |
| Orchestrator → Child (interrupt) | Abort + re-prompt | `send_message` with `interrupt: true` |
| Child → Orchestrator | Prompt dispatch via DO | `notify_parent` tool → `POST /api/session-message` → parent DO |
| Orchestrator reads child | Message fetch from D1 | `read_messages` tool → `GET /api/session-messages` |
| Orchestrator reads child (verbatim) | Forward messages | `forward_messages` tool → copies messages into orchestrator chat |

### Termination

`terminate_session` tool → `POST /api/terminate-child` → sends `POST http://do/stop` to child DO → updates status to `terminated` in D1.

When the orchestrator itself is terminated, it cascades: all child sessions receive `POST http://do/stop`.

### Wait-for-Event (Monitoring)

The `wait_for_event` tool implements a **polling loop** inside the sandbox:
- Every 2 seconds, fetches `/api/child-sessions` from the gateway.
- Builds a snapshot of child session statuses.
- On status transitions (terminal state, any change, or new child), returns a message and yields the turn.
- Blocks indefinitely until an event occurs.

This is how the orchestrator "sleeps" between child completions. Despite the name, it is polling-based, not truly event-driven.

### Child Session Enrichment

`getEnrichedChildSessions()` in the sessions service:
1. Queries D1 for child sessions by `parentSessionId`.
2. Enriches with runtime status from each child's DO (tunnel URLs, gateway URL).
3. Refreshes open PR states from GitHub API (60-second cache).

## Channel System

### Scope Key Routing

The channel system routes incoming messages to the correct session using **scope keys**.

`POST /api/prompt` is the channel-agnostic prompt endpoint:
1. Compute scope key from `channelType + channelId` (or use explicit `scopeKey`).
2. Look up `channel_bindings` by scope key.
3. **If binding found:** route to the bound session's DO.
4. **If no binding:** fall back to `dispatchOrchestratorPrompt` — route to the user's orchestrator.

This is the key mechanism: **unbound prompts default to the orchestrator**.

### Auto-Binding

Every non-orchestrator session gets a web channel binding auto-created at session creation:
```typescript
channelType: 'web',
channelId: sessionId,
scopeKey: webManualScopeKey(userId, sessionId),
```

Orchestrator sessions do NOT get auto-created web bindings through this path.

### Channel Reply

The `channel_reply` tool allows the orchestrator (or any session) to reply on external channels. Supports text and images. Routes through the gateway to the DO, which dispatches to the appropriate channel handler (Telegram, Slack, etc.).

## Memory System

### Read (`memory_read` tool)

Gateway call → DO message → D1 query. Uses FTS5 full-text search with BM25 ranking when a search query is provided. Falls back to category-filtered listing. Returns up to 50 memories.

### Write (`memory_write` tool)

Gateway call → DO message → D1 insert. Checks the 200-memory cap. If exceeded, prunes lowest-relevance memories. Also inserts into the FTS5 index.

### Delete (`memory_delete` tool)

Gateway call → DO message → D1 delete. Also removes from FTS5 index.

### Prune (`memory_prune` tool)

Bulk cleanup tool. Details of the prune logic beyond the cap-based auto-prune are handled by the gateway callback.

### FTS5 Search

The FTS5 virtual table enables full-text search with BM25 ranking. Queries use the `MATCH` operator:

```sql
SELECT om.* FROM orchestrator_memories om
JOIN orchestrator_memories_fts fts ON om.id = fts.rowid
WHERE om.user_id = ? AND fts.content MATCH ?
ORDER BY bm25(orchestrator_memories_fts) LIMIT ?
```

### Sync Risk

FTS inserts/deletes are separate SQL statements from the main table operations. If either fails, the FTS index and table can get out of sync.

## Task Board

### Scoping

Tasks are scoped to an `orchestratorSessionId`. When a child session creates a task, the code resolves the parent:

```typescript
let orchestratorSessionId = sessionId;
const session = await getSession(db, sessionId);
if (session?.parentSessionId) {
  orchestratorSessionId = session.parentSessionId;
}
```

Both orchestrators and children can create/list tasks on the same board.

### Operations

| Tool | Description |
|------|-------------|
| `task_create` | Create task with title, description, optional parentTaskId and dependencies |
| `task_list` | List all tasks on the orchestrator's board |
| `task_update` | Update task status, result, or assigned sessionId |
| `my_tasks` | List tasks assigned to the current session |

## API Contract

### Orchestrator Routes (`/api/me`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/orchestrator` | Get orchestrator info (session, identity, needsRestart) |
| POST | `/orchestrator` | Create/restart orchestrator (name, handle, avatar, customInstructions) |
| GET | `/orchestrator/identity` | Get identity |
| PUT | `/orchestrator/identity` | Update identity |
| GET | `/orchestrator/check-handle` | Check handle availability |

### Memory Routes (`/api/me`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/memories` | List/search memories (optional category, query, limit) |
| POST | `/memories` | Create memory (content + category) |
| DELETE | `/memories/:id` | Delete memory |

### Notification Routes (`/api/me`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/notifications` | User inbox (paginated, filterable) |
| GET | `/notifications/count` | Unread count |
| GET | `/notifications/threads/:threadId` | Thread view (auto-marks read) |
| PUT | `/notifications/:messageId/read` | Mark single as read |
| PUT | `/notifications/read-non-actionable` | Bulk mark message/notification types |
| PUT | `/notifications/read-all` | Mark all read |
| POST | `/notifications/:messageId/reply` | Reply in thread |

### Notification Preference Routes (`/api/me`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/notification-preferences` | List all preferences |
| PUT | `/notification-preferences` | Upsert per messageType + eventType |

### Org Directory Routes (`/api/me`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/org-agents` | List all orchestrator identities in org |
| GET | `/identity-links` | List user's linked external identities |
| POST | `/identity-links` | Link external identity |
| DELETE | `/identity-links/:id` | Unlink |

### Mailbox Routes

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/sessions/:sessionId/notifications` | Session-scoped mailbox |
| POST | `/api/notifications/emit` | Emit notification (supports `toHandle` resolution) |
| PUT | `/api/sessions/:sessionId/notifications/read` | Mark all read for session |

### Channel Routes

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/prompt` | Channel-agnostic prompt dispatch (scope key routing) |

### Task Routes

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/sessions/:sessionId/tasks` | List tasks for orchestrator board |
| POST | `/api/sessions/:sessionId/tasks` | Create task |
| PUT | `/api/sessions/:sessionId/tasks/:taskId` | Update task |
| GET | `/api/sessions/:sessionId/my-tasks` | Tasks assigned to this session |

## OpenCode Tools

Tools available to the orchestrator inside the sandbox, communicating via `http://localhost:9000/api/*`:

### Session Management
| Tool | Description |
|------|-------------|
| `spawn_session` | Spawn child session (blocked in children) |
| `terminate_session` | Kill a child session |
| `complete_session` | Self-terminate (**removed for orchestrators** during tool copy) |
| `get_session_status` | Get another session's status |
| `list_sessions` | List child sessions |
| `send_message` | Send prompt to another session (optional interrupt) |
| `read_messages` | Read messages from another session |
| `forward_messages` | Forward child messages verbatim into orchestrator chat |
| `notify_parent` | Send message to parent (**removed for orchestrators** during tool copy) |
| `wait_for_event` | Poll for child status changes |

### Memory
| Tool | Description |
|------|-------------|
| `memory_read` | Search/list memories (FTS) |
| `memory_write` | Store memory with category |
| `memory_delete` | Delete memory by ID |
| `memory_prune` | Bulk cleanup |

### Communication
| Tool | Description |
|------|-------------|
| `channel_reply` | Reply on external channel (Telegram, Slack) |
| `list_channels` | List channel bindings for current session |
| `mailbox_send` / `emit_notification` | Send notification to another session/user/handle |
| `mailbox_check` | Check session's notification queue |

### Task Management
| Tool | Description |
|------|-------------|
| `task_create` | Create task on orchestrator board |
| `task_list` | List tasks |
| `task_update` | Update task status/result |
| `my_tasks` | Tasks assigned to current session |

### Other
| Tool | Description |
|------|-------------|
| `list_personas` | List available agent personas |
| `sleep` | Sleep for N seconds (polling fallback) |
| All workflow/trigger/execution tools | Full workflow automation |
| All PR/git tools | GitHub operations |
| All tunnel/browser/secret tools | Sandbox utilities |

## Orchestrator-Specific Behaviors in SessionAgentDO

- **Skip lifecycle EventBus notifications:** `session.started` and `session.completed` events are not emitted for orchestrator sessions (guarded by `sessionId?.startsWith('orchestrator:')`).
- **Config flag:** `isOrchestrator: true` is sent to the Runner in `opencode-config`, which triggers tool filtering (removes `complete_session` and `notify_parent`).
- **Clear-on-start:** The DO explicitly clears old messages, queue, audit log when starting an orchestrator session to handle DO reuse.

## Edge Cases & Failure Modes

### Session ID Rotation vs. Volume Persistence

Each restart gets a fresh session ID and DO, but the Modal workspace volume (`workspace-orchestrator-{userId}`) persists. The orchestrator retains its filesystem (repos, deps, generated files) but loses its in-DO state (messages, prompt queue, connected users) on restart.

### Stale Session Detection

`getOrchestratorSession()` queries by `user_id` and `is_orchestrator`, not by a fixed session ID. This means the cron and client auto-restart correctly find the newest orchestrator session regardless of ID rotation.

### Wait-for-Event Polling Overhead

The `wait_for_event` tool polls every 2 seconds, which creates continuous HTTP traffic between the sandbox and the DO. For an orchestrator with many children, this can generate significant request volume. A true WebSocket push mechanism would be more efficient.

### FTS Index Sync

FTS inserts and deletes are separate SQL operations from the main `orchestrator_memories` table. A failure in one but not the other leaves the index out of sync with the data.

### Concurrent Auto-Restart

Both the cron and the client hook can try to restart the orchestrator simultaneously. The `onboardOrchestrator` function handles this by returning `already_exists` if a healthy session is found, so the second attempt is a no-op. The 2-minute delay on the cron gives the client hook priority.

## Implementation Status

### Fully Implemented
- Orchestrator identity CRUD (name, handle, avatar, custom instructions)
- Session lifecycle with ID rotation and workspace volume persistence
- Three-layer auto-restart (cron, client hook, manual)
- Comprehensive system prompt with decision flows and tool usage patterns
- Child session spawning with inherited env vars and credential injection
- Recursive spawn prevention (children cannot spawn)
- Inter-session messaging via DO prompt dispatch
- Mailbox/notification queue (session inbox + user inbox with threads)
- Channel binding system with scope key routing and orchestrator fallback
- Memory system with FTS5 search, BM25 ranking, relevance scoring, 200-memory cap with auto-prune
- Task board with hierarchical tasks and dependencies
- Identity links for external platform accounts
- Concurrency bypass for orchestrator-spawned children
- 30+ OpenCode tools for orchestrator operations

### Not Implemented / Gaps
- **`org` type orchestrator:** supported in types but only `personal` is ever created.
- **Relevance boosting on memory access:** function exists but no code path calls it.
- **`agent_memories` table cleanup:** older table exists alongside `orchestrator_memories`, unused by the orchestrator.
- **True event-driven monitoring:** `wait_for_event` uses 2-second polling, not WebSocket push.
- **Orchestrator web channel binding:** not auto-created through the standard session creation path.
