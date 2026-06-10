import { sql, and, gte, desc, isNotNull, inArray } from 'drizzle-orm';
import type { AppDb } from '../drizzle.js';
import { requestMetrics } from '../schema/index.js';

// ─── Request Forensics Queries ───────────────────────────────────────────────
//
// Investigation lenses over `request_metrics`. They answer "who touched what,
// was it allowed, and how big / slow was it" — the starting point for both
// information-leakage and reliability investigations. Each row carries the
// request_id, so an analyst can pivot from a suspicious aggregate to the full
// request log in Cloudflare Observability.

export interface AccessDenialRow {
  userId: string | null;
  route: string;
  status: number; // 401 (unauthenticated) or 403 (forbidden)
  count: number;
}

/**
 * Authorization failures grouped by actor + route, most frequent first.
 *
 * Repeated 403s on resource-scoped routes (e.g. /api/sessions/:id) are the
 * canonical signal for probing or broken object-level authorization — i.e.
 * attempts to reach information the caller should not see.
 */
export async function getAccessDenials(
  db: AppDb,
  periodStart: string,
  limit = 20,
): Promise<AccessDenialRow[]> {
  const rows = await db
    .select({
      userId: requestMetrics.userId,
      route: requestMetrics.route,
      status: requestMetrics.status,
      count: sql<number>`count(*)`,
    })
    .from(requestMetrics)
    .where(and(gte(requestMetrics.createdAt, periodStart), inArray(requestMetrics.status, [401, 403])))
    .groupBy(requestMetrics.userId, requestMetrics.route, requestMetrics.status)
    .orderBy(desc(sql`count(*)`))
    .limit(limit);

  return rows.map((r) => ({
    userId: r.userId ?? null,
    route: r.route,
    status: r.status,
    count: Number(r.count),
  }));
}

export interface RequestSampleRow {
  method: string;
  route: string;
  status: number;
  durationMs: number;
  requestBytes: number | null;
  requestId: string | null;
  createdAt: string;
}

const sampleColumns = {
  method: requestMetrics.method,
  route: requestMetrics.route,
  status: requestMetrics.status,
  durationMs: requestMetrics.durationMs,
  requestBytes: requestMetrics.requestBytes,
  requestId: requestMetrics.requestId,
  createdAt: requestMetrics.createdAt,
} as const;

function toSample(r: {
  method: string;
  route: string;
  status: number;
  durationMs: number;
  requestBytes: number | null;
  requestId: string | null;
  createdAt: string | null;
}): RequestSampleRow {
  return {
    method: r.method,
    route: r.route,
    status: r.status,
    durationMs: r.durationMs,
    requestBytes: r.requestBytes ?? null,
    requestId: r.requestId ?? null,
    createdAt: r.createdAt ?? '',
  };
}

/**
 * Largest inbound payloads, biggest first. Surfaces large-file / large-payload
 * ingress and — via the status on each row — whether those heavy requests failed,
 * the API-side symptom of "can't parse large files".
 */
export async function getHeavyRequests(
  db: AppDb,
  periodStart: string,
  limit = 10,
): Promise<RequestSampleRow[]> {
  const rows = await db
    .select(sampleColumns)
    .from(requestMetrics)
    .where(and(gte(requestMetrics.createdAt, periodStart), isNotNull(requestMetrics.requestBytes)))
    .orderBy(desc(requestMetrics.requestBytes))
    .limit(limit);
  return rows.map(toSample);
}

/**
 * Slowest requests, longest first. Surfaces timeout-prone synchronous calls; the
 * request_id pivots into the trace to see where the time went.
 */
export async function getSlowestRequests(
  db: AppDb,
  periodStart: string,
  limit = 10,
): Promise<RequestSampleRow[]> {
  const rows = await db
    .select(sampleColumns)
    .from(requestMetrics)
    .where(gte(requestMetrics.createdAt, periodStart))
    .orderBy(desc(requestMetrics.durationMs))
    .limit(limit);
  return rows.map(toSample);
}
