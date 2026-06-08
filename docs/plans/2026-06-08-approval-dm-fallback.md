# Approval DM Fallback & Better Expiry Errors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix two bugs: (1) approval prompts for scheduled/unattended automations are silently dropped because `'thread'` is treated as a real delivery channel; (2) the agent receives no useful guidance when an approval expires unattended.

**Architecture:** Add a `resolveUserDmTarget` extension point to the `ChannelTransport` SDK interface, implement it in `SlackTransport` via `conversations.open`, expose it on `ChannelRouter`, then wire it into `sendChannelInteractivePrompts` in `SessionAgentDO` — fixing the `'thread'` filter bug and adding a Slack DM fallback with provenance context. Separately, improve the `expireInteractivePromptRow` error message to break the silent retry loop.

**Tech Stack:** TypeScript, Vitest, Cloudflare Workers DO SQLite, Slack Block Kit API

---

### Task 1: DB helper — `getWorkflowNameByExecutionId`

**Files:**
- Modify: `packages/worker/src/lib/db/workflows.ts`

- [ ] **Step 1: Write the failing test**

In `packages/worker/src/lib/db/workflows.ts` there are already Vitest tests co-located with the file — check for an adjacent `workflows.test.ts`. If it doesn't exist, add the test to the nearest test file that tests DB helpers. Add:

```typescript
// In the appropriate db test file (create packages/worker/src/lib/db/workflows.test.ts if none exists)
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../../test/helpers.js'; // adjust path to match project test helpers
import { getWorkflowNameByExecutionId } from './workflows.js';

describe('getWorkflowNameByExecutionId', () => {
  it('returns the workflow name for a known execution ID', async () => {
    const { db } = createTestDb();
    // Insert a workflow and execution row using raw SQL (same pattern as other db tests)
    db.run(
      `INSERT INTO workflows (id, user_id, name, slug, version, data, created_at, updated_at)
       VALUES ('wf-1', 'user-1', 'Weekly Report', 'weekly-report', 1, '{}', datetime('now'), datetime('now'))`
    );
    db.run(
      `INSERT INTO workflow_executions (id, workflow_id, user_id, status, trigger_type, started_at)
       VALUES ('exec-1', 'wf-1', 'user-1', 'running', 'schedule', datetime('now'))`
    );
    const appDb = getAppDb(db); // use whatever pattern matches existing db tests
    const name = await getWorkflowNameByExecutionId(appDb, 'exec-1');
    expect(name).toBe('Weekly Report');
  });

  it('returns null for an unknown execution ID', async () => {
    const { db } = createTestDb();
    const appDb = getAppDb(db);
    const name = await getWorkflowNameByExecutionId(appDb, 'does-not-exist');
    expect(name).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/worker && pnpm vitest run --reporter=verbose 2>&1 | grep -A5 "getWorkflowNameByExecutionId"
```

Expected: FAIL — `getWorkflowNameByExecutionId` is not exported.

- [ ] **Step 3: Implement the function**

Add to `packages/worker/src/lib/db/workflows.ts`:

```typescript
export async function getWorkflowNameByExecutionId(
  db: AppDb,
  executionId: string,
): Promise<string | null> {
  const row = await db
    .select({ name: workflows.name })
    .from(workflowExecutions)
    .innerJoin(workflows, eq(workflowExecutions.workflowId, workflows.id))
    .where(eq(workflowExecutions.id, executionId))
    .get();
  return row?.name ?? null;
}
```

