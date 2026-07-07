# Session Tracing & Observability — Design Spec

**Date**: 2026-04-24

**Author**: Conner Swann

**Linear**: TKAI-49

**Prior art**: [Observability design (metrics/logging)](./2026-03-30-observability-design.md), [Braintrust OpenCode plugin](https://github.com/braintrustdata/braintrust-opencode-plugin)

---

## Goal

Add OpenTelemetry-native tracing across all three layers of the Valet stack (Worker DO, Runner, OpenCode) so that every agent session's lifecycle — from sandbox provisioning through LLM calls to teardown — is visible as correlated traces in Grafana Tempo.

This gives us: latency debugging, cost attribution, tool failure analysis, infrastructure performance visibility, and a foundation for SLOs and evals.

## Non-Goals

- Replacing the existing analytics/metrics pipeline (the [observability design spec](./2026-03-30-observability-design.md) covers Prometheus metrics and structured logging — that work is complementary, not replaced)
- Grafana dashboard creation (deployment concern)
- Alerting rules or SLO definitions
- Sampling strategy optimization (start with trace-everything, tune later)

---

## Core Design Decision: Multiple Traces Per Session

A Valet session is **not** a single request-response. It's a long-lived state machine that gets poked by various external events (webhooks, user messages, cron alarms) over hours or days. Modeling this as a single root span creates problems:

1. **Disjoint lifecycles** — A Slack webhook arrives, gets processed, and returns a 200 in milliseconds. That webhook triggers a sandbox restore that takes 30 seconds. The HTTP request is already finished before the sandbox even starts. These can't nest.

2. **Unbounded span duration** — A session can hibernate for days. OTel backends (Tempo, Jaeger) have practical limits on span duration and trace size. A trace that lives for days is useless in a trace viewer.

3. **Mismatched semantics** — Parent-child spans imply containment. But the webhook doesn't *contain* the sandbox restore — it *caused* it. OTel has a first-class primitive for this: span links.

### The model

Instead of one root span per session, each **discrete operation** gets its own trace. All traces for a session carry `valet.session.id` as a resource attribute. Causal relationships use **span links**.

```
Trace A: inbound.slack_webhook               (ms)
  ├── webhook.verify
  ├── prompt.enqueue
  └── [link → Trace B]

Trace B: sandbox.restore                      (seconds)
  ├── modal.api.restore
  ├── runner.reconnect
  └── prompt.dispatch
       [link → Trace C]

Trace C: agent.turn                           (seconds-minutes)
  ├── llm.call (claude-sonnet, 1523 in / 847 out)
  ├── tool.bash (git status, 42ms)
  ├── llm.call (follow-up)
  └── turn.finalize

All carry: valet.session.id=abc-123, valet.user.id=user-456
```

Grafana queries by `{resource.valet.session.id="abc-123"}` to see all traces for a session, ordered by time.

### Queue wait visibility

The time between prompt enqueue (end of inbound request trace) and prompt dispatch (start of turn trace) is user-perceived latency and must be visible. This gap occurs when the runner is busy, the sandbox is hibernated, collect mode is debouncing, or the runner is disconnected after a crash.

Rather than a fifth trace type, queue wait is captured as **attributes on the turn trace root span**:

| Attribute | Source | Purpose |
|---|---|---|
| `valet.queue.wait_ms` | `promptReceivedAt` → dispatch delta | Total time prompt sat in queue |
| `valet.queue.reason` | Queue state at enqueue time | Why it was queued: `runner_busy`, `sandbox_hibernated`, `collect_debounce`, `runner_disconnected` |
| `valet.collect.message_count` | Collect mode buffer | How many messages were batched (collect mode only) |
| `valet.collect.buffer_ms` | Collect mode timing | How long the debounce buffer was open |

The turn trace root span also carries a **span link** back to the inbound request trace that enqueued the prompt, so you can click through from "this turn was slow to start" to "because this webhook arrived while the runner was busy."

This makes queue wait directly queryable: `{name="valet.turn" && valet.queue.wait_ms > 5000}`.

### Four trace types

| Trace type | Lifetime | Root span created by | Example triggers |
|---|---|---|---|
| **Inbound request** | ms-seconds | Worker HTTP handler | Slack webhook, user prompt via API, WebSocket message |
| **Sandbox lifecycle** | seconds-minutes | SessionAgentDO | Spawn, restore, hibernate, terminate |
| **Agent turn** | seconds-minutes | Runner prompt handler | Prompt dispatched → LLM calls → tools → response |
| **Runner bootstrap** | seconds-minutes | Runner bin.ts | Process start → WS connect → OpenCode healthy → idle |

---

## Trace Context Propagation

The critical challenge: stitching spans across three runtimes (Worker, Runner, OpenCode) into correlated traces.

### Propagation path

```
                     ┌─────────────────┐
                     │  Inbound HTTP    │
                     │  (own trace)     │
                     └───────┬─────────┘
                             │ span link + session_id
                     ┌───────▼─────────┐
                     │  Worker DO       │
                     │  (lifecycle ops) │
                     └───────┬─────────┘
                             │ TRACEPARENT in:
                             │  - env vars (spawn)
                             │  - runner protocol msg (prompt)
                     ┌───────▼─────────┐
                     │  Runner          │
                     │  (bootstrap +    │
                     │   turn handling) │
                     └───────┬─────────┘
                             │ TRACEPARENT in:
                             │  - HTTP header (prompt_async)
                             │  - env var inheritance
                     ┌───────▼─────────┐
                     │  OpenCode Plugin │
                     │  (LLM + tools)  │
                     └─────────────────┘
                             │
                     All export OTLP ──► Grafana Tempo
```

### Mechanism by layer boundary

| Boundary | Propagation method | Details |
|---|---|---|
| HTTP client → Worker | W3C `traceparent` header | Standard; load balancer / client may set this |
| Worker → Runner (initial) | `TRACEPARENT` env var in sandbox spawn request | Set in `env-assembly.ts`, carried through Modal to process env |
| Worker → Runner (per-prompt) | `traceparent` field on runner protocol `prompt` message | New optional field; backward-compatible |
| Worker → Runner (per-workflow) | `traceparent` field on `workflow-execute` message | Same pattern |
| Runner → OpenCode | `Traceparent` HTTP header on `POST /session/:id/prompt_async` | Standard W3C header |
| Runner → OpenCode (env) | `TRACEPARENT` env var inherited by OpenCode process | Set by runner, available to plugins |

### What gets stored

The DO stores `traceId` for the current session lifecycle trace in `SessionState` (persisted to SQLite). This allows:
- Span links from inbound request traces to the active lifecycle trace
- Trace context restoration after hibernation (the `traceId` survives in state)
- Analytics events to carry `trace_id` for correlation with traces

---

## Layer 1: Worker DO Instrumentation

**Runtime**: Cloudflare Workers (`packages/worker/`)

### OTel SDK approach

CF Workers have no Node.js APIs and limited async context. We use `@opentelemetry/sdk-trace-base` with a fetch-based OTLP exporter. Manual context passing (no automatic context propagation via AsyncLocalStorage).

Each instrumented function receives a `SpanContext` parameter explicitly. The DO holds a `Tracer` instance initialized in the constructor.

### Spans by trace type

**Inbound request traces** (created in route handlers):

| Span | Source file | Key attributes |
|---|---|---|
| `valet.http.request` | `src/lib/metrics/http-metrics.ts` | `http.method`, `http.route`, `http.status_code` |
| `valet.webhook.process` | `src/routes/channels.ts` | `valet.channel.type`, `valet.user.id` |
| `valet.prompt.enqueue` | `src/routes/sessions.ts` or channel handler | `valet.session.id`, `valet.prompt.source` |
| `valet.env.assemble` | `src/lib/env-assembly.ts` | `valet.org.id` (wraps DB reads, token minting, decryption) |

**Sandbox lifecycle traces** (created in SessionAgentDO):

| Span | Source file | Key attributes |
|---|---|---|
| `valet.sandbox.spawn` (root) | `session-lifecycle.ts:spawnSandbox()` | `valet.session.id`, `valet.sandbox.image` |
| `valet.modal.api` | `session-lifecycle.ts` | `http.url`, `http.status_code`, `duration_ms` |
| `valet.sandbox.restore` (root) | `session-lifecycle.ts:restoreSandbox()` | `valet.session.id`, `valet.snapshot.image_id` |
| `valet.sandbox.hibernate` (root) | `session-lifecycle.ts:snapshotSandbox()` | `valet.session.id` |
| `valet.sandbox.terminate` (root) | `session-lifecycle.ts:terminateSandbox()` | `valet.session.id` |
| `valet.session.status_change` | `session-agent.ts` | `valet.from_status`, `valet.to_status` |
| `valet.db.flush_metrics` | `session-agent.ts` | `valet.event_count` |
| `valet.db.flush_messages` | `session-agent.ts` | `valet.message_count` |

**Prompt dispatch** (child of lifecycle or inbound trace):

| Span | Source file | Key attributes |
|---|---|---|
| `valet.prompt.dispatch` | `prompt-queue.ts:sendNextQueuedPrompt()` | `valet.message.id`, `valet.queue.mode`, `valet.queue.wait_ms`, `valet.queue.reason` |
| `valet.prompt.collect_flush` | `prompt-queue.ts` | `valet.collect.message_count`, `valet.collect.buffer_ms` |

### Context storage

Add to `SessionState` (persisted in DO SQLite `state` table):

```typescript
// New fields in session-state.ts
lifecycleTraceId: string | null;    // trace_id for current lifecycle trace
lifecycleSpanId: string | null;     // root span_id for current lifecycle trace
```

These are set when a lifecycle trace starts (spawn/restore) and read when creating span links from inbound request traces.

### TRACEPARENT injection

In `env-assembly.ts`, add to the returned `envVars`:

```typescript
// In assembleRepoEnv(), after assembling all other env vars:
envVars.TRACEPARENT = traceparent;  // "00-{traceId}-{spanId}-01"
envVars.OTEL_EXPORTER_OTLP_ENDPOINT = env.OTEL_EXPORTER_OTLP_ENDPOINT ?? '';
envVars.OTEL_EXPORTER_OTLP_HEADERS = env.OTEL_EXPORTER_OTLP_HEADERS ?? '';
```

### Flush strategy

CF Workers can't hold connections open after the response. Use `ctx.waitUntil()` to flush spans after the response:

```typescript
// In route handlers:
c.executionCtx.waitUntil(tracer.forceFlush());

// In DO alarm/WebSocket handlers:
this.ctx.waitUntil(this.tracer.forceFlush());
```

Batch spans and flush at natural boundaries (end of HTTP request, end of lifecycle operation, alarm handler completion). The OTLP HTTP exporter sends a single POST per flush.

---

## Layer 2: Runner Instrumentation

**Runtime**: Bun process inside Modal sandbox (`packages/runner/`)

### OTel SDK approach

The runner is a long-lived Bun process. Use `@opentelemetry/sdk-trace-node` (Bun supports the Node.js OTel SDK) with `OTLPTraceExporter` (HTTP/protobuf). The SDK's `BatchSpanProcessor` handles buffering and periodic flush.

Read `TRACEPARENT` from `process.env` on startup to link the bootstrap trace to the DO's spawn/restore trace.

### Spans by trace type

**Runner bootstrap trace** (created in `bin.ts`):

| Span | Source file | Key attributes |
|---|---|---|
| `valet.runner.bootstrap` (root) | `bin.ts:main()` | `valet.session.id`, `valet.runner.version` |
| `valet.runner.ws_connect` | `bin.ts` (initial WS connect) | `valet.ws.attempts`, `valet.ws.url` |
| `valet.runner.config_receive` | `bin.ts` (wait for opencode-config) | `valet.config.timeout_ms` |
| `valet.runner.opencode_start` | `opencode-manager.ts:setDesiredConfig()` | `valet.opencode.port` |
| `valet.runner.opencode_health` | `opencode-manager.ts:waitForHealth()` | `valet.health.attempts`, `valet.health.duration_ms` |
| `valet.runner.git_clone` | `git-setup.ts:cloneRepo()` | `valet.git.repo_url`, `valet.git.branch` |
| `valet.runner.git_config` | `git-setup.ts:setupGitConfig()` | |
| `valet.runner.secrets_resolve` | `secrets.ts:resolveSecrets()` | `valet.secrets.count` |
| `valet.runner.idle_signal` | `bin.ts` (send agentStatus: idle) | |

**Agent turn traces** (created in `prompt.ts:handlePrompt()`):

| Span | Source file | Key attributes |
|---|---|---|
| `valet.turn` (root) | `prompt.ts:handlePrompt()` | `valet.message.id`, `valet.channel.type`, `valet.turn.number`, `valet.queue.wait_ms`, `valet.queue.reason` |
| `valet.turn.audio_transcribe` | `prompt.ts` | `valet.audio.duration_ms` |
| `valet.turn.pdf_extract` | `prompt.ts` | `valet.pdf.page_count` |
| `valet.turn.model_attempt` | `prompt.ts` (model failover loop) | `gen_ai.request.model`, `valet.model.attempt_index` |
| `valet.turn.prompt_send` | `prompt.ts:sendPromptSyncWithRecovery()` | `valet.opencode.session_id` |
| `valet.turn.finalize` | `prompt.ts:finalizeResponse()` | `valet.turn.duration_ms`, `valet.turn.has_error` |
| `valet.turn.usage_report` | `prompt.ts` | `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens` |

**SSE event spans** (children of turn trace, created from OpenCode event stream):

| Span | Source | Key attributes |
|---|---|---|
| `valet.tool` | `message.part.updated` with `type: "tool"` | `valet.tool.name`, `valet.tool.status`, `valet.tool.duration_ms` |
| `valet.llm` | `message.updated` with token counts | `gen_ai.system`, `gen_ai.request.model`, `gen_ai.usage.*` |

Tool spans are derived from SSE events: `pending` → start span, `completed`/`error` → end span. The runner already tracks tool state transitions in `ChannelSession.toolStates`.

### Trace context from DO

**On bootstrap**: Read `TRACEPARENT` from `process.env`, create bootstrap root span as child.

**On each prompt**: Read `traceparent` from the runner protocol `prompt` message. Create a new turn trace with a span link to the DO's prompt dispatch span.

```typescript
// In agent-client.ts handleMessage(), for type === 'prompt':
const turnTraceContext = msg.traceparent
  ? parseTraceparent(msg.traceparent)
  : undefined;
// Pass to handlePrompt() which creates the turn root span with link
```

### Context to OpenCode

Pass trace context as HTTP header when sending prompts:

```typescript
// In prompt.ts, sendPromptSyncWithRecovery():
const headers: Record<string, string> = {
  'Content-Type': 'application/json',
};
if (currentTurnTraceparent) {
  headers['Traceparent'] = currentTurnTraceparent;
}
const response = await fetch(`http://localhost:${port}/session/${sessionId}/prompt_async`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ content }),
});
```

---

## Layer 3: OpenCode Plugin

**Runtime**: OpenCode process inside sandbox

### Approach: SSE-based capture in the Runner (Phase 3a) vs. OpenCode plugin (Phase 3b)

The runner already consumes OpenCode's SSE event stream and processes `message.part.updated`, `message.updated`, and `session.idle` events. This means the runner can capture **most** LLM and tool telemetry without a plugin:

- **Tool spans**: `message.part.updated` with `type: "tool"` includes tool name, state transitions (pending → running → completed/error), and output. The runner tracks these in `ChannelSession.toolStates`.
- **LLM usage**: `message.updated` includes token counts per message. The runner aggregates these in `ChannelSession.usageEntries`.
- **Turn boundaries**: Already defined by `handlePrompt()` → `finalizeResponse()`.

**Phase 3a (Runner-side capture)** instruments the SSE event processing in `prompt.ts` to create OTel spans from these events. This requires no changes to OpenCode or its plugin system.

**Phase 3b (OpenCode plugin)** adds a `@valet/plugin-tracing` plugin that runs inside OpenCode for higher-fidelity capture:
- Individual LLM call latency (vs. aggregate token counts)
- System prompt content/length at each turn
- Tool input args (the SSE stream only reliably has output)
- Internal OpenCode reasoning/planning spans

Phase 3b depends on OpenCode's plugin hook maturity. The hooks referenced in the Braintrust plugin (`tool.execute.before`, `tool.execute.after`, `chat.message`) may not be available in our deployed OpenCode version. Phase 3a gives us 80% of the value with 20% of the effort.

### Plugin structure (Phase 3b, when hooks are available)

```
packages/plugin-tracing/
├── plugin.yaml
└── tools/
    └── tracing-hooks.ts    # @opencode-ai/plugin hooks for LLM/tool spans
