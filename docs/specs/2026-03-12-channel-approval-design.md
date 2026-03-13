# Channel-Based Action Approvals

**Date:** 2026-03-12
**Status:** Approved

## Overview

When an agent action requires approval (per action policy), send an interactive approval message to any bound channel that supports it. The user can approve or deny from Slack (or any future channel with interactive support), the web UI, or both — first response wins.

## Requirements

- Approval messages go to the same thread/channel where the conversation is happening
- Web UI and channel approvals work simultaneously; first resolution wins
- After resolution, the channel message updates in-place (buttons replaced with status)
- Expired approvals also update the channel message
- Deny is one-click, no reason prompt
- Generic plugin interface — any channel can implement approval support

## SDK Interface Changes

### New Types (`packages/sdk/src/channels/index.ts`)

```typescript
export interface ApprovalRequest {
  invocationId: string;
  sessionId: string;
  toolId: string;       // "service:actionId"
  service: string;
  actionId: string;
  riskLevel: string;
  params?: Record<string, unknown>;
  expiresAt: number;    // epoch ms
}

export interface ApprovalMessageRef {
  messageId: string;          // platform message ID (Slack ts, Telegram message_id)
  channelId: string;          // where it was sent
  [key: string]: unknown;     // platform-specific extras
}

export type ApprovalResolution =
  | { status: 'approved'; resolvedBy: string }
  | { status: 'denied'; resolvedBy: string; reason?: string }
  | { status: 'expired' };
```

### New Optional Methods on `ChannelTransport`

```typescript
sendApprovalRequest?(
  target: ChannelTarget,
  approval: ApprovalRequest,
  ctx: ChannelContext
): Promise<ApprovalMessageRef | null>;

updateApprovalStatus?(
  target: ChannelTarget,
  ref: ApprovalMessageRef,
  resolution: ApprovalResolution,
  ctx: ChannelContext
): Promise<void>;
```

Plugins that don't implement these methods don't get approval messages. No behavior change for existing channels.

## SessionAgentDO Changes

### Sending Approval Requests

In the `require_approval` block (~line 8732), after broadcasting to clients and EventBus, add:

1. Query `getSessionChannelBindings(db, sessionId)` to find bound channels
2. For each binding, get the transport via `channelRegistry.getTransport(channelType)`
3. If `transport.sendApprovalRequest` exists, call it with the approval details and the channel target derived from the binding
4. Store returned `ApprovalMessageRef` entries in the `pending_action_approvals` local SQLite row

**Schema change** to `pending_action_approvals`:

```sql
ALTER TABLE pending_action_approvals ADD COLUMN channel_refs TEXT;
```

`channel_refs` is a JSON array: `[{ "channelType": "slack", "ref": { "messageId": "...", "channelId": "..." } }]`

### Resolving Approvals

The existing `handleActionApproved`, `handleActionDenied`, and expiry alarm handlers gain a new step after their current logic:

1. Read `channel_refs` from the pending approval row (before it's deleted)
2. For each ref, get the transport and call `updateApprovalStatus` if implemented
3. Fire-and-forget via `ctx.waitUntil()` — resolution should not block on message updates

### Token Resolution

The DO already resolves channel tokens in `handleChannelReply` (Slack uses org bot token, others use per-user credentials). The same pattern applies here.

## Slack Interactive Payload Route

### New Route: `POST /channels/slack/interactive`

Added to `slack-events.ts`. Handles Slack's `block_actions` interactive payloads.

**Slack delivery format:** `application/x-www-form-urlencoded` with a `payload` field containing JSON.

**3-second deadline:** Slack requires HTTP 200 within 3 seconds. The route responds immediately and processes asynchronously via `ctx.waitUntil()`.

**Flow:**

1. Parse `payload` from form-encoded body
2. Verify Slack request signature (same as events route)
3. Extract `actions[0].action_id` (`approve_action` or `deny_action`) and `actions[0].value` (invocation ID)
4. Extract `user.id` from the payload — resolve to internal user via Slack user mapping
5. Return 200 OK immediately
6. `ctx.waitUntil()`: look up session from invocation, call `POST /action-approved` or `/action-denied` on the SessionAgentDO

**Action ID convention:**
- `action_id: "approve_action"` — approve button
- `action_id: "deny_action"` — deny button
- `value: "{invocationId}"` — which invocation to resolve

**Slack app configuration:** The interactivity Request URL must be set to `{WORKER_URL}/channels/slack/interactive` in the Slack app settings under "Interactivity & Shortcuts."

## Slack Transport Implementation

### `sendApprovalRequest()`

Sends a Block Kit message via `chat.postMessage` to the bound thread.

**Block Kit structure:**

```json
{
  "channel": "C123...",
  "thread_ts": "1234567890.123456",
  "text": "Action linear:linear.create_issue requires approval (medium risk)",
  "blocks": [
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "*Action requires approval*\n`linear:linear.create_issue` (risk: *medium*)"
      }
    },
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "```{\"title\": \"Fix login bug\", \"teamId\": \"ENG\"}```"
      }
    },
    {
      "type": "context",
      "elements": [
        {
          "type": "mrkdwn",
          "text": "Expires <!date^1710288000^{date_short_pretty} at {time}|in 10 minutes>"
        }
      ]
    },
    {
      "type": "actions",
      "elements": [
        {
          "type": "button",
          "text": { "type": "plain_text", "text": "Approve" },
          "style": "primary",
          "action_id": "approve_action",
          "value": "{invocationId}"
        },
        {
          "type": "button",
          "text": { "type": "plain_text", "text": "Deny" },
          "style": "danger",
          "action_id": "deny_action",
          "value": "{invocationId}"
        }
      ]
    }
  ]
}
```

The `text` field serves as a fallback for notifications and accessibility.

Returns `{ messageId: response.ts, channelId }`.

### `updateApprovalStatus()`

Calls `chat.update` with the stored `ts` and `channel`, replacing the actions block with a context block:

- **Approved:** "Approved by @user"
- **Denied:** "Denied by @user"
- **Expired:** "Expired"

The section blocks (tool info, params) are preserved. Only the actions block is swapped for a status context block.

## Data Flow

```
Agent calls tool -> DO resolves "require_approval"
  |-- Store in local SQLite (with channel_refs after sending)
  |-- Notify Runner (call-tool-pending)
  |-- Broadcast to web clients (action_approval_required)
  |-- Publish to EventBus
  |-- For each channel binding with sendApprovalRequest:
  |     Send Block Kit message -> store ref in channel_refs
  |
Resolution (whichever comes first):
  Web UI click -> POST /action-invocations/:id/approve -> DO
  Slack button -> POST /channels/slack/interactive -> DO
  Expiry alarm -> DO
    |-- Execute or reject the action
    |-- Broadcast to web clients
    |-- For each stored channel ref with updateApprovalStatus:
          Update Slack message (remove buttons, show status)
```

## What This Spec Does NOT Cover

- Approval routing to designated approvers or admin channels (future: configurable per policy)
- Denial reason prompts via Slack modals
- Telegram interactive button implementation (follows same interface when added)
- Changes to the action policy resolution logic itself
- Workflow approval gates (separate system in WorkflowExecutorDO)
