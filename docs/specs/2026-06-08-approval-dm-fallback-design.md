# Approval DM Fallback & Better Expiry Errors

**Date:** 2026-06-08
**Status:** Approved
**Linear:** TKAI-154

## Overview

Two bugs cause tool-approval requests to silently fail during scheduled automations and unattended workflow runs:

1. **`'thread'` channel type bypass**: `sendChannelInteractivePrompts` treats `'thread'` as a real external delivery channel (it isn't — it's the web UI's internal thread concept). This causes the fail-closed check to be skipped, and the channel router silently drops the delivery attempt.

2. **No DM fallback**: When no real external channel target is available (unattended run, no Slack thread context), there is no durable notification path. The approval is broadcast to WebSocket clients only — useless when no client is connected.

The result: approvals are created, never seen, expire after 240s, the agent retries indefinitely, burning context with no user feedback.

## Fix 1: `sendChannelInteractivePrompts` — `'thread'` fix + DM fallback

**Location:** `packages/worker/src/durable-objects/session-agent.ts`, `sendChannelInteractivePrompts` method (~line 7049).

### 1a. Fix the `'thread'` bypass

Both target-filter guards currently exclude only `'web'`. Extend them to also exclude `'thread'`:

```typescript
// originTarget check (~line 7061)
if (originTarget && originTarget.channelType !== 'web' && originTarget.channelType !== 'thread') {

// callerCh check (~line 7071)
if (callerCh?.channelType && callerCh?.channelId
    && callerCh.channelType !== 'web'
    && callerCh.channelType !== 'thread') {
```

This ensures scheduled orchestrator prompts (which arrive with `channelType = 'thread'`) correctly reach the fallback path rather than being silently dropped by the channel router.

### 1b. DM fallback

After the existing `targets.length === 0` check, if the user has a Slack credential, resolve their Slack user ID and send a Block Kit interactive DM — the same approve/deny format as normal channel approvals — with an added provenance block.

**Provenance label** is assembled from system metadata, not model output:

- If the currently-processing prompt queue row has `queue_type = 'workflow_execute'`: do a best-effort D1 lookup of the workflow name via `workflow_execution_id`. Label: *"Joan requested this while running workflow **{name}**"*. If the lookup fails or returns nothing, fall back to the general label.
- All other cases (orchestrator scheduled prompt, other unattended paths): *"Joan requested this while running a scheduled task (no active session was connected)"*

"Joan" here is the orchestrator persona name. Read it from the orchestrator identity record (already loaded during session init and available on `sessionState`). Fall back to `"Your Valet assistant"` if unavailable.

**Delivery:** Add a synthetic `{ channelType: 'slack', channelId: '<user-dm-channel-id>' }` entry to `targets` and let the existing `channelRouter.sendInteractivePrompt` path handle it. The DM channel ID is obtained by calling Slack's `conversations.open` with the user's Slack user ID (stored in the Slack credential/token metadata). The Slack plugin's channel transport is the right place for a `resolveDmChannelId(userId)` helper that does this lookup and caches the result. If `conversations.open` fails, skip the DM fallback and log the error.

**Refs storage:** The DM fallback goes through the same `refs` → `channel_refs` path as any other channel delivery, so resolution (approve/deny) updates the DM message in-place exactly like a normal Slack thread approval.

**Best-effort:** The DM fallback is wrapped in the existing try/catch. If it fails, log the error and move on — the approval is still visible in the web UI for when the user eventually connects.

### What the DM looks like

The Block Kit message structure (same as the existing channel approval format from `2026-03-12-channel-approval-design.md`) with one additional section block inserted before the approval body:

```
┌─────────────────────────────────────────────────────────┐
│ 🔔 Approval needed (unattended run)                      │
│ Joan requested this while running workflow Weekly Report  │
├─────────────────────────────────────────────────────────┤
│ [existing approval body / summary]                       │
│ Tool: slack.send_message  •  Risk: medium                │
├─────────────────────────────────────────────────────────┤
│ [Approve]  [Deny]                                        │
└─────────────────────────────────────────────────────────┘
```

## Fix 2: Better agent error on approval expiry

**Location:** `packages/worker/src/durable-objects/session-agent.ts`, `expireInteractivePromptRow` method (~line 6628).

Replace the bare error string with a message that gives the agent actionable signal. The session context (unattended vs. interactive) is inferred from the processing queue row at expiry time:

```
Action "${toolId}" approval request expired without a response.

This likely means the session was running unattended (scheduled task or
automation) and no one saw the approval prompt. Do not retry this action
automatically — instead, let the user know that approval is needed and
ask them to re-run or approve it manually.
```

If the queue context indicates a workflow execution, append: `"(This run was triggered by workflow: {name}.)"`

This error is returned to the runner as `call-tool-result.error`, which OpenCode surfaces to the agent as the tool call result. The explicit "do not retry" instruction breaks the silent retry loop.

## Out of scope

- Slack DM delivery for interactive sessions with an active channel context (those already work).
- Push notifications / email fallback (TKAI-85).
- The companion issue for "Always Allow in scheduled automations" (TKAI-155).
- Changes to the `ACTION_APPROVAL_EXPIRY_MS` timeout — not changed here.

## Files affected

| File | Change |
|------|--------|
| `packages/worker/src/durable-objects/session-agent.ts` | Fix `'thread'` filter, add DM fallback, improve expiry error |
| `packages/worker/src/durable-objects/channel-router.ts` | No changes — existing `sendInteractivePrompt` handles DM target |
| `packages/plugin-slack/src/channels/` | Possibly: ensure `sendInteractivePrompt` supports user DM channel IDs, not just thread channel IDs |