Check the existing imports in `workflows.ts` — `workflowExecutions` is likely already imported (it's used in `getWorkflowExecutions`). Add it if not.

- [ ] **Step 4: Run test to verify it passes**

```bash
cd packages/worker && pnpm vitest run --reporter=verbose 2>&1 | grep -A5 "getWorkflowNameByExecutionId"
```

Expected: PASS

- [ ] **Step 5: Typecheck**

```bash
cd packages/worker && pnpm typecheck 2>&1 | tail -5
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/worker/src/lib/db/workflows.ts packages/worker/src/lib/db/workflows.test.ts
git commit -m "feat(db): add getWorkflowNameByExecutionId helper"
```

---

### Task 2: PromptQueue — `getProcessingWorkflowContext`

**Files:**
- Modify: `packages/worker/src/durable-objects/prompt-queue.ts`

- [ ] **Step 1: Understand the existing helper pattern**

Read `packages/worker/src/durable-objects/prompt-queue.ts` lines 337–400. The helpers follow this exact pattern:

```typescript
getProcessingThreadId(): string | null {
  const rows = this.sql
    .exec("SELECT thread_id FROM prompt_queue WHERE status = 'processing' ORDER BY created_at DESC LIMIT 1")
    .toArray();
  return rows.length > 0 ? (rows[0].thread_id as string | null) : null;
}
```

- [ ] **Step 2: Write the failing test**

In `packages/worker/src/durable-objects/prompt-queue.ts` there may be a co-located test file or tests within `session-agent.test.ts`. Add the following test in whichever test file covers `PromptQueue`:

```typescript
describe('PromptQueue.getProcessingWorkflowContext', () => {
  it('returns null when nothing is processing', () => {
    const sql = createInMemorySql(); // use existing test helper pattern
    const queue = new PromptQueue(sql);
    expect(queue.getProcessingWorkflowContext()).toBeNull();
  });

  it('returns queueType and workflowExecutionId for a workflow_execute row', () => {
    const sql = createInMemorySql();
    const queue = new PromptQueue(sql);
    // Insert a processing workflow_execute row
    sql.exec(
      `INSERT INTO prompt_queue (id, content, queue_type, workflow_execution_id, status, created_at)
       VALUES ('pq-1', '', 'workflow_execute', 'exec-99', 'processing', datetime('now'))`
    );
    const ctx = queue.getProcessingWorkflowContext();
    expect(ctx).toEqual({ queueType: 'workflow_execute', workflowExecutionId: 'exec-99' });
  });

  it('returns queueType=prompt and workflowExecutionId=null for a regular prompt row', () => {
    const sql = createInMemorySql();
    const queue = new PromptQueue(sql);
    sql.exec(
      `INSERT INTO prompt_queue (id, content, queue_type, status, created_at)
       VALUES ('pq-2', 'hello', 'prompt', 'processing', datetime('now'))`
    );
    const ctx = queue.getProcessingWorkflowContext();
    expect(ctx).toEqual({ queueType: 'prompt', workflowExecutionId: null });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
cd packages/worker && pnpm vitest run --reporter=verbose 2>&1 | grep -A5 "getProcessingWorkflowContext"
```

Expected: FAIL — method does not exist.

- [ ] **Step 4: Implement the method**

Add to `PromptQueue` class in `packages/worker/src/durable-objects/prompt-queue.ts`, after the `getProcessingChannelTarget` method:

```typescript
/** Returns queue_type and workflow_execution_id for the currently-processing row.
 *  Returns null if nothing is processing. Used by sendChannelInteractivePrompts
 *  to determine provenance for unattended-run approval DMs. */
getProcessingWorkflowContext(): { queueType: string; workflowExecutionId: string | null } | null {
  const rows = this.sql
    .exec(
      "SELECT queue_type, workflow_execution_id FROM prompt_queue WHERE status = 'processing' ORDER BY created_at DESC LIMIT 1",
    )
    .toArray();
  if (rows.length === 0) return null;
  return {
    queueType: (rows[0].queue_type as string) || 'prompt',
    workflowExecutionId: (rows[0].workflow_execution_id as string | null) ?? null,
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
cd packages/worker && pnpm vitest run --reporter=verbose 2>&1 | grep -A5 "getProcessingWorkflowContext"
```

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/worker/src/durable-objects/prompt-queue.ts
git commit -m "feat(prompt-queue): add getProcessingWorkflowContext helper"
```

---

### Task 3: SDK + SlackTransport — `resolveUserDmTarget` and provenance block

**Files:**
- Modify: `packages/sdk/src/channels/index.ts`
- Modify: `packages/plugin-slack/src/channels/transport.ts`
- Modify: `packages/plugin-slack/src/channels/transport.test.ts`

- [ ] **Step 1: Read the existing `ChannelTransport` interface**

Open `packages/sdk/src/channels/index.ts` and find the `ChannelTransport` interface (around line 137). It has a series of optional methods: `sendMessage`, `editMessage`, `deleteMessage`, `resolveLabel`, `sendTypingIndicator`, `sendInteractivePrompt`, `updateInteractivePrompt`.

- [ ] **Step 2: Write the failing transport test**

In `packages/plugin-slack/src/channels/transport.test.ts`, find the `describe('sendInteractivePrompt', ...)` block (around line 1279) to understand the mock pattern for `slackApiCall`. Then add two new `describe` blocks at the end of the file:

```typescript
describe('resolveUserDmTarget', () => {
  it('returns a DM channel target by calling conversations.open', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      channel: { id: 'D0123ABCDEF' },
    });
    vi.stubGlobal('fetch', fetchMock);

    const transport = new SlackTransport();
    const ctx: ChannelContext = { token: 'xoxb-test', userId: 'user-1' };
    const result = await transport.resolveUserDmTarget('U0ASENUETKP', ctx);

    expect(result).toEqual({ channelType: 'slack', channelId: 'D0123ABCDEF' });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('conversations.open'),
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('returns null when conversations.open fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, error: 'not_authed' }));

    const transport = new SlackTransport();
    const ctx: ChannelContext = { token: 'xoxb-bad', userId: 'user-1' };
    const result = await transport.resolveUserDmTarget('U999', ctx);
    expect(result).toBeNull();
  });
});

