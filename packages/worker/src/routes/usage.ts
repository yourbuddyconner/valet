import { Hono } from 'hono';
import type { Env, Variables } from '../env.js';
import type { UsageStatsResponse } from '@agent-ops/shared';
import { getUsageHeroStats, getUsageByDay, getUsageByUser, getUsageByModel, getUsageByUserModel } from '../lib/db/usage.js';
import { getModelPricing } from '../services/model-catalog.js';
import { getDb } from '../lib/drizzle.js';

export const usageRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * Compute cost for a given token count using the pricing map.
 * Returns null if no pricing data is available for the model.
 */
function computeCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  pricingMap: Map<string, { inputCostPerMillion: number; outputCostPerMillion: number }>,
): number | null {
  const pricing = pricingMap.get(model);
  if (!pricing) return null;
  return (inputTokens * pricing.inputCostPerMillion + outputTokens * pricing.outputCostPerMillion) / 1_000_000;
}

// GET /api/usage/stats?period=24
usageRouter.get('/stats', async (c) => {
  const user = c.get('user');
  if (!user || user.role !== 'admin') {
    return c.json({ error: 'Admin access required', code: 'FORBIDDEN' }, 403);
  }

  const rawPeriod = parseInt(c.req.query('period') || '720', 10);
  const periodHours = Number.isFinite(rawPeriod) ? Math.min(Math.max(rawPeriod, 1), 8760) : 720;
  const periodStart = new Date(Date.now() - periodHours * 60 * 60 * 1000).toISOString();

  const db = c.env.DB;
  const appDb = getDb(db);

  // Fetch all data + pricing in parallel
  const [heroStats, byDayRaw, byUserRaw, byModelRaw, byUserModelRaw, pricingMap] = await Promise.all([
    getUsageHeroStats(db, periodStart),
    getUsageByDay(db, periodStart),
    getUsageByUser(db, periodStart),
    getUsageByModel(db, periodStart),
    getUsageByUserModel(db, periodStart),
    getModelPricing(appDb, c.env),
  ]);

  // Compute hero total cost
  let heroTotalCost: number | null = null;
  for (const modelRow of byModelRaw) {
    const cost = computeCost(modelRow.model, modelRow.inputTokens, modelRow.outputTokens, pricingMap);
    if (cost !== null) {
      heroTotalCost = (heroTotalCost ?? 0) + cost;
    }
  }

  // Aggregate cost by day (collapse model-level rows into day-level)
  const dayMap = new Map<string, { cost: number | null; inputTokens: number; outputTokens: number }>();
  for (const row of byDayRaw) {
    const existing = dayMap.get(row.date) ?? { cost: null, inputTokens: 0, outputTokens: 0 };
    existing.inputTokens += row.inputTokens;
    existing.outputTokens += row.outputTokens;
    const cost = computeCost(row.model, row.inputTokens, row.outputTokens, pricingMap);
    if (cost !== null) {
      existing.cost = (existing.cost ?? 0) + cost;
    }
    dayMap.set(row.date, existing);
  }
  const costByDay = Array.from(dayMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, data]) => ({ date, ...data }));

  // Build per-user cost from per-user per-model data
  const userCostMap = new Map<string, number | null>();
  for (const row of byUserModelRaw) {
    const cost = computeCost(row.model, row.inputTokens, row.outputTokens, pricingMap);
    if (cost !== null) {
      userCostMap.set(row.userId, (userCostMap.get(row.userId) ?? 0) + cost);
    }
  }

  const byUser = byUserRaw.map((row) => ({
    userId: row.userId,
    email: row.email,
    ...(row.name ? { name: row.name } : {}),
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cost: userCostMap.get(row.userId) ?? null,
    sessionCount: row.sessionCount,
  }));

  // Cost by model
  const totalTokens = byModelRaw.reduce((sum, r) => sum + r.inputTokens + r.outputTokens, 0);
  const byModel = byModelRaw.map((row) => {
    const cost = computeCost(row.model, row.inputTokens, row.outputTokens, pricingMap);
    const percentage = totalTokens > 0
      ? Math.round(((row.inputTokens + row.outputTokens) / totalTokens) * 1000) / 10
      : 0;
    return {
      model: row.model,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cost,
      callCount: row.callCount,
      percentage,
    };
  });

  const response: UsageStatsResponse = {
    hero: {
      totalCost: heroTotalCost,
      totalInputTokens: heroStats.totalInputTokens,
      totalOutputTokens: heroStats.totalOutputTokens,
      totalSessions: heroStats.totalSessions,
      totalUsers: heroStats.totalUsers,
    },
    costByDay,
    byUser,
    byModel,
    period: periodHours,
  };

  return c.json(response);
});
