# Observability

Valet instruments with **OpenTelemetry over OTLP** — a vendor-neutral standard, so the
backend is swappable via two env vars (a Collector, Datadog, Grafana Tempo, …). This is
the first slice (the Worker layer); the runner and OpenCode layers follow in later PRs.

**Metrics are the durable signal; traces are transient.** Spans export over OTLP, but the
lasting value is **metrics derived from them** — RED (rate/errors/duration) and, later,
spend/usage — at a Collector's `spanmetrics` connector. So retaining raw traces is
optional, and dashboards are built on metrics, not on trace queries. Treat spans as a
high-detail debugging signal, not the source of truth a dashboard depends on.

## What's instrumented today (Worker)

The Worker fetch/scheduled handler is wrapped with
[`@microlabs/otel-cf-workers`](https://github.com/evanderkoogh/otel-cf-workers), which
auto-creates spans for each request, instruments outbound `fetch`, and — via the DO
bindings — emits a **client span + W3C trace-context propagation for each worker→DO
call**, so DO calls stay correlated even though the DOs run uninstrumented. On top of that:

> **The DOs are deliberately not wrapped with `instrumentDO()`.** That wrapper proxies
> `ctx.storage`, which breaks the SQLite storage API (`ctx.storage.sql.exec`) the DOs
> rely on with an `Illegal invocation` error — even when tracing is disabled. DO-internal
> spans are a follow-up that adds manual spans inside the DO code (which bypass the
> storage proxy).

- **`valet.*` correlation attributes** (`valet.session.id`, `valet.user.id`,
  `valet.org.id`) are set as **span attributes** (not resource attributes — a Worker
  isolate is multi-tenant) via `setSessionAttributes()`. Query in Tempo with
  `{ span.valet.user.id = "..." }`.
- **Structured, trace-aware logging** (`lib/log.ts`): leveled JSON lines stamped with
  the active `trace_id` / `span_id`, so logs pivot to the trace that produced them.
- **Query strings are stripped from span URLs at the exporter** (`RedactingSpanExporter`
  in `index.ts`), so OAuth codes / tokens in URLs (e.g. `?code=...`) are never exported.
  This is source-side defense-in-depth; the Collector gateway (below) is still the place
  for full redaction.

Tracing is a **no-op when `OTEL_EXPORTER_OTLP_ENDPOINT` is unset** — the head sampler
drops every span, so nothing is recorded or exported and no network call is made. It
is safe to ship dark and enable per-environment.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset (disabled) | OTLP/HTTP base, e.g. `http://localhost:4318`. Traces POST to `/v1/traces`. |
| `OTEL_EXPORTER_OTLP_HEADERS` | unset | `key=value,key2=value2` auth headers (e.g. Grafana Cloud basic auth). Set via `wrangler secret put`. |

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

Or run **`make otel-e2e`** for an automated smoke (no Grafana needed): it boots the
worker against a throwaway local collector and asserts spans export, query-string
secrets are redacted, and disabling the endpoint is a true no-op.

## Production

Do **not** point the worker directly at the backend in production. The `otel-cf-workers`
exporter sends one OTLP/HTTP request per worker invocation over `ctx.waitUntil` with
**no batching, no retry, and a silent drop on any non-2xx** — a brief outage loses every
span in that window with zero signal. Production sends to a standalone **OTel Collector**
(or Grafana Alloy) that owns the sending queue, retry, WAL, tail sampling, and PII
redaction. Crucially, the Collector also **derives metrics from the spans** (the
`spanmetrics` connector) and forwards *those* to the metrics backend (Datadog / Prometheus)
— retaining the raw traces is optional. Point `OTEL_EXPORTER_OTLP_ENDPOINT` at the
Collector; reconcile worker-emitted vs Collector-accepted span counts to watch the one
lossy hop.

The full cross-layer design (runner + OpenCode layers, the spend/usage metrics, span
links) lives in the tracing design doc / Linear issue.
