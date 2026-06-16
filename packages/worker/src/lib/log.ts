import { trace } from '@opentelemetry/api';
import type { Attributes } from '@opentelemetry/api';

/**
 * Structured, leveled, trace-aware logging.
 *
 * Every line is a single JSON object stamped with the active `trace_id` / `span_id`
 * (when a span is in context), so logs are pivotable to the trace that produced them
 * — "logs are traces" without coupling log delivery to the OTLP exporter. warn/error
 * are also surfaced as events on the active span.
 *
 * Replaces ad-hoc `console.*` calls, which had no levels and no JSON structure.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const INVALID_TRACE_ID = '00000000000000000000000000000000';

let threshold: number = LEVEL_WEIGHT.debug;

/** Drop log lines below `level`. Defaults to `debug` (emit everything). */
export function setLogLevel(level: LogLevel): void {
  threshold = LEVEL_WEIGHT[level];
}

export type LogFields = Record<string, unknown>;

/** Coerce arbitrary fields into OTel span-event Attributes (primitives kept, else JSON). */
function toAttributes(fields: LogFields): Attributes {
  const attrs: Attributes = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value == null) continue;
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      attrs[key] = value;
    } else {
      attrs[key] = JSON.stringify(value);
    }
  }
  return attrs;
}

function emit(level: LogLevel, message: string, fields?: LogFields): void {
  if (LEVEL_WEIGHT[level] < threshold) return;

  const span = trace.getActiveSpan();
  const ctx = span?.spanContext();

  const entry: Record<string, unknown> = {
    level,
    message,
    time: new Date().toISOString(),
  };
  if (ctx && ctx.traceId && ctx.traceId !== INVALID_TRACE_ID) {
    entry.trace_id = ctx.traceId;
    entry.span_id = ctx.spanId;
  }
  if (fields) Object.assign(entry, fields);

  const line = JSON.stringify(entry);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);

  // Surface the noteworthy lines on the trace itself.
  if (span && (level === 'warn' || level === 'error')) {
    span.addEvent(message, fields ? toAttributes(fields) : undefined);
  }
}

export const log = {
  debug: (message: string, fields?: LogFields) => emit('debug', message, fields),
  info: (message: string, fields?: LogFields) => emit('info', message, fields),
  warn: (message: string, fields?: LogFields) => emit('warn', message, fields),
  error: (message: string, fields?: LogFields) => emit('error', message, fields),
};
