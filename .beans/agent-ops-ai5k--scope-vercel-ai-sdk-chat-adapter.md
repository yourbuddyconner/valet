---
# valet-ai5k
title: Scope Vercel AI SDK Chat adapter
status: todo
type: task
priority: medium
tags:
    - client
    - worker
    - architecture
    - streaming
    - ai-sdk
created_at: 2026-02-25T00:00:00Z
updated_at: 2026-02-25T00:00:00Z
closes: 18
---

Produce a written implementation plan (RFC) for adding Vercel AI SDK Chat compatibility to Valet via an adapter-first approach. No production code ships in this bean — the deliverable is a committed RFC document and follow-up tickets. The RFC must make a concrete recommendation (adapter vs full migration), map the existing V2 protocol to the AI SDK stream protocol, identify every file that Phase 1 implementation would touch, and define a test plan for stream/message parity.

## Problem

The project uses a fully custom WebSocket chat stack: a bespoke `use-chat.ts` hook on the client, a V2 parts-based streaming protocol between Runner → SessionAgent DO → browser, and hand-rolled message state management via Zustand. This works, but it is a maintenance island:

- New contributors must learn a proprietary protocol instead of using ecosystem-standard hooks.
- Features that AI SDK gives for free (reconnection, stream recovery, optimistic UI, multi-step tool call rendering) must be reimplemented.
- Future surfaces (mobile app, embeddable widget, third-party integrations) would each need to reimplement the custom protocol.

The Vercel AI SDK (v5/v6) defines a well-documented SSE stream protocol and a `useChat` hook that handles message state, streaming status, tool calls, and error recovery out of the box. If Valet can expose an AI SDK-compatible endpoint, any AI SDK client can connect with zero custom code.

## Current Architecture (what exists today)

### Message flow

```
OpenCode (agent) → Runner (Bun) → SessionAgent DO (CF Worker) → Browser (React)
                   ─── WebSocket (V2 protocol) ──────────────→ ─── WebSocket ──→
```

### V2 protocol events (Runner → DO → client)

| V2 Event | Payload shape | Purpose |
|----------|--------------|---------|
| `message.create` | `{ turnId, channelType?, channelId?, opencodeSessionId? }` | Start a new assistant turn |
| `message.part.text-delta` | `{ turnId, delta }` | Incremental text token |
| `message.part.tool-update` | `{ turnId, callId, toolName, status, args?, result?, error? }` | Tool call lifecycle |
| `message.finalize` | `{ turnId, reason, finalText?, error? }` | Turn complete |
| `complete` | `{}` | Agent idle, ready for next prompt |
| `agentStatus` | `{ status, detail? }` | Agent state (idle/thinking/streaming/tool_calling/error) |

### Client-side events (DO → browser WebSocket)

| WS Event | Shape |
|----------|-------|
| `init` | Full session hydration (messages[], models, users, audit log) |
| `message` | Complete message object |
| `message.updated` | Updated message with parts |
| `chunk` | `{ content, messageId? }` (legacy text delta) |
| `status` | Session status change |
| `question` | Agent asking for user input |
| `agentStatus` | Agent state change |
| `error` | Error message |

Plus ~10 more event types for git state, diffs, reviews, child sessions, etc.

### Message/part types (`packages/shared`)

```typescript
type MessagePart = TextPart | ToolCallPart | FinishPart | ErrorPart;

interface TextPart    { type: 'text'; text: string; streaming?: boolean }
interface ToolCallPart { type: 'tool-call'; callId: string; toolName: string;
                         status: 'pending'|'running'|'completed'|'error';
                         args?: unknown; result?: unknown; error?: string }
interface FinishPart  { type: 'finish'; reason: 'end_turn'|'error'|'canceled' }
interface ErrorPart   { type: 'error'; message: string }
```

### Key files

