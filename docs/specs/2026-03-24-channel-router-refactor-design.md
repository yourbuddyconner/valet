# Channel Router Refactor — Design Spec

**Date:** 2026-03-24
**Linear:** TKAI-9
**Status:** Draft

## Problem

The channel router has an auto-reply code path that automatically sends the agent's last response to the originating Slack channel/thread when a prompt cycle completes — even if the agent didn't explicitly call `channel_reply`. This causes:

1. **Internal messages leak to Slack** — orchestrator internal chatter gets posted to user-facing threads
2. **Double-posting** — when the agent calls `channel_reply`, the auto-reply fires too with a slightly different version

Beyond the bug, channel dispatch logic is scattered across three places in session-agent.ts: `handleChannelReply()` (~130 lines), `sendChannelInteractivePrompts()` (~45 lines), and `updateChannelInteractivePrompts()` (~40 lines). All three duplicate the same token-resolution + channelId-parsing + transport-dispatch pattern. Meanwhile `ChannelRouter` only tracks auto-reply state and `services/channel-reply.ts` only serves the auto-reply path.

## Goals

1. Remove the auto-reply code path entirely — all channel messages sent exclusively via explicit `channel_reply` tool calls
2. Consolidate **all outbound channel dispatch** into `ChannelRouter` — explicit replies, interactive prompt sends, and interactive prompt updates
3. Move Slack shimmer clearing into the Slack transport where it belongs
4. Extract composite channelId parsing (`channel:thread_ts`) to a shared utility
5. Keep follow-up reminders as a soft safety net

## Non-Goals

- Treating the web UI as a channel (noted as a future TODO — the image message store write in `handleChannelReply` is the primary remaining coupling)
- Changing the `channel_reply` OpenCode tool, Runner gateway route, or agent-client WebSocket protocol
- Modifying the follow-up reminder alarm logic

## Design

### ChannelRouter — New Shape

`ChannelRouter` becomes the single dispatch service for all outbound channel operations. It owns: active channel tracking, transport resolution, token resolution, composite channelId parsing, outbound message building, interactive prompt dispatch, and follow-up lifecycle notifications.

It is a **helper class scoped to one DO instance** — not a Durable Object, not a standalone service. Constructed with injected dependencies for testability.

#### Constructor Dependencies

```ts
interface ChannelRouterDeps {
  /** Resolve auth token for a channel. Implementation branches on channelType (Slack uses org-level bot token, others use per-user credentials). */
  resolveToken(channelType: string, userId: string): Promise<string | undefined>;
  /** Resolve persona identity for Slack messages. Must not throw — returns undefined if unavailable. */
  resolvePersona(userId: string): Promise<Persona | undefined>;
  /** Callback when a substantive reply is sent — DO uses this to resolve follow-up reminders. */
  onReplySent(channelType: string, channelId: string): void;
}
```

The `resolveToken` callback is implemented by the DO using `getSlackBotToken(env)` for Slack and `getCredential(env, 'user', userId, channelType)` for other channels. The `resolvePersona` callback wraps `resolveOrchestratorPersona(appDb, userId)` with a `.catch(() => undefined)` guard since persona resolution can throw when Slack isn't linked — a missing persona should degrade gracefully (send without persona), not fail the send. All three imports (`getSlackBotToken`, `getCredential`, `resolveOrchestratorPersona`) stay on session-agent.ts.

#### Public API

| Method | Purpose |
|--------|---------|
| `setActiveChannel(channel)` | Track which channel the current prompt is associated with. Called at prompt dispatch. |
| `clearActiveChannel()` | Clear on new prompt cycle or dispatch failure. |
| `get activeChannel` | Current channel context. Used by agent status broadcasts, approvals, etc. |
| `recoverActiveChannel(channelType, channelId)` | Restore tracking state after DO hibernation from prompt_queue data. Sets in-memory state so subsequent `activeChannel` reads return it without hitting SQLite again. |
| `sendReply(opts): Promise<SendReplyResult>` | Explicit reply dispatch (text + optional file/image attachments). |
| `sendInteractivePrompt(opts): Promise<Array<{ channelType: string; ref: InteractivePromptRef }>>` | Send an interactive prompt (e.g. approval) to one or more channel targets. |
| `updateInteractivePrompt(opts): Promise<void>` | Update a previously sent interactive prompt with resolution status. |

#### sendReply

```ts
interface SendReplyOpts {
  userId: string;
  channelType: string;
  channelId: string;
  message: string;
  fileBase64?: string;
  fileMimeType?: string;
  fileName?: string;
  imageBase64?: string;    // legacy — normalized to file params internally
  imageMimeType?: string;  // legacy
  followUp?: boolean;      // default true — controls follow-up resolution
}

interface SendReplyResult {
  success: boolean;
  error?: string;
}
```