describe('sendInteractivePrompt — provenance block', () => {
  it('inserts a provenance context block when provenanceLabel is in context', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, ts: '111.222' });
    vi.stubGlobal('fetch', fetchMock);

    const transport = new SlackTransport();
    const ctx: ChannelContext = { token: 'xoxb-test', userId: 'user-1' };
    const prompt: InteractivePrompt = {
      id: 'inv-1',
      sessionId: 'orchestrator:user-1',
      type: 'approval',
      title: 'Action requires approval',
      body: 'Post weekly report to #general',
      actions: [{ id: 'approve_once', label: 'Approve', style: 'primary' }],
      context: {
        toolId: 'slack:send_message',
        riskLevel: 'medium',
        summary: 'Post weekly report to #general',
        provenanceLabel: 'Joan requested this while running a scheduled task',
      },
    };

    await transport.sendInteractivePrompt(
      { channelType: 'slack', channelId: 'D0123ABCDEF' },
      prompt,
      ctx,
    );

    const callBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    const blocks: Array<{ type: string; elements?: Array<{ text: string }> }> = callBody.blocks;
    const provenanceBlock = blocks.find(
      (b) => b.type === 'context' && b.elements?.some((e) => e.text.includes('scheduled task')),
    );
    expect(provenanceBlock).toBeDefined();
    // Provenance block must come BEFORE the action buttons
    const actionsIdx = blocks.findIndex((b) => b.type === 'actions');
    const provIdx = blocks.indexOf(provenanceBlock!);
    expect(provIdx).toBeLessThan(actionsIdx);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
cd packages/plugin-slack && pnpm vitest run --reporter=verbose 2>&1 | grep -A5 "resolveUserDmTarget\|provenance block"
```

Expected: FAIL — `resolveUserDmTarget` not found on transport, provenance block not present.

- [ ] **Step 4: Add `resolveUserDmTarget` to the SDK interface**

In `packages/sdk/src/channels/index.ts`, add after the `updateInteractivePrompt?` line:

```typescript
/** Resolve a direct-message channel target for the given platform user ID.
 *  Used as a DM fallback when no real channel context is available (unattended runs).
 *  Returns null if DM resolution fails or is unsupported. */
resolveUserDmTarget?(slackUserId: string, ctx: ChannelContext): Promise<ChannelTarget | null>;
```

- [ ] **Step 5: Implement `resolveUserDmTarget` in SlackTransport**

In `packages/plugin-slack/src/channels/transport.ts`, add after the `updateInteractivePrompt` method:

```typescript
async resolveUserDmTarget(
  slackUserId: string,
  ctx: ChannelContext,
): Promise<ChannelTarget | null> {
  const result = await slackApiCall('conversations.open', { users: slackUserId }, ctx.token);
  if (!result.ok || !result.channel?.id) {
    console.error(`[SlackTransport] resolveUserDmTarget failed: ${result.error}`);
    return null;
  }
  return { channelType: 'slack', channelId: result.channel.id as string };
}
```

- [ ] **Step 6: Add provenance block rendering in `sendInteractivePrompt`**

In `packages/plugin-slack/src/channels/transport.ts`, in the `sendInteractivePrompt` method, find where `blocks` is defined (around line 789). After the initial `blocks` array definition and before the `if (prompt.expiresAt)` block, insert:

```typescript
// Provenance context — present on unattended-run DM fallbacks
const provenanceLabel = prompt.context?.provenanceLabel as string | undefined;
if (provenanceLabel) {
  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `_${provenanceLabel}_` }],
  });
}
```

- [ ] **Step 7: Run tests to verify they pass**

```bash
cd packages/plugin-slack && pnpm vitest run --reporter=verbose 2>&1 | grep -A5 "resolveUserDmTarget\|provenance block"
```

Expected: PASS

- [ ] **Step 8: Typecheck both packages**

```bash
cd packages/sdk && pnpm typecheck 2>&1 | tail -5
cd packages/plugin-slack && pnpm typecheck 2>&1 | tail -5
```

Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add packages/sdk/src/channels/index.ts packages/plugin-slack/src/channels/transport.ts packages/plugin-slack/src/channels/transport.test.ts
git commit -m "feat(slack): add resolveUserDmTarget and provenance block to sendInteractivePrompt"
```

