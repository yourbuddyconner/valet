# Orchestrator Threads — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add thread support to orchestrator sessions so users can start fresh conversations without sandbox restarts, with persistent thread history in D1.

**Architecture:** Each thread maps 1:1 to an OpenCode session. The Runner creates OpenCode sessions via the session API and mirrors title/summary updates to the DO, which persists them in D1. The frontend shows one active thread at a time, with a dedicated history page for browsing past threads.

**Tech Stack:** Drizzle ORM (D1), Hono routes, TanStack Router/Query, OpenCode session API, Runner↔DO WebSocket protocol

**Design doc:** `docs/plans/2026-03-08-orchestrator-threads-design.md`

---

### Task 1: D1 Migration — Create `session_threads` Table

**Files:**
- Create: `packages/worker/migrations/0062_session_threads.sql`

**Step 1: Write the migration SQL**

```sql
-- Thread tracking for orchestrator sessions
CREATE TABLE session_threads (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  opencode_session_id TEXT,
  title TEXT,
  summary_additions INTEGER DEFAULT 0,
  summary_deletions INTEGER DEFAULT 0,
  summary_files INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  message_count INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_active_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_session_threads_session ON session_threads(session_id);
CREATE INDEX idx_session_threads_session_status ON session_threads(session_id, status);
CREATE INDEX idx_session_threads_last_active ON session_threads(session_id, last_active_at);

-- Add thread_id column to messages table
ALTER TABLE messages ADD COLUMN thread_id TEXT REFERENCES session_threads(id);
CREATE INDEX idx_messages_thread ON messages(thread_id);
```

**Step 2: Run migration locally**

Run: `make db-migrate`
Expected: Migration 0062 applied successfully

**Step 3: Commit**

```bash
git add packages/worker/migrations/0062_session_threads.sql
git commit -m "feat(threads): add session_threads table and messages.thread_id column"
```

---

### Task 2: Drizzle Schema — Add `sessionThreads` Table Definition

**Files:**
- Create: `packages/worker/src/lib/schema/threads.ts`
- Modify: `packages/worker/src/lib/schema/index.ts`
- Modify: `packages/worker/src/lib/schema/sessions.ts:37-55` (add `threadId` to messages)

**Step 1: Create the Drizzle schema file**

Create `packages/worker/src/lib/schema/threads.ts`:

```typescript
import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { sessions } from './sessions.js';

export const sessionThreads = sqliteTable('session_threads', {
  id: text().primaryKey(),
  sessionId: text().notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  opencodeSessionId: text(),
  title: text(),
  summaryAdditions: integer().default(0),
  summaryDeletions: integer().default(0),
  summaryFiles: integer().default(0),
  status: text().notNull().default('active'),
  messageCount: integer().default(0),
  createdAt: text().notNull().default(sql`(datetime('now'))`),
  lastActiveAt: text().notNull().default(sql`(datetime('now'))`),
}, (table) => [
  index('idx_session_threads_session').on(table.sessionId),
  index('idx_session_threads_session_status').on(table.sessionId, table.status),
  index('idx_session_threads_last_active').on(table.sessionId, table.lastActiveAt),
]);
```

**Step 2: Add `threadId` to messages schema**

In `packages/worker/src/lib/schema/sessions.ts`, add to the `messages` table definition (after `messageFormat` field, before `createdAt`):

```typescript
threadId: text(),
```

Note: We don't add a Drizzle-level foreign key reference here because the `session_threads` table is in a separate schema file and the migration SQL already has the FK constraint. The column just needs to exist in the Drizzle schema for queries.

**Step 3: Export from schema barrel**

In `packages/worker/src/lib/schema/index.ts`, add:

```typescript
export * from './threads.js';
```

**Step 4: Typecheck**

Run: `cd packages/worker && pnpm typecheck`
Expected: No errors

**Step 5: Commit**

```bash
git add packages/worker/src/lib/schema/threads.ts packages/worker/src/lib/schema/index.ts packages/worker/src/lib/schema/sessions.ts
git commit -m "feat(threads): add Drizzle schema for session_threads and messages.threadId"
```

---

### Task 3: Shared Types — Add Thread Types

**Files:**
- Modify: `packages/shared/src/types/index.ts`

**Step 1: Add thread types**

Add after the `Message` interface (around line 199):

