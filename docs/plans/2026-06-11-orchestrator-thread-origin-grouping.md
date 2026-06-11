# Orchestrator Thread Origin Grouping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist orchestrator thread display origin so Web, Slack, and Automations sidebar groups reflect where a thread originally started, not later reply-routing bindings.

**Architecture:** Add immutable origin metadata to `session_threads`, return it through the thread list API, and make the client group by origin first with a legacy fallback. Keep `channel_thread_mappings` as routing metadata only, and keep workflow executions out of scope.

**Tech Stack:** TypeScript, Cloudflare Worker D1, Drizzle schema, Hono routes, React, TanStack Query, Vitest.

---

## File Map

- `packages/worker/migrations/0018_session_thread_origin_metadata.sql`: add nullable origin columns to `session_threads`.
- `packages/worker/src/lib/schema/threads.ts`: add Drizzle fields for the new columns.
- `packages/shared/src/types/index.ts`: extend `SessionThread` with origin response fields.
- `packages/worker/src/lib/db/threads.ts`: accept thread origin input, persist origin fields, return origin fields, and make legacy channel mapping fallback deterministic.
- `packages/worker/src/lib/db/threads.test.ts`: new DB tests for origin persistence and list behavior.
- `packages/worker/src/lib/db/channel-threads.ts`: mark newly-created external Slack threads with Slack origin; leave pre-registered thread origins untouched.
- `packages/worker/src/lib/db/channel-threads.test.ts`: add tests proving Slack mapping registration does not relabel existing Web or Automation threads.
- `packages/worker/src/services/orchestrator.ts`: accept explicit thread origin metadata and pass it into auto-created orchestrator threads.
- `packages/worker/src/services/orchestrator.test.ts`: add dispatch test for automation-origin threads.
- `packages/worker/src/services/triggers.ts`: pass automation origin for orchestrator-targeted manual trigger runs.
- `packages/worker/src/services/triggers.test.ts`: add a focused test for manually invoking an orchestrator-targeted trigger.
- `packages/worker/src/services/session-workflows.ts`: pass automation origin for orchestrator-targeted manual trigger runs invoked through workflow/session tools.
- `packages/worker/src/index.ts`: pass automation origin for cron-dispatched orchestrator schedule triggers.
- `packages/worker/src/routes/slack-events.ts`: no routing redesign; keep raw Slack `message.channelId` as the origin channel id when a new Slack thread is created through `getOrCreateChannelThread`.
- `packages/client/src/components/chat/thread-sidebar.tsx`: group threads by origin metadata before legacy channel metadata.
- `packages/client/src/components/chat/thread-sidebar.test.ts`: new pure-function tests for sidebar grouping.
- `docs/specs/sessions.md`: update the canonical sessions data model with thread origin fields and listing behavior.
- `docs/specs/orchestrator.md`: document that channel mappings route replies and thread origin drives sidebar grouping.

---

### Task 1: Add Thread Origin Schema, Types, and DB Listing

**Files:**
- Create: `packages/worker/migrations/0018_session_thread_origin_metadata.sql`
- Create: `packages/worker/src/lib/db/threads.test.ts`
- Modify: `packages/worker/src/lib/schema/threads.ts`
- Modify: `packages/shared/src/types/index.ts`
- Modify: `packages/worker/src/lib/db/threads.ts`

- [ ] **Step 1: Write the failing DB tests**

Add `packages/worker/src/lib/db/threads.test.ts` using the same in-memory migration loader pattern as `packages/worker/src/lib/db/channel-threads.test.ts`.

Include these tests:

