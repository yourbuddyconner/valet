import { Hono } from 'hono';
import type { Env, Variables } from '../env.js';
import type { DashboardStatsResponse } from '@valet/shared';
import * as db from '../lib/db.js';
import type { SessionAggregateRow } from '../lib/db/dashboard.js';

export const dashboardRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * Trigger a metrics flush on DOs for sessions that haven't been backfilled yet.
 * Fire-and-forget: best-effort, non-blocking for fresh sessions.
 */
async function backfillUnflushedSessions(env: Env, sessionIds: string[]): Promise<void> {
  if (sessionIds.length === 0) return;

  await Promise.allSettled(
    sessionIds.map(async (id) => {
      try {
        const doId = env.SESSIONS.idFromName(id);
        const stub = env.SESSIONS.get(doId);
        await stub.fetch(new Request('http://do/flush-metrics', { method: 'POST' }));
      } catch {
        // DO may be evicted — skip
      }
    })
  );
}

/**
 * GET /api/dashboard/stats?period=30
 * Returns aggregated dashboard statistics for the given period (days).
 * All data comes from D1 — message/tool counts are flushed from DOs periodically.
 */
dashboardRouter.get('/stats', async (c) => {
  const user = c.get('user');
  // Accept period in hours (e.g. 1, 24, 168, 720) or legacy days via ?period=30
  const rawPeriod = c.req.query('period') || '720';
  const periodUnit = c.req.query('unit') || 'hours';
  const periodHours = periodUnit === 'days'
    ? Math.min(Math.max(parseInt(rawPeriod), 1), 90) * 24
    : Math.min(Math.max(parseInt(rawPeriod), 1), 2160); // max 90 days in hours
  const period = periodHours;

  const now = new Date();
  const periodStart = new Date(now.getTime() - periodHours * 60 * 60 * 1000);
  const prevPeriodStart = new Date(periodStart.getTime() - periodHours * 60 * 60 * 1000);

  const periodStartStr = periodStart.toISOString();
  const prevPeriodStartStr = prevPeriodStart.toISOString();

  // Lazy backfill: find sessions with message_count still at 0 and trigger DO flush.
  const unflushedIds = await db.getUnflushedSessionIds(c.env.DB, user.id, 20);
  if (unflushedIds.length > 0) {
    c.executionCtx?.waitUntil(backfillUnflushedSessions(c.env, unflushedIds));
  }

  const [
    orgAgg,
    userAgg,
    prevPeriod,
    activity,
    topRepos,
    recentSessions,
    activeSessions,
  ] = await Promise.all([
    db.getOrgSessionAggregate(c.env.DB, periodStartStr),
    db.getUserSessionAggregate(c.env.DB, user.id, periodStartStr),
    db.getPrevPeriodAggregate(c.env.DB, prevPeriodStartStr, periodStartStr),
    db.getSessionActivityByDay(c.env.DB, periodStartStr, Math.max(1, Math.ceil(periodHours / 24))),
    db.getTopReposBySessionCount(c.env.DB, periodStartStr, 8),
    db.getRecentUserSessions(c.env.DB, user.id, 10),
    db.getActiveUserSessions(c.env.DB, user.id),
  ]);

  function buildHero(agg: SessionAggregateRow) {
    const totalSessions = agg.total_sessions;
    const totalToolCalls = agg.total_tool_calls;
    const totalDuration = agg.total_duration;
    return {
      totalSessions,
      activeSessions: agg.active_sessions,
      totalMessages: agg.total_messages,
      uniqueRepos: agg.unique_repos,
      totalToolCalls,
      totalSessionDurationSeconds: totalDuration,
      avgSessionDurationSeconds: totalSessions > 0 ? Math.floor(totalDuration / totalSessions) : 0,
      estimatedLinesChanged: totalToolCalls * 15,
      sessionHours: Math.round((totalDuration / 3600) * 10) / 10,
    };
  }

  const prevSessions = prevPeriod.count;
  const prevMessages = prevPeriod.messages;
  const sessionDelta = prevSessions > 0 ? Math.round(((orgAgg.total_sessions - prevSessions) / prevSessions) * 100) : 0;
  const messageDelta = prevMessages > 0 ? Math.round(((orgAgg.total_messages - prevMessages) / prevMessages) * 100) : 0;

  const response: DashboardStatsResponse = {
    hero: buildHero(orgAgg),
    userHero: buildHero(userAgg),
    delta: {
      sessions: sessionDelta,
      messages: messageDelta,
    },
    activity,
    topRepos,
    recentSessions: recentSessions as DashboardStatsResponse['recentSessions'],
    activeSessions: activeSessions as DashboardStatsResponse['activeSessions'],
    period,
  };

  return c.json(response);
});

/**
 * GET /api/dashboard/adoption?period=30
 * Returns adoption metrics for agent-created PRs and commits.
 */
dashboardRouter.get('/adoption', async (c) => {
  const periodStr = c.req.query('period') || '30';
  const period = Math.min(Math.max(parseInt(periodStr), 1), 365);

  const metrics = await db.getAdoptionMetrics(c.get('db'), period);

  return c.json(metrics);
});
