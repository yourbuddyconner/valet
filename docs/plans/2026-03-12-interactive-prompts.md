# Unified Interactive Prompts Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace separate `questions` and `pending_action_approvals` systems with a single `interactive_prompts` system — one table, one resolution path, one channel transport interface.

**Architecture:** Rename the approval-specific SDK types/methods to generic interactive prompt types. Merge the two DO local SQLite tables into `interactive_prompts`. Collapse separate handlers into a single `handlePromptResolved`. Update the Slack transport, interactive route, action-invocations route, and frontend to use the unified interface.

**Tech Stack:** TypeScript, Cloudflare Workers Durable Objects (local SQLite), Slack Block Kit, React (TanStack Query + Zustand)

**Spec:** `docs/specs/2026-03-12-interactive-prompts-design.md`

---

## Chunk 1: SDK Interface Refactor

### Task 1: Replace Approval Types with Interactive Prompt Types

**Files:**
- Modify: `packages/sdk/src/channels/index.ts`

- [ ] **Step 1: Replace the approval types**

In `packages/sdk/src/channels/index.ts`, find the `// ─── Approval Types` section (around line 66) and replace all three interfaces (`ApprovalRequest`, `ApprovalMessageRef`, `ApprovalResolution`) with:

```typescript
// ─── Interactive Prompt Types ───────────────────────────────────────────────

export interface InteractivePrompt {
  id: string;
  sessionId: string;
  type: string;
  title: string;
  body?: string;
  actions: InteractiveAction[];
  expiresAt?: number;
  context?: Record<string, unknown>;
}

export interface InteractiveAction {
  id: string;
  label: string;
  style?: 'primary' | 'danger';
}

export interface InteractivePromptRef {
  messageId: string;
  channelId: string;
  [key: string]: unknown;
}

export interface InteractiveResolution {
  actionId?: string;
  value?: string;
  resolvedBy: string;
}
```

- [ ] **Step 2: Replace the ChannelTransport methods**

In the `ChannelTransport` interface, replace `sendApprovalRequest` and `updateApprovalStatus` with:

```typescript
  /** Send an interactive prompt to a channel (e.g. Slack Block Kit buttons, or plain text for free-text questions). */
  sendInteractivePrompt?(target: ChannelTarget, prompt: InteractivePrompt, ctx: ChannelContext): Promise<InteractivePromptRef | null>;

  /** Update a previously sent interactive prompt with resolution status. */
  updateInteractivePrompt?(target: ChannelTarget, ref: InteractivePromptRef, resolution: InteractiveResolution, ctx: ChannelContext): Promise<void>;
```

- [ ] **Step 3: Build SDK and typecheck**

