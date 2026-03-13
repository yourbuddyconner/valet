# Channel-Based Action Approvals Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire action approval requests to bound channels (starting with Slack) via interactive components, so users can approve/deny from Slack or the web UI — first response wins.

**Architecture:** Add optional `sendApprovalRequest` / `updateApprovalStatus` methods to the `ChannelTransport` interface. SessionAgentDO sends approval messages to all bound channels on `require_approval`, stores message refs, and updates them on resolution. A new Slack interactive route handles button clicks.

**Tech Stack:** Slack Block Kit, Slack `chat.postMessage`/`chat.update`, `application/x-www-form-urlencoded` interactive payloads, Cloudflare Workers Hono routes, Durable Object local SQLite.

**Spec:** `docs/specs/2026-03-12-channel-approval-design.md`

---

## Chunk 1: SDK Interface + Slack Transport Methods

### Task 1: Add Approval Types and Methods to ChannelTransport

**Files:**
- Modify: `packages/sdk/src/channels/index.ts:25-115`

- [ ] **Step 1: Add approval types before the ChannelTransport interface**

Add these types after the `ChannelContext` interface (after line 64):

```typescript
// ─── Approval Types ─────────────────────────────────────────────────────────

export interface ApprovalRequest {
  invocationId: string;
  sessionId: string;
  toolId: string;
  service: string;
  actionId: string;
  riskLevel: string;
  params?: Record<string, unknown>;
  expiresAt: number;
}

export interface ApprovalMessageRef {
  messageId: string;
  channelId: string;
  [key: string]: unknown;
}

export type ApprovalResolution =
  | { status: 'approved'; resolvedBy: string }
  | { status: 'denied'; resolvedBy: string; reason?: string }
  | { status: 'expired' };
```

- [ ] **Step 2: Add optional methods to ChannelTransport**

Add after `unregisterWebhook` (line 114), before the closing `}`:

```typescript
  /** Send an interactive approval request to a channel (e.g. Slack Block Kit buttons). */
  sendApprovalRequest?(target: ChannelTarget, approval: ApprovalRequest, ctx: ChannelContext): Promise<ApprovalMessageRef | null>;

  /** Update a previously sent approval message with resolution status. */
  updateApprovalStatus?(target: ChannelTarget, ref: ApprovalMessageRef, resolution: ApprovalResolution, ctx: ChannelContext): Promise<void>;
```

- [ ] **Step 3: Run typecheck**

Run: `cd packages/sdk && pnpm typecheck`
Expected: PASS (new optional methods don't break existing implementations)

- [ ] **Step 4: Commit**

```bash
git add packages/sdk/src/channels/index.ts
git commit -m "feat(sdk): add approval request/resolution types and optional ChannelTransport methods"
```

---

### Task 2: Implement sendApprovalRequest on SlackTransport

**Files:**
- Modify: `packages/plugin-slack/src/channels/transport.ts:279-312`

The `slackApiCall` helper (line 20) and `sendMessage` pattern (line 279) already exist and handle `chat.postMessage`. Follow the same structure.

- [ ] **Step 1: Add the sendApprovalRequest method**

Add after the `resolveLabel` method (after line 476), before the closing `}` of the class:

```typescript
  async sendApprovalRequest(
    target: ChannelTarget,
    approval: import('@valet/sdk').ApprovalRequest,
    ctx: ChannelContext,
  ): Promise<import('@valet/sdk').ApprovalMessageRef | null> {
    const riskEmoji = approval.riskLevel === 'critical' ? '🔴'
      : approval.riskLevel === 'high' ? '🟠'
      : approval.riskLevel === 'medium' ? '🟡'
      : '🟢';

    const paramsPreview = approval.params
      ? '```' + JSON.stringify(approval.params, null, 2).slice(0, 500) + '```'
      : '_No parameters_';

    const expiryUnix = Math.floor(approval.expiresAt / 1000);

    const blocks = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${riskEmoji} *Action requires approval*\n\`${approval.toolId}\` (risk: *${approval.riskLevel}*)`,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: paramsPreview,
        },
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `Expires <!date^${expiryUnix}^{date_short_pretty} at {time}|in 10 minutes>`,
          },
        ],
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Approve' },
            style: 'primary',
            action_id: 'approve_action',
            value: approval.invocationId,
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Deny' },
            style: 'danger',
            action_id: 'deny_action',
            value: approval.invocationId,
          },
        ],
      },
    ];

    const body: Record<string, unknown> = {
      channel: target.channelId,
      text: `Action ${approval.toolId} requires approval (${approval.riskLevel} risk)`,
      blocks,
      unfurl_links: false,
    };

    if (target.threadId) {
      body.thread_ts = target.threadId;
    }

    const result = await slackApiCall('chat.postMessage', body, ctx.token);
    if (!result.ok) {
      console.error(`[SlackTransport] sendApprovalRequest error: ${result.error}`);
      return null;
    }

    return { messageId: result.ts!, channelId: target.channelId };
  }