Internal flow:
1. Resolve transport via `channelRegistry.getTransport(channelType)`
2. Resolve token via `deps.resolveToken(channelType, userId)`
3. Parse composite channelId via shared `parseCompositeChannelId()`
4. Build `OutboundMessage` with attachments if present
5. Resolve persona via `deps.resolvePersona(userId)` for Slack
6. Call `transport.sendMessage(target, outbound, ctx)`
7. On success, call `deps.onReplySent(channelType, channelId)` if `followUp !== false`
8. Return result

#### sendInteractivePrompt

```ts
interface SendInteractivePromptOpts {
  userId: string;
  targets: Array<{ channelType: string; channelId: string }>;
  prompt: InteractivePrompt;
}
```

Internal flow (per target):
1. Resolve transport, check `transport.sendInteractivePrompt` exists
2. Resolve token via `deps.resolveToken(channelType, userId)`
3. Parse composite channelId via shared `parseCompositeChannelId()`
4. Call `transport.sendInteractivePrompt(target, prompt, ctx)`
5. Collect and return refs

Returns `Array<{ channelType: string; ref: InteractivePromptRef }>` — the DO stores these in SQLite as before.

#### updateInteractivePrompt

```ts
interface UpdateInteractivePromptOpts {
  userId: string | undefined;
  refs: Array<{ channelType: string; ref: InteractivePromptRef }>;
  resolution: InteractiveResolution;
}
```

Internal flow (per ref):
1. Resolve transport, check `transport.updateInteractivePrompt` exists
2. Resolve token via `deps.resolveToken(channelType, userId)`
3. Parse composite channelId via shared `parseCompositeChannelId()`
4. Call `transport.updateInteractivePrompt(target, ref, resolution, ctx)`
5. Log and swallow errors per-ref (matches current behavior)

### Composite ChannelId Parsing — Shared Utility

The `parseCompositeChannelId` function is currently duplicated: `parseSlackChannelId()` on session-agent.ts and `parseCompositeChannelId()` in `services/channel-reply.ts`. Both do the same thing — split `"C123:thread_ts"` into `{ channelId, threadId }`.

Extract to a shared utility in the SDK channel module (`@valet/sdk/channels`) since it's a transport-layer concern:

```ts
// packages/sdk/src/channels/index.ts
export function parseCompositeChannelId(
  channelType: string,
  channelId: string,
): ChannelTarget {
  if (channelType === 'slack' && channelId.includes(':')) {
    const idx = channelId.indexOf(':');
    return { channelType, channelId: channelId.slice(0, idx), threadId: channelId.slice(idx + 1) };
  }
  return { channelType, channelId };
}
```

ChannelRouter imports this. `parseSlackChannelId()` is removed from session-agent.ts.

### What Gets Removed

#### Deleted files
- `packages/worker/src/services/channel-reply.ts` — auto-reply dispatch service
- `packages/worker/src/durable-objects/channel-router.test.ts` — auto-reply state machine tests (replaced by new tests)

#### Removed from ChannelRouter
- `PendingReply` interface, `ReplyIntent` interface
- `trackReply()`, `setResult()`, `consumePendingReply()`, `markHandled()`, `recover()`
- `hasPending`, `pendingSnapshot` getters
- `handled` flag, `resultContent`, `resultMessageId` fields

#### Removed from session-agent.ts
- `flushPendingChannelReply()` — entire method (~70 lines)
- `channelRouter.setResult()` call in finalize turn handler
- `channelRouter.markHandled()` call in `handleChannelReply()`
- Auto-reply flush in `complete` handler
- Auto-reply tracking log in `complete` handler
- `channelRouter.clear()` + `channelRouter.trackReply()` blocks in `handlePrompt()` and `sendNextQueuedPrompt()` (replaced by `setActiveChannel()` calls)
- Shimmer clearing code block (~13 lines) in `handleChannelReply()` — moves to Slack transport
- `parseSlackChannelId()` private method — replaced by shared `parseCompositeChannelId()`
- `handleChannelReply()` transport/token/message-building logic (~80 lines) — moves to `ChannelRouter.sendReply()`
- `sendChannelInteractivePrompts()` transport/token logic (~45 lines) — replaced by thin call to `ChannelRouter.sendInteractivePrompt()`
- `updateChannelInteractivePrompts()` transport/token logic (~40 lines) — replaced by thin call to `ChannelRouter.updateInteractivePrompt()`
- `sendChannelReply` import removed
- `channelRegistry` import removed — all transport access goes through ChannelRouter

### What Stays on session-agent.ts

- **Wiring:** Constructing ChannelRouter with deps at DO construction
- **`setActiveChannel()` calls:** At prompt dispatch time in `handlePrompt()` and `sendNextQueuedPrompt()`
- **Runner communication:** Receiving `channel-reply` WebSocket message, calling `channelRouter.sendReply()`, forwarding result back via `runnerLink.send()`
- **Image message store write + broadcast:** After successful reply with image, writes system message to messageStore and broadcasts to web clients
  - `// TODO: Treat web UI as a channel — this is the primary remaining coupling between channel dispatch and the DO's message/broadcast layer`