Run: `cd packages/sdk && pnpm build && pnpm typecheck`
Expected: PASS (downstream packages will fail until updated — that's fine)

- [ ] **Step 4: Commit**

```bash
git add packages/sdk/src/channels/index.ts
git commit -m "feat(sdk): replace approval types with unified interactive prompt interface"
```

---

## Chunk 2: Slack Transport Refactor

### Task 2: Rename Slack Transport Methods

**Files:**
- Modify: `packages/plugin-slack/src/channels/transport.ts`

- [ ] **Step 1: Update imports**

Replace `ApprovalRequest, ApprovalMessageRef, ApprovalResolution` in the import block with `InteractivePrompt, InteractivePromptRef, InteractiveResolution, InteractiveAction`.

- [ ] **Step 2: Replace `sendApprovalRequest` with `sendInteractivePrompt`**

Replace the entire `sendApprovalRequest` method with:

```typescript
  async sendInteractivePrompt(
    target: ChannelTarget,
    prompt: InteractivePrompt,
    ctx: ChannelContext,
  ): Promise<InteractivePromptRef | null> {
    // If no actions, send plain text prompt for thread-reply input
    if (!prompt.actions || prompt.actions.length === 0) {
      const text = `*${prompt.title}*${prompt.body ? '\n' + prompt.body : ''}\n_Reply to this thread with your answer._`;
      const body: Record<string, unknown> = {
        channel: target.channelId,
        text: this.formatMarkdown(text),
        unfurl_links: false,
      };
      if (target.threadId) body.thread_ts = target.threadId;

      const result = await slackApiCall('chat.postMessage', body, ctx.token);
      if (!result.ok) {
        console.error(`[SlackTransport] sendInteractivePrompt (text) error: ${result.error}`);
        return null;
      }
      return { messageId: result.ts!, channelId: target.channelId };
    }

    // Build Block Kit message with buttons
    const blocks: Record<string, unknown>[] = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${prompt.title}*${prompt.body ? '\n' + prompt.body : ''}`,
        },
      },
    ];

    if (prompt.expiresAt) {
      const expiryUnix = Math.floor(prompt.expiresAt / 1000);
      blocks.push({
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `Expires <!date^${expiryUnix}^{date_short_pretty} at {time}|soon>`,
          },
        ],
      });
    }

    blocks.push({
      type: 'actions',
      elements: prompt.actions.map((action) => ({
        type: 'button',
        text: { type: 'plain_text' as const, text: action.label },
        ...(action.style ? { style: action.style } : {}),
        action_id: action.id,
        value: prompt.id,
      })),
    });

    const body: Record<string, unknown> = {
      channel: target.channelId,
      text: prompt.title,
      blocks,
      unfurl_links: false,
    };
    if (target.threadId) body.thread_ts = target.threadId;

    const result = await slackApiCall('chat.postMessage', body, ctx.token);
    if (!result.ok) {
      console.error(`[SlackTransport] sendInteractivePrompt error: ${result.error}`);
      return null;
    }
    return { messageId: result.ts!, channelId: target.channelId };
  }
```

- [ ] **Step 3: Replace `updateApprovalStatus` with `updateInteractivePrompt`**

Replace the entire `updateApprovalStatus` method with:

```typescript
  async updateInteractivePrompt(
    _target: ChannelTarget,
    ref: InteractivePromptRef,
    resolution: InteractiveResolution,
    ctx: ChannelContext,
  ): Promise<void> {
    let statusText: string;
    if (resolution.actionId) {
      statusText = `Resolved: *${resolution.actionId}* by ${resolution.resolvedBy}`;
    } else if (resolution.value) {
      const preview = resolution.value.length > 100
        ? resolution.value.slice(0, 97) + '...'
        : resolution.value;
      statusText = `Answered by ${resolution.resolvedBy}: ${preview}`;
    } else {
      statusText = `Resolved by ${resolution.resolvedBy}`;
    }

    const blocks = [
      { type: 'section', text: { type: 'mrkdwn', text: statusText } },
    ];

    const result = await slackApiCall('chat.update', {
      channel: ref.channelId,
      ts: ref.messageId,
      text: statusText,
      blocks,
    }, ctx.token);

    if (!result.ok) {
      console.error(`[SlackTransport] updateInteractivePrompt error: ${result.error}`);
    }
  }
```

- [ ] **Step 4: Typecheck**

Run: `cd packages/plugin-slack && pnpm typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/plugin-slack/src/channels/transport.ts
git commit -m "feat(slack): replace approval methods with generic interactive prompt methods"
```

---

## Chunk 3: SessionAgentDO — Table and Resolution

This is the largest task. It modifies `packages/worker/src/durable-objects/session-agent.ts`.

### Task 3: Replace Tables and Add Unified Resolution Handler

**Files:**
- Modify: `packages/worker/src/durable-objects/session-agent.ts`

- [ ] **Step 1: Replace table definitions**

Find the `CREATE TABLE IF NOT EXISTS questions` block (line ~484) and `CREATE TABLE IF NOT EXISTS pending_action_approvals` block (line ~550). Delete both and replace with a single table in the same location as the `questions` table was:

```sql
  CREATE TABLE IF NOT EXISTS interactive_prompts (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    request_id TEXT,
    title TEXT NOT NULL,
    body TEXT,
    actions TEXT,
    context TEXT,
    channel_refs TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    expires_at INTEGER
  );