```typescript
// Thread types
export type ThreadStatus = 'active' | 'archived';

export interface SessionThread {
  id: string;
  sessionId: string;
  opencodeSessionId?: string;
  title?: string;
  summaryAdditions: number;
  summaryDeletions: number;
  summaryFiles: number;
  status: ThreadStatus;
  messageCount: number;
  firstMessagePreview?: string;
  createdAt: Date;
  lastActiveAt: Date;
}

export interface ListThreadsResponse {
  threads: SessionThread[];
  cursor?: string;
  hasMore: boolean;
}
```

**Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: No errors

**Step 3: Commit**

```bash
git add packages/shared/src/types/index.ts
git commit -m "feat(threads): add SessionThread shared types"
```

---

### Task 4: DB Query Helpers — Thread CRUD

**Files:**
- Create: `packages/worker/src/lib/db/threads.ts`
- Modify: `packages/worker/src/lib/db.ts`

**Step 1: Create thread query helpers**

Create `packages/worker/src/lib/db/threads.ts`. This file should implement:

- `createThread(db, { id, sessionId, opencodeSessionId? })` — INSERT into session_threads, return the new thread
- `getThread(db, threadId)` — SELECT single thread by ID
- `getActiveThread(db, sessionId)` — SELECT the most recent active thread for a session (ORDER BY lastActiveAt DESC LIMIT 1)
- `listThreads(db, sessionId, { cursor?, limit? })` — Paginated list of threads for a session, newest first, with first message preview (join messages table, take first user message content truncated to 120 chars)
- `updateThread(db, threadId, { title?, opencodeSessionId?, summaryAdditions?, summaryDeletions?, summaryFiles?, status?, messageCount? })` — UPDATE partial fields + set lastActiveAt
- `incrementThreadMessageCount(db, threadId)` — UPDATE message_count = message_count + 1, set lastActiveAt

Follow the pattern from `packages/worker/src/lib/db/messages.ts` — use raw D1 SQL via `db.run()` / `db.first()` / `db.all()` for queries, return plain objects.

Row-to-type conversion should map snake_case DB columns to camelCase TypeScript fields (matching the `SessionThread` type from shared).

**Step 2: Export from db barrel**

In `packages/worker/src/lib/db.ts`, add:

```typescript
export * from './db/threads.js';
```

**Step 3: Typecheck**

Run: `cd packages/worker && pnpm typecheck`
Expected: No errors

**Step 4: Commit**

```bash
git add packages/worker/src/lib/db/threads.ts packages/worker/src/lib/db.ts
git commit -m "feat(threads): add D1 query helpers for session threads"
```

---

### Task 5: API Routes — Thread Endpoints

**Files:**
- Create: `packages/worker/src/routes/threads.ts`
- Modify: `packages/worker/src/index.ts` (mount the router)

**Step 1: Create thread routes**

Create `packages/worker/src/routes/threads.ts` with a Hono router exporting `threadsRouter`. Follow the pattern from `packages/worker/src/routes/sessions.ts`.

Endpoints:

1. **`GET /api/sessions/:sessionId/threads`** — List threads for a session
   - Auth: require logged-in user, verify session access
   - Query params: `cursor` (optional), `limit` (optional, default 20)
   - Response: `ListThreadsResponse`

2. **`POST /api/sessions/:sessionId/threads`** — Create a new thread
   - Auth: require logged-in user, verify session ownership
   - Body: `{}` (empty — thread creation is simple)
   - Logic: generate UUID, create thread record, return the new `SessionThread`
   - This does NOT create the OpenCode session — that happens when the Runner receives the first prompt for this thread

3. **`GET /api/sessions/:sessionId/threads/:threadId`** — Get thread detail with messages
   - Auth: require logged-in user, verify session access
   - Response: `{ thread: SessionThread, messages: Message[] }`
   - Messages filtered by `thread_id = threadId`

4. **`POST /api/sessions/:sessionId/threads/:threadId/continue`** — Start a new thread from an old one
   - Auth: require logged-in user, verify session ownership
   - Logic: fetch old thread's messages from D1, create new thread, return new `SessionThread` with a `sourceThreadId` field so the frontend/DO knows to generate a continuation summary
   - Response: `{ thread: SessionThread, sourceMessages: Message[] }`

**Step 2: Mount in worker index**

In `packages/worker/src/index.ts`, add:

```typescript
import { threadsRouter } from './routes/threads.js';
// Mount under sessions path since threads are scoped to sessions
app.route('/api/sessions', threadsRouter);
```

**Step 3: Typecheck**

Run: `cd packages/worker && pnpm typecheck`
Expected: No errors

**Step 4: Commit**

```bash
git add packages/worker/src/routes/threads.ts packages/worker/src/index.ts
git commit -m "feat(threads): add thread CRUD API endpoints"
```

---