- **Interactive prompt target collection + SQLite bookkeeping:** The DO's `sendChannelInteractivePrompts()` retains all pre-dispatch logic: building the `targets` array from origin + caller channels, deduplication, fail-closed `listUserChannelBindings` check, and error broadcast to web clients. Only the per-target dispatch loop moves to ChannelRouter. The DO methods become thin wrappers around the dispatch call:
  ```ts
  // Target collection + fail-closed check stays here (~20 lines)
  // Then dispatch + storage (~5 lines):
  const refs = await this.channelRouter.sendInteractivePrompt({ userId, targets, prompt });
  if (refs.length > 0) {
    this.ctx.storage.sql.exec('UPDATE interactive_prompts SET channel_refs = ? WHERE id = ?', JSON.stringify(refs), promptId);
  }
  ```
- **Follow-up SQLite writes:** `insertChannelFollowup()` at prompt dispatch, `resolveChannelFollowups()` triggered by `onReplySent` callback
- **Alarm-based follow-up reminders:** Reads pending followups from SQLite, injects system messages
- **Credential imports:** `getSlackBotToken` and `getCredential` stay — used to implement the `resolveToken` callback

### Slack Shimmer Clearing

Shimmer clearing moves into `SlackTransport.sendMessage()` — after a successful `chat.postMessage`, if the target has a `threadId`, it calls `this.setThreadStatus(target, '', ctx)`. Failure to clear shimmer is logged but does not fail the send.

This means any `sendMessage` to a threaded target clears shimmer. This is correct: shimmer means "agent is working", and posting a reply means the agent has produced output. If the agent sends multiple replies in one cycle, shimmer clears after the first — acceptable since the user already sees a response.

### activeChannel Getter — Simplified

The current `activeChannel` getter checks `channelRouter.pendingSnapshot` then falls back to `promptQueue.getProcessingChannelContext()`. After the refactor:

- `channelRouter.activeChannel` is the primary source (set via `setActiveChannel()` or `recoverActiveChannel()`)
- The DO's `activeChannel` getter keeps the lazy fallback pattern: checks `channelRouter.activeChannel` first, then falls back to `promptQueue.getProcessingChannelContext()` and calls `channelRouter.recoverActiveChannel()` if found. This ensures correctness across all wake-up paths (alarm, WebSocket reconnect, HTTP fetch) without requiring eager recovery.

### Channel Delivery Stamping

The auto-reply path stamped assistant messages with channel metadata (`stampChannelDelivery`) so the web UI could show a "sent to Slack" badge. The explicit `handleChannelReply()` path does not do this. With auto-reply removed, stamping is intentionally dropped — when the agent explicitly replies, the web UI already shows the `channel_reply` tool call.

### Telegram and Other Channels

The Telegram transport uses the same `ChannelTransport` contract. It does not use composite channelIds, shimmer, or persona resolution. The refactor is transparent to it — all three ChannelRouter dispatch methods resolve the transport generically and only apply Slack-specific behavior (persona, composite channelId) when applicable.

### Files Changed

| File | Change |
|------|--------|
| `packages/worker/src/durable-objects/channel-router.ts` | Rewrite: deps injection, `sendReply`, `sendInteractivePrompt`, `updateInteractivePrompt`, active channel tracking |
| `packages/worker/src/durable-objects/session-agent.ts` | Remove auto-reply code, delegate all channel dispatch to ChannelRouter, remove `parseSlackChannelId`, slim `handleChannelReply`/`sendChannelInteractivePrompts`/`updateChannelInteractivePrompts` to thin wrappers |
| `packages/sdk/src/channels/index.ts` | Add exported `parseCompositeChannelId()` utility |
| `packages/plugin-slack/src/channels/transport.ts` | Clear shimmer after successful `sendMessage` |
| `packages/plugin-slack/src/channels/transport.test.ts` | Update tests for shimmer-on-send behavior |
| `packages/worker/src/services/channel-reply.ts` | Delete |
| `packages/worker/src/durable-objects/channel-router.test.ts` | Rewrite for new ChannelRouter API |

### Acceptance Criteria

- [ ] Auto-reply path completely removed
- [ ] All outbound channel dispatch consolidated in ChannelRouter (replies + interactive prompts)
- [ ] ChannelRouter owns transport resolution, token resolution, message building
- [ ] Explicit `channel_reply` tool works for all channels (Slack, Telegram)
- [ ] Interactive prompts (approvals) dispatched through ChannelRouter
- [ ] No internal/orchestrator messages leak to Slack
- [ ] No double-posting of replies
- [ ] Slack shimmer cleared by transport, not by DO
- [ ] Composite channelId parsing extracted to shared SDK utility
- [ ] `parseSlackChannelId` removed from session-agent.ts
- [ ] `channelRegistry` no longer imported directly by session-agent.ts
- [ ] Follow-up reminders still function as a soft safety net
- [ ] ChannelRouter is unit-testable with injected deps
- [ ] TODO added for treating web UI as a channel
- [ ] Build passes