---

### Task 4: ChannelRouter — `resolveUserDmTarget`

**Files:**
- Modify: `packages/worker/src/durable-objects/channel-router.ts`
- Modify: `packages/worker/src/durable-objects/channel-router.test.ts`

- [ ] **Step 1: Read the existing test setup**

Open `packages/worker/src/durable-objects/channel-router.test.ts` around line 1–50. Note the mock transport structure and how `channelRegistry` is stubbed.

- [ ] **Step 2: Write the failing test**

In `packages/worker/src/durable-objects/channel-router.test.ts`, add a new `describe('resolveUserDmTarget', ...)` block after the existing `sendInteractivePrompt` describe:

```typescript
describe('resolveUserDmTarget', () => {
  it('delegates to transport.resolveUserDmTarget and returns the target', async () => {
    const dmTarget = { channelType: 'slack', channelId: 'D0ABC' };
    const mockTransport = {
      sendMessage: vi.fn(),
      resolveUserDmTarget: vi.fn().mockResolvedValue(dmTarget),
    };
    // Use whatever pattern the existing tests use to register a mock transport
    // e.g. channelRegistry.register('slack', mockTransport) or similar
    const router = createTestRouter({ transport: mockTransport });

    const result = await router.resolveUserDmTarget('slack', 'user-1', 'U0ABC123');
    expect(result).toEqual(dmTarget);
    expect(mockTransport.resolveUserDmTarget).toHaveBeenCalledWith(
      'U0ABC123',
      expect.objectContaining({ token: expect.any(String), userId: 'user-1' }),
    );
  });

  it('returns null when transport has no resolveUserDmTarget', async () => {
    const mockTransport = { sendMessage: vi.fn() }; // no resolveUserDmTarget
    const router = createTestRouter({ transport: mockTransport });
    const result = await router.resolveUserDmTarget('slack', 'user-1', 'U0ABC');
    expect(result).toBeNull();
  });

  it('returns null when token resolution fails', async () => {
    const mockTransport = {
      sendMessage: vi.fn(),
      resolveUserDmTarget: vi.fn(),
    };
    const router = createTestRouter({ transport: mockTransport, tokenFails: true });
    const result = await router.resolveUserDmTarget('slack', 'user-1', 'U0ABC');
    expect(result).toBeNull();
    expect(mockTransport.resolveUserDmTarget).not.toHaveBeenCalled();
  });
});
```

Adapt `createTestRouter` to match the pattern used in existing tests.

- [ ] **Step 3: Run tests to verify they fail**

```bash
cd packages/worker && pnpm vitest run channel-router --reporter=verbose 2>&1 | grep -A5 "resolveUserDmTarget"
```

Expected: FAIL — `resolveUserDmTarget` not on router.

- [ ] **Step 4: Implement `resolveUserDmTarget` on ChannelRouter**

In `packages/worker/src/durable-objects/channel-router.ts`, add after the `sendInteractivePrompt` method:

```typescript
async resolveUserDmTarget(
  channelType: string,
  userId: string,
  platformUserId: string,
): Promise<ChannelTarget | null> {
  const transport = channelRegistry.getTransport(channelType);
  if (!transport?.resolveUserDmTarget) return null;
  const token = await this.deps.resolveToken(channelType, userId);
  if (!token) return null;
  const ctx: ChannelContext = { token, userId };
  return transport.resolveUserDmTarget(platformUserId, ctx);
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd packages/worker && pnpm vitest run channel-router --reporter=verbose 2>&1 | grep -A5 "resolveUserDmTarget"
```

Expected: PASS

- [ ] **Step 6: Typecheck**

```bash
cd packages/worker && pnpm typecheck 2>&1 | tail -5
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/worker/src/durable-objects/channel-router.ts packages/worker/src/durable-objects/channel-router.test.ts
git commit -m "feat(channel-router): add resolveUserDmTarget for DM fallback"
```

---

### Task 5: SessionAgentDO — fix `'thread'` filter, DM fallback, expiry error

