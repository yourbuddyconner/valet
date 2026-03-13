# Unified Interactive Prompts

**Date:** 2026-03-12
**Status:** Approved
**Supersedes:** `docs/specs/2026-03-12-channel-approval-design.md` (approval-specific interface)

## Overview

Replace the separate `questions` and `pending_action_approvals` systems in SessionAgentDO with a single `interactive_prompts` system. One table, one alarm handler, one resolution path, one channel transport interface. Both action approvals and agent questions flow through the same generic interactive prompt mechanism.

## SDK Interface

### New Types (`packages/sdk/src/channels/index.ts`)

Replace `ApprovalRequest`, `ApprovalMessageRef`, `ApprovalResolution` with:

```typescript
interface InteractivePrompt {
  id: string;
  sessionId: string;
  type: string;                         // "approval" | "question"
  title: string;
  body?: string;
  actions: InteractiveAction[];         // empty = thread-reply (free-text) prompt
  expiresAt?: number;                   // epoch ms
  context?: Record<string, unknown>;    // type-specific data
}

interface InteractiveAction {
  id: string;
  label: string;
  style?: 'primary' | 'danger';
}

interface InteractivePromptRef {
  messageId: string;
  channelId: string;
  [key: string]: unknown;
}

interface InteractiveResolution {
  actionId?: string;      // which button was clicked (absent for thread replies)
  value?: string;         // free-text for thread replies
  resolvedBy: string;     // display name
}
```

### ChannelTransport Methods

Replace `sendApprovalRequest` / `updateApprovalStatus` with:

```typescript
sendInteractivePrompt?(target: ChannelTarget, prompt: InteractivePrompt, ctx: ChannelContext): Promise<InteractivePromptRef | null>;
updateInteractivePrompt?(target: ChannelTarget, ref: InteractivePromptRef, resolution: InteractiveResolution, ctx: ChannelContext): Promise<void>;
```

## SessionAgentDO Changes

### Single Table

Replace both `pending_action_approvals` and `questions` with:

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

- `type`: `"approval"` or `"question"`
- `request_id`: Runner request ID to unblock on resolution
- `actions`: JSON array of `InteractiveAction` (empty array for free-text questions)
- `context`: JSON blob with type-specific data
  - Approval: `{ toolId, service, actionId, params, riskLevel, isOrgScoped, invocationId }`
  - Question: `{ options }` (if any)
  - Both prompt types may also include `{ channelType, channelId }` to preserve the exact originating channel target for channel delivery and reply capture
- `channel_refs`: JSON array of `{ channelType, ref: InteractivePromptRef }`

### Single Resolution Handler

`handlePromptResolved(promptId: string, resolution: InteractiveResolution)`:

1. Read row from `interactive_prompts` where `id = promptId` and `status = 'pending'`
2. If not found, return (already resolved or expired)
3. Read `channel_refs` before deletion
4. Delete the row
5. Switch on `type`:
   - `"approval"`:
     - If `resolution.actionId === 'approve'`: call `approveInvocation` in D1, execute the action, send result to Runner via `request_id`
     - If `resolution.actionId === 'deny'`: call `denyInvocation` in D1, send error to Runner via `request_id`
   - `"question"`:
     - Send answer to Runner: `{ type: 'question-answer', requestId, answer: resolution.actionId || resolution.value }`
6. Resolve display name for `resolvedBy` (getUserById)
7. Update channel messages via stored `channel_refs` (fire-and-forget)
8. Broadcast resolution to web clients
9. Publish to EventBus

### Single Alarm Handler

Replace separate expiry loops for questions and approvals with one:

```sql
SELECT id, type, request_id, context, channel_refs
FROM interactive_prompts
WHERE expires_at IS NOT NULL AND expires_at <= ?
```

For each expired prompt:
1. Delete the row
2. Switch on `type`:
   - `"approval"`: update D1 invocation status to `expired`, send timeout error to Runner
   - `"question"`: send timeout answer to Runner
3. Update channel messages with `{ status: 'expired' }` (fire-and-forget)
4. Broadcast `prompt_expired` to web clients

### Creating Prompts

**Approval prompts** (in `handleCallTool` when `require_approval` resolves):

