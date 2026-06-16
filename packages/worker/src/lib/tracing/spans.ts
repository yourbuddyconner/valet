import { trace, SpanStatusCode } from '@opentelemetry/api';
import type { Attributes, Span } from '@opentelemetry/api';

/**
 * App-level span helpers. These use only `@opentelemetry/api`, which degrades to a
 * no-op when no TracerProvider is registered (e.g. in unit tests, or when tracing
 * is disabled) — so they are always safe to call.
 */

export const TRACER_NAME = 'valet-worker';

export function getTracer() {
  return trace.getTracer(TRACER_NAME);
}

/**
 * Attach Valet correlation ids to a span as SPAN attributes (NOT resource
 * attributes — a Worker isolate serves many sessions, so these vary per request).
 * Query in Tempo with `{ span.valet.session.id = "..." }`.
 */
export function setSessionAttributes(
  attrs: { sessionId?: string | null; userId?: string | null; orgId?: string | null },
  span: Span | undefined = trace.getActiveSpan(),
): void {
  if (!span) return;
  if (attrs.sessionId) span.setAttribute('valet.session.id', attrs.sessionId);
  if (attrs.userId) span.setAttribute('valet.user.id', attrs.userId);
  if (attrs.orgId) span.setAttribute('valet.org.id', attrs.orgId);
}

/**
 * Run `fn` inside a child span: records exceptions, sets OK/ERROR status, and always
 * ends the span. Returns whatever `fn` returns (and rethrows on failure).
 */
export async function withSpan<T>(
  name: string,
  fn: (span: Span) => Promise<T> | T,
  attributes?: Attributes,
): Promise<T> {
  return getTracer().startActiveSpan(name, { attributes }, async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      span.end();
    }
  });
}