```

Registered in `opencode-config-writer.ts` alongside existing plugins. Reads `TRACEPARENT` from env to create child spans under the runner's turn trace.

---

## OTel Semantic Conventions

Follow [OTel GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/) for LLM spans, standard HTTP conventions for requests.

### Resource attributes (set on all spans from a layer)

| Attribute | Value | Layer |
|---|---|---|
| `service.name` | `valet-worker` / `valet-runner` / `valet-agent` | All |
| `service.version` | Package version | All |
| `valet.session.id` | Session ID | All |
| `valet.org.id` | Organization ID | Worker, Runner |
| `valet.user.id` | User ID | Worker, Runner |

### Span attributes

| Attribute | Example | Convention |
|---|---|---|
| `gen_ai.system` | `anthropic` | GenAI semconv |
| `gen_ai.request.model` | `claude-sonnet-4-5` | GenAI semconv |
| `gen_ai.usage.input_tokens` | `1523` | GenAI semconv |
| `gen_ai.usage.output_tokens` | `847` | GenAI semconv |
| `gen_ai.usage.reasoning_tokens` | `200` | GenAI semconv |
| `gen_ai.response.finish_reasons` | `["end_turn"]` | GenAI semconv |
| `http.method` | `POST` | HTTP semconv |
| `http.route` | `/api/sessions/:id/prompt` | HTTP semconv |
| `http.status_code` | `200` | HTTP semconv |
| `valet.sandbox.id` | `sb-xxx` | Custom |
| `valet.snapshot.image_id` | `img-yyy` | Custom |
| `valet.tool.name` | `bash` | Custom |
| `valet.tool.status` | `completed` | Custom |
| `valet.channel.type` | `slack` | Custom |
| `valet.queue.mode` | `followup` | Custom |
| `valet.queue.wait_ms` | `3200` | Custom |
| `valet.queue.reason` | `runner_busy` | Custom |
| `valet.collect.message_count` | `3` | Custom |
| `valet.collect.buffer_ms` | `2000` | Custom |
| `valet.prompt.source` | `webhook` / `api` / `websocket` | Custom |

### Sensitive data policy

**Default: redact.** Do not include prompt content, tool input/output, or LLM response text in span attributes. Include only:
- Lengths (`valet.prompt.length`, `valet.response.length`)
- Counts (token counts, tool call counts)
- Identifiers (session ID, message ID, model name)
- Timing (duration, latency)

A future `OTEL_CAPTURE_CONTENT=true` env var can opt-in to full content capture for debugging.

---

## Runner Protocol Changes

Add optional `traceparent` field to three DO → Runner message types:

```typescript
// In packages/shared/src/types/runner-protocol.ts