| File | Role |
|------|------|
| `packages/client/src/hooks/use-chat.ts` | Custom chat hook (state, WS, send/abort/answer) |
| `packages/client/src/hooks/use-websocket.ts` | Generic WS hook with reconnect |
| `packages/shared/src/types/index.ts` | Message, Session, User types |
| `packages/shared/src/types/message-parts.ts` | MessagePart union |
| `packages/worker/src/durable-objects/session-agent.ts` | DO: WS handling, turn aggregation, broadcast |
| `packages/runner/src/types.ts` | RunnerToDOMessage types |
| `packages/runner/src/prompt.ts` | OpenCode event → V2 message conversion |
| `packages/runner/src/agent-client.ts` | Runner → DO WebSocket client |

## AI SDK Stream Protocol (target)

The AI SDK v5/v6 data stream protocol uses SSE with these event types:

| SSE Event | JSON shape |
|-----------|-----------|
| `message-start` | `{ type: "start", messageId }` |
| `text-start` | `{ type: "text-start", id }` |
| `text-delta` | `{ type: "text-delta", id, delta }` |
| `text-end` | `{ type: "text-end", id }` |
| `tool-input-start` | `{ type: "tool-input-start", toolCallId, toolName }` |
| `tool-input-delta` | `{ type: "tool-input-delta", toolCallId, inputTextDelta }` |
| `tool-input-available` | `{ type: "tool-input-available", toolCallId, toolName, input }` |
| `tool-output-available` | `{ type: "tool-output-available", toolCallId, output }` |
| `start-step` / `finish-step` | Step boundary markers |
| `message-finish` | `{ type: "finish" }` |
| `error` | `{ type: "error", errorText }` |

Required response header: `x-vercel-ai-ui-message-stream: v1`

### useChat contract

- POST to endpoint (default `/api/chat`) with `{ messages, ...config }`
- Server returns SSE stream in the format above
- Hook manages `UIMessage[]` state with `id`, `role`, `parts[]`
- Status lifecycle: `ready → submitted → streaming → ready`
- `sendMessage()`, `stop()`, `regenerate()`, `addToolOutput()`

## Design: Recommendation and Mapping

### Recommendation: Adapter mode

Full migration is premature. The existing V2 protocol carries domain-specific events (git state, diffs, reviews, child sessions, questions, multiplayer presence) that have no AI SDK equivalent. Replacing the WS transport would mean losing those features or shoe-horning them into custom data events.

Instead, add a **thin SSE adapter endpoint** in the worker that translates the internal V2 event stream into AI SDK-compatible SSE. The existing WebSocket flow stays untouched. Clients that want AI SDK compatibility use the new endpoint; the existing `use-chat.ts` hook continues to work for the full-featured UI.

### Protocol mapping: V2 → AI SDK SSE

| V2 Event | AI SDK SSE Event(s) |
|----------|-------------------|
| `message.create` | `message-start` → `text-start` |
| `message.part.text-delta` | `text-delta` |
| `message.part.tool-update` (status=pending) | `tool-input-start` |
| `message.part.tool-update` (status=running, has args) | `tool-input-available` |
| `message.part.tool-update` (status=completed) | `tool-output-available` |
| `message.finalize` (reason=end_turn) | `text-end` → `finish-step` → `message-finish` |
| `message.finalize` (reason=error) | `error` → `message-finish` |
| `message.finalize` (reason=canceled) | `text-end` → `message-finish` |
| `agentStatus` | No direct mapping — emit as `data-agent-status` custom event |
| `question` | No direct mapping — emit as `data-question` custom event |
| `status`, `git-state`, `diff`, etc. | No mapping — these are domain events, not chat events |

### Architecture

```
Browser (useChat)
    ↓ POST /api/sessions/:id/chat
    ↓ SSE response
Worker route handler
    ↓ Opens internal WS to SessionAgent DO
    ↓ Translates V2 WS events → AI SDK SSE events
    ↓ Writes SSE frames to response stream
SessionAgent DO (unchanged)
    ↓ Existing V2 protocol
Runner ↔ OpenCode (unchanged)
```

