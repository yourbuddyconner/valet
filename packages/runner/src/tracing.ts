import {
  SimpleTracer,
  SpanKind,
  formatTraceparent,
  parseTraceparent,
  type SimpleSpan,
  type SpanAttributes,
  type SpanKindValue,
  type TraceContext,
} from "@valet/shared";

let tracer: SimpleTracer | null = null;
let sessionId: string | undefined;

export function initTracing(currentSessionId: string): SimpleTracer {
  sessionId = currentSessionId;
  tracer = new SimpleTracer({
    serviceName: "valet-runner",
    endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
    headers: process.env.OTEL_EXPORTER_OTLP_HEADERS,
    resourceAttributes: {
      "valet.session.id": currentSessionId,
    },
  });
  return tracer;
}

export function startSpan(
  name: string,
  options: { parent?: TraceContext | null; attributes?: SpanAttributes; kind?: SpanKindValue } = {},
): SimpleSpan {
  if (!tracer) initTracing(sessionId || process.env.SESSION_ID || "unknown");
  return tracer!.startSpan(name, options);
}

export async function flushTracing(): Promise<void> {
  await tracer?.flush();
}

export function parentFromTraceparent(traceparent: string | undefined): TraceContext | null {
  return parseTraceparent(traceparent || process.env.TRACEPARENT);
}

export function traceparentFromSpan(span: SimpleSpan): string {
  return formatTraceparent(span.context);
}

export { SpanKind };
