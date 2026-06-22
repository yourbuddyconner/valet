import {
  context, trace, SpanKind, SpanStatusCode, TraceFlags,
  type Span, type Attributes, type Context,
} from '@opentelemetry/api';
import { BasicTracerProvider, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { OTLPExporter } from '@microlabs/otel-cf-workers';
import { buildTraceConfig, isTracingEnabled } from './tracing.js';
import type { Env } from '../env.js';

/**
 * Per-invocation OpenTelemetry tracing for a Durable Object.
 *
 * The Worker's `instrument()` wrapper establishes its exporter config in a per-invocation
 * AsyncLocalStorage context and flushes via `waitUntil` — neither of which reaches an
 * un-wrapped DO, so spans created inside a DO never export. We can't wrap the DO with
 * `instrumentDO()` either: it proxies `ctx.storage` and breaks the SQLite API
 * (`ctx.storage.sql.exec` → "Illegal invocation").
 *
 * So a DO gets its OWN tracer + OTLP exporter (reusing the Worker's trace config — same
 * endpoint/headers), parents its root span to the W3C `traceparent` the Worker propagated
 * on the `stub.fetch()` call, and flushes via `ctx.waitUntil`. `ctx.storage` is left native.
 * Result: DO-internal spans nest under the Worker's DO-client span in one connected trace.
 */
export interface DoTracer {
  readonly enabled: boolean;
  /** Wrap a DO fetch in a SERVER root span; records status/exceptions; flushes via waitUntil. */
  traceFetch(request: Request, name: string, handler: (span: Span) => Promise<Response>): Promise<Response>;
  /** Run `fn` inside a child span of the currently-active span. */
  span<T>(name: string, fn: (span: Span) => Promise<T> | T, attrs?: Attributes): Promise<T>;
}

const NOOP_SPAN = trace.wrapSpanContext({ traceId: '0'.repeat(32), spanId: '0'.repeat(16), traceFlags: TraceFlags.NONE });
const NOOP: DoTracer = {
  enabled: false,
  traceFetch: (_req, _name, handler) => handler(NOOP_SPAN),
  span: async (_name, fn) => fn(NOOP_SPAN),
};

export function createDoTracer(env: Env, ctx: DurableObjectState, serviceName: string): DoTracer {
  if (!isTracingEnabled(env)) return NOOP;
  const config = buildTraceConfig(env, serviceName);
  if (!('exporter' in config) || !config.exporter || !('url' in config.exporter)) return NOOP;
  const exporter = new OTLPExporter(config.exporter);
  // NOTE: service.name resource (so DO spans show 'valet-*-do' instead of 'unknown_service')
  // needs @opentelemetry/resources as a direct worker dep — added as a follow-up.
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  const tracer = provider.getTracer(serviceName);

  return {
    enabled: true,
    async traceFetch(request, name, handler) {
      const parent = parentContext(request);
      const span = tracer.startSpan(name, { kind: SpanKind.SERVER }, parent);
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
        ctx.waitUntil(provider.forceFlush());
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
  };
}

/** Parent context from the incoming Worker→DO `traceparent` header (W3C trace-context). */
function parentContext(request: Request): Context {
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
