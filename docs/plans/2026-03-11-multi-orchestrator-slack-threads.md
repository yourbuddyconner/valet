# Multi-Orchestrator Slack Thread Routing — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable multiple orchestrators to participate in the same public Slack thread with shared context and explicit invocation.

**Architecture:** Widen the `channel_thread_mappings` unique index to be per-user, add a cursor column for tracking seen messages, drop `slack_bot_threads`, create a new `slack-threads` service for fetching and formatting thread context from the Slack API, and simplify the `slack-events.ts` routing to require explicit @mention in public channels.

**Tech Stack:** Cloudflare Workers, D1 (SQLite), Slack API (`conversations.replies`, `users.info`), Hono

**Spec:** [`docs/specs/2026-03-11-multi-orchestrator-slack-threads-design.md`](../specs/2026-03-11-multi-orchestrator-slack-threads-design.md)

---

## Chunk 1: Schema Migration & DB Functions

### Task 1: D1 Migration — Widen Unique Index + Add Cursor Column

**Files:**
- Create: `packages/worker/migrations/0065_multi_orchestrator_threads.sql`

- [ ] **Step 1: Write the migration SQL**

```sql
-- Multi-orchestrator thread support:
-- 1. Widen unique index to include user_id (allows multiple users per external thread)
-- 2. Add last_seen_ts cursor column for tracking thread context

-- Drop the old unique index (one mapping per external thread)
DROP INDEX IF EXISTS idx_channel_thread_mappings_lookup;

-- Create new unique index scoped to user (one mapping per user per external thread)
CREATE UNIQUE INDEX idx_channel_thread_mappings_user_lookup
  ON channel_thread_mappings(channel_type, channel_id, external_thread_id, user_id);

-- Add cursor column for tracking last seen message timestamp
ALTER TABLE channel_thread_mappings ADD COLUMN last_seen_ts TEXT;

-- Drop slack_bot_threads (no longer used for routing)
DROP TABLE IF EXISTS slack_bot_threads;
```

- [ ] **Step 2: Update Drizzle schema for `channel_thread_mappings`**

Modify: `packages/worker/src/lib/schema/channel-threads.ts`

Change the unique index and add the `lastSeenTs` column:

```typescript
import { sqliteTable, text, uniqueIndex, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { sessions } from './sessions.js';
import { sessionThreads } from './threads.js';

export const channelThreadMappings = sqliteTable('channel_thread_mappings', {
  id: text().primaryKey(),
  sessionId: text().notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  threadId: text().notNull().references(() => sessionThreads.id, { onDelete: 'cascade' }),
  channelType: text().notNull(),
  channelId: text().notNull(),
  externalThreadId: text().notNull(),
  userId: text().notNull(),
  lastSeenTs: text(),
  createdAt: text().notNull().default(sql`(datetime('now'))`),
}, (table) => [
  uniqueIndex('idx_channel_thread_mappings_user_lookup').on(table.channelType, table.channelId, table.externalThreadId, table.userId),
  index('idx_channel_thread_mappings_thread').on(table.threadId),
  index('idx_channel_thread_mappings_session').on(table.sessionId),
]);
```

- [ ] **Step 3: Remove `slackBotThreads` from Drizzle schema**

Modify: `packages/worker/src/lib/schema/slack.ts`

