import { Hono } from 'hono';
import type { Env, Variables } from '../env.js';
import type { UsageStatsResponse } from '@valet/shared';
import { getUsageHeroStats, getUsageByDay, getUsageByUser, getUsageByModel, getUsageByUserModel, getSandboxHeroStats, getSandboxByDay, getSandboxByUser } from '../lib/db/analytics.js';
import { getModelPricing } from '../services/model-catalog.js';
import { computeSandboxCost, DEFAULT_CPU_CORES, DEFAULT_MEMORY_GIB } from '../services/sandbox-pricing.js';
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

  // Fetch all data + pricing in parallel (including sandbox stats)
  const [heroStats, byDayRaw, byUserRaw, byModelRaw, byUserModelRaw, pricingMap, sandboxHero, sandboxByDay, sandboxByUser] = await Promise.all([
    getUsageHeroStats(db, periodStart),
    getUsageByDay(db, periodStart),
    getUsageByUser(db, periodStart),
    getUsageByModel(db, periodStart),
    getUsageByUserModel(db, periodStart),
    getModelPricing(appDb, c.env),
    getSandboxHeroStats(db, periodStart),
    getSandboxByDay(db, periodStart),
    getSandboxByUser(db, periodStart),
  ]);

  // Compute hero LLM total cost
  let heroLlmCost: number | null = null;
  for (const modelRow of byModelRaw) {
    const cost = computeCost(modelRow.model, modelRow.inputTokens, modelRow.outputTokens, pricingMap);
    if (cost !== null) {
      heroLlmCost = (heroLlmCost ?? 0) + cost;
    }
  }

  // Compute hero sandbox cost
  const heroSandboxCost = computeSandboxCost(sandboxHero.totalActiveSeconds);
  const heroTotalCost = heroLlmCost !== null ? heroLlmCost + heroSandboxCost : heroSandboxCost > 0 ? heroSandboxCost : null;

  // Build sandbox-by-day lookup
  const sandboxDayMap = new Map<string, number>();
  for (const row of sandboxByDay) {
    sandboxDayMap.set(row.date, row.activeSeconds);
  }

  // Aggregate cost by day (collapse model-level rows into day-level)
  const dayMap = new Map<string, { cost: number | null; inputTokens: number; outputTokens: number; sandboxCost: number; sandboxActiveSeconds: number }>();
  for (const row of byDayRaw) {
    const existing = dayMap.get(row.date) ?? { cost: null, inputTokens: 0, outputTokens: 0, sandboxCost: 0, sandboxActiveSeconds: 0 };
    existing.inputTokens += row.inputTokens;
    existing.outputTokens += row.outputTokens;
    const cost = computeCost(row.model, row.inputTokens, row.outputTokens, pricingMap);
    if (cost !== null) {
      existing.cost = (existing.cost ?? 0) + cost;
    }
    dayMap.set(row.date, existing);
  }
  // Merge sandbox data into day map (some days may only have sandbox data)
  for (const row of sandboxByDay) {
    const existing = dayMap.get(row.date) ?? { cost: null, inputTokens: 0, outputTokens: 0, sandboxCost: 0, sandboxActiveSeconds: 0 };
    existing.sandboxActiveSeconds = row.activeSeconds;
    existing.sandboxCost = computeSandboxCost(row.activeSeconds);
    dayMap.set(row.date, existing);
  }
  const costByDay = Array.from(dayMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, data]) => ({ date, ...data }));

  // Build per-user LLM cost from per-user per-model data
  const userCostMap = new Map<string, number | null>();
  for (const row of byUserModelRaw) {
    const cost = computeCost(row.model, row.inputTokens, row.outputTokens, pricingMap);
    if (cost !== null) {
      userCostMap.set(row.userId, (userCostMap.get(row.userId) ?? 0) + cost);
    }
  }

  // Build per-user sandbox cost lookup
  const userSandboxMap = new Map<string, { cost: number; activeSeconds: number }>();
  for (const row of sandboxByUser) {
    const cpuCores = row.sandboxCpuCores ?? DEFAULT_CPU_CORES;
    const memoryGiB = row.sandboxMemoryMib != null ? row.sandboxMemoryMib / 1024 : DEFAULT_MEMORY_GIB;
    userSandboxMap.set(row.userId, {
      cost: computeSandboxCost(row.activeSeconds, cpuCores, memoryGiB),
      activeSeconds: row.activeSeconds,
    });
  }

  const byUser = byUserRaw.map((row) => {
    const llmCost = userCostMap.get(row.userId) ?? null;
    const sandbox = userSandboxMap.get(row.userId);
    const sandboxCost = sandbox?.cost ?? 0;
    const totalCost = llmCost !== null ? llmCost + sandboxCost : sandboxCost > 0 ? sandboxCost : null;
    return {
      userId: row.userId,
      email: row.email,
      ...(row.name ? { name: row.name } : {}),
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cost: totalCost,
      sessionCount: row.sessionCount,
      sandboxCost,
      sandboxActiveSeconds: sandbox?.activeSeconds ?? 0,
    };
  });

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
      sandboxCost: heroSandboxCost,
      sandboxActiveSeconds: sandboxHero.totalActiveSeconds,
    },
    costByDay,
    byUser,
    byModel,
    period: periodHours,
  };

  return c.json(response);
});
