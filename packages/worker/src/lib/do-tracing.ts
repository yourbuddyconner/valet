import {
  context, trace, SpanKind, SpanStatusCode, TraceFlags,
  type Span, type Attributes, type Context,
} from '@opentelemetry/api';
import {
  BasicTracerProvider, BatchSpanProcessor,
  type SpanProcessor, type ReadableSpan, type SpanExporter,
} from '@opentelemetry/sdk-trace-base';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { buildTraceConfig, isTracingEnabled, RedactingSpanExporter } from './tracing.js';
import type { Env } from '../env.js';

/**
 * Per-DO-INSTANCE OpenTelemetry tracer for a Durable Object.
 *
 * The Worker's `instrument()` wrapper establishes its exporter config in a per-invocation
 * AsyncLocalStorage context and flushes via `waitUntil` — neither of which reaches an
 * un-wrapped DO, so spans created inside a DO never export. We can't wrap the DO with
 * `instrumentDO()` either: it proxies `ctx.storage` and breaks the SQLite API
 * (`ctx.storage.sql.exec` → "Illegal invocation").
 *
 * So a DO gets its OWN tracer + OTLP exporter (reusing the Worker's trace config — same
 * endpoint/headers), parents its root span to the W3C `traceparent` the Worker propagated
 * on the `stub.fetch()` call, and leaves `ctx.storage` native. DO-internal spans nest under
 * the Worker's DO-client span in one connected trace.
 *
 * BATCHING: the tracer is created ONCE per DO instance (cache it on the DO and reuse — see
 * the getTracer() pattern in the DOs) and uses a BatchSpanProcessor, so the WebSocket hotpath
 * does not emit one OTLP POST per span. We have no Collector gateway, so spans go straight to
 * Grafana Cloud; per-span POSTs at session concurrency would be a request storm. The batch
 * buffer is in-memory and DO hibernation freezes JS timers, so flushing must be driven by real
 * DO lifecycle events (the alarm, webSocketClose, pre-hibernate, size threshold) — never the
 * processor's internal timer. forceFlush()/pendingCount() expose those controls to the DO.
 */
export interface DoTracer {
  /** Wrap a DO fetch in a SERVER root span; records status/exceptions. flushOnEnd (default true)
   *  drains the buffer after the fetch — pass false for high-frequency callers (EventBus /publish)
   *  so spans batch and flush via the size threshold / close instead of one POST per fetch. */
  traceFetch(request: Request, name: string, handler: (span: Span) => Promise<Response>, flushOnEnd?: boolean): Promise<Response>;
  /** Run `fn` inside a span (a child of the active span, or a new root when none is active — the
   *  WebSocket/alarm entrypoints, which carry no inbound trace context). */
  span<T>(name: string, fn: (span: Span) => Promise<T> | T, attrs?: Attributes): Promise<T>;
  /** Drain buffered spans now. Called from the alarm, webSocketClose, pre-hibernate, and per-fetch. */
  forceFlush(): Promise<void>;
  /** Approx. spans ended since the last flush — lets the DO decide whether to keep a flush alarm
   *  armed (BatchSpanProcessor doesn't expose its buffer size). */
  pendingCount(): number;
  /** Running total of spans dropped on failed exports — makes silent OTLP drops visible. */
  getDropCount(): number;
}

const NOOP_SPAN = trace.wrapSpanContext({ traceId: '0'.repeat(32), spanId: '0'.repeat(16), traceFlags: TraceFlags.NONE });
const NOOP: DoTracer = {
  traceFetch: (_req, _name, handler) => handler(NOOP_SPAN),
  span: async (_name, fn) => fn(NOOP_SPAN),
  forceFlush: () => Promise.resolve(),
  pendingCount: () => 0,
  getDropCount: () => 0,
};

/**
 * Wraps a SpanExporter to count failed exports. The OTLP exporter is fire-and-forget / no-retry,
 * so without this a rate-limited or dropped batch is silent. The running total rides out on the
 * next successfully-exported trace as `do.trace.export_dropped_total` (see traceFetch), plus a
 * warn log per failure.
 */
class DropCountingSpanExporter implements SpanExporter {
  dropped = 0;
  errors = 0;
  constructor(private readonly inner: SpanExporter) {}
  export(spans: ReadableSpan[], resultCallback: Parameters<SpanExporter['export']>[1]): void {
    this.inner.export(spans, (result) => {
      // ExportResultCode.SUCCESS === 0; any non-zero code means the batch did not land.
      if (result.code !== 0) {
        this.dropped += spans.length;
        this.errors += 1;
        console.warn('[do-tracing] span export failed', {
          code: result.code,
          error: result.error?.message,
          batch: spans.length,
          droppedTotal: this.dropped,
        });
      }
      resultCallback(result);
    });
  }
  shutdown(): Promise<void> { return this.inner.shutdown(); }
  forceFlush(): Promise<void> { return this.inner.forceFlush?.() ?? Promise.resolve(); }
}