```ts
it('persists default web origin for newly-created threads', async () => {
  const thread = await createThread(d1, { id: 'thread-web', sessionId: 'orchestrator:user-1' });

  expect(thread.originType).toBe('web');

  const stored = await getThread(d1, 'thread-web');
  expect(stored?.originType).toBe('web');
});

it('returns origin metadata separately from legacy routing channel metadata', async () => {
  await createThread(d1, {
    id: 'thread-automation',
    sessionId: 'orchestrator:user-1',
    originType: 'automation',
    originTriggerId: 'trigger-1',
    originTriggerType: 'schedule',
  });

  await registerChannelThread(d1, {
    channelType: 'slack',
    channelId: 'D123',
    externalThreadId: '1700000000.000001',
    userId: 'user-1',
    sessionId: 'orchestrator:user-1',
    threadId: 'thread-automation',
  });

  const result = await listThreads(d1, 'orchestrator:user-1');
  expect(result.threads).toHaveLength(1);
  expect(result.threads[0]).toMatchObject({
    id: 'thread-automation',
    originType: 'automation',
    originTriggerId: 'trigger-1',
    originTriggerType: 'schedule',
    channelType: 'slack',
    channelId: 'D123',
  });
});

it('does not duplicate a thread with multiple legacy routing mappings', async () => {
  await createThread(d1, { id: 'thread-web', sessionId: 'orchestrator:user-1' });
  await registerChannelThread(d1, {
    channelType: 'slack',
    channelId: 'D123',
    externalThreadId: '1700000000.000001',
    userId: 'user-1',
    sessionId: 'orchestrator:user-1',
    threadId: 'thread-web',
  });
  await registerChannelThread(d1, {
    channelType: 'slack',
    channelId: 'D123',
    externalThreadId: '1700000000.000002',
    userId: 'user-1',
    sessionId: 'orchestrator:user-1',
    threadId: 'thread-web',
  });

  const result = await listThreads(d1, 'orchestrator:user-1');
  expect(result.threads.map((thread) => thread.id)).toEqual(['thread-web']);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/worker/src/lib/db/threads.test.ts`

Expected: FAIL because `session_threads` does not have origin columns and `SessionThread` has no origin fields.

- [ ] **Step 3: Add the migration**

Create `packages/worker/migrations/0018_session_thread_origin_metadata.sql`:

```sql
ALTER TABLE session_threads ADD COLUMN origin_type TEXT;
ALTER TABLE session_threads ADD COLUMN origin_channel_type TEXT;
ALTER TABLE session_threads ADD COLUMN origin_channel_id TEXT;
ALTER TABLE session_threads ADD COLUMN origin_trigger_id TEXT;
ALTER TABLE session_threads ADD COLUMN origin_trigger_type TEXT;
```

- [ ] **Step 4: Add schema and shared types**

In `packages/worker/src/lib/schema/threads.ts`, add nullable text fields:

```ts
originType: text(),
originChannelType: text(),
originChannelId: text(),
originTriggerId: text(),
originTriggerType: text(),
```

In `packages/shared/src/types/index.ts`, extend `SessionThread`:

```ts
originType?: string;
originChannelType?: string;
originChannelId?: string;
originTriggerId?: string;
originTriggerType?: 'manual' | 'schedule' | string;
```

- [ ] **Step 5: Update DB helper input/output**

In `packages/worker/src/lib/db/threads.ts`, introduce a focused input type:

```ts
export interface ThreadOriginInput {
  originType?: string;
  originChannelType?: string;
  originChannelId?: string;
  originTriggerId?: string;
  originTriggerType?: string;
}
```

Update `createThread` data input to include `ThreadOriginInput`. Default `originType` to `'web'` when omitted.

Update the insert to include the origin columns:

```ts
const originType = data.originType ?? 'web';

INSERT INTO session_threads (
  id, session_id, opencode_session_id,
  origin_type, origin_channel_type, origin_channel_id,
  origin_trigger_id, origin_trigger_type
) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
```

Update `rowToThread` to map:

```ts
originType: row.origin_type || undefined,
originChannelType: row.origin_channel_type || undefined,
originChannelId: row.origin_channel_id || undefined,
originTriggerId: row.origin_trigger_id || undefined,
originTriggerType: row.origin_trigger_type || undefined,
```

Update `listThreads` legacy mapping join so it returns at most one mapping row per thread:

```sql
LEFT JOIN channel_thread_mappings ctm
  ON ctm.id = (
    SELECT id
    FROM channel_thread_mappings
    WHERE thread_id = t.id
    ORDER BY created_at ASC, id ASC
    LIMIT 1
  )
```

- [ ] **Step 6: Run the DB tests to verify they pass**