```

- [ ] **Step 2: Update imports**

Replace the approval-specific type imports from `@valet/sdk`:

Change `ApprovalRequest, ApprovalMessageRef, ApprovalResolution` to `InteractivePrompt, InteractiveAction, InteractivePromptRef, InteractiveResolution`.

- [ ] **Step 3: Update the client broadcast type union**

Find the `ClientOutbound` interface's `type` field (line ~373). In the union, replace:
- `'action_approval_required' | 'action_approved' | 'action_denied' | 'action_expired'`

with:
- `'interactive_prompt' | 'interactive_prompt_resolved' | 'interactive_prompt_expired'`

Also remove `'question'` from the union since it's now handled by `'interactive_prompt'`.

- [ ] **Step 4: Replace the question handler in Runner message processing**

Find `case 'question':` (line ~2347). Replace the entire case with:

```typescript
      case 'question': {
        const qId = msg.questionId || crypto.randomUUID();
        const questionCh = this.activeChannel;
        const QUESTION_TIMEOUT_SECS = 5 * 60;
        const expiresAt = Math.floor(Date.now() / 1000) + QUESTION_TIMEOUT_SECS;

        const actions: Array<{ id: string; label: string }> = msg.options
          ? msg.options.map((opt: string, i: number) => ({ id: `option_${i}`, label: opt }))
          : [];

        this.ctx.storage.sql.exec(
          "INSERT INTO interactive_prompts (id, type, request_id, title, actions, context, status, expires_at) VALUES (?, 'question', ?, ?, ?, ?, 'pending', ?)",
          qId,
          null,  // questions don't have a runner request_id — answer is sent via 'answer' message type
          msg.text || '',
          JSON.stringify(actions),
          msg.options ? JSON.stringify({ options: msg.options }) : null,
          expiresAt,
        );

        this.broadcastToClients({
          type: 'interactive_prompt',
          prompt: {
            id: qId,
            sessionId: this.getStateValue('sessionId') || '',
            type: 'question',
            title: msg.text || '',
            actions,
            expiresAt: expiresAt * 1000,
            context: msg.options ? { options: msg.options } : undefined,
          },
          ...(questionCh ? { channelType: questionCh.channelType, channelId: questionCh.channelId } : {}),
        });

        this.ctx.storage.setAlarm(Date.now() + QUESTION_TIMEOUT_SECS * 1000);

        this.notifyEventBus({
          type: 'question.asked',
          sessionId: this.getStateValue('sessionId'),
          data: { questionId: qId, text: msg.text || '' },
          timestamp: new Date().toISOString(),
        });

        // Send channel interactive prompts
        const prompt: InteractivePrompt = {
          id: qId,
          sessionId: this.getStateValue('sessionId') || '',
          type: 'question',
          title: msg.text || '',
          actions,
          expiresAt: expiresAt * 1000,
          context: msg.options ? { options: msg.options } : undefined,
        };
        this.ctx.waitUntil(this.sendChannelInteractivePrompts(qId, prompt));

        const ownerUserId = this.getStateValue('userId') || undefined;
        const questionSummary = msg.text?.trim()
          ? `Agent question: ${msg.text.trim()}`
          : 'Agent requested a decision.';
        if (ownerUserId && this.isUserConnected(ownerUserId)) {
          this.sendToastToUser(ownerUserId, {
            title: 'Agent question',
            description: questionSummary.slice(0, 240),
            variant: 'warning',
          });
        } else {
          await this.enqueueOwnerNotification({
            messageType: 'question',
            content: questionSummary,
            contextSessionId: this.getStateValue('sessionId') || undefined,
          });
        }
        break;
      }
