import { sql, gte, asc } from 'drizzle-orm';
import type { AppDb } from '../drizzle.js';
import { requestMetrics } from '../schema/index.js';

// ─── Request Performance Queries ─────────────────────────────────────────────
//
// Reads over `request_metrics` for the API-latency dashboard. Percentiles use the
// same ordered-offset approach as lib/db/analytics.ts (exact, index-friendly for
// the row counts this table holds) so behaviour stays uniform across the two
// telemetry surfaces.

export interface RequestLatencyStats {
  p50: number | null;
  p95: number | null;
  p99: number | null;
  count: number;
  errorCount: number;
  errorRate: number;
}

/** Overall request latency (p50/p95/p99) and 5xx error rate across the window. */
export async function getRequestLatency(
  db: AppDb,
  periodStart: string,
): Promise<RequestLatencyStats> {
  const [agg] = await db
    .select({
      count: sql<number>`count(*)`,
      errors: sql<number>`coalesce(sum(case when ${requestMetrics.status} >= 500 then 1 else 0 end), 0)`,
    })
    .from(requestMetrics)
    .where(gte(requestMetrics.createdAt, periodStart));

  const count = Number(agg?.count ?? 0);
  const errorCount = Number(agg?.errors ?? 0);
  if (count === 0) {
    return { p50: null, p95: null, p99: null, count: 0, errorCount: 0, errorRate: 0 };
  }

  // The k-th smallest duration_ms via ORDER BY ... LIMIT 1 OFFSET k.
  const at = async (quantile: number): Promise<number | null> => {
    const offset = Math.min(Math.floor((count - 1) * quantile), count - 1);
    const [row] = await db
      .select({ durationMs: requestMetrics.durationMs })
      .from(requestMetrics)
      .where(gte(requestMetrics.createdAt, periodStart))
      .orderBy(asc(requestMetrics.durationMs))
      .limit(1)
      .offset(offset);
    return row?.durationMs ?? null;
  };

  const [p50, p95, p99] = await Promise.all([at(0.5), at(0.95), at(0.99)]);

  return { p50, p95, p99, count, errorCount, errorRate: errorCount / count };
}

export interface SlowRouteRow {
  method: string;
  route: string;
  count: number;
  errorCount: number;
  errorRate: number;
  p50: number | null;
  p95: number | null;
}

/**
 * Per-route latency breakdown, slowest first (by p95). Rows arrive ordered by
 * (route, method, duration) so each group's durations are already ascending and
 * percentile offsets are a direct index.
 */
export async function getSlowRoutes(
  db: AppDb,
  periodStart: string,
  limit = 20,
): Promise<SlowRouteRow[]> {
  const rows = await db
    .select({
      method: requestMetrics.method,
      route: requestMetrics.route,
      status: requestMetrics.status,
      durationMs: requestMetrics.durationMs,
    })
    .from(requestMetrics)
    .where(gte(requestMetrics.createdAt, periodStart))
    .orderBy(asc(requestMetrics.route), asc(requestMetrics.method), asc(requestMetrics.durationMs));

  const groups = new Map<string, { method: string; route: string; durations: number[]; errors: number }>();
  for (const r of rows) {
    const key = `${r.method} ${r.route}`;
    const group = groups.get(key) ?? { method: r.method, route: r.route, durations: [], errors: 0 };
    group.durations.push(r.durationMs);
    if (r.status >= 500) group.errors += 1;
    groups.set(key, group);
  }

  return Array.from(groups.values())
    .map((g) => {
      const n = g.durations.length;
      return {
        method: g.method,
        route: g.route,
        count: n,
        errorCount: g.errors,
        errorRate: n > 0 ? g.errors / n : 0,
        p50: g.durations[Math.floor((n - 1) * 0.5)] ?? null,
        p95: g.durations[Math.floor((n - 1) * 0.95)] ?? null,
      };
    })
    .sort((a, b) => (b.p95 ?? 0) - (a.p95 ?? 0))
    .slice(0, limit);
}