Run: `pnpm vitest run packages/worker/src/lib/db/threads.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit Task 1**

Run:

```bash
git add packages/worker/migrations/0018_session_thread_origin_metadata.sql packages/worker/src/lib/schema/threads.ts packages/shared/src/types/index.ts packages/worker/src/lib/db/threads.ts packages/worker/src/lib/db/threads.test.ts
git commit -m "feat(worker): persist thread origin metadata"
```

---

### Task 2: Mark Orchestrator Automation Threads at Creation

**Files:**
- Modify: `packages/worker/src/services/orchestrator.ts`
- Modify: `packages/worker/src/services/orchestrator.test.ts`
- Create: `packages/worker/src/services/triggers.test.ts`
- Modify: `packages/worker/src/services/triggers.ts`
- Modify: `packages/worker/src/services/session-workflows.ts`
- Modify: `packages/worker/src/index.ts`

- [ ] **Step 1: Write the failing orchestrator dispatch test**

In `packages/worker/src/services/orchestrator.test.ts`, add a test:

```ts
it('marks forced trigger-created threads as automation origin', async () => {
  const doFetch = vi
    .fn()
    .mockResolvedValueOnce(new Response(null, { status: 200 }))
    .mockResolvedValueOnce(Response.json({ success: true }));
  const env = {
    DB: {},
    SESSIONS: {
      idFromName: vi.fn((name: string) => `do:${name}`),
      get: vi.fn(() => ({ fetch: doFetch })),
    },
  } as any;

  await dispatchOrchestratorPrompt(env, {
    userId: 'user-1',
    content: 'run the daily check',
    forceNewThread: true,
    threadOrigin: {
      originType: 'automation',
      originTriggerId: 'trigger-1',
      originTriggerType: 'schedule',
    },
  });

  expect(createThreadMock).toHaveBeenCalledWith(env.DB, expect.objectContaining({
    originType: 'automation',
    originTriggerId: 'trigger-1',
    originTriggerType: 'schedule',
  }));
});
```

- [ ] **Step 2: Write the failing manual trigger invocation test**

Create `packages/worker/src/services/triggers.test.ts` with a focused mock-based test for `runTrigger`. This verifies that manually pressing Run on an orchestrator-targeted trigger still creates an Automation-origin thread.

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  dispatchOrchestratorPromptMock,
  getDbMock,
  getTriggerForRunMock,
  updateTriggerLastRunMock,
} = vi.hoisted(() => ({
  dispatchOrchestratorPromptMock: vi.fn(),
  getDbMock: vi.fn(),
  getTriggerForRunMock: vi.fn(),
  updateTriggerLastRunMock: vi.fn(),
}));

vi.mock('./orchestrator.js', () => ({
  dispatchOrchestratorPrompt: dispatchOrchestratorPromptMock,
}));

vi.mock('../lib/drizzle.js', () => ({
  getDb: getDbMock,
}));

vi.mock('../lib/db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/db.js')>();
  return {
    ...actual,
    getTriggerForRun: getTriggerForRunMock,
    updateTriggerLastRun: updateTriggerLastRunMock,
  };
});

import { runTrigger } from './triggers.js';

describe('runTrigger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getDbMock.mockReturnValue({});
    dispatchOrchestratorPromptMock.mockResolvedValue({
      dispatched: true,
      sessionId: 'orchestrator:user-1',
    });
    getTriggerForRunMock.mockResolvedValue({
      wf_id: null,
      workflow_name: null,
      config: JSON.stringify({
        type: 'schedule',
        target: 'orchestrator',
        prompt: 'Daily triage',
        timezone: 'UTC',
        cron: '0 9 * * *',
      }),
    });
  });

  it('marks manually invoked orchestrator-targeted triggers as automation origin', async () => {
    const env = { DB: {} } as any;

    await runTrigger(env, 'trigger-1', 'user-1', { clientRequestId: 'manual-run' }, 'http://worker.test');

    expect(dispatchOrchestratorPromptMock).toHaveBeenCalledWith(env, expect.objectContaining({
      forceNewThread: true,
      threadOrigin: {
        originType: 'automation',
        originTriggerId: 'trigger-1',
        originTriggerType: 'schedule',
      },
    }));
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run:

```bash
pnpm vitest run \
  packages/worker/src/services/orchestrator.test.ts \
  packages/worker/src/services/triggers.test.ts