### Task 6: SessionAgentDO — Thread-Aware Message Handling

**Files:**
- Modify: `packages/worker/src/durable-objects/session-agent.ts`

This is the most complex task. The DO needs to:

**Step 1: Add thread message types to the Runner↔DO WebSocket protocol**

In the Runner message type handling (around line 225), add support for:
- `'thread.created'` — Runner informs DO that a new OpenCode session was created for a thread. Payload: `{ threadId: string, opencodeSessionId: string }`. DO updates the thread's `opencodeSessionId` in D1.
- `'thread.updated'` — Runner forwards OpenCode `session.updated` events. Payload: `{ threadId: string, title?: string, summaryAdditions?: number, summaryDeletions?: number, summaryFiles?: number }`. DO updates the thread record in D1.

**Step 2: Tag messages with threadId**

When the DO receives `message.create` / `message.part.*` / `message.finalize` from the Runner, it should check for a `threadId` field and include it when persisting to D1 via `saveMessage()` / `batchUpsertMessages()`.

**Step 3: Add threadId to prompt routing**

When the DO receives a `prompt` message from a client WebSocket (line ~138 `ClientMessage`), add an optional `threadId` field. The DO forwards this `threadId` to the Runner so the Runner knows which OpenCode session to route the prompt to.

**Step 4: Broadcast thread events to clients**

When the DO processes `thread.created` or `thread.updated` from the Runner, broadcast these events to connected client WebSockets so the UI updates live.

**Step 5: Typecheck**

Run: `cd packages/worker && pnpm typecheck`
Expected: No errors

**Step 6: Commit**

```bash
git add packages/worker/src/durable-objects/session-agent.ts
git commit -m "feat(threads): add thread-aware message handling to SessionAgentDO"
```

---

### Task 7: Runner — Thread-Aware OpenCode Session Management

**Files:**
- Modify: `packages/runner/src/prompt.ts:383-522` (ChannelSession class)
- Modify: `packages/runner/src/prompt.ts:525+` (PromptHandler class)
- Modify: `packages/runner/src/agent-client.ts` (add thread message handlers)

**Step 1: Add threadId to ChannelSession**

The `ChannelSession` class (line 383) already maps channels to OpenCode sessions. For orchestrator threads, the `channelKey` will encode the thread: `thread:{threadId}`. This means the existing per-channel session routing naturally handles threads — each thread gets its own `ChannelSession` with its own `opencodeSessionId`.

No structural change to `ChannelSession` is needed. The thread ID is carried in the channel key.

**Step 2: Handle `session.updated` events from OpenCode SSE**

Currently, `session.updated` is in the ignored events list (line 3098). Change this to extract title and summary data and forward to the DO:

```typescript
case "session.updated": {
  const sessionInfo = sseData?.properties;
  if (!sessionInfo) break;
  // Find which channel/thread this OpenCode session belongs to
  const updatedChannel = this.ocSessionToChannel.get(sessionInfo.id);
  if (!updatedChannel) break;
  // Extract thread ID from channel key if it's a thread channel
  const threadId = updatedChannel.channelKey.startsWith('thread:')
    ? updatedChannel.channelKey.slice(7)
    : null;
  if (!threadId) break;
  // Forward title/summary to DO
  this.agentClient.send({
    type: 'thread.updated',
    threadId,
    title: sessionInfo.title,
    summaryAdditions: sessionInfo.summary?.additions,
    summaryDeletions: sessionInfo.summary?.deletions,
    summaryFiles: sessionInfo.summary?.files,
  });
  break;
}
```

**Step 3: Handle thread creation acknowledgment**

When the Runner creates an OpenCode session for a thread channel (via `ensureChannelOpenCodeSession`), send a `thread.created` message to the DO:

After the `createSession()` call returns an `opencodeSessionId`, if the channel key starts with `thread:`, send:

```typescript
this.agentClient.send({
  type: 'thread.created',
  threadId,
  opencodeSessionId,
});
```

**Step 4: Handle incoming prompts with threadId**

In `handlePrompt()` (line 1249), when a prompt arrives with a `threadId`, derive the channel key as `thread:{threadId}` so the prompt routes to the correct OpenCode session (or creates a new one).

The DO already sends `channelType` and `channelId` with prompts — for threads, it should send `channelType: 'thread'` and `channelId: threadId`. The existing `ChannelSession.channelKeyFrom()` (line 519) will produce `thread:{threadId}`.

**Step 5: Handle continuation context**

When the DO sends a prompt with a `continuationContext` field (summary text from an old thread), the Runner should inject this as the first message in the new OpenCode session before sending the user's prompt. Use `sendPromptAsync()` with a system-level preamble, then send the actual user prompt.