Remove the `slackBotThreads` export entirely. Keep `orgSlackInstalls` and `slackLinkVerifications`. Remove the import of `slackBotThreads` (it's referenced in `slack.ts` DB helpers).

The file should become:

```typescript
import { sqliteTable, text, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { users } from './users.js';

export const orgSlackInstalls = sqliteTable('org_slack_installs', {
  id: text().primaryKey(),
  teamId: text().notNull().unique(),
  teamName: text(),
  botUserId: text().notNull(),
  appId: text(),
  encryptedBotToken: text().notNull(),
  encryptedSigningSecret: text(),
  installedBy: text().notNull().references(() => users.id),
  createdAt: text().notNull().default(sql`(datetime('now'))`),
  updatedAt: text().notNull().default(sql`(datetime('now'))`),
}, (table) => [
  index('idx_org_slack_installs_team').on(table.teamId),
]);

export const slackLinkVerifications = sqliteTable('slack_link_verifications', {
  id: text().primaryKey(),
  userId: text().notNull().references(() => users.id),
  slackUserId: text().notNull(),
  slackDisplayName: text(),
  code: text().notNull(),
  expiresAt: text().notNull(),
  createdAt: text().notNull().default(sql`(datetime('now'))`),
}, (table) => [
  index('idx_slack_link_verifications_user').on(table.userId),
]);
```

- [ ] **Step 4: Commit**

```bash
git add packages/worker/migrations/0065_multi_orchestrator_threads.sql packages/worker/src/lib/schema/channel-threads.ts packages/worker/src/lib/schema/slack.ts
git commit -m "feat(slack): migration to widen thread mapping index and drop slack_bot_threads"
```

---

### Task 2: Update DB Functions for Per-User Thread Mappings

**Files:**
- Modify: `packages/worker/src/lib/db/channel-threads.ts`

- [ ] **Step 1: Add `userId` parameter to `getChannelThreadMapping`**

The function currently queries without `user_id`. Add it as a required parameter and include it in the WHERE clause:

```typescript
export async function getChannelThreadMapping(
  db: D1Database,
  channelType: string,
  channelId: string,
  externalThreadId: string,
  userId: string,
): Promise<{ threadId: string; sessionId: string; lastSeenTs: string | null } | null> {
  const row = await db
    .prepare(
      'SELECT thread_id, session_id, last_seen_ts FROM channel_thread_mappings WHERE channel_type = ? AND channel_id = ? AND external_thread_id = ? AND user_id = ?'
    )
    .bind(channelType, channelId, externalThreadId, userId)
    .first();

  if (!row) return null;
  return {
    threadId: row.thread_id as string,
    sessionId: row.session_id as string,
    lastSeenTs: row.last_seen_ts as string | null,
  };
}
```

- [ ] **Step 2: Update `getOrCreateChannelThread` to use `userId` in lookups**

The existing function calls `getChannelThreadMapping` without `userId` and uses `INSERT OR IGNORE` against the old unique index. Update both the lookup and the race-safety logic:

```typescript
export async function getOrCreateChannelThread(
  db: D1Database,
  params: {
    channelType: string;
    channelId: string;
    externalThreadId: string;
    sessionId: string;
    userId: string;
  },
): Promise<string> {
  // Fast path: existing mapping for this user
  const existing = await getChannelThreadMapping(
    db,
    params.channelType,
    params.channelId,
    params.externalThreadId,
    params.userId,
  );
  if (existing) {
    // Auto-reactivate if the thread was archived (no-op for active threads)
    await db
      .prepare(
        "UPDATE session_threads SET status = 'active', last_active_at = datetime('now') WHERE id = ? AND status = 'archived'"
      )
      .bind(existing.threadId)
      .run();
    return existing.threadId;
  }

  // Create orchestrator thread optimistically
  const threadId = crypto.randomUUID();
  await createThread(db, { id: threadId, sessionId: params.sessionId });

  // Insert mapping with INSERT OR IGNORE to handle concurrent racers.
  // The unique index on (channel_type, channel_id, external_thread_id, user_id)
  // ensures only the first writer wins per user; the second silently no-ops.
  const mappingId = crypto.randomUUID();
  await db
    .prepare(
      'INSERT OR IGNORE INTO channel_thread_mappings (id, session_id, thread_id, channel_type, channel_id, external_thread_id, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .bind(
      mappingId,
      params.sessionId,
      threadId,
      params.channelType,
      params.channelId,
      params.externalThreadId,
      params.userId,
    )
    .run();

  // Read back the winner — may be ours or a concurrent racer's
  const winner = await getChannelThreadMapping(
    db,
    params.channelType,
    params.channelId,
    params.externalThreadId,
    params.userId,
  );

  // If we lost the race, clean up our orphaned thread
  if (winner && winner.threadId !== threadId) {
    await db.prepare('DELETE FROM session_threads WHERE id = ?').bind(threadId).run();
  }

  return winner!.threadId;
}
```

- [ ] **Step 3: Add cursor helper functions**

Append to the same file:

```typescript
/**
 * Update the last-seen cursor for a user's thread mapping.
 */
export async function updateThreadCursor(
  db: D1Database,
  channelType: string,
  channelId: string,
  externalThreadId: string,
  userId: string,
  lastSeenTs: string,
): Promise<void> {
  await db
    .prepare(
      'UPDATE channel_thread_mappings SET last_seen_ts = ? WHERE channel_type = ? AND channel_id = ? AND external_thread_id = ? AND user_id = ?'
    )
    .bind(lastSeenTs, channelType, channelId, externalThreadId, userId)
    .run();
}
```

- [ ] **Step 4: Commit**

```bash
git add packages/worker/src/lib/db/channel-threads.ts
git commit -m "feat(slack): update channel thread DB functions for per-user mappings"
```

---

### Task 3: Remove `slack_bot_threads` DB Helpers

**Files:**
- Modify: `packages/worker/src/lib/db/slack.ts`

- [ ] **Step 1: Remove bot thread functions and imports**

Remove these three functions from `packages/worker/src/lib/db/slack.ts`:
- `trackSlackBotThread`
- `isSlackBotThread`
- `cleanupOldSlackBotThreads`

Also remove the `slackBotThreads` import from the schema imports at the top of the file. The import line should change from:

```typescript
import { orgSlackInstalls, slackLinkVerifications, slackBotThreads } from '../schema/index.js';
```

to:

```typescript
import { orgSlackInstalls, slackLinkVerifications } from '../schema/index.js';
```

Keep all other functions (org install helpers, verification helpers) untouched.

- [ ] **Step 2: Verify no other references remain**

Run: `cd /Users/conner/code/valet && grep -r "slackBotThread\|trackSlackBotThread\|isSlackBotThread\|cleanupOldSlackBotThread" packages/worker/src/ --include="*.ts" -l`

Expected: only `packages/worker/src/routes/slack-events.ts` should remain (will be updated in Task 5).

- [ ] **Step 3: Commit**

```bash
git add packages/worker/src/lib/db/slack.ts
git commit -m "refactor(slack): remove slack_bot_threads DB helpers"
```

---

## Chunk 2: Slack Thread Context Service

### Task 4: Create `slack-threads` Service

**Files:**
- Create: `packages/worker/src/services/slack-threads.ts`

This service fetches thread history from Slack, resolves display names, computes the cursor delta, and formats the context block.

- [ ] **Step 1: Implement `fetchThreadContext`**

```typescript
import { getSlackUserInfo } from './slack.js';

const SLACK_API = 'https://slack.com/api';
const MAX_THREAD_MESSAGES = 200;

export interface ThreadContextMessage {
  ts: string;
  userId: string | null;
  username: string | null; // bot persona name (from chat.postMessage username override)
  text: string;
  files: Array<{ name: string }>;
  isBotMessage: boolean;
}

/**
 * Fetch thread replies from Slack via conversations.replies.
 * Returns up to MAX_THREAD_MESSAGES most recent messages.
 */
export async function fetchThreadReplies(
  botToken: string,
  channel: string,
  threadTs: string,
): Promise<ThreadContextMessage[]> {
  const allMessages: ThreadContextMessage[] = [];
  let cursor: string | undefined;

  // Paginate through thread replies
  do {
    const params = new URLSearchParams({
      channel,
      ts: threadTs,
      limit: '200',
    });
    if (cursor) {
      params.set('cursor', cursor);
    }

    let resp: Response;
    try {
      resp = await fetch(`${SLACK_API}/conversations.replies?${params}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${botToken}` },
      });
    } catch (err) {
      console.error(`[SlackThreads] conversations.replies fetch error:`, err);
      break;
    }

    // Retry on 429 rate limit with Retry-After backoff
    if (resp.status === 429) {
      const retryAfter = parseInt(resp.headers.get('Retry-After') || '1', 10);
      console.log(`[SlackThreads] Rate limited, retrying after ${retryAfter}s`);
      await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
      continue;
    }

    if (!resp.ok) {
      console.error(`[SlackThreads] conversations.replies HTTP error: status=${resp.status}`);
      break;
    }

    const result = (await resp.json()) as {
      ok: boolean;
      messages?: Array<{
        ts: string;
        user?: string;
        username?: string;
        text?: string;
        subtype?: string;
        bot_id?: string;
        files?: Array<{ name: string }>;
      }>;
      has_more?: boolean;
      response_metadata?: { next_cursor?: string };
    };

    if (!result.ok || !result.messages) break;

    for (const msg of result.messages) {
      allMessages.push({
        ts: msg.ts,
        userId: msg.user || null,
        username: msg.username || null,
        text: msg.text || '',
        files: msg.files?.map((f) => ({ name: f.name })) || [],
        isBotMessage: !!msg.bot_id || msg.subtype === 'bot_message',
      });
    }

    cursor = result.has_more ? result.response_metadata?.next_cursor : undefined;
  } while (cursor);

  // Return only the most recent MAX_THREAD_MESSAGES
  if (allMessages.length > MAX_THREAD_MESSAGES) {
    return allMessages.slice(-MAX_THREAD_MESSAGES);
  }
  return allMessages;
}

/**
 * Resolve display names for a set of Slack user IDs.
 * Returns a Map of userId → displayName.
 * Uses an in-memory cache scoped to this call to avoid redundant API requests.
 */
export async function resolveDisplayNames(
  botToken: string,
  userIds: string[],
): Promise<Map<string, string>> {
  const nameMap = new Map<string, string>();
  const uniqueIds = [...new Set(userIds)];

  // Resolve in parallel (batch of unique IDs)
  const results = await Promise.all(
    uniqueIds.map(async (uid) => {
      const profile = await getSlackUserInfo(botToken, uid);
      return { uid, name: profile?.displayName || profile?.realName || uid };
    }),
  );

  for (const { uid, name } of results) {
    nameMap.set(uid, name);
  }

  return nameMap;
}

/**
 * Convert a Slack ts (epoch.sequence) to human-readable format.
 */
function formatSlackTs(ts: string): string {
  const epochSeconds = parseFloat(ts);
  const date = new Date(epochSeconds * 1000);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

/**
 * Build a formatted thread context string from Slack thread messages.
 *
 * Fetches thread history, resolves display names, filters to messages
 * newer than the cursor, and returns a formatted context block ready
 * to prepend to the user's message.
 *
 * Returns null if there are no new context messages.
 */
export async function buildThreadContext(
  botToken: string,
  channel: string,
  threadTs: string,
  lastSeenTs: string | null,
  currentMessageTs: string,
): Promise<string | null> {
  const messages = await fetchThreadReplies(botToken, channel, threadTs);

  // Filter to messages newer than cursor (if cursor exists)
  // Exclude the current invoking message (it will be sent separately)
  const newMessages = messages.filter((msg) => {
    if (msg.ts === currentMessageTs) return false;
    if (!lastSeenTs) return true;
    return msg.ts > lastSeenTs;
  });

  if (newMessages.length === 0) return null;

  // Collect user IDs that need name resolution (skip bot messages — they use username)
  const userIdsToResolve = newMessages
    .filter((msg) => !msg.isBotMessage && msg.userId)
    .map((msg) => msg.userId!);

  const nameMap = await resolveDisplayNames(botToken, userIdsToResolve);

  // Format each message
  const lines = newMessages.map((msg) => {
    const timestamp = formatSlackTs(msg.ts);
    const displayName = msg.isBotMessage
      ? (msg.username || 'Bot')
      : (msg.userId ? nameMap.get(msg.userId) || msg.userId : 'Unknown');

    let content = msg.text;

    // FUTURE: Download images via url_private with bot token for multipart attachment
    // For now, note files as placeholders
    for (const file of msg.files) {
      content += ` [file: ${file.name}]`;
    }

    return `[${timestamp}] ${displayName}: ${content}`;
  });

  return `--- Thread context (messages you haven't seen) ---\n${lines.join('\n')}\n--- End thread context ---`;
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/worker/src/services/slack-threads.ts
git commit -m "feat(slack): add slack-threads service for thread context fetching"
```

---

## Chunk 3: Routing Changes

### Task 5: Rewrite `slack-events.ts` Routing Logic

**Files:**
- Modify: `packages/worker/src/routes/slack-events.ts`

This is the core change. The routing decision block, thread tracking, and dispatch logic all change.

- [ ] **Step 1: Update imports**

At the top of `slack-events.ts`, add the import for the new thread context service and the cursor update function. Remove `dispatchOrchestratorPrompt` if it's only used for orchestrator dispatch (it's re-exported from `workflow-runtime.ts`):

Add:
```typescript
import { buildThreadContext } from '../services/slack-threads.js';
import { updateThreadCursor } from '../lib/db/channel-threads.js';
```

The `dispatchOrchestratorPrompt` import from `'../lib/workflow-runtime.js'` stays as-is.

- [ ] **Step 2: Simplify routing decision block**

Replace lines 166–190 (the routing decision block) with:

```typescript
  // ─── Routing decision ──────────────────────────────────────────────────
  const isDm = slackChannelType === 'im';
  const isMention = slackEventType === 'app_mention';

  let shouldRoute = false;

  if (isDm) {
    // DMs → always route
    shouldRoute = true;
  } else if (isMention) {
    // @mention in any channel → route to mentioning user's orchestrator
    shouldRoute = true;
  } else {
    // Regular channel message (no mention) → ignore
    // FUTURE: push-model hook — broadcast to subscribed orchestrators for ambient awareness
    console.log(`[Slack] Ignoring non-mention channel message: channel=${message.channelId}`);
    return c.json({ ok: true });
  }
```

This removes the `isThreadReply` path and the `isSlackBotThread` check entirely.

- [ ] **Step 3: Remove `trackSlackBotThread` call**

Delete lines 213–222 (the "Track @mention threads" block):

```typescript
  // ─── Track @mention threads ────────────────────────────────────────────
  if (isMention && threadId) {
    await db.trackSlackBotThread(c.get('db'), {
      id: crypto.randomUUID(),
      teamId,
      channelId: message.channelId,
      threadTs: threadId,
      userId,
    });
  }
```

- [ ] **Step 4: Skip channel bindings for public channels**

Replace the binding lookup and bound-session dispatch block. The current code (lines 224–323) does binding lookup unconditionally. Change it to only look up bindings for DMs:

```typescript
  // Build scope key and look up channel binding (DMs only — public channels use multi-orchestrator routing)
  let binding: Awaited<ReturnType<typeof db.getChannelBindingByScopeKey>> = null;
  if (isDm) {
    const parts = transport.scopeKeyParts(message, userId);
    const scopeKey = channelScopeKey(userId, parts.channelType, parts.channelId);
    binding = await db.getChannelBindingByScopeKey(c.get('db'), scopeKey);
  } else {
    console.log(`[Slack] Public channel mention — skipping binding lookup, using multi-orchestrator routing`);
  }
```

Keep the existing bound-session dispatch block (lines 279–323) as-is — it now only fires for DMs. Remove or update the `No binding for scopeKey=` log statement in the else branch (line ~322) since `scopeKey` is no longer defined for public channels.

- [ ] **Step 5: Add thread context pull before orchestrator dispatch**

Before the orchestrator dispatch block (currently around line 325), add the thread context fetching for public channel mentions. Insert this before the `dispatchOrchestratorPrompt` call:

```typescript
  // ─── Pull thread context for public channel mentions ──────────────────
  // FUTURE: push-model hook — in a push model, context would already be available
  // from real-time broadcast. This pull path fetches on-demand from Slack API.
  let contentWithContext = message.text || '[Attachment]';
  if (!isDm && threadId) {
    try {
      // Look up existing cursor for this user's view of the thread
      const existingMapping = await db.getChannelThreadMapping(
        c.env.DB, 'slack', message.channelId, threadId, userId
      );

      const context = await buildThreadContext(
        botToken,
        message.channelId,
        threadId,
        existingMapping?.lastSeenTs || null,
        messageId,
      );

      if (context) {
        contentWithContext = `${context}\n\n${contentWithContext}`;
      }

      // Advance cursor to current message
      if (existingMapping) {
        await updateThreadCursor(c.env.DB, 'slack', message.channelId, threadId, userId, messageId);
      }
      // If no existing mapping, cursor will be set when getOrCreateChannelThread runs below
    } catch (err) {
      // Thread context is best-effort — don't block message dispatch
      console.error(`[Slack] Failed to fetch thread context:`, err);
    }
  }
```

- [ ] **Step 6: Update orchestrator dispatch to use `contentWithContext`**

Change the `dispatchOrchestratorPrompt` call to use `contentWithContext` instead of `message.text || '[Attachment]'`:

```typescript
  console.log(`[Slack] Orchestrator dispatch: userId=${userId} channelId=${dispatchChannelId}`);
  const result = await dispatchOrchestratorPrompt(c.env, {
    userId,
    content: contentWithContext,
    channelType: 'slack',
    channelId: dispatchChannelId,
    threadId: orchestratorThreadId,
    authorName: message.senderName,
    attachments: attachments.length > 0 ? attachments : undefined,
  });
```

- [ ] **Step 7: Update the cursor after thread mapping creation**

In the "Resolve orchestrator thread" block, after `getOrCreateChannelThread` succeeds, set the initial cursor for new mappings. Add after the `orchestratorThreadId` assignment:

```typescript
        // Set initial cursor for new thread mappings
        if (orchestratorThreadId && !isDm) {
          await updateThreadCursor(c.env.DB, 'slack', message.channelId, threadId, userId, messageId);
        }
```

This goes inside the existing `try` block, right after the `orchestratorThreadId` assignment (before the `catch`).

- [ ] **Step 8: Update the file header comment**

Replace the routing rules comment at the top of the handler (lines 16–25) with:

```typescript
/**
 * POST /channels/slack/events — Slack Events API handler
 *
 * Routing rules:
 * 1. DMs (channel_type === 'im') → always route
 * 2. @mention (event.type === 'app_mention') → route to mentioning user's orchestrator
 *    with thread context pulled from Slack API
 * 3. Everything else → ignore (200 OK)
 *
 * FUTURE (push model): Non-mention messages in tracked threads could be broadcast
 * to subscribed orchestrators for ambient awareness. See comments at routing decision
 * points for hook locations.
 *
 * Bot replies always thread on the invoking message.
 */
```

- [ ] **Step 9: Verify typecheck passes**

Run: `cd /Users/conner/code/valet && pnpm typecheck`

Expected: No type errors. The `db.isSlackBotThread` and `db.trackSlackBotThread` calls should be gone. The `getChannelThreadMapping` callers should now pass `userId`.

- [ ] **Step 10: Commit**

```bash
git add packages/worker/src/routes/slack-events.ts
git commit -m "feat(slack): multi-orchestrator routing with thread context pull"
```

---

### Task 6: Verify End-to-End & Clean Up

**Files:**
- Possibly modify: `packages/worker/src/lib/db.ts` (if re-exports need cleanup)

- [ ] **Step 1: Check for remaining `slackBotThread` references**

Run: `cd /Users/conner/code/valet && grep -r "slackBotThread\|slack_bot_thread" packages/worker/src/ --include="*.ts"`

Expected: No matches. If any remain, remove them.

- [ ] **Step 2: Run full typecheck**

Run: `cd /Users/conner/code/valet && pnpm typecheck`

Expected: Clean pass across all packages.

- [ ] **Step 3: Verify the schema barrel export is clean**

Check that `packages/worker/src/lib/schema/index.ts` still exports from `./slack.js` (it does — the file still has `orgSlackInstalls` and `slackLinkVerifications`). No changes needed since we only removed `slackBotThreads` from the file, and it's a `*` export.

- [ ] **Step 4: Final commit (if any cleanup was needed)**

```bash
git add -A
git commit -m "chore(slack): clean up remaining slack_bot_threads references"
```
