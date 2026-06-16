# Observability

Valet emits OpenTelemetry traces. This is the first slice (the Worker layer); the
runner and OpenCode layers follow in later PRs. The end state is correlated traces
spanning worker → runner → OpenCode, viewable in Grafana, with metrics derived from
the traces.

## What's instrumented today (Worker)

The Worker handler and all three Durable Objects are wrapped with
[`@microlabs/otel-cf-workers`](https://github.com/evanderkoogh/otel-cf-workers), which
auto-creates spans for `fetch`, DO `fetch`/`alarm`/storage, and outbound calls, and
propagates W3C trace context across worker → DO → DO. On top of that:

- **`valet.*` correlation attributes** (`valet.session.id`, `valet.user.id`,
  `valet.org.id`) are set as **span attributes** (not resource attributes — a Worker
  isolate is multi-tenant) via `setSessionAttributes()`. Query in Tempo with
  `{ span.valet.user.id = "..." }`.
- **Structured, trace-aware logging** (`lib/log.ts`): leveled JSON lines stamped with
  the active `trace_id` / `span_id`, so logs pivot to the trace that produced them.

Tracing is a **no-op when `OTEL_EXPORTER_OTLP_ENDPOINT` is unset** — the head sampler
drops every span, so nothing is recorded or exported and no network call is made. It
is safe to ship dark and enable per-environment.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset (disabled) | OTLP/HTTP base, e.g. `http://localhost:4318`. Traces POST to `/v1/traces`. |
| `OTEL_EXPORTER_OTLP_HEADERS` | unset | `key=value,key2=value2` auth headers (e.g. Grafana Cloud basic auth). Set via `wrangler secret put`. |
| `OTEL_TRACES_SAMPLER_RATIO` | `1` when enabled | Head sample ratio in `[0,1]`. |

## Run it locally

```bash
make otel-local        # starts grafana/otel-lgtm (Collector + Tempo + Prometheus + Loki + Grafana)
```

Then point the worker at it — add to `packages/worker/.dev.vars`:

```
OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318"
```

```bash
make dev-worker        # wrangler dev on :8787
curl http://localhost:8787/health
```

Open Grafana at <http://localhost:3000> (admin/admin) → **Explore** → **Tempo** →
*Search* to see the trace. Filter by attribute, e.g. `{ span.valet.user.id = "..." }`.

## Design

The full cross-layer design (four trace types, span links for the long-lived session
state machine, queue-wait visibility, GenAI semantic conventions, and the
traces → metrics path via Tempo's metrics-generator) lives in the tracing design doc /
Linear issue. Notable conventions:

- **Session id is a span attribute, not a resource attribute** (the Worker serves many
  sessions per isolate; resource attributes are immutable per process). On the
  single-session runner/OpenCode processes it may instead be a resource attribute.
- **GenAI spans** (runner layer) follow OTel GenAI semantic conventions and use
  `gen_ai.provider.name` (not the deprecated `gen_ai.system`). Prompt/response content
  is redacted by default.