**Step 6: Typecheck**

Run: `cd packages/runner && pnpm typecheck`
Expected: No errors

**Step 7: Commit**

```bash
git add packages/runner/src/prompt.ts packages/runner/src/agent-client.ts
git commit -m "feat(threads): add thread-aware OpenCode session management to Runner"
```

---

### Task 8: Frontend — Thread API Hooks

**Files:**
- Create: `packages/client/src/api/threads.ts`

**Step 1: Create thread query key factory and hooks**

Create `packages/client/src/api/threads.ts` following the pattern from `packages/client/src/api/sessions.ts`:

```typescript
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import type { SessionThread, ListThreadsResponse, Message } from '@valet/shared';

export const threadKeys = {
  all: ['threads'] as const,
  lists: () => [...threadKeys.all, 'list'] as const,
  list: (sessionId: string) => [...threadKeys.lists(), sessionId] as const,
  details: () => [...threadKeys.all, 'detail'] as const,
  detail: (sessionId: string, threadId: string) => [...threadKeys.details(), sessionId, threadId] as const,
};

export function useThreads(sessionId: string) {
  return useQuery({
    queryKey: threadKeys.list(sessionId),
    queryFn: () => api.get<ListThreadsResponse>(`/sessions/${sessionId}/threads`),
  });
}

export function useThread(sessionId: string, threadId: string) {
  return useQuery({
    queryKey: threadKeys.detail(sessionId, threadId),
    queryFn: () => api.get<{ thread: SessionThread; messages: Message[] }>(
      `/sessions/${sessionId}/threads/${threadId}`
    ),
    enabled: !!threadId,
  });
}

export function useCreateThread(sessionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<SessionThread>(`/sessions/${sessionId}/threads`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: threadKeys.list(sessionId) });
    },
  });
}

export function useContinueThread(sessionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (threadId: string) =>
      api.post<{ thread: SessionThread }>(`/sessions/${sessionId}/threads/${threadId}/continue`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: threadKeys.list(sessionId) });
    },
  });
}
```

**Step 2: Typecheck**

Run: `cd packages/client && pnpm typecheck`
Expected: No errors

**Step 3: Commit**

```bash
git add packages/client/src/api/threads.ts
git commit -m "feat(threads): add React Query hooks for thread API"
```

---

### Task 9: Frontend — "New Thread" Button in Chat Header

**Files:**
- Modify: `packages/client/src/components/chat/chat-container.tsx`
- Modify: `packages/client/src/hooks/use-chat.ts` (if needed for threadId state)

**Step 1: Add thread state to chat container**

In `ChatContainer` (`packages/client/src/components/chat/chat-container.tsx`), add:
- State for `activeThreadId` (initially null for non-orchestrator sessions)
- For orchestrator sessions: on mount, fetch or create an active thread
- A "New Thread" button in the header toolbar (only shown when `session.isOrchestrator`)
- When "New Thread" is clicked: call `useCreateThread`, set the new thread as active, clear the message display

**Step 2: Pass threadId through to sendMessage**

The `sendMessage` function from `useChat` needs to include the `threadId` in the WebSocket prompt message. Modify the `useChat` hook or the `sendMessage` call in `ChatContainer` to include `threadId` in the payload.

**Step 3: Filter messages by thread**

When `activeThreadId` is set, filter the displayed messages to only show messages with matching `threadId`.

**Step 4: Add thread title breadcrumb**

Show the active thread's title (or "New thread") as a small label in the chat header. This is a simple text element, not a complex component.

**Step 5: Typecheck**

Run: `cd packages/client && pnpm typecheck`
Expected: No errors

**Step 6: Commit**

```bash
git add packages/client/src/components/chat/chat-container.tsx packages/client/src/hooks/use-chat.ts
git commit -m "feat(threads): add New Thread button and thread-aware chat display"
```

---

### Task 10: Frontend — Thread History Page

**Files:**
- Create: `packages/client/src/routes/sessions/$sessionId/threads.tsx`
- Create: `packages/client/src/routes/sessions/$sessionId/threads/$threadId.tsx`

**Step 1: Create thread history list route**

Create `packages/client/src/routes/sessions/$sessionId/threads.tsx`:
- Page title: "Thread History"
- Uses `useThreads(sessionId)` to fetch the list
- Renders each thread as a card/row showing:
  - Title (or "Untitled thread" fallback)
  - Relative timestamp (e.g., "2 hours ago")
  - First message preview (truncated)
  - Diff stats badge: `+{additions} -{deletions} across {files} files` (if any)
  - Message count
