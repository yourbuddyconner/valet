# Slack Thread Auto-Binding

**Date:** 2026-06-08  
**Status:** Approved

## Problem

When Valet sends a Slack message (from a scheduled automation, an agent action, or any outbound send), Slack users can always reply in that thread. Currently no channel binding exists for the resulting thread, so replies produce a new Valet session via the orchestrator instead of routing back to the session that sent the original message.

## Desired Behavior

Every outbound Slack message that has a session context automatically creates a channel binding for the resulting thread. Replies in that thread route back to the originating session. If that session has since terminated, the system walks up to the parent session before falling back to the orchestrator.

## Scope

**In scope:**
- Auto-binding on all session-bound outbound Slack sends
- Parent-chain fallback (one level) on stale binding eviction

**Out of scope:**
- System-level sends with no session context (OAuth prompts, slash command acks)
- Changes to binding queue mode defaults
- Changes to how bindings are displayed in the integrations UI

## Architecture

### Outbound Binding Creation

The Slack API's `chat.postMessage` response includes a `ts` field. That `ts` becomes the `thread_ts` for all replies to the message. After every session-bound Slack send, call `ensureChannelBinding()` with:

- `sessionId` — the originating session
- `channelType: 'slack'`
- `channelId` — composite `teamId:slackChannelId:ts` (3-part thread scope)
- `slackChannelId` — the raw Slack channel ID
- `slackThreadTs` — the returned `ts`
- `queueMode: 'followup'`

`ensureChannelBinding()` uses `onConflictDoUpdate`, so this is idempotent. If the same thread is already bound to another session, the most recent sender takes ownership — correct behavior when a child session sends into a parent-owned thread.

**Touch point 1 — `packages/worker/src/durable-objects/channel-router.ts` (~line 82)**

The session DO routes outbound agent responses to Slack here via `transport.sendMessage()`. The return value already contains `messageId` (the Slack `ts`). After a successful send, create the binding. The routing target provides team ID and channel ID.

**Touch point 2 — `packages/worker/src/durable-objects/session-agent.ts` (`executeActionAndSend`)**

After `executeActionSvc` returns a successful result for `slack.send_message`, `slack.dm_owner`, or `slack.dm_user`, the DO reads `result.data.ts` and `result.data.channel`, looks up the Slack team ID from the org's install record, and creates the binding fire-and-forget. The action plugin itself is not modified — session context (sessionId, orgId) is only available in the DO, not in the action handler. Skips binding when `params.thread_ts` is set, since replies in existing threads always use the root message's `thread_ts` which already has a binding.

Sends without session context — `slack-events.ts` OAuth prompts, `channel-webhooks.ts` status/ack messages — have no `sessionId` and are not modified.

### Inbound Routing: Parent-Chain Fallback

Location: `packages/worker/src/routes/channel-webhooks.ts`, stale binding eviction block.

Current behavior:
```
binding found, session is terminated/archived/error
  → delete binding
  → fall through to orchestrator
```

New behavior:
```
binding found, session is terminated/archived/error
  → check session.parentSessionId
  → parent exists AND parent status is active/waiting/etc?
      → upsert binding to point to parent session
      → route to parent
  → otherwise (no parent, or parent also dead)
      → delete binding
      → fall through to orchestrator
```

Upserting the binding (rather than a one-shot route) means future messages in the same thread route directly to the parent without repeating the eviction check.

The parent lookup is a single `sessions` table read by `parentSessionId`. "Alive" means status is not in `{ terminated, archived, error }` — the same condition already used for stale detection. Only one level of parent walking is performed; if the parent is also dead, the binding is deleted and the message falls through to the orchestrator.

## Error Handling

| Scenario | Behavior |
|---|---|
| `ensureChannelBinding()` fails after successful send | Log error, do not fail the send. Thread behaves as unbound; replies fall through to orchestrator. |
| Slack API returns no `ts` on success | Log warning, skip binding creation. |
| Parent session found but also terminated | Delete binding, fall through to orchestrator. |
| Parent session found and alive | Upsert binding to parent, route message to parent. |

## Files Changed

| File | Change |
|---|---|
| `packages/worker/src/durable-objects/channel-router.ts` | Surface `messageId` in `SendReplyResult` |
| `packages/worker/src/durable-objects/session-agent.ts` | Create binding after channel reply and after Slack send actions |
| `packages/worker/src/lib/db/channels.ts` | Extend `ensureChannelBinding` to accept and persist `slackChannelId`/`slackThreadTs` |
| `packages/worker/src/routes/channel-webhooks.ts` | Add parent-chain walk to stale eviction logic |