// Existing prompt message — add traceparent
interface PromptMessage {
  type: 'prompt';
  messageId: string;
  content: string;
  // ... existing fields ...
  traceparent?: string;  // W3C Trace Context: "00-{traceId}-{spanId}-01"
}

// Existing workflow-execute message — add traceparent
interface WorkflowExecuteMessage {
  type: 'workflow-execute';
  // ... existing fields ...
  traceparent?: string;
}

// Existing repo-config message — add traceparent
interface RepoConfigMessage {
  type: 'repo-config';
  // ... existing fields ...
  traceparent?: string;
}
```

These are optional fields — runners that don't understand them ignore them. No protocol version bump needed.

---

## Env Vars Added

| Var | Type | Default | Purpose |
|---|---|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | string | unset | OTLP endpoint URL. When unset, tracing is no-op. |
| `OTEL_EXPORTER_OTLP_HEADERS` | string | unset | Auth headers for OTLP endpoint (e.g., `Authorization=Basic ...`) |
| `OTEL_SERVICE_NAME` | string | per-layer default | Override service name |
| `OTEL_CAPTURE_CONTENT` | boolean | `false` | Include prompt/response content in spans |

These follow OTel SDK conventions so standard tooling works.

---

## Dependencies

### Worker (`packages/worker/package.json`)

```
@opentelemetry/api                    # Core OTel API
@opentelemetry/sdk-trace-base         # Tracer, spans (no Node.js deps)
@opentelemetry/exporter-trace-otlp-http  # OTLP exporter using fetch()
@opentelemetry/resources              # Resource attributes
@opentelemetry/semantic-conventions   # Standard attribute names
```

CF Workers compatibility: `sdk-trace-base` and `exporter-trace-otlp-http` use fetch (not Node.js http module), so they work in Workers. Verify with `wrangler dev` during implementation. If the full exporter has Node.js deps, fall back to a hand-rolled OTLP HTTP exporter (the protocol is simple: POST JSON to `/v1/traces`).

### Runner (`packages/runner/package.json`)

```
@opentelemetry/api
@opentelemetry/sdk-trace-node         # Full Node.js SDK (Bun-compatible)
@opentelemetry/exporter-trace-otlp-http
@opentelemetry/resources
@opentelemetry/semantic-conventions
```

### Plugin (`packages/plugin-tracing/` — Phase 3b)

```
@opentelemetry/api
@opentelemetry/sdk-trace-base
@opentelemetry/exporter-trace-otlp-http
@opencode-ai/plugin
```

---

## Files Changed

### Phase 1: Worker DO instrumentation

| File | Change |
|---|---|
| `packages/worker/package.json` | Add OTel dependencies |
| `packages/worker/src/env.ts` | Add `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_CAPTURE_CONTENT` to `Env` |
| `packages/worker/src/lib/tracing/tracer.ts` | **New.** Tracer factory: `createTracer(serviceName, env)` → returns `Tracer` or no-op when endpoint unset |
| `packages/worker/src/lib/tracing/propagation.ts` | **New.** W3C traceparent parse/serialize, span link helpers |
| `packages/worker/src/lib/tracing/index.ts` | **New.** Barrel export |
| `packages/worker/src/durable-objects/session-agent.ts` | Init tracer in constructor. Wrap lifecycle operations in spans. Store `lifecycleTraceId`/`lifecycleSpanId` in state. Add `traceparent` to prompt dispatch. |
| `packages/worker/src/durable-objects/session-lifecycle.ts` | Wrap `spawnSandbox()`, `restoreSandbox()`, `snapshotSandbox()`, `terminateSandbox()` in spans |
| `packages/worker/src/durable-objects/prompt-queue.ts` | Span on `sendNextQueuedPrompt()` |
| `packages/worker/src/durable-objects/session-state.ts` | Add `lifecycleTraceId`, `lifecycleSpanId` state fields |
| `packages/worker/src/lib/env-assembly.ts` | Inject `TRACEPARENT`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS` into sandbox env |
| `packages/worker/src/routes/channels.ts` | Create inbound request trace for webhooks, add span link to lifecycle trace |
| `packages/worker/src/routes/sessions.ts` | Create inbound request trace for prompt/session APIs |
| `packages/worker/wrangler.toml` | Add env vars to `[vars]` |