- Each card links to the thread detail route
- Uses `PageContainer` + `PageHeader` layout pattern

**Step 2: Create thread detail (read-only view) route**

Create `packages/client/src/routes/sessions/$sessionId/threads/$threadId.tsx`:
- Uses `useThread(sessionId, threadId)` to fetch thread + messages
- Renders messages using the existing `MessageList` component (from `packages/client/src/components/chat/message-list.tsx`) but without the `ChatInput`
- "Continue" button at the bottom — calls `useContinueThread`, then navigates back to the main session view with the new thread active
- Read-only: no input box, no question prompts

**Step 3: Add navigation link**

In `packages/client/src/components/session/orchestrator-metadata-sidebar.tsx`, add a link to the thread history page for orchestrator sessions.

**Step 4: Typecheck**

Run: `cd packages/client && pnpm typecheck`
Expected: No errors

**Step 5: Commit**

```bash
git add packages/client/src/routes/sessions/\$sessionId/threads.tsx packages/client/src/routes/sessions/\$sessionId/threads/\$threadId.tsx packages/client/src/components/session/orchestrator-metadata-sidebar.tsx
git commit -m "feat(threads): add thread history page and read-only thread detail view"
```

---

### Task 11: EventBusDO — Thread Event Types

**Files:**
- Modify: `packages/worker/src/durable-objects/event-bus.ts`
- Modify: `packages/shared/src/types/index.ts`

**Step 1: Add thread event types**

In `packages/shared/src/types/index.ts`, add to `EventBusEventType`:

```typescript
| 'thread.created'
| 'thread.updated'
```

**Step 2: Handle thread events in EventBusDO**

In `packages/worker/src/durable-objects/event-bus.ts`, ensure the broadcast logic handles `thread.created` and `thread.updated` event types. These should be broadcast to all WebSocket connections for the session's user, so the thread list and active thread indicator update in real-time.

**Step 3: Frontend WebSocket handler**

In `packages/client/src/hooks/use-chat.ts`, add handlers for `thread.created` and `thread.updated` WebSocket messages. On receiving these, invalidate the thread list query cache so the UI refreshes.

**Step 4: Typecheck**

Run: `pnpm typecheck`
Expected: No errors

**Step 5: Commit**

```bash
git add packages/worker/src/durable-objects/event-bus.ts packages/shared/src/types/index.ts packages/client/src/hooks/use-chat.ts
git commit -m "feat(threads): add real-time thread event broadcasting"
```

---

### Task 12: Continuation Summary Generation

**Files:**
- Modify: `packages/runner/src/prompt.ts`

**Step 1: Implement continuation summary**

When the Runner receives a prompt with `continuationContext` (an array of messages from the old thread, sent by the DO when processing a "continue" action):

1. Format the messages into a compaction-style summary prompt
2. Create a new OpenCode session for the thread
3. Send the summary as the first message (system context) to prime the conversation
4. Then send the user's actual prompt

The summary prompt template:

```
You are continuing a conversation from a previous thread. Here is the context:

## Previous Thread Summary
[Title of old thread]

## Key Points
[Messages formatted as a conversation transcript, truncated to last ~20 messages or ~4000 chars]

Continue from this context. The user may reference topics from the previous thread.
```

This does NOT require calling an external LLM for summarization — it's a simple context injection. The orchestrator's own LLM will naturally understand the continuation context.

**Step 2: Typecheck**

Run: `cd packages/runner && pnpm typecheck`
Expected: No errors

**Step 3: Commit**

```bash
git add packages/runner/src/prompt.ts
git commit -m "feat(threads): add continuation context injection for resumed threads"
```

---

### Task 13: Integration Testing & Smoke Test

**Step 1: Manual smoke test flow**

1. Start local dev: `make dev-all`
2. Navigate to an orchestrator session
3. Verify "New Thread" button appears in chat header
4. Send a message — verify it creates a thread automatically
5. Click "New Thread" — verify chat clears, new thread starts
6. Send messages in new thread — verify they appear correctly
7. Navigate to thread history — verify both threads appear with titles
8. Click on old thread — verify read-only view with messages
9. Click "Continue" — verify new thread created with context
10. Refresh sandbox — verify thread history persists in D1

**Step 2: Verify edge cases**

- Non-orchestrator sessions should NOT show thread UI
- Thread title should appear after first assistant response
- Diff stats should update as the orchestrator makes changes

**Step 3: Commit any fixes**

```bash
git add -A
git commit -m "fix(threads): address integration testing issues"
```