```

- [ ] **Step 5: Replace the approval block in `handleCallTool`**

Find the `// ─── Require Approval` block (line ~8732). Replace the section that creates `pending_action_approvals` rows, broadcasts, and sends channel approvals. The new code inserts into `interactive_prompts` instead:

```typescript
      if (invocationResult.outcome === 'pending_approval') {
        const expiresAt = Math.floor(Date.now() / 1000) + Math.floor(ACTION_APPROVAL_EXPIRY_MS / 1000);

        const actions: InteractiveAction[] = [
          { id: 'approve', label: 'Approve', style: 'primary' },
          { id: 'deny', label: 'Deny', style: 'danger' },
        ];

        const promptContext = {
          toolId, service, actionId, params, riskLevel,
          isOrgScoped: isOrgScoped ? 1 : 0,
          invocationId: invocationResult.invocationId,
        };

        this.ctx.storage.sql.exec(
          `INSERT OR REPLACE INTO interactive_prompts
            (id, type, request_id, title, body, actions, context, status, expires_at)
           VALUES (?, 'approval', ?, ?, ?, ?, ?, 'pending', ?)`,
          invocationResult.invocationId,
          requestId,
          'Action requires approval',
          `\`${toolId}\` (risk: **${riskLevel}**)`,
          JSON.stringify(actions),
          JSON.stringify(promptContext),
          expiresAt,
        );

        this.sendToRunner({
          type: 'call-tool-pending',
          requestId,
          invocationId: invocationResult.invocationId,
          message: `Action "${toolId}" requires approval (risk level: ${riskLevel}). Waiting for human review.`,
        } as any);

        const prompt: InteractivePrompt = {
          id: invocationResult.invocationId,
          sessionId: sessionId || '',
          type: 'approval',
          title: 'Action requires approval',
          body: `\`${toolId}\` (risk: **${riskLevel}**)`,
          actions,
          expiresAt: expiresAt * 1000,
          context: promptContext,
        };

        this.broadcastToClients({
          type: 'interactive_prompt',
          prompt,
        });

        this.notifyEventBus({
          type: 'action.approval_required',
          sessionId,
          userId,
          data: {
            invocationId: invocationResult.invocationId,
            toolId, service, actionId, riskLevel,
          },
          timestamp: new Date().toISOString(),
        });

        this.appendAuditLog('agent.tool_call', `Action ${toolId} requires approval (${riskLevel})`, undefined, { invocationId: invocationResult.invocationId, riskLevel });

        this.ctx.waitUntil(this.sendChannelInteractivePrompts(invocationResult.invocationId, prompt));

        await this.ensureActionExpiryAlarm(expiresAt * 1000);
        return;
      }
```

- [ ] **Step 6: Replace `handleAnswer`**

Find `private async handleAnswer` (line ~1949). Replace with a call through the unified handler:

```typescript
  private async handleAnswer(questionId: string, answer: string | boolean) {
    // Route through unified resolution handler
    await this.handlePromptResolved(questionId, {
      value: String(answer),
      resolvedBy: this.getStateValue('userId') || 'user',
    });
  }
