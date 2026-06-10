import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { Env, Variables } from '../env.js';
import { errorHandler } from './error-handler.js';
import { requestTelemetry } from './request-telemetry.js';
import { createTestDb } from '../test-utils/db.js';
import { requestMetrics } from '../lib/schema/index.js';

/**
 * Builds an app wired exactly like production: requestTelemetry wraps the
 * pipeline, and a db-provider middleware (standing in for dbMiddleware) sets the
 * per-request Drizzle instance that the telemetry recorder reads from c.get('db').
 */
function buildApp(db: BetterSQLite3Database) {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.onError(errorHandler);
  app.use('*', requestTelemetry);
  app.use('*', async (c, next) => {
    c.set('requestId', 'req-test'); // set by hono's requestId() in production
    c.set('db', db);
    await next();
  });
  app.get('/api/fast', (c) => c.json({ ok: true }));
  app.get('/api/slow/:id', async (c) => {
    await new Promise((resolve) => setTimeout(resolve, 12));
    return c.json({ id: c.req.param('id') });
  });
  app.post('/api/upload', (c) => c.json({ ok: true }));
  app.get('/api/forbidden', (c) => c.json({ error: 'forbidden' }, 403));
  app.get('/api/boom', () => {
    throw new Error('kaboom');
  });
  app.get('/health', (c) => c.json({ ok: true }));
  return app;
}

/** Fake ExecutionContext that captures waitUntil promises so the test can await the flush. */
function fakeCtx() {
  const waits: Promise<unknown>[] = [];
  const ctx = {
    waitUntil(p: Promise<unknown>) {
      waits.push(p);
    },
    passThroughOnException() {},
    props: {},
  };
  return { ctx, waits };
}

describe('requestTelemetry middleware', () => {
  let db: BetterSQLite3Database;

  beforeEach(() => {
    ({ db } = createTestDb());
  });

  it('records latency for each /api request, labelled by route pattern', async () => {
    const app = buildApp(db);
    const { ctx, waits } = fakeCtx();

    await app.request('/api/fast', undefined, {}, ctx);
    await app.request('/api/slow/abc123', undefined, {}, ctx);
    await Promise.all(waits);

    const rows = db.select().from(requestMetrics).all().sort((a, b) => a.route.localeCompare(b.route));
    expect(rows).toHaveLength(2);

    expect(rows[0]).toMatchObject({ method: 'GET', route: '/api/fast', status: 200, requestId: 'req-test' });
    // IDs are collapsed to the parameter name — low cardinality for grouping.
    expect(rows[1]).toMatchObject({ method: 'GET', route: '/api/slow/:id', status: 200, requestId: 'req-test' });
    expect(rows[1].durationMs).toBeGreaterThanOrEqual(5);
    for (const row of rows) expect(row.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('captures inbound payload size from Content-Length', async () => {
    const app = buildApp(db);
    const { ctx, waits } = fakeCtx();

    await app.request('/api/upload', { method: 'POST', headers: { 'content-length': '4096' } }, {}, ctx);
    await Promise.all(waits);

    const rows = db.select().from(requestMetrics).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ method: 'POST', route: '/api/upload', requestBytes: 4096 });
  });

  it('captures the error status for thrown requests', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = buildApp(db);
    const { ctx, waits } = fakeCtx();

    const res = await app.request('/api/boom', undefined, {}, ctx);
    await Promise.all(waits);

    expect(res.status).toBe(500);
    const rows = db.select().from(requestMetrics).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ method: 'GET', route: '/api/boom', status: 500 });
    vi.restoreAllMocks();
  });

  it('skips non-API paths', async () => {
    const app = buildApp(db);
    const { ctx, waits } = fakeCtx();

    const res = await app.request('/health', undefined, {}, ctx);
    await Promise.all(waits);

    expect(res.status).toBe(200);
    expect(db.select().from(requestMetrics).all()).toHaveLength(0);
  });

  it('respects a zero sample rate but always records errors and auth failures', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = buildApp(db);
    const { ctx, waits } = fakeCtx();
    const env = { REQUEST_TELEMETRY_SAMPLE_RATE: '0' };

    await app.request('/api/fast', undefined, env, ctx); // 200 — dropped by sampling
    await app.request('/api/boom', undefined, env, ctx); // 500 — always kept
    await app.request('/api/forbidden', undefined, env, ctx); // 403 — always kept (security signal)
    await Promise.all(waits);

    const rows = db.select().from(requestMetrics).all().sort((a, b) => a.status - b.status);
    expect(rows.map((r) => ({ route: r.route, status: r.status }))).toEqual([
      { route: '/api/forbidden', status: 403 },
      { route: '/api/boom', status: 500 },
    ]);
    vi.restoreAllMocks();
  });
});