```

Note: `slackApiCall` is a module-level function (line 20), already accessible within this file.

- [ ] **Step 2: Add the import for approval types**

Add to the existing import block at line 1:

```typescript
import type {
  ChannelTransport,
  ChannelTarget,
  ChannelContext,
  InboundMessage,
  OutboundMessage,
  RoutingMetadata,
  SendResult,
  ApprovalRequest,
  ApprovalMessageRef,
  ApprovalResolution,
} from '@valet/sdk';
```

- [ ] **Step 3: Run typecheck**

Run: `cd packages/plugin-slack && pnpm typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/plugin-slack/src/channels/transport.ts
git commit -m "feat(slack): implement sendApprovalRequest with Block Kit buttons"
```

---

### Task 3: Implement updateApprovalStatus on SlackTransport

**Files:**
- Modify: `packages/plugin-slack/src/channels/transport.ts`

- [ ] **Step 1: Add the updateApprovalStatus method**

Add after the `sendApprovalRequest` method:

```typescript
  async updateApprovalStatus(
    target: ChannelTarget,
    ref: ApprovalMessageRef,
    resolution: ApprovalResolution,
    ctx: ChannelContext,
  ): Promise<void> {
    let statusText: string;
    if (resolution.status === 'approved') {
      statusText = `✅ Approved by ${resolution.resolvedBy}`;
    } else if (resolution.status === 'denied') {
      statusText = `❌ Denied by ${resolution.resolvedBy}`;
      if (resolution.reason) statusText += `: ${resolution.reason}`;
    } else {
      statusText = '⏰ Expired';
    }

    // Fetch existing message to preserve the info blocks, replace the actions block
    // with a status context block. We rebuild the blocks to avoid a round-trip GET.
    const blocks = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: statusText,
        },
      },
    ];

    const result = await slackApiCall('chat.update', {
      channel: ref.channelId,
      ts: ref.messageId,
      text: statusText,
      blocks,
    }, ctx.token);

    if (!result.ok) {
      console.error(`[SlackTransport] updateApprovalStatus error: ${result.error}`);
    }
  }