### Phase 2: Runner instrumentation

| File | Change |
|---|---|
| `packages/runner/package.json` | Add OTel dependencies |
| `packages/runner/src/tracing.ts` | **New.** Tracer init, TRACEPARENT parsing, span helpers |
| `packages/runner/src/bin.ts` | Init OTel SDK on startup. Wrap bootstrap sequence in spans. |
| `packages/runner/src/agent-client.ts` | Extract `traceparent` from `prompt` messages, pass to prompt handler |
| `packages/runner/src/prompt.ts` | Create turn root span in `handlePrompt()`. Create tool/LLM child spans from SSE events. Add `Traceparent` header to `prompt_async` requests. |
| `packages/runner/src/opencode-manager.ts` | Wrap OpenCode spawn, health check, crash detection in spans |
| `packages/runner/src/git-setup.ts` | Wrap clone/config in spans |
| `packages/runner/src/secrets.ts` | Wrap secret resolution in spans |
| `packages/runner/src/gateway.ts` | Wrap tunnel registration in span |
| `packages/shared/src/types/runner-protocol.ts` | Add optional `traceparent` field to `prompt`, `workflow-execute`, `repo-config` messages |

### Phase 3a: Runner-side LLM/tool capture

| File | Change |
|---|---|
| `packages/runner/src/prompt.ts` | Enhance SSE event processing to create tool spans (from `toolStates` transitions) and LLM spans (from `usageEntries`) as children of turn trace |