```typescript
const prompt: InteractivePrompt = {
  id: invocationId,
  sessionId,
  type: 'approval',
  title: `Action requires approval`,
  body: `\`${toolId}\` (risk: **${riskLevel}**)`,
  actions: [
    { id: 'approve', label: 'Approve', style: 'primary' },
    { id: 'deny', label: 'Deny', style: 'danger' },
  ],
  expiresAt: expiresAt * 1000,
  context: { toolId, service, actionId, params, riskLevel, isOrgScoped, invocationId },
};
```

**Question prompts** (in Runner message handler for `type: 'question'`):

```typescript
const prompt: InteractivePrompt = {
  id: questionId,
  sessionId,
  type: 'question',
  title: questionText,
  actions: options
    ? options.map((opt, i) => ({ id: `option_${i}`, label: opt }))
    : [],  // empty = free-text, thread-reply
  expiresAt: expiresAt * 1000,
  context: { options },
};
```

### Channel Dispatch

After inserting into `interactive_prompts`, resolve the originating channel target from `prompt.context.channelType` / `prompt.context.channelId` when present and send the prompt only to that exact target. This preserves the same lineage as normal channel replies: one originating Slack thread plus the web UI session stream. Only if no origin target is present should the implementation fall back to broader channel binding discovery.

### Thread Reply Capture (Free-Text Questions)

When a prompt has no `actions` (free-text question), the channel message says "Reply to this thread with your answer." The DO checks for pending text-input prompts when it receives a new message: if the session has a pending prompt of type `"question"` with no actions, the inbound message is from the session owner, and the inbound channel target matches the prompt's stored origin target, resolve the prompt with the message text.

This check goes in the DO's prompt handler, before normal processing.

## Slack Transport Implementation

### `sendInteractivePrompt`

If `prompt.actions` is non-empty:
- Block Kit message with section (title + body), context (expiry), and actions block (one button per action, using `action.style` for color)
- `action_id` = action's `id`, `value` = prompt's `id`

If `prompt.actions` is empty (free-text):
- Plain text message: `"*{title}*\n{body}\n_Reply to this thread with your answer._"`
- Still returns a ref (for status update on resolution/expiry)

### `updateInteractivePrompt`

Replace message blocks with resolution status text. Same as current `updateApprovalStatus` but using `InteractiveResolution`:
- If `resolution.actionId`: show the action label + who resolved
- If `resolution.value`: show truncated answer text + who resolved

## Slack Interactive Route

`POST /channels/slack/interactive` becomes generic:

1. Parse form-encoded `payload`
2. Verify Slack signature
3. Extract `action_id` and `value` (prompt ID) from `actions[0]`
4. Resolve Slack user to internal user
5. Resolve the internal user from the Slack actor and verify they own the target session
6. If unauthorized, return an explicit ephemeral Slack error message
7. Call DO: `POST /prompt-resolved` with `{ promptId, actionId, resolvedBy }`
8. Return 200 immediately, process asynchronously via `waitUntil`

The DO route `/prompt-resolved` replaces `/action-approved` and `/action-denied`.

## Slack Events Route Change

No change to the events route itself. Thread reply capture for free-text questions is handled in the DO when it receives a prompt — the DO checks for pending text-input prompts before normal message processing.

## Web Client Changes

The frontend `ActionApprovalCard` and any question UI components should be updated to consume a unified `InteractivePrompt` WebSocket event instead of separate `action_approval_required` and `question` events. The card renders buttons from `prompt.actions` and shows prompt info from `title`/`body`.

New event: `interactive_prompt` (replaces `action_approval_required` and `question`)
Resolution events: `interactive_prompt_resolved` (replaces `action_approved`, `action_denied`)
Expiry event: `interactive_prompt_expired` (replaces `action_expired`)

## What Gets Deleted

- `pending_action_approvals` table and all references
- `questions` table and all references
- `ApprovalRequest`, `ApprovalMessageRef`, `ApprovalResolution` types
- `sendApprovalRequest` / `updateApprovalStatus` transport methods
- Separate `handleActionApproved` / `handleActionDenied` / `handleAnswerQuestion` handlers
- Separate alarm handling for questions vs approvals
- `/action-approved` and `/action-denied` DO routes (replaced by `/prompt-resolved`)

## What This Spec Does NOT Cover

- New prompt types beyond `approval` and `question`
- Slack modal dialogs for rich text input
- Admin/reviewer approval routing (future: different user than session owner)
- Frontend component redesign details (just the event contract change)
- D1 migration for `action_invocations` table (unchanged, still used for audit trail)
