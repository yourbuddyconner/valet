import { trace } from '@opentelemetry/api';
import type { TraceConfig } from '@microlabs/otel-cf-workers';
import type { Env } from '../env.js';

/**
 * OpenTelemetry config + helpers for the Worker.
 *
 * Only `import type` is used against `@microlabs/otel-cf-workers` (it pulls in the
 * Workers-only `cloudflare:workers` module), so this stays unit-testable under Node;
 * the runtime `instrument()` wiring (and the redacting exporter) live in `index.ts`.
 * Tracing is a no-op when `OTEL_EXPORTER_OTLP_ENDPOINT` is unset — the head sampler
 * drops every span, so nothing is recorded or exported and no network call is made.
 */

type TracingEnv = Pick<Env, 'OTEL_EXPORTER_OTLP_ENDPOINT' | 'OTEL_EXPORTER_OTLP_HEADERS'>;

const DEFAULT_OTLP_BASE = 'http://localhost:4318';

export function isTracingEnabled(env: TracingEnv): boolean {
  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT;
  return typeof endpoint === 'string' && endpoint.trim().length > 0;
}

/** Parse the OTLP `key=value,key2=value2` header convention into a header map. */
export function parseOtlpHeaders(raw: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  if (!raw) return headers;
  for (const pair of raw.split(',')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const key = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (key) headers[key] = value;
  }
  return headers;
}

/**
 * Drop secrets/PII from a span's URL attributes (applied by the exporter in index.ts
 * before export). The HTTP instrumentation records the full request URL including the
 * query string, which can carry OAuth codes and tokens (e.g.
 * `/auth/github/callback?code=...`). Keep the path (low-cardinality, useful); drop the
 * query.
 */
export function redactUrlAttributes(attrs: Record<string, unknown>): void {
  const full = attrs['url.full'];
  if (typeof full === 'string') {
    const q = full.indexOf('?');
    if (q >= 0) attrs['url.full'] = full.slice(0, q);
  }
  if ('url.query' in attrs) attrs['url.query'] = '';
}

export function buildTraceConfig(env: TracingEnv, serviceName: string): TraceConfig {
  const enabled = isTracingEnabled(env);
  const base = (env.OTEL_EXPORTER_OTLP_ENDPOINT ?? DEFAULT_OTLP_BASE).replace(/\/+$/, '');
  return {
    service: { name: serviceName },
    exporter: {
      url: `${base}/v1/traces`,
      headers: parseOtlpHeaders(env.OTEL_EXPORTER_OTLP_HEADERS),
    },
    // Sample everything when enabled, nothing when disabled (the no-op). Production
    // samples centrally at the Collector gateway, so the edge stays at 1.0.
    sampling: { headSampler: { ratio: enabled ? 1 : 0, acceptRemote: enabled } },
  };
}

/**
 * Attach Valet correlation ids to the active span as SPAN attributes (not resource
 * attributes — a Worker isolate serves many sessions). Safe to call when tracing is
 * off: `getActiveSpan()` returns undefined and this is a no-op. Query in Tempo with
 * `{ span.valet.user.id = "..." }`.
 */
export function setSessionAttributes(attrs: {
  sessionId?: string | null;
  userId?: string | null;
  orgId?: string | null;
}): void {
  const span = trace.getActiveSpan();
  if (!span) return;
  if (attrs.sessionId) span.setAttribute('valet.session.id', attrs.sessionId);
  if (attrs.userId) span.setAttribute('valet.user.id', attrs.userId);
  if (attrs.orgId) span.setAttribute('valet.org.id', attrs.orgId);
}
