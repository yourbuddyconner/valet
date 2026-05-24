export interface TraceContext {
  traceId: string;
  spanId: string;
  traceFlags?: string;
}

export interface SpanLink {
  context: TraceContext;
  attributes?: SpanAttributes;
}

export const SpanKind = {
  INTERNAL: 1,
  SERVER: 2,
  CLIENT: 3,
  PRODUCER: 4,
  CONSUMER: 5,
} as const;

export type SpanKindValue = (typeof SpanKind)[keyof typeof SpanKind];
type SpanAttributeScalar = string | number | boolean;
export type SpanAttributeValue = SpanAttributeScalar | readonly SpanAttributeScalar[] | undefined | null;
export type SpanAttributes = Record<string, SpanAttributeValue>;

export interface StartSpanOptions {
  parent?: TraceContext | null;
  links?: SpanLink[];
  attributes?: SpanAttributes;
  startTimeMs?: number;
  kind?: SpanKindValue;
}

export interface TracerOptions {
  serviceName: string;
  endpoint?: string;
  headers?: string;
  resourceAttributes?: SpanAttributes;
  fetchFn?: typeof fetch;
  /**
   * Auto-flush once the buffered span count reaches this threshold.
   * Set to 0 or undefined to disable auto-flush (callers must invoke flush() manually).
   */
  maxQueuedSpans?: number;
  /**
   * Hook invoked with the auto-flush promise so the host can keep the
   * Promise alive (e.g. via `ctx.waitUntil` in a Cloudflare Worker DO).
   * If omitted, auto-flush errors are logged and the promise is otherwise
   * fire-and-forget.
   */
  scheduleFlush?: (flush: Promise<void>) => void;
}

interface FinishedSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: SpanAttributes;
  links: SpanLink[];
  kind: SpanKindValue;
  status?: { code: number; message?: string };
}

const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;

export function parseTraceparent(value: string | null | undefined): TraceContext | null {
  if (!value) return null;
  const match = value.trim().match(TRACEPARENT_RE);
  if (!match) return null;
  const [, traceId, spanId, traceFlags] = match;
  if (/^0+$/.test(traceId) || /^0+$/.test(spanId)) return null;
  return { traceId: traceId.toLowerCase(), spanId: spanId.toLowerCase(), traceFlags: traceFlags.toLowerCase() };
}

export function formatTraceparent(context: TraceContext): string {
  return `00-${context.traceId}-${context.spanId}-${context.traceFlags || '01'}`;
}

export function createTraceContext(parent?: TraceContext | null): TraceContext {
  return {
    traceId: parent?.traceId || randomHex(16),
    spanId: randomHex(8),
    traceFlags: parent?.traceFlags || '01',
  };
}

export function isValidTraceContext(context: TraceContext | null | undefined): context is TraceContext {
  return !!context && /^[0-9a-f]{32}$/.test(context.traceId) && /^[0-9a-f]{16}$/.test(context.spanId);
}

export class SimpleSpan {
  readonly context: TraceContext;
  readonly parent?: TraceContext | null;
  private readonly tracer: SimpleTracer;
  private readonly name: string;
  private readonly startTimeMs: number;
  private readonly attributes: SpanAttributes;
  private readonly links: SpanLink[];
  private readonly kind: SpanKindValue;
  private ended = false;
  private status: { code: number; message?: string } | undefined;

  constructor(tracer: SimpleTracer, name: string, options: StartSpanOptions = {}) {
    this.tracer = tracer;
    this.name = name;
    this.parent = options.parent;
    this.startTimeMs = options.startTimeMs || Date.now();
    this.attributes = { ...(options.attributes || {}) };
    this.links = options.links || [];
    this.kind = options.kind || SpanKind.INTERNAL;
    this.context = createTraceContext(options.parent);
  }

  setAttribute(key: string, value: SpanAttributeValue): void {
    this.attributes[key] = value;
  }

  setAttributes(attributes: SpanAttributes): void {
    Object.assign(this.attributes, attributes);
  }

  recordException(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.attributes['exception.message'] = message.slice(0, 500);
    if (error instanceof Error && error.name) this.attributes['exception.type'] = error.name;
    this.status = { code: 2, message };
  }

  setStatus(code: number, message?: string): void {
    this.status = { code, message };
  }

  end(endTimeMs = Date.now()): void {
    if (this.ended) return;
    this.ended = true;
    this.tracer.record({
      traceId: this.context.traceId,
      spanId: this.context.spanId,
      parentSpanId: this.parent?.spanId,
      name: this.name,
      startTimeUnixNano: msToUnixNano(this.startTimeMs),
      endTimeUnixNano: msToUnixNano(endTimeMs),
      attributes: this.attributes,
      links: this.links,
      kind: this.kind,
      status: this.status,
    });
  }
}