```

Note: This replaces the entire message blocks with just the status. This is simpler than preserving the original blocks, and the relevant context (tool name, params) is already visible in the thread. If we want to preserve the original info blocks, we'd need to either store them alongside the ref or re-fetch the message — not worth the complexity for v1.

- [ ] **Step 2: Run typecheck**

Run: `cd packages/plugin-slack && pnpm typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/plugin-slack/src/channels/transport.ts
git commit -m "feat(slack): implement updateApprovalStatus to replace buttons with resolution"
```

---

## Chunk 2: SessionAgentDO Integration

### Task 4: Add channel_refs Column to Local SQLite

**Files:**
- Modify: `packages/worker/src/durable-objects/session-agent.ts:550-560`

The `pending_action_approvals` table is created in local SQLite (DO storage) at line ~550.

- [ ] **Step 1: Add channel_refs column to table creation**

Find the CREATE TABLE statement for `pending_action_approvals` (line ~550) and add:

```sql
channel_refs TEXT
```

after the `expires_at` column.

The full statement becomes:

```sql
CREATE TABLE IF NOT EXISTS pending_action_approvals (
  invocation_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  tool_id TEXT NOT NULL,
  service TEXT NOT NULL,
  action_id TEXT NOT NULL,
  params TEXT,
  is_org_scoped INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at INTEGER,
  channel_refs TEXT
);
```

- [ ] **Step 2: Run typecheck**

Run: `cd packages/worker && pnpm typecheck`
Expected: PASS (SQL string change only)

- [ ] **Step 3: Commit**

```bash
git add packages/worker/src/durable-objects/session-agent.ts
git commit -m "feat(worker): add channel_refs column to pending_action_approvals local SQLite"
```

---

### Task 5: Send Approval Requests to Bound Channels

**Files:**
- Modify: `packages/worker/src/durable-objects/session-agent.ts:8732-8789`

This is the `require_approval` block in `handleCallTool`. After the existing EventBus publish (line ~8784), add channel notification logic.

The DO already has access to:
- `channelRegistry` (imported at top of file)
- `getSessionChannelBindings` from `../lib/db.js`
- `getSlackBotToken` from `../services/slack.js`
- `getCredential` from `../lib/db.js`
- The `parseSlackChannelId` helper method (for building targets)

- [ ] **Step 1: Add the channel approval notification after EventBus publish**

After the `this.appendAuditLog(...)` line (~8786) and before `await this.ensureActionExpiryAlarm(...)` (~8789), add:

```typescript
        // ─── Notify bound channels with approval request ───────────────
        const approvalRequest: import('@valet/sdk').ApprovalRequest = {
          invocationId: invocationResult.invocationId,
          sessionId: sessionId || '',
          toolId,
          service,
          actionId,
          riskLevel,
          params,
          expiresAt: expiresAt * 1000,
        };

        // Fire-and-forget: send approval messages to all bound channels that support it
        this.ctx.waitUntil(
          this.sendChannelApprovalRequests(invocationResult.invocationId, approvalRequest)
        );
```

- [ ] **Step 2: Add the sendChannelApprovalRequests helper method**

Add as a new private method on the class (near the other approval handlers, around line ~9030):

```typescript
  /**
   * Send approval request messages to all bound channels that support interactive approvals.
   * Stores returned message refs in local SQLite for later status updates.
   */
  private async sendChannelApprovalRequests(invocationId: string, approval: import('@valet/sdk').ApprovalRequest) {
    try {
      const sessionId = this.getStateValue('sessionId');
      const userId = this.getStateValue('userId');
      if (!sessionId || !userId) return;

      const bindings = await getSessionChannelBindings(this.appDb, sessionId);
      if (bindings.length === 0) return;

      const refs: Array<{ channelType: string; ref: import('@valet/sdk').ApprovalMessageRef }> = [];

      for (const binding of bindings) {
        const transport = channelRegistry.getTransport(binding.channelType);
        if (!transport?.sendApprovalRequest) continue;

        // Resolve token (same pattern as handleChannelReply)
        let token: string | undefined;
        if (binding.channelType === 'slack') {
          token = await getSlackBotToken(this.env) ?? undefined;
        } else {
          const credResult = await getCredential(this.env, userId, binding.channelType);
          if (credResult.ok) token = credResult.credential.accessToken;
        }
        if (!token) continue;

        // Build target from binding
        const parsed = this.parseSlackChannelId(binding.channelType, binding.channelId);
        const target: import('@valet/sdk').ChannelTarget = {
          channelType: binding.channelType,
          channelId: parsed.channelId,
          threadId: parsed.threadId,
        };
        const ctx: import('@valet/sdk').ChannelContext = { token, userId };

        const ref = await transport.sendApprovalRequest(target, approval, ctx);
        if (ref) {
          refs.push({ channelType: binding.channelType, ref });
        }
      }

      // Store refs in local SQLite for later status updates
      if (refs.length > 0) {
        this.ctx.storage.sql.exec(
          'UPDATE pending_action_approvals SET channel_refs = ? WHERE invocation_id = ?',
          JSON.stringify(refs),
          invocationId,
        );
      }
    } catch (err) {
      console.error('[SessionAgentDO] sendChannelApprovalRequests failed:', err instanceof Error ? err.message : String(err));
    }
  }