```

Expected: FAIL because `dispatchOrchestratorPrompt` does not accept or pass `threadOrigin`, and `runTrigger` does not pass automation origin.

- [ ] **Step 4: Add `threadOrigin` dispatch support**

In `packages/worker/src/services/orchestrator.ts`, import `ThreadOriginInput` from `../lib/db/threads.js` or use the existing `db` export if that is cleaner.

Extend `dispatchOrchestratorPrompt` params:

```ts
threadOrigin?: ThreadOriginInput;
```

When auto-creating a thread, pass the origin:

```ts
thread = await db.createThread(env.DB, {
  id,
  sessionId,
  ...(params.threadOrigin ?? {}),
  ...(params.channelType && params.channelType !== 'thread' && !params.threadOrigin
    ? {
        originType: params.channelType,
        originChannelType: params.channelType,
        originChannelId: params.channelId,
      }
    : {}),
});
```

Keep `originType` defaulting to `web` inside `createThread`, so web route-created threads do not need route-specific changes.

- [ ] **Step 5: Pass automation origin from orchestrator-targeted trigger call sites**

Update `packages/worker/src/services/triggers.ts` in the orchestrator-targeted trigger branch:

```ts
threadOrigin: {
  originType: 'automation',
  originTriggerId: triggerId,
  originTriggerType: config.type,
},
```

Update `packages/worker/src/services/session-workflows.ts` in its orchestrator-targeted trigger branch with the same shape.

Update `packages/worker/src/index.ts` cron dispatch:

```ts
threadOrigin: {
  originType: 'automation',
  originTriggerId: row.trigger_id,
  originTriggerType: 'schedule',
},
```

Do not add this to workflow execution session creation or workflow executor paths.

- [ ] **Step 6: Run the focused tests**

Run:

```bash
pnpm vitest run \
  packages/worker/src/services/orchestrator.test.ts \
  packages/worker/src/services/triggers.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit Task 2**

Run:

```bash
git add packages/worker/src/services/orchestrator.ts packages/worker/src/services/orchestrator.test.ts packages/worker/src/services/triggers.test.ts packages/worker/src/services/triggers.ts packages/worker/src/services/session-workflows.ts packages/worker/src/index.ts
git commit -m "feat(worker): mark orchestrator trigger threads as automations"
```

---

### Task 3: Preserve Slack Thread Origin Separately From Reply Routing

**Files:**
- Modify: `packages/worker/src/lib/db/channel-threads.ts`
- Modify: `packages/worker/src/lib/db/channel-threads.test.ts`
- Review only: `packages/worker/src/routes/slack-events.ts`

- [ ] **Step 1: Write failing channel-thread tests**

In `packages/worker/src/lib/db/channel-threads.test.ts`, add:

```ts
it('creates new Slack channel threads with Slack origin metadata', async () => {
  const threadId = await getOrCreateChannelThread(d1, {
    channelType: 'slack',
    channelId: 'D_DM_CHANNEL',
    externalThreadId: '1700000000.000001',
    sessionId: 'orchestrator:user-1',
    userId: 'user-1',
  });

  const thread = await getThread(d1, threadId);
  expect(thread).toMatchObject({
    originType: 'slack',
    originChannelType: 'slack',
    originChannelId: 'D_DM_CHANNEL',
  });
});

it('does not relabel an existing web-origin thread when registering a Slack reply mapping', async () => {
  await createThread(d1, {
    id: 'existing-web-thread',
    sessionId: 'orchestrator:user-1',
    originType: 'web',
  });

  await registerChannelThread(d1, {
    channelType: 'slack',
    channelId: 'D_DM_CHANNEL',
    externalThreadId: '1700000000.000001',
    userId: 'user-1',
    sessionId: 'orchestrator:user-1',
    threadId: 'existing-web-thread',
  });

  const threadId = await getOrCreateChannelThread(d1, {
    channelType: 'slack',
    channelId: 'D_DM_CHANNEL',
    externalThreadId: '1700000000.000001',
    sessionId: 'orchestrator:user-1',
    userId: 'user-1',
  });
  const thread = await getThread(d1, threadId);

  expect(thread?.id).toBe('existing-web-thread');
  expect(thread?.originType).toBe('web');
});
```