export class SimpleTracer {
  private readonly endpoint?: string;
  private readonly headers: Record<string, string>;
  private readonly serviceName: string;
  private readonly resourceAttributes: SpanAttributes;
  private readonly fetchFn: typeof fetch;
  private readonly maxQueuedSpans: number;
  private readonly scheduleFlush?: (flush: Promise<void>) => void;
  private readonly spans: FinishedSpan[] = [];

  constructor(options: TracerOptions) {
    this.endpoint = normalizeEndpoint(options.endpoint);
    this.headers = parseOtelHeaders(options.headers);
    this.serviceName = options.serviceName;
    this.resourceAttributes = options.resourceAttributes || {};
    this.fetchFn = options.fetchFn || fetch;
    this.maxQueuedSpans = options.maxQueuedSpans ?? 0;
    this.scheduleFlush = options.scheduleFlush;
  }

  get enabled(): boolean {
    return !!this.endpoint;
  }

  startSpan(name: string, options: StartSpanOptions = {}): SimpleSpan {
    return new SimpleSpan(this, name, options);
  }

  async withSpan<T>(name: string, options: StartSpanOptions, fn: (span: SimpleSpan) => Promise<T>): Promise<T> {
    const span = this.startSpan(name, options);
    try {
      const result = await fn(span);
      span.end();
      return result;
    } catch (error) {
      span.recordException(error);
      span.end();
      throw error;
    }
  }

  record(span: FinishedSpan): void {
    if (!this.enabled) return;
    this.spans.push(span);
    if (this.maxQueuedSpans > 0 && this.spans.length >= this.maxQueuedSpans) {
      const flushPromise = this.flush();
      if (this.scheduleFlush) {
        this.scheduleFlush(flushPromise);
      } else {
        flushPromise.catch((err) => console.warn('[Tracing] Auto-flush failed:', err));
      }
    }
  }

  async flush(): Promise<void> {
    if (!this.endpoint || this.spans.length === 0) return;
    const spans = this.spans.splice(0, this.spans.length);
    const body = buildOtlpJson(this.serviceName, this.resourceAttributes, spans);
    try {
      const response = await this.fetchFn(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...this.headers,
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        console.warn(`[Tracing] OTLP export failed: ${response.status} ${response.statusText}`);
      }
    } catch (error) {
      console.warn('[Tracing] OTLP export failed:', error);
    }
  }
}

function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function msToUnixNano(ms: number): string {
  // Epoch nanoseconds exceed Number.MAX_SAFE_INTEGER, so multiply with BigInt
  // to avoid silent precision loss in span timestamps.
  return (BigInt(Math.floor(ms)) * 1_000_000n).toString();
}

function normalizeEndpoint(endpoint: string | undefined): string | undefined {
  const trimmed = endpoint?.trim();
  if (!trimmed) return undefined;
  return trimmed.endsWith('/v1/traces')
    ? trimmed
    : `${trimmed.replace(/\/+$/, '')}/v1/traces`;
}

function parseOtelHeaders(headerSpec: string | undefined): Record<string, string> {
  if (!headerSpec?.trim()) return {};
  const headers: Record<string, string> = {};
  for (const pair of headerSpec.split(',')) {
    const idx = pair.indexOf('=');
    if (idx <= 0) continue;
    const key = decodeURIComponent(pair.slice(0, idx).trim());
    const value = decodeURIComponent(pair.slice(idx + 1).trim());
    if (key && value) headers[key] = value;
  }
  return headers;
}

function buildOtlpJson(serviceName: string, resourceAttributes: SpanAttributes, spans: FinishedSpan[]) {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: attributesToOtlp({
            'service.name': serviceName,
            ...resourceAttributes,
          }),
        },
        scopeSpans: [
          {
            scope: { name: serviceName },
            spans: spans.map((span) => ({
              traceId: span.traceId,
              spanId: span.spanId,
              ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
              name: span.name,
              kind: span.kind,
              startTimeUnixNano: span.startTimeUnixNano,
              endTimeUnixNano: span.endTimeUnixNano,
              attributes: attributesToOtlp(span.attributes),
              ...(span.status ? { status: span.status } : {}),
              ...(span.links.length > 0 ? { links: span.links.map(linkToOtlp) } : {}),
            })),
          },
        ],
      },
    ],
  };
}

function linkToOtlp(link: SpanLink) {
  return {
    traceId: link.context.traceId,
    spanId: link.context.spanId,
    attributes: attributesToOtlp(link.attributes || {}),
  };
}

function attributesToOtlp(attributes: SpanAttributes) {
  return Object.entries(attributes)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => ({ key, value: attributeValueToOtlp(value!) }));
}

function attributeValueToOtlp(value: SpanAttributeScalar | readonly SpanAttributeScalar[]): Record<string, unknown> {
  if (Array.isArray(value)) {
    return {
      arrayValue: {
        values: value.map(attributeValueToOtlp),
      },
    };
  }
  if (typeof value === 'boolean') return { boolValue: value };
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  }
  return { stringValue: value };
}
