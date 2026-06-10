import { Hono } from 'hono';
import type { Env, Variables } from '../env.js';
import type { AnalyticsPerformanceResponse, AnalyticsEventsResponse, RequestMetricsResponse, RequestForensicsResponse } from '@valet/shared';
import {
  getPercentiles,
  getPerfTrend,
  getStageBreakdown,
  getErrorRate,
  getSlowPaths,
  getThroughputStats,
  getEventFeed,
} from '../lib/db/analytics.js';
import { getRequestLatency, getSlowRoutes } from '../lib/db/request-metrics.js';
import { getAccessDenials, getHeavyRequests, getSlowestRequests } from '../lib/db/request-forensics.js';

export const analyticsRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

// GET /api/analytics/performance?period=720
analyticsRouter.get('/performance', async (c) => {
  const user = c.get('user');
  if (!user || user.role !== 'admin') {
    return c.json({ error: 'Admin access required', code: 'FORBIDDEN' }, 403);
  }

  const rawPeriod = parseInt(c.req.query('period') || '720', 10);
  const periodHours = Number.isFinite(rawPeriod) ? Math.min(Math.max(rawPeriod, 1), 8760) : 720;
  const periodStart = new Date(Date.now() - periodHours * 60 * 60 * 1000).toISOString();

  const db = c.env.DB;

  const [turnPercentiles, queuePercentiles, wakePercentiles, errorRate, throughput, trend, stages, slowByChannel, slowByModel] = await Promise.all([
    getPercentiles(db, 'turn_complete', periodStart),
    getPercentiles(db, 'queue_wait', periodStart),
    getPercentiles(db, 'runner_idle', periodStart),
    getErrorRate(db, periodStart),
    getThroughputStats(db, periodStart),
    getPerfTrend(db, 'turn_complete', periodStart),
    getStageBreakdown(db, periodStart),
    getSlowPaths(db, periodStart, 'channel'),
    getSlowPaths(db, periodStart, 'model'),
  ]);

  const slowPaths = [
    ...slowByChannel.map((r) => ({ dimension: 'channel', value: r.dimension, p50: r.p50, p95: r.p95, count: r.count })),
    ...slowByModel.map((r) => ({ dimension: 'model', value: r.dimension, p50: r.p50, p95: r.p95, count: r.count })),
  ];

  const response: AnalyticsPerformanceResponse = {
    hero: {
      turnLatencyP50: turnPercentiles.p50,
      turnLatencyP95: turnPercentiles.p95,
      queueWaitP50: queuePercentiles.p50,
      sandboxWakeP50: wakePercentiles.p50,
      errorRate: errorRate.errorRate,
      turnCount: errorRate.totalCompleted,
      errorCount: errorRate.totalErrors,
      tokensPerSecP50: throughput.medianTokensPerSec,
    },
    trend,
    stages,
    slowPaths,
    period: periodHours,
  };

  return c.json(response);
});

// GET /api/analytics/events?period=720&type=github.&limit=50&offset=0
analyticsRouter.get('/events', async (c) => {
  const user = c.get('user');
  if (!user || user.role !== 'admin') {
    return c.json({ error: 'Admin access required', code: 'FORBIDDEN' }, 403);
  }

  const rawPeriod = parseInt(c.req.query('period') || '720', 10);
  const periodHours = Number.isFinite(rawPeriod) ? Math.min(Math.max(rawPeriod, 1), 8760) : 720;
  const periodStart = new Date(Date.now() - periodHours * 60 * 60 * 1000).toISOString();
  const typePrefix = c.req.query('type') || undefined;
  const limit = Math.min(Math.max(parseInt(c.req.query('limit') || '50', 10), 1), 200);
  const offset = Math.max(parseInt(c.req.query('offset') || '0', 10), 0);

  const db = c.env.DB;
  const { events, total } = await getEventFeed(db, periodStart, { typePrefix, limit, offset });

  // Parse properties JSON for the response
  const parsed = events.map((e) => ({
    id: e.id,
    eventType: e.eventType,
    sessionId: e.sessionId,
    sessionTitle: e.sessionTitle,
    userId: e.userId,
    userEmail: e.userEmail,
    userName: e.userName,
    turnId: e.turnId,
    durationMs: e.durationMs,
    channel: e.channel,
    model: e.model,
    toolName: e.toolName,
    errorCode: e.errorCode,
    summary: e.summary,
    createdAt: e.createdAt,
    properties: e.properties ? (() => { try { return JSON.parse(e.properties!) as Record<string, unknown>; } catch { return null; } })() : null,
  }));

  const response: AnalyticsEventsResponse = {
    events: parsed,
    total,
    period: periodHours,
  };

  return c.json(response);
});

// GET /api/analytics/requests?period=720
// API request latency baseline: overall percentiles + slowest routes.
analyticsRouter.get('/requests', async (c) => {
  const user = c.get('user');
  if (!user || user.role !== 'admin') {
    return c.json({ error: 'Admin access required', code: 'FORBIDDEN' }, 403);
  }

  const rawPeriod = parseInt(c.req.query('period') || '720', 10);
  const periodHours = Number.isFinite(rawPeriod) ? Math.min(Math.max(rawPeriod, 1), 8760) : 720;
  const periodStart = new Date(Date.now() - periodHours * 60 * 60 * 1000).toISOString();

  const db = c.get('db');

  const [latency, routes] = await Promise.all([
    getRequestLatency(db, periodStart),
    getSlowRoutes(db, periodStart, 20),
  ]);

  const response: RequestMetricsResponse = {
    hero: {
      p50: latency.p50,
      p95: latency.p95,
      p99: latency.p99,
      count: latency.count,
      errorRate: latency.errorRate,
    },
    routes: routes.map((r) => ({
      method: r.method,
      route: r.route,
      count: r.count,
      p50: r.p50,
      p95: r.p95,
      errorRate: r.errorRate,
    })),
    period: periodHours,
  };

  return c.json(response);
});

// GET /api/analytics/requests/forensics?period=720
// Security + reliability investigation: authorization failures, heaviest
// payloads, and slowest requests — each with a request_id to pivot into logs.
analyticsRouter.get('/requests/forensics', async (c) => {
  const user = c.get('user');
  if (!user || user.role !== 'admin') {
    return c.json({ error: 'Admin access required', code: 'FORBIDDEN' }, 403);
  }

  const rawPeriod = parseInt(c.req.query('period') || '720', 10);
  const periodHours = Number.isFinite(rawPeriod) ? Math.min(Math.max(rawPeriod, 1), 8760) : 720;
  const periodStart = new Date(Date.now() - periodHours * 60 * 60 * 1000).toISOString();

  const db = c.get('db');

  const [accessDenials, heavyRequests, slowestRequests] = await Promise.all([
    getAccessDenials(db, periodStart, 20),
    getHeavyRequests(db, periodStart, 10),
    getSlowestRequests(db, periodStart, 10),
  ]);

  const response: RequestForensicsResponse = {
    accessDenials,
    heavyRequests,
    slowestRequests,
    period: periodHours,
  };

  return c.json(response);
});
