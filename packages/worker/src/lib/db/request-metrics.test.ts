import { beforeEach, describe, expect, it } from 'vitest';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { createTestDb } from '../../test-utils/db.js';
import { requestMetrics } from '../schema/index.js';
import { recordRequestMetric } from '../request-telemetry.js';
import { getRequestLatency, getSlowRoutes } from './request-metrics.js';

const HOUR = 60 * 60 * 1000;

interface SeedRow {
  method: string;
  route: string;
  status: number;
  durationMs: number;
  ageMs?: number; // how long ago the request happened (default: 1 min)
}

function seed(db: BetterSQLite3Database, rows: SeedRow[]): void {
  for (const r of rows) {
    db.insert(requestMetrics).values({
      id: crypto.randomUUID(),
      createdAt: new Date(Date.now() - (r.ageMs ?? 60_000)).toISOString(),
      method: r.method,
      route: r.route,
      status: r.status,
      durationMs: r.durationMs,
    }).run();
  }
}

describe('request-metrics queries', () => {
  let db: BetterSQLite3Database;

  beforeEach(() => {
    ({ db } = createTestDb());
  });

  it('records a well-formed row via recordRequestMetric', async () => {
    await recordRequestMetric(db, {
      method: 'GET',
      route: '/api/sessions/:id',
      status: 200,
      durationMs: 42,
      userId: null,
    });

    const rows = db.select().from(requestMetrics).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      method: 'GET',
      route: '/api/sessions/:id',
      status: 200,
      durationMs: 42,
      userId: null,
    });
    expect(rows[0].id).toBeTruthy();
    expect(rows[0].createdAt).toBeTruthy();
  });

  it('computes overall percentiles and 5xx error rate within the window', async () => {
    // Route A: 10 fast GETs (10..100ms), all 200.
    seed(db, Array.from({ length: 10 }, (_, i) => ({
      method: 'GET', route: '/api/sessions', status: 200, durationMs: (i + 1) * 10,
    })));
    // Route B: 3 slow GETs (200/400/600ms); the slowest is a 500.
    seed(db, [
      { method: 'GET', route: '/api/sessions/:id', status: 200, durationMs: 200 },
      { method: 'GET', route: '/api/sessions/:id', status: 200, durationMs: 400 },
      { method: 'GET', route: '/api/sessions/:id', status: 500, durationMs: 600 },
    ]);
    // Outside the 1h window — must be excluded.
    seed(db, [{ method: 'GET', route: '/api/old', status: 200, durationMs: 9999, ageMs: 2 * HOUR }]);

    const periodStart = new Date(Date.now() - HOUR).toISOString();
    const stats = await getRequestLatency(db, periodStart);

    // In-window durations sorted: 10,20,30,40,50,60,70,80,90,100,200,400,600 (n=13)
    expect(stats.count).toBe(13);
    expect(stats.p50).toBe(70);  // offset floor(12*0.50)=6
    expect(stats.p95).toBe(400); // offset floor(12*0.95)=11
    expect(stats.p99).toBe(400); // offset floor(12*0.99)=11
    expect(stats.errorCount).toBe(1);
    expect(stats.errorRate).toBeCloseTo(1 / 13);
  });

  it('returns zeros when there is no data in the window', async () => {
    const periodStart = new Date(Date.now() - HOUR).toISOString();
    const stats = await getRequestLatency(db, periodStart);
    expect(stats).toEqual({ p50: null, p95: null, p99: null, count: 0, errorCount: 0, errorRate: 0 });
  });

  it('breaks down latency per route, slowest (p95) first', async () => {
    seed(db, Array.from({ length: 10 }, (_, i) => ({
      method: 'GET', route: '/api/sessions', status: 200, durationMs: (i + 1) * 10,
    })));
    seed(db, [
      { method: 'GET', route: '/api/sessions/:id', status: 200, durationMs: 200 },
      { method: 'GET', route: '/api/sessions/:id', status: 200, durationMs: 400 },
      { method: 'GET', route: '/api/sessions/:id', status: 500, durationMs: 600 },
    ]);
    seed(db, [{ method: 'GET', route: '/api/old', status: 200, durationMs: 9999, ageMs: 2 * HOUR }]);

    const periodStart = new Date(Date.now() - HOUR).toISOString();
    const routes = await getSlowRoutes(db, periodStart);

    expect(routes.map((r) => r.route)).toEqual(['/api/sessions/:id', '/api/sessions']);

    const [slow, fast] = routes;
    expect(slow).toMatchObject({ method: 'GET', route: '/api/sessions/:id', count: 3, errorCount: 1, p50: 400, p95: 400 });
    expect(slow.errorRate).toBeCloseTo(1 / 3);
    expect(fast).toMatchObject({ method: 'GET', route: '/api/sessions', count: 10, errorCount: 0, errorRate: 0, p50: 50, p95: 90 });
  });

  it('honours the limit', async () => {
    seed(db, [
      { method: 'GET', route: '/api/a', status: 200, durationMs: 10 },
      { method: 'GET', route: '/api/b', status: 200, durationMs: 20 },
      { method: 'GET', route: '/api/c', status: 200, durationMs: 30 },
    ]);
    const periodStart = new Date(Date.now() - HOUR).toISOString();
    const routes = await getSlowRoutes(db, periodStart, 2);
    expect(routes).toHaveLength(2);
    // Slowest two by p95: /api/c (30) then /api/b (20).
    expect(routes.map((r) => r.route)).toEqual(['/api/c', '/api/b']);
  });
});