/**
 * Delegates to the BatchSpanProcessor but tracks how many spans have ended since the last flush.
 * BatchSpanProcessor doesn't expose its buffer size, and the DO needs that signal to decide
 * whether to keep a flush alarm armed (its only reliable periodic flush — timers freeze under
 * hibernation). Overcounts slightly after a size-threshold auto-export, which costs at most one
 * extra (empty) flush; it never undercounts, so buffered spans are never silently stranded.
 */
class CountingSpanProcessor implements SpanProcessor {
  private pending = 0;
  constructor(private readonly inner: SpanProcessor) {}
  onStart(): void {}
  onEnd(span: ReadableSpan): void { this.pending += 1; this.inner.onEnd(span); }
  async forceFlush(): Promise<void> { this.pending = 0; await this.inner.forceFlush(); }
  shutdown(): Promise<void> { return this.inner.shutdown(); }
  pendingCount(): number { return this.pending; }
}

export async function createDoTracer(env: Env, ctx: DurableObjectState, serviceName: string): Promise<DoTracer> {
  if (!isTracingEnabled(env)) return NOOP;
  const config = buildTraceConfig(env, serviceName);
  if (!('exporter' in config) || !config.exporter || !('url' in config.exporter)) return NOOP;
  // Lazy import keeps `@microlabs/otel-cf-workers` (which pulls `cloudflare:workers`) off the
  // module-load path, so the DOs that import this file stay loadable in Node unit tests.
  const { OTLPExporter } = await import('@microlabs/otel-cf-workers');
  // Exporter chain: redact URL secrets, then count drops, then OTLP. Redaction must run before
  // bytes leave; the counter wraps it so it sees the real OTLP export result.
  const dropCounter = new DropCountingSpanExporter(new RedactingSpanExporter(new OTLPExporter(config.exporter)));
  // Batch within the DO rather than one POST per span. The internal timer is a backstop only —
  // DO hibernation freezes it — so flushing is driven externally (alarm / close / size threshold).
  const batch = new BatchSpanProcessor(dropCounter, {
    maxQueueSize: 2048,
    maxExportBatchSize: 512,
    scheduledDelayMillis: 30_000,
    exportTimeoutMillis: 15_000,
  });
  const counting = new CountingSpanProcessor(batch);
  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes({ 'service.name': serviceName }),
    spanProcessors: [counting],
  });
  const tracer = provider.getTracer(serviceName);

  return {
    async traceFetch(request, name, handler, flushOnEnd = true) {
      const parent = parentContext(request);
      const span = tracer.startSpan(name, { kind: SpanKind.SERVER }, parent);
      // Surface the running drop total so silent export failures are visible on the next trace.
      span.setAttribute('do.trace.export_dropped_total', dropCounter.dropped);
      const active = trace.setSpan(parent, span);
      try {
        const res = await context.with(active, () => handler(span));
        span.setAttribute('http.response.status_code', res.status);
        if (res.status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
        return res;
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error)?.message });
        throw err;
      } finally {
        span.end();
        if (flushOnEnd) ctx.waitUntil(provider.forceFlush());
      }
    },
    span(name, fn, attrs) {
      return tracer.startActiveSpan(name, { attributes: attrs }, async (span) => {
        try {
          return await fn(span);
        } catch (err) {
          span.recordException(err as Error);
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw err;
        } finally {
          span.end();
        }
      });
    },
    forceFlush() { return provider.forceFlush(); },
    pendingCount() { return counting.pendingCount(); },
    getDropCount() { return dropCounter.dropped; },
  };
}

/** Parent context from the incoming Worker→DO `traceparent` header (W3C trace-context). */
export function parentContext(request: Request): Context {
  const tp = request.headers.get('traceparent');
  if (!tp) return context.active();
  // traceparent = version "-" trace-id(32 hex) "-" span-id(16 hex) "-" flags(2 hex)
  const p = tp.trim().split('-');
  if (p.length < 4 || p[1]?.length !== 32 || p[2]?.length !== 16) return context.active();
  return trace.setSpanContext(context.active(), {
    traceId: p[1],
    spanId: p[2],
    traceFlags: (parseInt(p[3], 16) & 1) === 1 ? TraceFlags.SAMPLED : TraceFlags.NONE,
    isRemote: true,
  });
}