```

Note: `getSessionChannelBindings` is already imported via `../lib/db.js`. `getSlackBotToken` and `getCredential` are already imported and used in `handleChannelReply` (~line 8308). `channelRegistry` is already imported. `parseSlackChannelId` is already a method on the class. Verify these are available — if any are missing, add the import.

- [ ] **Step 3: Run typecheck**

Run: `cd packages/worker && pnpm typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/worker/src/durable-objects/session-agent.ts
git commit -m "feat(worker): send channel approval requests to bound channels on require_approval"
```

---

### Task 6: Update Channel Messages on Resolution and Expiry

**Files:**
- Modify: `packages/worker/src/durable-objects/session-agent.ts`

Three handlers need to call `updateApprovalStatus`: `handleActionApproved` (~8916), `handleActionDenied` (~8976), and the expiry alarm handler (~1400).

- [ ] **Step 1: Add a shared helper for updating channel approval status**

Add near the `sendChannelApprovalRequests` method:

```typescript
  /**
   * Update approval status on all channel messages that were sent for this invocation.
   * Reads channel_refs from local SQLite before the row is deleted.
   */
  private async updateChannelApprovalStatus(
    channelRefsJson: string | null,
    resolution: import('@valet/sdk').ApprovalResolution,
  ) {
    if (!channelRefsJson) return;

    const userId = this.getStateValue('userId');
    let refs: Array<{ channelType: string; ref: import('@valet/sdk').ApprovalMessageRef }>;
    try {
      refs = JSON.parse(channelRefsJson);
    } catch {
      return;
    }

    for (const { channelType, ref } of refs) {
      const transport = channelRegistry.getTransport(channelType);
      if (!transport?.updateApprovalStatus) continue;

      let token: string | undefined;
      if (channelType === 'slack') {
        token = await getSlackBotToken(this.env) ?? undefined;
      } else if (userId) {
        const credResult = await getCredential(this.env, userId, channelType);
        if (credResult.ok) token = credResult.credential.accessToken;
      }
      if (!token) continue;

      const parsed = this.parseSlackChannelId(channelType, ref.channelId);
      const target: import('@valet/sdk').ChannelTarget = {
        channelType,
        channelId: parsed.channelId,
        threadId: parsed.threadId,
      };
      const ctx: import('@valet/sdk').ChannelContext = { token, userId: userId || '' };

      try {
        await transport.updateApprovalStatus(target, ref, resolution, ctx);
      } catch (err) {
        console.error(`[SessionAgentDO] updateApprovalStatus failed for ${channelType}:`, err instanceof Error ? err.message : String(err));
      }
    }
  }
```

- [ ] **Step 2: Update handleActionApproved (~line 8916)**

Read `channel_refs` before deleting the row. Change the SELECT and add a `waitUntil` call.

Before the existing `DELETE` (line 8936), read channel_refs from the row:

```typescript
    const channelRefsJson = (row.channel_refs as string) || null;
```

After the `this.appendAuditLog(...)` at line 8970, add:

```typescript
    // Update channel approval messages
    this.ctx.waitUntil(
      this.updateChannelApprovalStatus(channelRefsJson, { status: 'approved', resolvedBy: userId })
    );
```

- [ ] **Step 3: Update handleActionDenied (~line 8976)**

Same pattern. Read `channel_refs` before deletion:

```typescript
    const channelRefsJson = (row.channel_refs as string) || null;
```

After the `this.appendAuditLog(...)` at line 9027, add:

```typescript
    // Update channel approval messages
    const resolvedBy = this.getStateValue('userId') || 'system';
    this.ctx.waitUntil(
      this.updateChannelApprovalStatus(channelRefsJson, { status: 'denied', resolvedBy, reason })
    );
