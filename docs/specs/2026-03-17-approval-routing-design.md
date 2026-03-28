# Fail-Closed Approval Routing with Thread-Aware Channel Context

## Problem

When `sendChannelInteractivePrompts` has no `originTarget` (because the prompt came from the web UI or `activeChannel` is null), it falls back to fetching **all user channel bindings** from D1 and broadcasting the approval to every one of them. This caused an approval to be posted to ~14 Slack threads (DMs and public channels) simultaneously.

The root cause: `activeChannel` depends on `pendingChannelReply`, which is only set for non-web channels (`requiresExplicitChannelReply('web')` returns false). When a user steers an orchestrator from the web UI, `pendingChannelReply` is null, so the approval context has no channel info, and the fallback broadcasts everywhere.

A secondary symptom: the steering message "disappeared" from the web UI because `flushPendingChannelReply` had nothing to flush — the response was processed but had no channel to route back to.

## Design

### Two Channel Dimensions

Every prompt in an orchestrator session has two relevant channel contexts:

1. **Thread origin channel** — the Slack channel + thread_ts that created this orchestrator thread. Stored in `channel_thread_mappings` in D1. Stable over the lifetime of the thread. Retrieved by looking up the current `threadId`.

2. **Most recent caller channel** — where the last message came from. Could be the web UI, could be the same Slack thread as the origin, could be a *different* Slack thread (multiple Slack threads can route into the same orchestrator thread).

Today's code only tracks `pendingChannelReply` (the caller), and only for non-web channels. The thread origin is never consulted for approval routing.

### Change 1: Recover thread origin as `pendingChannelReply` fallback

When a prompt is dispatched (both direct and queue paths), after the existing `requiresExplicitChannelReply` check:

- If `pendingChannelReply` would be null (web UI message) but the prompt has a `threadId`:
  - Query `channel_thread_mappings` in D1 for the thread's origin `channelType` + `channelId`
  - If found, set `pendingChannelReply` to the origin channel
  - If no mapping exists (pure web-originated thread), leave null

This fixes both the approval routing (origin channel is available as `activeChannel`) and the auto-reply flush (steering responses route back to the Slack thread).

### Change 2: Approval routing sends to origin + caller

In `sendChannelInteractivePrompts`, replace the current logic with:

1. Determine the **origin target** from `prompt.context` (channelType + channelId stored at approval creation time — this comes from `activeChannel`, which Change 1 ensures is set)
2. Determine the **caller target** from `this.activeChannel` at send time (may differ from origin if the prompt came from a different channel)
3. Build a deduplicated target list:
   - Add origin target (if non-web)
   - Add caller target (if non-web and different from origin)
4. Send to each target
5. Web UI always gets the approval via the existing `broadcastToClients` call (line ~9061), which is outside this method

### Change 3: Fail closed — never broadcast to all bindings

Remove the entire else branch that calls `listUserChannelBindings` / `getSessionChannelBindings` and iterates all bindings.

If no origin target can be determined:
- Log an error: `"No origin target for interactive prompt — refusing to broadcast"`
- Broadcast an error event to web UI clients via `broadcastToClients({ type: 'error', message: '...' })` so the user sees the failure in the dashboard
- Return early — no Slack messages sent
- The approval remains visible and actionable in the web UI (the `broadcastToClients` of the prompt itself at line ~9061 still fires)

### Files Changed

| File | Location | Change |
|------|----------|--------|
| `session-agent.ts` | ~line 1972 (direct dispatch) | After `requiresExplicitChannelReply` check, add thread origin lookup from `channel_thread_mappings` as fallback for `pendingChannelReply` |
| `session-agent.ts` | ~line 7034 (queue dispatch) | Same thread origin lookup fallback |
| `session-agent.ts` | ~line 9384-9474 (`sendChannelInteractivePrompts`) | Replace all-bindings fallback with: origin + caller targeting, fail-closed error if neither exists |

### What Doesn't Change

- Happy path (Slack message -> approval -> same Slack thread) is unchanged
- Web UI broadcast of approvals (`broadcastToClients`) is unchanged
- `requiresExplicitChannelReply` logic is unchanged
- Channel binding creation is unchanged
- `channel_thread_mappings` schema is unchanged (read-only use)

### Edge Cases

- **Pure web-originated thread (no Slack origin):** No `channel_thread_mappings` entry. `pendingChannelReply` stays null. Approval only shows in web UI. No error because web UI delivery is sufficient.
- **Multiple Slack threads subscribed to same orchestrator thread:** Only origin + caller get the approval, not all subscribers. Other subscribers see the approval resolution when the agent responds in their thread context.
- **Orchestrator autonomous action (no active prompt):** `activeChannel` is null, approval context has no channel. Fail-closed: error to web UI, approval visible only there.