**Files:**
- Modify: `packages/worker/src/durable-objects/session-agent.ts`
- Modify: `packages/worker/src/durable-objects/session-agent.test.ts`

This task has three sub-fixes. Implement and test each in order.

---

#### 5a: Fix `'thread'` filter in `sendChannelInteractivePrompts`

- [ ] **Step 1: Write the failing test**

In `packages/worker/src/durable-objects/session-agent.test.ts`, find the `describe('action approval prompts', ...)` block (line ~1893). Add a new test after the existing tests:

```typescript
describe('sendChannelInteractivePrompts — thread filter', () => {
  it('does not add thread-type channel as a delivery target', async () => {
    const { agent } = await createTestAgent();
    // Mock channelRouter.sendInteractivePrompt to track calls
    const sendInteractiveMock = vi.fn().mockResolvedValue([]);
    (agent as any).channelRouter.sendInteractivePrompt = sendInteractiveMock;
    // Mock listUserChannelBindings to return no external bindings
    vi.spyOn(
      await import('../lib/db/channels.js'),
      'listUserChannelBindings',
    ).mockResolvedValue([]);

    const prompt: InteractivePrompt = {
      id: 'inv-thread',
      sessionId: 'orchestrator:user-1',
      type: 'approval',
      title: 'Action requires approval',
      body: 'Test action',
      actions: [],
      context: { channelType: 'thread', channelId: 'thread-uuid-123' },
    };

    // Enqueue a processing prompt with channel_type='thread'
    (agent as any).promptQueue.sql.exec(
      `INSERT INTO prompt_queue (id, content, queue_type, channel_type, channel_id, status, created_at)
       VALUES ('pq-thread', '', 'prompt', 'thread', 'thread-uuid-123', 'processing', datetime('now'))`
    );

    await (agent as any).sendChannelInteractivePrompts('inv-thread', prompt);

    // sendInteractivePrompt should NOT be called with a 'thread' target
    if (sendInteractiveMock.mock.calls.length > 0) {
      const callTargets = sendInteractiveMock.mock.calls[0][0].targets as Array<{ channelType: string }>;
      expect(callTargets.every((t) => t.channelType !== 'thread')).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run test to verify behavior before fix**

```bash
cd packages/worker && pnpm vitest run session-agent --reporter=verbose 2>&1 | grep -A10 "thread filter"
```

Note whether the test passes or reveals the bug.

- [ ] **Step 3: Apply the fix**

In `packages/worker/src/durable-objects/session-agent.ts`, in `sendChannelInteractivePrompts`, update the two target filter guards:

Find (~line 7061):
```typescript
if (originTarget && originTarget.channelType !== 'web') {
```
Replace with:
```typescript
if (originTarget && originTarget.channelType !== 'web' && originTarget.channelType !== 'thread') {
```

Find (~line 7071):
```typescript
if (callerCh?.channelType && callerCh?.channelId && callerCh.channelType !== 'web') {
```
Replace with:
```typescript
if (callerCh?.channelType && callerCh?.channelId
    && callerCh.channelType !== 'web'
    && callerCh.channelType !== 'thread') {
```

- [ ] **Step 4: Run test to verify fix passes**

```bash
cd packages/worker && pnpm vitest run session-agent --reporter=verbose 2>&1 | grep -A5 "thread filter"
```

Expected: PASS

---

#### 5b: Add DM fallback in `sendChannelInteractivePrompts`

- [ ] **Step 5: Write the failing test for DM fallback**

In `packages/worker/src/durable-objects/session-agent.test.ts`, add inside the `describe('sendChannelInteractivePrompts — thread filter', ...)` block:

```typescript
it('sends a DM with provenance label when orchestrator session has Slack identity link and no real targets', async () => {
  const { agent } = await createTestAgent();
  (agent as any).sessionState.sessionId = 'orchestrator:user-1';
  (agent as any).sessionState.userId = 'user-1';

  // Mock getUserSlackIdentityLink to return a Slack identity
  vi.spyOn(
    await import('../lib/db/channels.js'),
    'getUserSlackIdentityLink',
  ).mockResolvedValue({ id: 'link-1', userId: 'user-1', provider: 'slack', externalId: 'U0SLACK99', externalName: 'Julie' });

  // Mock listUserChannelBindings to return a Slack binding (has external bindings)
  vi.spyOn(
    await import('../lib/db/channels.js'),
    'listUserChannelBindings',
  ).mockResolvedValue([{ channelType: 'slack', channelId: 'C123', userId: 'user-1' } as any]);

  // Mock channelRouter.resolveUserDmTarget to return a DM target
  const resolveUserDmTargetMock = vi.fn().mockResolvedValue({ channelType: 'slack', channelId: 'D0DM1234' });
  (agent as any).channelRouter.resolveUserDmTarget = resolveUserDmTargetMock;

  const sendInteractiveMock = vi.fn().mockResolvedValue([{ channelType: 'slack', ref: { messageId: 't1', channelId: 'D0DM1234' } }]);
  (agent as any).channelRouter.sendInteractivePrompt = sendInteractiveMock;

  const prompt: InteractivePrompt = {
    id: 'inv-dm',
    sessionId: 'orchestrator:user-1',
    type: 'approval',
    title: 'Action requires approval',
    body: 'Post weekly report',
    actions: [{ id: 'approve_once', label: 'Approve', style: 'primary' }],
    context: { toolId: 'slack:send_message', riskLevel: 'medium', summary: 'Post weekly report' },
  };

  await (agent as any).sendChannelInteractivePrompts('inv-dm', prompt);

  // resolveUserDmTarget should have been called with the Slack user ID
  expect(resolveUserDmTargetMock).toHaveBeenCalledWith('slack', 'user-1', 'U0SLACK99');

  // sendInteractivePrompt should have been called with a DM target
  expect(sendInteractiveMock).toHaveBeenCalledOnce();
  const callOpts = sendInteractiveMock.mock.calls[0][0] as { targets: Array<{ channelType: string; channelId: string }>; prompt: InteractivePrompt };
  expect(callOpts.targets).toContainEqual({ channelType: 'slack', channelId: 'D0DM1234' });

  // The prompt passed to sendInteractivePrompt must include a provenanceLabel in context
  expect(callOpts.prompt.context?.provenanceLabel).toBeTruthy();
  expect(typeof callOpts.prompt.context?.provenanceLabel).toBe('string');
});

it('sends a DM with workflow name in provenance label when queue_type is workflow_execute', async () => {
  const { agent } = await createTestAgent();
  (agent as any).sessionState.sessionId = 'orchestrator:user-1';
  (agent as any).sessionState.userId = 'user-1';

  vi.spyOn(
    await import('../lib/db/channels.js'),
    'getUserSlackIdentityLink',
  ).mockResolvedValue({ id: 'link-1', userId: 'user-1', provider: 'slack', externalId: 'U0SLACK99', externalName: 'Julie' });

  vi.spyOn(
    await import('../lib/db/channels.js'),
    'listUserChannelBindings',
  ).mockResolvedValue([{ channelType: 'slack', channelId: 'C123', userId: 'user-1' } as any]);

  vi.spyOn(
    await import('../lib/db/workflows.js'),
    'getWorkflowNameByExecutionId',
  ).mockResolvedValue('Weekly Report');

  const resolveUserDmTargetMock = vi.fn().mockResolvedValue({ channelType: 'slack', channelId: 'D0DM1234' });
  (agent as any).channelRouter.resolveUserDmTarget = resolveUserDmTargetMock;
  const sendInteractiveMock = vi.fn().mockResolvedValue([]);
  (agent as any).channelRouter.sendInteractivePrompt = sendInteractiveMock;

  // Enqueue a processing workflow_execute row
  (agent as any).promptQueue.sql.exec(
    `INSERT INTO prompt_queue (id, content, queue_type, workflow_execution_id, status, created_at)
     VALUES ('pq-wf', '', 'workflow_execute', 'exec-wf-1', 'processing', datetime('now'))`
  );

  const prompt: InteractivePrompt = {
    id: 'inv-wf',
    sessionId: 'orchestrator:user-1',
    type: 'approval',
    title: 'Action requires approval',
    body: 'Send workflow report',
    actions: [{ id: 'approve_once', label: 'Approve', style: 'primary' }],
    context: { toolId: 'slack:send_message', riskLevel: 'medium', summary: 'Send workflow report' },
  };

  await (agent as any).sendChannelInteractivePrompts('inv-wf', prompt);

  const callOpts = sendInteractiveMock.mock.calls[0][0] as { prompt: InteractivePrompt };
  expect(callOpts.prompt.context?.provenanceLabel).toContain('Weekly Report');
});
```

- [ ] **Step 6: Run tests to verify they fail**

```bash
cd packages/worker && pnpm vitest run session-agent --reporter=verbose 2>&1 | grep -A5 "DM with provenance\|workflow name in provenance"
```

Expected: FAIL — DM fallback not yet implemented.

- [ ] **Step 7: Import the required helpers at the top of `session-agent.ts`**

Near the other DB imports at the top of `packages/worker/src/durable-objects/session-agent.ts`, add:

```typescript
import { getUserSlackIdentityLink } from '../lib/db/channels.js';
import { getWorkflowNameByExecutionId } from '../lib/db/workflows.js';
```

Check whether these are already imported — don't duplicate.

- [ ] **Step 8: Implement the DM fallback in `sendChannelInteractivePrompts`**

In `sendChannelInteractivePrompts` in `packages/worker/src/durable-objects/session-agent.ts`, find the `if (targets.length === 0)` block (~line 7085). Replace it entirely with:

```typescript
if (targets.length === 0) {
  // Attempt Slack DM fallback for unattended runs (scheduled tasks, workflow executions).
  // Only fires when the user has a Slack identity link — otherwise fall through to the
  // existing web-UI-only error path.
  const slackLink = await getUserSlackIdentityLink(this.appDb, userId).catch(() => null);
  if (slackLink?.externalId) {
    const dmTarget = await this.channelRouter
      .resolveUserDmTarget('slack', userId, slackLink.externalId)
      .catch(() => null);
    if (dmTarget) {
      const provenanceLabel = await this.buildApprovalProvenanceLabel(userId);
      const dmPrompt: InteractivePrompt = {
        ...prompt,
        context: { ...(prompt.context ?? {}), provenanceLabel },
      };
      const refs = await this.channelRouter.sendInteractivePrompt({ userId, targets: [dmTarget], prompt: dmPrompt });
      if (refs.length > 0) {
        this.ctx.storage.sql.exec(
          'UPDATE interactive_prompts SET channel_refs = ? WHERE id = ?',
          JSON.stringify(refs),
          promptId,
        );
      }
      return;
    }
  }

  // No Slack identity or DM resolution failed — fall back to web UI error
  const hasExternalBindings = (await listUserChannelBindings(this.appDb, userId))
    .some((b) => b.channelType !== 'web');
  if (hasExternalBindings) {
    console.error(
      `[SessionAgentDO] sendChannelInteractivePrompts: No origin or caller channel for prompt ${promptId} — refusing to broadcast. ` +
      `Session has external channel bindings but no channel context was propagated. ` +
      `Approval is visible in web UI only. sessionId=${sessionId} userId=${userId}`,
    );
    this.broadcastToClients({
      type: 'error',
      error: 'Approval could not be delivered to Slack: no origin channel context. Please approve via the web dashboard.',
      promptId,
    });
  }
  return;
}
```

- [ ] **Step 9: Add `buildApprovalProvenanceLabel` private method**

Add to `SessionAgentDO` class in `packages/worker/src/durable-objects/session-agent.ts`:

```typescript
/** Build a human-readable provenance label for unattended-run approval DMs.
 *  Identifies whether the approval came from a workflow execution or a scheduled prompt. */
private async buildApprovalProvenanceLabel(userId: string): Promise<string> {
  const sessionId = this.sessionState.sessionId ?? '';
  const wfCtx = this.promptQueue.getProcessingWorkflowContext();

  if (wfCtx?.queueType === 'workflow_execute' && wfCtx.workflowExecutionId) {
    const workflowName = await getWorkflowNameByExecutionId(this.appDb, wfCtx.workflowExecutionId)
      .catch(() => null);
    if (workflowName) {
      const agentName = await this.resolveAgentDisplayName(userId);
      return `${agentName} requested this while running workflow *${workflowName}*`;
    }
  }

  const agentName = await this.resolveAgentDisplayName(userId);
  return `${agentName} requested this while running a scheduled task (no active session was connected)`;
}

/** Returns the orchestrator persona display name, or a generic fallback. */
private async resolveAgentDisplayName(userId: string): Promise<string> {
  try {
    const identity = await getOrchestratorIdentity(this.appDb, userId);
    return identity?.name ?? 'Your Valet assistant';
  } catch {
    return 'Your Valet assistant';
  }
}
```

Verify that `getOrchestratorIdentity` is already imported in `session-agent.ts` (search for `getOrchestratorIdentity`). If not, add it to the imports from `'../lib/db/orchestrator.js'`.

- [ ] **Step 10: Run tests to verify they pass**

```bash
cd packages/worker && pnpm vitest run session-agent --reporter=verbose 2>&1 | grep -A5 "DM with provenance\|workflow name in provenance"
```

Expected: PASS

---

#### 5c: Fix `expireInteractivePromptRow` error message

- [ ] **Step 11: Write the failing test**

In `packages/worker/src/durable-objects/session-agent.test.ts`, find the `describe('action approval prompts', ...)` block. Add:

```typescript
describe('expireInteractivePromptRow — error message', () => {
  it('sends an actionable error message to runner that includes unattended context', async () => {
    const { agent } = await createTestAgent();
    (agent as any).sessionState.sessionId = 'orchestrator:user-1';

    const runnerSendMock = vi.fn().mockReturnValue(true);
    (agent as any).runnerLink.send = runnerSendMock;

    const row = {
      id: 'inv-expire',
      type: 'approval',
      request_id: 'req-expire',
      context: JSON.stringify({ toolId: 'slack:send_message', invocationId: 'inv-expire' }),
      channel_refs: null,
    };

    await (agent as any).expireInteractivePromptRow(row);

    const call = runnerSendMock.mock.calls.find(
      (c: Array<{ type: string; error?: string }>) => c[0].type === 'call-tool-result',
    );
    expect(call).toBeDefined();
    const error: string = call![0].error;
    expect(error).toContain('expired without a response');
    expect(error).toContain('Do not retry');
  });
});
```

- [ ] **Step 12: Run test to verify it fails**

```bash
cd packages/worker && pnpm vitest run session-agent --reporter=verbose 2>&1 | grep -A5 "expireInteractivePromptRow — error message"
```

Expected: FAIL — current error is just `"Action \"...\" approval expired"`.

- [ ] **Step 13: Replace the expiry error message**

In `packages/worker/src/durable-objects/session-agent.ts`, in `expireInteractivePromptRow` (~line 6650), find:

```typescript
this.runnerLink.send({ type: 'call-tool-result', requestId, error: `Action "${toolId}" approval expired` } as any);
```

Replace with:

```typescript
const isOrchestrator = (this.sessionState.sessionId ?? '').startsWith('orchestrator:');
const wfCtx = this.promptQueue.getProcessingWorkflowContext();
const isUnattended = isOrchestrator || wfCtx?.queueType === 'workflow_execute';
const expiryError = isUnattended
  ? `Action "${toolId}" approval request expired without a response. ` +
    `This likely means the session was running unattended (scheduled task or automation) and no one saw the approval prompt. ` +
    `Do not retry this action automatically — instead, let the user know that approval is needed and ask them to re-run or approve it manually.`
  : `Action "${toolId}" approval request expired without a response.`;
this.runnerLink.send({ type: 'call-tool-result', requestId, error: expiryError } as any);
```

- [ ] **Step 14: Run all approval tests**

```bash
cd packages/worker && pnpm vitest run session-agent --reporter=verbose 2>&1 | grep -E "PASS|FAIL|approval"
```

Expected: all approval tests pass.

- [ ] **Step 15: Run full test suite and typecheck**

```bash
cd packages/worker && pnpm typecheck 2>&1 | tail -10
pnpm test 2>&1 | tail -20
```

Expected: no type errors, all tests pass.

- [ ] **Step 16: Run frontend build check**

```bash
cd packages/client && pnpm build 2>&1 | tail -10
```

Expected: build succeeds (no client changes but verify nothing broke).

- [ ] **Step 17: Commit**

```bash
git add packages/worker/src/durable-objects/session-agent.ts packages/worker/src/durable-objects/session-agent.test.ts
git commit -m "fix(session-agent): approval DM fallback for unattended runs + better expiry errors (TKAI-154)"
```

---

### Task 6: PR

- [ ] **Step 1: Verify all tests pass**

```bash
pnpm test 2>&1 | tail -20
```

Expected: green.

- [ ] **Step 2: Typecheck all packages**

```bash
pnpm typecheck 2>&1 | tail -10
```

Expected: no errors.

- [ ] **Step 3: Push branch and open PR**

```bash
git push -u origin HEAD
```

Then open a PR targeting `main`. Title: `fix: approval DM fallback for unattended automations (TKAI-154)`.

PR body should describe:
- Root cause: `'thread'` channelType bypass in `sendChannelInteractivePrompts` causing silent drop of approval delivery for scheduled/orchestrator runs
- Fix 1: filter fix for `'thread'` type
- Fix 2: Slack DM fallback with provenance context (workflow name or "scheduled task")
- Fix 3: actionable expiry error breaking the silent retry loop
- Testing: unit tests for each component