```

- [ ] **Step 7: Add the unified `handlePromptResolved` method**

Add this new method, replacing `handleActionApproved` and `handleActionDenied`:

```typescript
  private async handlePromptResolved(promptId: string, resolution: InteractiveResolution) {
    const rows = this.ctx.storage.sql
      .exec('SELECT * FROM interactive_prompts WHERE id = ? AND status = ?', promptId, 'pending')
      .toArray();

    if (rows.length === 0) {
      console.warn(`[SessionAgentDO] handlePromptResolved: no pending prompt found for ${promptId}`);
      return;
    }

    const row = rows[0];
    const type = row.type as string;
    const requestId = row.request_id as string | null;
    const channelRefsJson = (row.channel_refs as string) || null;
    const contextJson = row.context as string | null;
    const context = contextJson ? JSON.parse(contextJson) : {};

    // Delete from local SQLite
    this.ctx.storage.sql.exec("DELETE FROM interactive_prompts WHERE id = ?", promptId);

    const userId = this.getStateValue('userId');
    const sessionId = this.getStateValue('sessionId');

    switch (type) {
      case 'approval': {
        const { toolId, service, actionId, params, isOrgScoped, invocationId } = context;

        if (resolution.actionId === 'approve') {
          await approveInvocation(this.appDb, invocationId, userId || 'system');
          const actionSource = integrationRegistry.getActions(service);
          await this.executeAction(requestId!, toolId, service, actionId, params || {}, !!isOrgScoped, userId!, actionSource, invocationId);

          this.broadcastToClients({
            type: 'interactive_prompt_resolved',
            promptId,
            promptType: 'approval',
            resolution: { ...resolution, actionId: 'approve' },
          });

          this.notifyEventBus({
            type: 'action.approved',
            sessionId, userId,
            data: { invocationId, toolId, service, actionId },
            timestamp: new Date().toISOString(),
          });

          this.appendAuditLog('agent.tool_call', `Action ${toolId} approved and executed`, undefined, { invocationId });
        } else {
          // deny
          const reason = resolution.value;
          await denyInvocation(this.appDb, invocationId, userId || 'system', reason);

          const errorMsg = reason
            ? `Action "${toolId}" was denied: ${reason}`
            : `Action "${toolId}" was denied by a reviewer`;
          this.sendToRunner({ type: 'call-tool-result', requestId: requestId!, error: errorMsg } as any);

          this.broadcastToClients({
            type: 'interactive_prompt_resolved',
            promptId,
            promptType: 'approval',
            resolution: { ...resolution, actionId: 'deny' },
          });

          this.notifyEventBus({
            type: 'action.denied',
            sessionId, userId,
            data: { invocationId, toolId, service, actionId, reason },
            timestamp: new Date().toISOString(),
          });

          this.appendAuditLog('agent.tool_call', `Action ${toolId} denied${reason ? `: ${reason}` : ''}`, undefined, { invocationId });
        }
        break;
      }

      case 'question': {
        const answer = resolution.actionId || resolution.value || '';

        // Forward to runner
        this.sendToRunner({
          type: 'answer',
          questionId: promptId,
          answer,
        });

        this.broadcastToClients({
          type: 'interactive_prompt_resolved',
          promptId,
          promptType: 'question',
          resolution,
        });

        this.notifyEventBus({
          type: 'question.answered',
          sessionId: this.getStateValue('sessionId'),
          data: { questionId: promptId, answer },
          timestamp: new Date().toISOString(),
        });

        this.appendAuditLog('user.answer', `Answered question: ${answer.slice(0, 80)}`, undefined, { questionId: promptId });
        break;
      }
    }

    // Resolve display name for channel updates
    let displayResolution = { ...resolution };
    if (userId) {
      try {
        const user = await getUserById(this.appDb, resolution.resolvedBy || userId);
        if (user?.name) displayResolution = { ...displayResolution, resolvedBy: user.name };
        else if (user?.email) displayResolution = { ...displayResolution, resolvedBy: user.email };
      } catch { /* best-effort */ }
    }

    // Update channel messages
    this.ctx.waitUntil(this.updateChannelInteractivePrompts(channelRefsJson, displayResolution));
  }