The adapter is a single route handler that:
1. Accepts the AI SDK POST body (`{ messages }`)
2. Extracts the latest user message
3. Opens an internal WS connection to the SessionAgent DO (same as the existing client path)
4. Sends a `prompt` message over WS
5. Reads V2 events from the WS and translates them to SSE frames
6. Streams SSE frames back to the HTTP response
7. Closes when `message.finalize` or `complete` is received

### What useChat gets for free

With just the adapter endpoint, an AI SDK `useChat` client gets:
- Streaming text display with proper status transitions
- Tool call rendering (pending → running → completed)
- Message history management
- Stop/abort support (client closes the SSE connection; adapter sends `abort` over WS)
- Error handling

### What useChat does NOT get (domain events)

These features are Valet-specific and have no AI SDK equivalent:
- Session status changes (initializing, hibernating, etc.)
- Git state (branch, PR, commits)
- Diff / code review results
- Child session spawning
- Multiplayer presence (user.joined / user.left)
- Agent question prompts (approval gates)
- Audit log entries
- Toast notifications

For the full-featured UI, keep using the existing `use-chat.ts` WebSocket hook. The AI SDK adapter is for simpler surfaces (embeddable widget, mobile app, third-party integrations) that only need the chat experience.

## Phase 1 — Minimal adapter (implementation scope)

### New files

| File | Purpose |
|------|---------|
| `packages/worker/src/routes/chat-adapter.ts` | SSE adapter route: `POST /api/sessions/:id/chat` |
| `packages/worker/src/lib/ai-sdk-stream.ts` | V2 → AI SDK SSE event translator |
| `packages/shared/src/types/ai-sdk.ts` | AI SDK SSE event type definitions |

### Modified files

| File | Change |
|------|--------|
| `packages/worker/src/index.ts` | Mount `chatAdapterRouter` |

### Dependencies

| Package | Where | Why |
|---------|-------|-----|
| None | — | The adapter emits raw SSE text; no `@ai-sdk/*` dependency needed on the server |
| `@ai-sdk/react` | `packages/client` (optional) | Only needed if we want to demo `useChat` in the existing client |

### Route spec: `POST /api/sessions/:id/chat`

```
Auth: Bearer token (same as existing routes)
Content-Type: application/json
Body: { messages: UIMessage[] }  // AI SDK format

Response:
  Content-Type: text/event-stream
  x-vercel-ai-ui-message-stream: v1
  Body: SSE frames per AI SDK data stream protocol
```

### Translator pseudocode

```typescript
function translateV2ToAISDK(v2Event: WSEvent): SSEFrame[] {
  switch (v2Event.type) {
    case 'message':
    case 'message.updated':
      // Full message — used for init hydration, skip during streaming
      return [];

    case 'chunk':
      // Legacy text delta — map to text-delta
      return [{ type: 'text-delta', id: v2Event.messageId, delta: v2Event.content }];

    case 'message.create':
      return [
        { type: 'start', messageId: v2Event.turnId },
        { type: 'text-start', id: v2Event.turnId },
      ];

    case 'message.part.text-delta':
      return [{ type: 'text-delta', id: v2Event.turnId, delta: v2Event.delta }];

    case 'message.part.tool-update':
      return translateToolUpdate(v2Event);

    case 'message.finalize':
      return translateFinalize(v2Event);

    default:
      // Domain events — emit as custom data if useful, otherwise skip
      return [];
  }
}
```

## Phase 2 — Feature flag + client experiment

### New files

| File | Purpose |
|------|---------|
| `packages/client/src/hooks/use-ai-chat.ts` | Thin wrapper around `useChat` from `@ai-sdk/react`, configured with the adapter endpoint |
| `packages/client/src/components/sessions/ai-chat-panel.tsx` | Experimental chat panel using the AI SDK hook |

### Modified files

| File | Change |
|------|--------|
| `packages/client/package.json` | Add `@ai-sdk/react` dependency |
| Session editor page | Feature flag to swap between custom hook and AI SDK hook |

## Phase 3 — Hardening