```

- [ ] **Step 4: Update expiry alarm handler (~line 1400)**

In the expiry loop, read `channel_refs` before deleting. Change the SELECT at line 1395 to include `channel_refs`:

```sql
SELECT invocation_id, request_id, tool_id, service, action_id, channel_refs FROM pending_action_approvals WHERE expires_at IS NOT NULL AND expires_at <= ?
```

After the `this.appendAuditLog(...)` at line 1429, add:

```typescript
      // Update channel approval messages
      const eaChannelRefs = (ea.channel_refs as string) || null;
      this.ctx.waitUntil(
        this.updateChannelApprovalStatus(eaChannelRefs, { status: 'expired' })
      );
```

- [ ] **Step 5: Run typecheck**

Run: `cd packages/worker && pnpm typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/worker/src/durable-objects/session-agent.ts
git commit -m "feat(worker): update channel approval messages on approve/deny/expire"
```

---

## Chunk 3: Slack Interactive Route

### Task 7: Add Slack Interactive Payload Route

**Files:**
- Modify: `packages/worker/src/routes/slack-events.ts`

This adds a new `POST /channels/slack/interactive` route to handle `block_actions` payloads from Slack. The existing route is `POST /channels/slack/events` (line 33).

**Important:** Slack sends interactive payloads as `application/x-www-form-urlencoded` with a `payload` JSON field. This is different from the Events API which sends JSON. Must respond with 200 within 3 seconds.

- [ ] **Step 1: Add the interactive route**

Add after the existing `slackEventsRouter.post('/slack/events', ...)` handler (after it closes). The route goes on the same `slackEventsRouter`:

```typescript
/**
 * POST /channels/slack/interactive — Slack interactive component handler
 *
 * Handles block_actions payloads (button clicks) for action approval.
 * Payload arrives as application/x-www-form-urlencoded with a `payload` JSON field.
 * Must respond with 200 within 3 seconds — actual processing is fire-and-forget.
 */