### Phase 3b: OpenCode plugin (future)

| File | Change |
|---|---|
| `packages/plugin-tracing/plugin.yaml` | **New.** Plugin manifest |
| `packages/plugin-tracing/tools/tracing-hooks.ts` | **New.** OTel spans from OpenCode hooks |
| `packages/runner/src/opencode-config-writer.ts` | Register tracing plugin in OpenCode config |

## Files NOT Changed

- `packages/client/` — Frontend doesn't emit traces (could add browser RUM later)
- `packages/worker/src/lib/metrics/` — Existing metrics/logging pipeline is orthogonal
- `packages/worker/src/durable-objects/event-bus.ts` — EventBusDO is a pub/sub relay, not session-scoped
- `packages/worker/src/durable-objects/workflow-executor.ts` — Workflow tracing is a separate concern (workflow spans would be their own trace type, but out of scope here)

---

## Implementation Sequence

### Phase 1: Worker DO (highest value, owns root context)

1. **Tracing library** — `src/lib/tracing/`: tracer factory, traceparent parse/serialize, no-op when endpoint unset
2. **Session state** — Add `lifecycleTraceId`/`lifecycleSpanId` to `session-state.ts`
3. **Lifecycle spans** — Wrap spawn/restore/hibernate/terminate in `session-lifecycle.ts`
4. **Prompt dispatch spans** — Instrument `prompt-queue.ts`, inject `traceparent` into runner messages
5. **Inbound request traces** — Create traces in route handlers for webhooks and prompt APIs
6. **Env injection** — Add TRACEPARENT + OTLP config to `env-assembly.ts`
7. **Flush** — `ctx.waitUntil(tracer.forceFlush())` at request/alarm boundaries

