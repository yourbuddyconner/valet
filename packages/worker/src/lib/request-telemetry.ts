import type { AppDb } from './drizzle.js';
import { requestMetrics } from './schema/index.js';
import type { Env } from '../env.js';

/**
 * Capture helpers for API request telemetry.
 *
 * Pure functions live here (sampling decision, rate resolution, the single-row
 * insert) so they can be tested without a request context. The middleware in
 * `middleware/request-telemetry.ts` wires them onto the request lifecycle.
 */

/** Record every request by default. Operators can dial this down for high-traffic deployments. */
export const DEFAULT_SAMPLE_RATE = 1;

export interface RequestMetricEntry {
  method: string;
  route: string;
  status: number;
  durationMs: number;
  requestId?: string | null;
  requestBytes?: number | null;
  userId?: string | null;
}

/** Authorization failures — authenticated-but-forbidden and unauthenticated. */
const AUTH_FAILURE_STATUSES = new Set([401, 403]);

/**
 * Whether a request must be recorded regardless of the sample rate. These are the
 * forensic-critical events that sampling must never drop: server errors (5xx) and
 * authorization failures (401/403 — the signal for probing / broken object-level
 * authorization / leakage attempts).
 */
export function isAlwaysRecorded(status: number): boolean {
  return status >= 500 || AUTH_FAILURE_STATUSES.has(status);
}

/**
 * Resolve the sample rate from the optional `REQUEST_TELEMETRY_SAMPLE_RATE` env
 * var (a number in [0, 1]). Falls back to {@link DEFAULT_SAMPLE_RATE} when unset
 * or malformed.
 */
export function resolveSampleRate(env: Pick<Env, 'REQUEST_TELEMETRY_SAMPLE_RATE'>): number {
  const raw = env.REQUEST_TELEMETRY_SAMPLE_RATE;
  if (raw == null) return DEFAULT_SAMPLE_RATE;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : DEFAULT_SAMPLE_RATE;
}

/**
 * Decide whether to record a request. Forensic-critical events (5xx and auth
 * failures — see {@link isAlwaysRecorded}) are always kept so security signal
 * survives aggressive sampling; otherwise we keep a `rate` fraction of requests.
 * `rng` is injectable for deterministic tests.
 */
export function shouldSample(status: number, rate: number, rng: () => number = Math.random): boolean {
  if (isAlwaysRecorded(status)) return true;
  if (rate >= 1) return true;
  if (rate <= 0) return false;
  return rng() < rate;
}

/**
 * Insert one request-metric row. Fire-and-forget from the edge — callers run this
 * inside `ctx.waitUntil` so it never adds latency to the response it measures.
 */
export async function recordRequestMetric(db: AppDb, entry: RequestMetricEntry): Promise<void> {
  await db.insert(requestMetrics).values({
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    method: entry.method,
    route: entry.route,
    status: entry.status,
    durationMs: entry.durationMs,
    requestId: entry.requestId ?? null,
    requestBytes: entry.requestBytes ?? null,
    userId: entry.userId ?? null,
  });
}
