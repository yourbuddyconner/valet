import { trace } from '@opentelemetry/api';

/**
 * Structured, leveled, trace-aware logging. Each line is one JSON object stamped with
 * the active `trace_id` / `span_id` (when a span is in context), so logs pivot to the
 * trace that produced them. Replaces ad-hoc `console.*` (no levels, no JSON).
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

function emit(level: LogLevel, message: string, fields?: LogFields): void {
  if (LEVEL_WEIGHT[level] < threshold) return;

  const ctx = trace.getActiveSpan()?.spanContext();
  const entry: Record<string, unknown> = { level, message, time: new Date().toISOString() };
  if (ctx && ctx.traceId && ctx.traceId !== INVALID_TRACE_ID) {
    entry.trace_id = ctx.traceId;
    entry.span_id = ctx.spanId;
  }
  if (fields) Object.assign(entry, fields);

  const line = JSON.stringify(entry);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const log = {
  debug: (message: string, fields?: LogFields) => emit('debug', message, fields),
  info: (message: string, fields?: LogFields) => emit('info', message, fields),
  warn: (message: string, fields?: LogFields) => emit('warn', message, fields),
  error: (message: string, fields?: LogFields) => emit('error', message, fields),
};