```

- [ ] **Step 8: Delete old handlers**

Delete these methods entirely:
- `handleActionApproved` (line ~8916)
- `handleActionDenied` (line ~8976)

They are fully replaced by `handlePromptResolved`.

- [ ] **Step 9: Rename channel helper methods**

Rename throughout the file:
- `sendChannelApprovalRequests` → `sendChannelInteractivePrompts`
- `updateChannelApprovalStatus` → `updateChannelInteractivePrompts`

Update the method signatures to use the new types:
- `sendChannelInteractivePrompts(promptId: string, prompt: InteractivePrompt)`
- `updateChannelInteractivePrompts(channelRefsJson: string | null, resolution: InteractiveResolution)`

Inside `sendChannelInteractivePrompts`, change `transport.sendApprovalRequest` to `transport.sendInteractivePrompt` and update the arguments accordingly.

Inside `updateChannelInteractivePrompts`, change `transport.updateApprovalStatus` to `transport.updateInteractivePrompt` and update arguments. Remove the `'resolvedBy' in resolution` display name lookup (it's now done in `handlePromptResolved` before calling this).

- [ ] **Step 10: Replace DO routes**

Find the `/action-approved` and `/action-denied` route cases (line ~874). Replace both with a single `/prompt-resolved` route:

```typescript
      case '/prompt-resolved': {
        if (request.method !== 'POST') {
          return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
        }
        const body = await request.json() as { promptId: string; actionId?: string; value?: string; resolvedBy?: string };
        if (!body.promptId) {
          return new Response(JSON.stringify({ error: 'Missing promptId' }), { status: 400 });
        }
        await this.handlePromptResolved(body.promptId, {
          actionId: body.actionId,
          value: body.value,
          resolvedBy: body.resolvedBy || 'system',
        });
        return Response.json({ success: true });
      }
```

- [ ] **Step 11: Update the alarm expiry handler**

Find the `// ─── Action Approval Expiry` section (line ~1392). Replace both the approval expiry loop and the question expiry loop (line ~1436) with a single loop:

```typescript
    // ─── Interactive Prompt Expiry ────────────────────────────────────
    const expiredPrompts = this.ctx.storage.sql
      .exec(
        "SELECT id, type, request_id, context, channel_refs FROM interactive_prompts WHERE expires_at IS NOT NULL AND expires_at <= ?",
        nowSecs
      )
      .toArray();

    for (const ep of expiredPrompts) {
      const epId = ep.id as string;
      const epType = ep.type as string;
      const epRequestId = ep.request_id as string | null;
      const epContext = ep.context ? JSON.parse(ep.context as string) : {};
      const epChannelRefs = (ep.channel_refs as string) || null;

      this.ctx.storage.sql.exec("DELETE FROM interactive_prompts WHERE id = ?", epId);

      if (epType === 'approval') {
        const { invocationId, toolId } = epContext;
        this.ctx.waitUntil(
          updateInvocationStatus(this.appDb, invocationId, { status: 'expired' })
            .catch((err) => console.error('[SessionAgentDO] Failed to mark invocation expired:', err))
        );
        if (epRequestId) {
          this.sendToRunner({ type: 'call-tool-result', requestId: epRequestId, error: `Action "${toolId}" approval expired after 10 minutes` } as any);
        }
      } else if (epType === 'question') {
        // Send expired answer to runner so it unblocks
        this.sendToRunner({ type: 'answer', questionId: epId, answer: '' });
      }

      this.broadcastToClients({
        type: 'interactive_prompt_expired',
        promptId: epId,
        promptType: epType,
      });

      this.ctx.waitUntil(
        this.updateChannelInteractivePrompts(epChannelRefs, { resolvedBy: 'system' })
      );

      this.appendAuditLog('agent.tool_call', `${epType} prompt ${epId} expired`, undefined, { promptId: epId });
    }
```

Also delete the old question expiry loop entirely (the `SELECT id, text FROM questions WHERE status = 'pending'...` block).

- [ ] **Step 12: Update reconnection handler**

Find where pending questions are sent on reconnect (line ~1070):
```typescript
.exec("SELECT id, text, options FROM questions WHERE status = 'pending'")
```

Replace with:
```typescript
.exec("SELECT * FROM interactive_prompts WHERE status = 'pending'")
```

And update the broadcast to send `interactive_prompt` messages for each pending prompt.