### Phase 2: Runner (second-highest value, captures turn lifecycle)

1. **OTel SDK init** — Init tracer in `bin.ts`, read TRACEPARENT from env
2. **Bootstrap spans** — Wrap WS connect, config wait, OpenCode start, git clone, secret resolution
3. **Turn traces** — Create root span in `handlePrompt()`, end on `finalizeResponse()`
4. **Context forwarding** — Read `traceparent` from prompt messages, pass to OpenCode via HTTP header

### Phase 3a: Runner-side LLM/tool capture (quick win)

1. **Tool spans** — Create spans from `toolStates` transitions in SSE event processing
2. **LLM spans** — Create spans from `usageEntries` in `message.updated` events
3. **Attributes** — Add GenAI semantic convention attributes

### Phase 3b: OpenCode plugin (when hooks mature)

1. Build `@valet/plugin-tracing` with OpenCode hooks
2. Register in `opencode-config-writer.ts`
3. Capture per-LLM-call latency, system prompt length, tool input args

### Phase 4: Dashboards & correlation

1. Grafana Tempo data source configuration
2. Session trace explorer dashboard
3. Latency breakdown by operation type
4. Cost attribution by model/session/org

---

## Open Questions (Resolved)

| Question | Resolution |
|---|---|
| Single root span vs. multi-trace? | **Multi-trace.** Each discrete operation (inbound request, lifecycle op, turn) is its own trace. Correlated by `valet.session.id` attribute. |
| Long-lived spans for hibernation? | **Not needed.** Hibernate is one trace, restore is another. No span stays open during hibernation. |
| CF Workers OTel support? | Use `@opentelemetry/sdk-trace-base` + fetch-based OTLP exporter. Fall back to hand-rolled exporter if SDK has Node.js deps. Verify in Phase 1. |
| Trace context propagation method? | W3C `TRACEPARENT` via env vars (spawn) and runner protocol messages (per-prompt). |
| Sensitive data? | Redact by default. Opt-in via `OTEL_CAPTURE_CONTENT=true`. |

## Open Questions (Remaining)

| Question | Notes |
|---|---|
| Grafana backend — Cloud or self-hosted? | Determines OTLP endpoint and auth. Grafana Cloud free tier has 50GB/month traces. |
| Sampling strategy? | Start with trace-everything. Add `TraceIdRatioBased` sampler if volume becomes a concern. Sampling decisions should propagate from worker → runner → plugin. |
| Trace retention? | Grafana Cloud free tier: 14 days. Sufficient for debugging. Evals may need longer — consider exporting to R2/S3 for archival. |
| Workflow tracing? | Workflow runtime traces (ValetWorkflowInterpreter) are a natural extension but out of scope for this spec. Would be a fifth trace type. |