Add imports for `createThread` and `getThread` from `./threads.js`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/worker/src/lib/db/channel-threads.test.ts`

Expected: FAIL because new Slack-created threads still use the default `web` origin until implementation.

- [ ] **Step 3: Mark newly-created channel threads with source channel origin**

In `packages/worker/src/lib/db/channel-threads.ts`, update the optimistic create call:

```ts
await createThread(db, {
  id: threadId,
  sessionId: params.sessionId,
  originType: params.channelType,
  originChannelType: params.channelType,
  originChannelId: params.channelId,
});
```

Do not update origin fields in `registerChannelThread`; it should only add routing metadata.

- [ ] **Step 4: Review Slack route call shape**

Inspect `packages/worker/src/routes/slack-events.ts` and confirm it calls `getOrCreateChannelThread` with:

```ts
channelType: 'slack',
channelId: message.channelId,
externalThreadId: threadId,
```

No code change is expected unless that shape has drifted. This keeps `originChannelId` as the raw Slack conversation id, as required by the spec.

- [ ] **Step 5: Run focused tests**

Run:

```bash
pnpm vitest run packages/worker/src/lib/db/channel-threads.test.ts packages/worker/src/lib/db/threads.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit Task 3**

Run:

```bash
git add packages/worker/src/lib/db/channel-threads.ts packages/worker/src/lib/db/channel-threads.test.ts
git commit -m "feat(worker): keep slack mappings from relabeling thread origin"
```

---

### Task 4: Group the Thread Sidebar by Origin Metadata

**Files:**
- Modify: `packages/client/src/components/chat/thread-sidebar.tsx`
- Create: `packages/client/src/components/chat/thread-sidebar.test.ts`

- [ ] **Step 1: Write failing sidebar grouping tests**

Export the grouping helper from `thread-sidebar.tsx` or move the pure grouping functions to a nearby helper if the file becomes awkward to test.

Create `packages/client/src/components/chat/thread-sidebar.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { groupThreadsByChannel } from './thread-sidebar';
import type { SessionThread } from '@/api/types';

const baseThread = (overrides: Partial<SessionThread>): SessionThread => ({
  id: overrides.id ?? 'thread',
  sessionId: 'orchestrator:user-1',
  summaryAdditions: 0,
  summaryDeletions: 0,
  summaryFiles: 0,
  status: 'active',
  messageCount: 1,
  createdAt: new Date('2026-06-11T00:00:00Z'),
  lastActiveAt: new Date('2026-06-11T00:00:00Z'),
  ...overrides,
});

describe('groupThreadsByChannel', () => {
  it('uses automation origin before Slack routing metadata', () => {
    const groups = groupThreadsByChannel([
      baseThread({
        id: 'automation-thread',
        originType: 'automation',
        channelType: 'slack',
        channelId: 'D123',
      }),
    ], new Map());

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      channelKey: 'automation:default',
      channelType: 'automation',
      label: 'Automations',
    });
  });

  it('keeps web-origin threads under Web even after Slack mappings exist', () => {
    const groups = groupThreadsByChannel([
      baseThread({
        id: 'web-thread',
        originType: 'web',
        channelType: 'slack',
        channelId: 'D123',
      }),
    ], new Map());

    expect(groups[0]).toMatchObject({
      channelKey: 'web:default',
      channelType: 'web',
      label: 'Web',
    });
  });

  it('uses Slack origin channel labels for Slack-origin threads', () => {
    const groups = groupThreadsByChannel([
      baseThread({
        id: 'slack-thread',
        originType: 'slack',
        originChannelType: 'slack',
        originChannelId: 'C123',
      }),
    ], new Map([['slack:C123', 'Slack #alerts']]));

    expect(groups[0]).toMatchObject({
      channelKey: 'slack:C123',
      channelType: 'slack',
      label: 'Slack #alerts',
    });
  });

  it('falls back to legacy channel metadata when origin is missing', () => {
    const groups = groupThreadsByChannel([
      baseThread({
        id: 'legacy-thread',
        channelType: 'slack',
        channelId: 'D123',
      }),
    ], new Map([['slack:D123', 'Slack DM']]));

    expect(groups[0]).toMatchObject({
      channelKey: 'slack:D123',
      label: 'Slack DM',
    });
  });
});
```

- [ ] **Step 2: Run the client grouping test to verify it fails**

Run: `pnpm vitest run packages/client/src/components/chat/thread-sidebar.test.ts`

Expected: FAIL because grouping still reads only `channelType/channelId`.

- [ ] **Step 3: Implement origin-first grouping**

In `packages/client/src/components/chat/thread-sidebar.tsx`, export `groupThreadsByChannel`.

Add a pure helper:

```ts
function getThreadGroupTarget(thread: SessionThread): { channelType: string; channelId: string; labelOverride?: string } {
  if (thread.originType === 'automation') {
    return { channelType: 'automation', channelId: 'default', labelOverride: 'Automations' };
  }
  if (thread.originType === 'web') {
    return { channelType: 'web', channelId: 'default' };
  }
  if (thread.originChannelType && thread.originChannelId) {
    return { channelType: thread.originChannelType, channelId: thread.originChannelId };
  }
  if (thread.originType && thread.originType !== 'thread') {
    return { channelType: thread.originType, channelId: thread.originChannelId || 'default' };
  }
  return {
    channelType: thread.channelType || 'web',
    channelId: thread.channelId || 'default',
  };
}
```

Use this helper inside `groupThreadsByChannel`.

Update `useResolvedChannelLabels` to resolve labels for origin-derived non-web, non-automation targets. A simple way is to compute targets with `getThreadGroupTarget(thread)` instead of reading `thread.channelType/thread.channelId` directly.

Update group sorting so Web stays first, Automations follows Web, and other channel groups sort by label:

```ts
const priority = (type: string) => type === 'web' ? 0 : type === 'automation' ? 1 : 2;
```

- [ ] **Step 4: Run the client grouping test**

Run: `pnpm vitest run packages/client/src/components/chat/thread-sidebar.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit Task 4**

Run:

```bash
git add packages/client/src/components/chat/thread-sidebar.tsx packages/client/src/components/chat/thread-sidebar.test.ts
git commit -m "feat(client): group orchestrator threads by origin"
```

---

### Task 5: Update Canonical Specs and Run Verification

**Files:**
- Modify: `docs/specs/sessions.md`
- Modify: `docs/specs/orchestrator.md`

- [ ] **Step 1: Update `docs/specs/sessions.md`**

In the `session_threads` table section, add rows for:

```md
| `originType` | text | UI grouping origin, e.g. `web`, `slack`, `automation` |
| `originChannelType` | text | Original external channel type when applicable |
| `originChannelId` | text | Original external channel id when applicable |
| `originTriggerId` | text | Orchestrator-targeted trigger id for automation threads |
| `originTriggerType` | text | Trigger type such as `manual` or `schedule` |
```

In Thread History Listing, add:

```md
Thread list responses include thread origin fields. Clients group by origin first and use legacy `channelType` / `channelId` only as compatibility fallback for older rows.
```

- [ ] **Step 2: Update `docs/specs/orchestrator.md`**

In the Channel System area, add a short note:

```md
`channel_thread_mappings` records reply-routing bindings only. Sidebar grouping for orchestrator threads uses `session_threads.origin*` metadata so Slack DM bindings created by approvals or follow-ups do not relabel Web or Automation-originated threads.
```

- [ ] **Step 3: Run focused test suite**

Run:

```bash
pnpm vitest run \
  packages/worker/src/lib/db/threads.test.ts \
  packages/worker/src/lib/db/channel-threads.test.ts \
  packages/worker/src/services/orchestrator.test.ts \
  packages/worker/src/services/triggers.test.ts \
  packages/client/src/components/chat/thread-sidebar.test.ts
```

Expected: PASS.

- [ ] **Step 4: Run package typechecks**

Run:

```bash
pnpm --filter @valet/worker typecheck
pnpm --filter @valet/client typecheck
```

Expected: PASS.

- [ ] **Step 5: Run final relevant full test command if time permits**

Run: `pnpm test`

Expected: PASS. If this is too slow or fails outside the touched area, capture the failure and run the focused suite again before reporting.

- [ ] **Step 6: Commit Task 5**

Run:

```bash
git add docs/specs/sessions.md docs/specs/orchestrator.md
git commit -m "docs: update thread origin behavior specs"
```

---

## Notes for Implementation

- Do not use `channel_thread_mappings` to determine new sidebar grouping. It is a routing table.
- Do not update origin metadata from `registerChannelThread`; that path is specifically used by Slack DM fallback and approvals and must not relabel existing threads.
- Keep `SessionThread.channelType` and `SessionThread.channelId` in API responses for compatibility.
- Workflow executions and workflow execution sessions are intentionally out of scope.
- Follow the repo rule from `CLAUDE.md`: do not add AI co-author trailers to commits.