- [ ] **Step 13: Update alarm scheduling**

Find references to `SELECT MIN(expires_at) as next FROM questions WHERE status = 'pending'` and replace with `SELECT MIN(expires_at) as next FROM interactive_prompts WHERE status = 'pending'`. There are ~3 occurrences (lines ~1540, ~2120, ~7669).

- [ ] **Step 14: Typecheck**

Run: `cd packages/worker && pnpm typecheck`
Expected: PASS

- [ ] **Step 15: Commit**

```bash
git add packages/worker/src/durable-objects/session-agent.ts
git commit -m "feat(worker): replace questions and approvals with unified interactive_prompts"
```

---

## Chunk 4: Routes and Slack Interactive Handler

### Task 4: Update Action Invocations Route

**Files:**
- Modify: `packages/worker/src/routes/action-invocations.ts`

The approve/deny endpoints call `/action-approved` and `/action-denied` on the DO. Update them to call `/prompt-resolved`.

- [ ] **Step 1: Update the approve endpoint**

In `POST /:id/approve` (line ~58), change the DO fetch:

```typescript
    await stub.fetch(new Request('https://session/prompt-resolved', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ promptId: id, actionId: 'approve', resolvedBy: user.id }),
    }));
```

- [ ] **Step 2: Update the deny endpoint**

In `POST /:id/deny` (line ~94), change the DO fetch:

```typescript
    await stub.fetch(new Request('https://session/prompt-resolved', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ promptId: id, actionId: 'deny', value: reason, resolvedBy: user.id }),
    }));
```

- [ ] **Step 3: Typecheck**

Run: `cd packages/worker && pnpm typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/worker/src/routes/action-invocations.ts
git commit -m "feat(worker): update action-invocations routes to use /prompt-resolved"
```

---

### Task 5: Update Slack Interactive Route

**Files:**
- Modify: `packages/worker/src/routes/slack-events.ts`

- [ ] **Step 1: Update the DO notification in the interactive handler**

Find the `waitUntil` block in `POST /channels/slack/interactive` that calls `/action-approved` or `/action-denied`. Replace with a single call to `/prompt-resolved`:

```typescript
  c.executionCtx.waitUntil((async () => {
    try {
      const doId = c.env.SESSIONS.idFromName(inv.sessionId);
      const stub = c.env.SESSIONS.get(doId);
      await stub.fetch(new Request('https://session/prompt-resolved', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          promptId: invocationId,
          actionId,
          resolvedBy: userId,
        }),
      }));
    } catch (err) {
      console.error('[Slack Interactive] Failed to notify DO:', err);
    }
  })());
```

Note: `actionId` here is the raw Slack `action_id` value (e.g., `"approve"`, `"deny"`, `"option_0"`). This passes through directly as the resolution's `actionId`.

- [ ] **Step 2: Update action_id validation**

Remove the hardcoded check for `approve_action` / `deny_action`. The route should accept any `action_id` since prompts can have arbitrary actions:

Change:
```typescript
  if (!invocationId || (actionId !== 'approve_action' && actionId !== 'deny_action')) {
```
To:
```typescript
  if (!invocationId || !actionId) {
```

The `action_id` values are now just `"approve"`, `"deny"`, `"option_0"`, etc. (set by `sendInteractivePrompt`), not prefixed with `_action`.

- [ ] **Step 3: Typecheck**

Run: `cd packages/worker && pnpm typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/worker/src/routes/slack-events.ts
git commit -m "feat(worker): update Slack interactive route to use generic prompt resolution"
```

---

## Chunk 5: Frontend Updates

### Task 6: Update Frontend to Use Unified Prompt Events

**Files:**
- Modify: `packages/client/src/hooks/use-chat.ts`
- Modify: `packages/client/src/components/session/action-approval-card.tsx`
- Modify: `packages/client/src/components/chat/chat-container.tsx`

