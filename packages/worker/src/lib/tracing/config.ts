import type { ResolveConfigFn, TraceConfig } from '@microlabs/otel-cf-workers';
import type { Env } from '../../env.js';

/**
 * Builds the OpenTelemetry trace config consumed by `instrument()` / `instrumentDO()`.
 *
 * This module is import-type-only against `@microlabs/otel-cf-workers` (which pulls
 * in the Workers-only `cloudflare:workers` module), so the pure logic here stays
 * unit-testable under Node. The runtime wiring lives in `index.ts`.
 *
 * Tracing is a no-op when `OTEL_EXPORTER_OTLP_ENDPOINT` is unset: the head sampler
 * drops every span, so nothing is recorded or exported and no network call is made.
 */

type TracingEnv = Pick<
  Env,
  'OTEL_EXPORTER_OTLP_ENDPOINT' | 'OTEL_EXPORTER_OTLP_HEADERS' | 'OTEL_TRACES_SAMPLER_RATIO'
>;

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

/** Head sample ratio in [0,1]: 0 when disabled; `OTEL_TRACES_SAMPLER_RATIO` (default 1) when enabled. */
export function resolveSampleRatio(env: TracingEnv): number {
  if (!isTracingEnabled(env)) return 0;
  const raw = env.OTEL_TRACES_SAMPLER_RATIO;
  if (raw == null) return 1;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 1;
}

export interface ServiceInfo {
  name: string;
  version?: string;
}

export function buildTraceConfig(env: TracingEnv, service: ServiceInfo): TraceConfig {
  const enabled = isTracingEnabled(env);
  const base = (env.OTEL_EXPORTER_OTLP_ENDPOINT ?? DEFAULT_OTLP_BASE).replace(/\/+$/, '');
  return {
    service: { name: service.name, version: service.version },
    exporter: {
      // Endpoint is the OTLP/HTTP base; traces go to /v1/traces. Unused when disabled
      // (ratio 0 means export() is never called).
      url: `${base}/v1/traces`,
      headers: parseOtlpHeaders(env.OTEL_EXPORTER_OTLP_HEADERS),
    },
    sampling: {
      headSampler: { ratio: resolveSampleRatio(env), acceptRemote: enabled },
    },
  };
}

/** A `ResolveConfigFn` bound to a fixed `service.name` (one per component/layer). */
export function traceConfigFor(service: ServiceInfo): ResolveConfigFn<Env> {
  return (env: Env) => buildTraceConfig(env, service);
}
