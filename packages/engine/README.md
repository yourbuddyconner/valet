# @valet/engine

Prototype implementation of the portable runtime engine described in
[`docs/specs/2026-05-02-portable-runtime-engine-design.md`](../../docs/specs/2026-05-02-portable-runtime-engine-design.md).

This is the V1 in-repo engine library. It runs the agent loop, owns
session/thread state, executes tools, and emits typed events. Platform
adapters (Cloudflare, Kubernetes) host this library; this package itself
has zero platform dependencies.

## What works in this prototype

- Engine public API: `createSession`, `getSession`, `deleteSession`, `Session.prompt`,
  `Session.thread()`, `Session.resolveDecision`, `Session.withdrawDecision`,
  `Session.abort/pause/resume`.
- Per-thread state: each thread gets its own `pi-agent-core` `Agent`
  instance with its own queue and DAG history.
- Per-thread queue modes: `followup` (FIFO), `steer` (abort + start),
  `collect` (buffered window).
- Decision gates: tool calls `ctx.requestDecision({...})` to suspend the
  turn. The gate is persisted, a `DecisionGateEntry` lands in the DAG, the
  engine emits `decision_gate`, and the turn resumes when the user calls
  `session.resolveDecision()`. Pending gates withdraw on `steer` or
  `abort` and expire after `expiresAt`.
- Multi-thread: threads run concurrently, share the sandbox, and have
  isolated histories. Aborting one thread doesn't affect siblings.
- Built-in `thread_read` tool: a thread can read recent messages from a
  sibling, parent, or child thread.
- Built-in tools: `read`, `write`, `edit`, `bash`, `thread_read`.
- In-memory providers: `InMemorySessionStore`, `InMemoryEventBus`,
  `InMemoryBlobStore`, `InMemoryCredentialStore`, `VirtualSandbox` /
  `VirtualSandboxProvider` (in-memory FS + a small whitelist of safe shell
  commands). These double as test fixtures.

## What's deferred (post-prototype)

- **Restart-safe re-entrant decision gates.** Today `requestDecision`
  returns a Promise that resolves when the user resolves the gate. That's
  correct for an in-process engine but doesn't survive process restarts.
  The persisted `SuspendedTurnState` record is written, but
  `Engine.restoreSession` is a stub. Once we have a persistent store, we
  re-prompt on restart and short-circuit `requestDecision` using
  `ctx.suspendedDecision` (already plumbed through `ToolContext`).
- **Compaction.** Token-aware context compression is not implemented.
  `CompactionEntry` is in the DAG schema; the algorithm itself is a
  follow-up.
- **Roles & skills loading.** The types are defined, but role and skill
  resolution at prompt time is not wired in.
- **Model failover.** Single-model only for now.
- **Plugin Action Bridge.** The `actionSourceToTools` adapter described
  in the spec is not implemented yet — plugins should currently export
  `ToolDef[]` directly.
- **Structured results.** Schema-validated output extraction with
  `---RESULT_START---` delimiters is not implemented.
- **Engine restoration.** `Engine.restoreSession()` throws; full
  rehydration of running queues + suspended turns is a follow-up.

## Spec-vs-reality deltas (notes from the pi-ai/pi-agent-core spike)

The spec was written before pinning the API surface of `pi-ai` /
`pi-agent-core`. The implementation reconciles:

1. **`ToolDef.execute(args, ctx)` vs `AgentTool.execute(toolCallId, params, signal, onUpdate)`.**
   The spec keeps the spec-faithful `ToolDef` shape as the public type;
   internally we wrap each `ToolDef` to a pi `AgentTool` via
   `tool-bridge.ts` and capture `ToolContext` in a closure.
2. **No native turn-suspension primitive.** pi-agent-core's
   `beforeToolCall` can `{ block: true }` (deny path) but doesn't pause.
   For a "wait for human" gate we await a Promise inside the tool.
3. **`message_start` vs `message_update`.** pi-agent-core fires
   `message_start` once per assistant message; `message_update` carries
   delta events (text, thinking, tool calls). The engine subscribes to
   both.
4. **Custom `AgentMessage` types via `convertToLlm`.** The engine could
   later persist `DecisionGateEntry` etc. as custom AgentMessages
   alongside the LLM transcript, then filter them out before each LLM
   call. We don't need this in the prototype because we persist via the
   SessionStore directly, but the pattern is useful when we want
   in-context awareness of past gates.

## Tests

```sh
pnpm --filter @valet/engine test
```

Covers: happy path (3), decision gates (4), queue modes (4),
multi-thread + thread_read (3) — 14 tests total, all in <2s.