The frontend needs to handle the new `interactive_prompt`, `interactive_prompt_resolved`, and `interactive_prompt_expired` WebSocket events instead of the old `question`, `action_approval_required`, `action_approved`, `action_denied`, and `action_expired` events.

- [ ] **Step 1: Update `use-chat.ts` WebSocket message handling**

In the WebSocket `onmessage` handler, replace the `case 'question'` and `case 'action_approval_required'` handlers with a single `case 'interactive_prompt'` handler. Replace `action_approved` / `action_denied` / `action_expired` with `interactive_prompt_resolved` / `interactive_prompt_expired`.

The state shape changes from separate `questions` and `pendingActionApprovals` arrays to a single `interactivePrompts` array.

Also update the `answerQuestion` function to send the answer via the existing `answer` WebSocket message type (unchanged — the DO's `handleAnswer` now routes through `handlePromptResolved`).

For approval resolution, update `approveActionWs` / `denyActionWs` to send a unified message. Or keep using the HTTP endpoint (`POST /action-invocations/:id/approve`) which was updated in Task 4.

- [ ] **Step 2: Rename `action-approval-card.tsx` to `interactive-prompt-card.tsx`**

Update the component to render any `InteractivePrompt`:
- Show `prompt.title` and `prompt.body`
- Render buttons from `prompt.actions` (not hardcoded approve/deny)
- For prompts with no actions, show a text input
- Show expiry countdown from `prompt.expiresAt`

The `PendingActionApproval` type becomes `InteractivePromptState`:

```typescript
export interface InteractivePromptState {
  id: string;
  sessionId: string;
  type: string;
  title: string;
  body?: string;
  actions: Array<{ id: string; label: string; style?: 'primary' | 'danger' }>;
  expiresAt?: number;
  context?: Record<string, unknown>;
  status: 'pending' | 'resolved' | 'expired';
}
```

- [ ] **Step 3: Update `chat-container.tsx`**

Replace rendering of `ActionApprovalCard` with the new `InteractivePromptCard`, iterating over the unified `interactivePrompts` state.

- [ ] **Step 4: Update status message handling**

In `use-chat.ts`, the `status` message handler checks for `data.questionAnswered` and `data.questionExpired`. These can be removed once the new `interactive_prompt_resolved` / `interactive_prompt_expired` events are handling cleanup.

- [ ] **Step 5: Typecheck**

Run: `cd packages/client && pnpm typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/client/src/hooks/use-chat.ts packages/client/src/components/session/ packages/client/src/components/chat/chat-container.tsx
git commit -m "feat(client): update frontend to use unified interactive prompt events"
```

---

## Chunk 6: Deploy and Test

### Task 7: Deploy and Manual Test

- [ ] **Step 1: Full typecheck**

Run: `pnpm typecheck` (from root)
Expected: All packages PASS

- [ ] **Step 2: Deploy**

Run: `make deploy`

- [ ] **Step 3: Test approval flow via Slack**

1. Start a Slack-bound session
2. Trigger an action with `require_approval` policy
3. Verify Block Kit buttons appear in Slack thread
4. Click Approve → verify message updates, action executes

- [ ] **Step 4: Test question flow via Slack**

1. Trigger an agent question with options
2. Verify buttons appear in Slack thread (one per option)
3. Click an option → verify message updates, answer is sent to Runner

- [ ] **Step 5: Test free-text question via Slack**

1. Trigger an agent question without options
2. Verify plain text message appears with "Reply to this thread" instruction
3. Reply in thread → verify answer is captured (this requires the thread-reply capture in the DO — if not yet implemented, note as follow-up)

- [ ] **Step 6: Test web UI**

1. Verify approval cards still render and work in web UI
2. Verify question prompts render with buttons
3. Verify expiry updates both Slack and web UI

- [ ] **Step 7: Test race condition**

1. Trigger approval, click Approve in web UI
2. Verify Slack message updates correctly
3. Verify no errors in logs