slackEventsRouter.post('/slack/interactive', async (c) => {
  // Parse form-encoded body
  const formData = await c.req.formData();
  const payloadStr = formData.get('payload') as string | null;
  if (!payloadStr) {
    return c.json({ error: 'Missing payload' }, 400);
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(payloadStr) as Record<string, unknown>;
  } catch {
    return c.json({ error: 'Invalid payload JSON' }, 400);
  }

  // Only handle block_actions
  if (payload.type !== 'block_actions') {
    return c.json({ ok: true });
  }

  // Extract team_id for signature verification
  const team = payload.team as Record<string, unknown> | undefined;
  const teamId = team?.id as string | undefined;
  if (!teamId) {
    return c.json({ error: 'Missing team_id' }, 400);
  }

  // Look up org-level Slack install for signing secret
  const install = await db.getOrgSlackInstall(c.get('db'), teamId);
  if (!install) {
    return c.json({ ok: true });
  }

  // Verify Slack signature
  const rawBody = await c.req.raw.clone().text();
  const rawHeaders: Record<string, string> = {};
  c.req.raw.headers.forEach((value, key) => {
    rawHeaders[key] = value;
  });

  const signingSecret = install.encryptedSigningSecret
    ? await decryptString(install.encryptedSigningSecret, c.env.ENCRYPTION_KEY)
    : c.env.SLACK_SIGNING_SECRET;

  if (signingSecret) {
    const valid = await verifySlackSignature(rawHeaders, rawBody, signingSecret);
    if (!valid) {
      return c.json({ error: 'Invalid signature' }, 401);
    }
  }

  // Extract action details
  const actions = payload.actions as Array<Record<string, unknown>> | undefined;
  const action = actions?.[0];
  if (!action) {
    return c.json({ ok: true });
  }

  const actionId = action.action_id as string;
  const invocationId = action.value as string;
  if (!invocationId || (actionId !== 'approve_action' && actionId !== 'deny_action')) {
    return c.json({ ok: true });
  }

  // Resolve Slack user to internal user
  const slackUser = payload.user as Record<string, unknown> | undefined;
  const slackUserId = slackUser?.id as string | undefined;
  if (!slackUserId) {
    return c.json({ ok: true });
  }

  const userId = await db.resolveUserByExternalId(c.get('db'), 'slack', slackUserId);
  if (!userId) {
    console.log(`[Slack Interactive] No identity link for slack user=${slackUserId}`);
    return c.json({ ok: true });
  }

  // Look up the invocation to find the session
  const inv = await db.getInvocation(c.get('db'), invocationId);
  if (!inv || inv.status !== 'pending') {
    return c.json({ ok: true });
  }

  // Verify the Slack user owns this invocation
  if (inv.userId !== userId) {
    console.log(`[Slack Interactive] User ${userId} not authorized for invocation ${invocationId}`);
    return c.json({ ok: true });
  }

  // Respond to Slack immediately (3-second deadline)
  // Process approval/denial asynchronously
  c.executionCtx.waitUntil((async () => {
    try {
      const doId = c.env.SESSIONS.idFromName(inv.sessionId);
      const stub = c.env.SESSIONS.get(doId);

      if (actionId === 'approve_action') {
        await stub.fetch(new Request('https://session/action-approved', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ invocationId }),
        }));
      } else {
        await stub.fetch(new Request('https://session/action-denied', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ invocationId }),
        }));
      }
    } catch (err) {
      console.error('[Slack Interactive] Failed to notify DO:', err);
    }
  })());

  return c.json({ ok: true });
});
```

- [ ] **Step 2: Verify imports are available**

The route file already imports: `db`, `decryptString`, `verifySlackSignature`, `channelRegistry`. It also already has access to `c.env.SESSIONS` for DO stubs.

Check that `db.getInvocation` is available from the db import. If not, add:

```typescript
import { getInvocation } from '../lib/db.js';
```

- [ ] **Step 3: Handle form body parsing caveat**

Slack sends the raw body as `application/x-www-form-urlencoded`. The signature verification in step 1 uses `c.req.raw.clone().text()` to get the raw body. However, `formData()` may consume the body. To fix this, read the raw body first, then parse form data from it manually:

Replace the first few lines of the handler with:

```typescript
slackEventsRouter.post('/slack/interactive', async (c) => {
  const rawBody = await c.req.text();

  // Parse form-encoded body manually
  const params = new URLSearchParams(rawBody);
  const payloadStr = params.get('payload');
  if (!payloadStr) {
    return c.json({ error: 'Missing payload' }, 400);
  }
```

And later for signature verification, use the already-read `rawBody` variable instead of `c.req.raw.clone().text()`.

- [ ] **Step 4: Run typecheck**

Run: `cd packages/worker && pnpm typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/routes/slack-events.ts
git commit -m "feat(worker): add Slack interactive payload route for action approvals"
```

---

### Task 8: Manual Integration Test

This is not an automated test — it's a walkthrough to verify the full flow works end-to-end.

- [ ] **Step 1: Deploy**

Run: `make deploy`

- [ ] **Step 2: Configure Slack app interactivity URL**

In the Slack app settings (api.slack.com/apps), go to "Interactivity & Shortcuts":
- Toggle Interactivity ON
- Set Request URL to: `{WORKER_URL}/channels/slack/interactive`
- Save

- [ ] **Step 3: Test the flow**

1. Start a session bound to a Slack thread
2. Set a policy for an action to "require_approval"
3. Trigger that action from the agent
4. Verify: Block Kit message appears in Slack thread with Approve/Deny buttons
5. Verify: Approval card also appears in web UI
6. Click Approve in Slack
7. Verify: Slack message updates to show "Approved by @user"
8. Verify: Web UI card also updates
9. Verify: Action executes successfully

- [ ] **Step 4: Test deny flow**

Repeat with Deny button — verify message updates and action is rejected.

- [ ] **Step 5: Test expiry flow**

Trigger an approval, wait 10 minutes (or temporarily reduce `ACTION_APPROVAL_EXPIRY_MS` for testing). Verify the Slack message updates to show "Expired".

- [ ] **Step 6: Test race condition**

Trigger an approval, click Approve in web UI before Slack. Verify Slack message still updates correctly and no errors.