- Test suite for the V2 → AI SDK translator (unit tests for each event mapping)
- Integration test: send a prompt through the adapter, verify the SSE stream matches AI SDK expectations
- Test stream recovery / reconnection behavior
- Test abort (client disconnect → agent abort)
- Document the adapter architecture and its limitations (no domain events)

## Test Plan

### Unit tests (`packages/worker/src/lib/ai-sdk-stream.test.ts`)

| Test | Assertion |
|------|-----------|
| `message.create` → `start` + `text-start` | Correct SSE event types and IDs |
| `message.part.text-delta` → `text-delta` | Delta content preserved |
| `message.part.tool-update` (pending) → `tool-input-start` | toolCallId and toolName correct |
| `message.part.tool-update` (running+args) → `tool-input-available` | Input object correct |
| `message.part.tool-update` (completed) → `tool-output-available` | Output object correct |
| `message.finalize` (end_turn) → `text-end` + `finish-step` + `message-finish` | Correct sequence |
| `message.finalize` (error) → `error` + `message-finish` | Error text preserved |
| `message.finalize` (canceled) → `text-end` + `message-finish` | Clean termination |
| Unknown V2 event → empty array | No crash, no output |
| Full turn lifecycle | Create → deltas → tool → finalize produces valid SSE stream |

### Integration tests (future, Phase 3)

- Round-trip: POST to adapter → verify SSE stream is parseable by `@ai-sdk/react` internals
- Abort: client closes connection → verify DO receives abort
- Auth: unauthenticated request → 401
- Session access: wrong user → 403

## Non-Goals

- No removal or deprecation of the existing `use-chat.ts` WebSocket hook
- No changes to Runner ↔ DO protocol
- No changes to SessionAgent DO internals
- No AI SDK dependency on the server side (pure SSE text output)
- No Slack/Telegram/channel transport changes

## Risks / Open Questions

1. **SSE vs WebSocket for the adapter.** AI SDK expects SSE (HTTP streaming). The existing DO speaks WebSocket. The adapter bridges the two, but this means one extra hop and connection. Is the latency acceptable? (Likely yes — it's all within the same CF edge.)

2. **Message history.** AI SDK `useChat` sends the full message history on each POST. The SessionAgent DO already has its own message history. Should the adapter ignore the AI SDK history and just extract the latest user message? (Recommended: yes, treat the DO as the source of truth.)

3. **Tool output flow.** AI SDK supports `addToolOutput()` for client-side tool execution. Valet tools run server-side (in the sandbox). The adapter should NOT expose `addToolOutput` — tools are handled internally. But the AI SDK client needs to know tools are "server-executed" so it doesn't wait for client-side output.

4. **Multiple concurrent turns.** The existing protocol supports channel-scoped turns (channelType + channelId). The AI SDK adapter would only expose the default channel. Multi-channel support is out of scope for the adapter.

5. **Question/approval gates.** When the agent asks a question (`question` event), the custom UI shows a prompt. The AI SDK adapter has no native way to represent this. Options: (a) emit as a custom `data-question` event and require custom client handling, (b) emit as an assistant text message asking the question. Option (b) is simpler but loses the structured question/answer flow.

## Follow-Up Tickets

- `feat(worker): add AI SDK SSE adapter endpoint (POST /api/sessions/:id/chat)` — Phase 1 implementation
- `feat(client): add experimental useChat path behind feature flag` — Phase 2 client experiment
- `test(worker): V2 → AI SDK stream translator test suite` — Phase 3 unit tests
- `test(worker): AI SDK adapter integration tests` — Phase 3 integration tests
- `docs(architecture): AI SDK adapter design and limitations` — Phase 3 documentation

## Acceptance Criteria

- [ ] RFC document committed at `docs/rfcs/ai-sdk-chat-adapter.md`
- [ ] Clear recommendation: adapter mode (not full migration), with rationale
- [ ] Complete V2 → AI SDK protocol mapping table
- [ ] Identified list of files to create/modify for Phase 1
- [ ] Test plan defined for stream/message parity (unit + integration)
- [ ] Follow-up implementation tickets created as GitHub issues
- [ ] Open questions documented with recommended resolutions
