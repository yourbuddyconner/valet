import { categorizeThread } from './categorize.js';
import { CATEGORIES } from './types.js';
import type {
  Attribution,
  Category,
  Classification,
  JoinDiagnostic,
  ThreadRow,
  ThreadTotals,
} from './types.js';

export interface AttributionInput {
  from: Date;
  to: Date;
  env: 'dev' | 'prod';
  generatedAt: Date;
  classifierModel: 'haiku' | 'sonnet' | null;
  diagnostic: JoinDiagnostic;
  threads: Map<string, ThreadRow>; // by threadId; missing for unattributed buckets
  totals: Map<string, ThreadTotals>; // by threadId; one entry per bucket including unattributed
  users: Map<string, { id: string; email: string | null }>;
  classifications: Map<string, Classification>; // by threadId
  topN?: number;
}

const DEFAULT_TOP_N = 50;

export function buildAttribution(input: AttributionInput): Attribution {
  const topN = input.topN ?? DEFAULT_TOP_N;

  // Initialize per-category accumulators.
  const byCategory = makeCategoryRecord(() => ({
    threads: 0,
    llmCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
  }));

  const byModel = new Map<string, { calls: number; inputTokens: number; outputTokens: number }>();
  const unattributed = { llmCalls: 0, inputTokens: 0, outputTokens: 0 };
  const byUser = new Map<
    string,
    {
      userId: string;
      email: string | null;
      totalInputTokens: number;
      totalOutputTokens: number;
      threadCount: number;
      byCategory: Record<Category, { threads: number; inputTokens: number; outputTokens: number }>;
    }
  >();
  const daily = new Map<string, Record<Category, { inputTokens: number; outputTokens: number }>>();
  const toolTotals = new Map<string, { calls: number; inputTokens: number }>();

  let totalInput = 0;
  let totalOutput = 0;
  let totalCalls = 0;

  // Track which threads are real (have a ThreadRow) vs unattributed buckets.
  const attributedThreads: Array<{
    threadId: string;
    sessionId: string;
    category: Category;
    userId: string;
    userEmail: string | null;
    totals: ThreadTotals;
  }> = [];

  for (const [threadId, totals] of input.totals) {
    totalInput += totals.inputTokens;
    totalOutput += totals.outputTokens;
    totalCalls += totals.llmCalls;

    for (const [model, bd] of Object.entries(totals.modelBreakdown)) {
      const m = byModel.get(model) ?? { calls: 0, inputTokens: 0, outputTokens: 0 };
      m.calls += bd.calls;
      m.inputTokens += bd.inputTokens;
      m.outputTokens += bd.outputTokens;
      byModel.set(model, m);
    }

    if (threadId.startsWith('__unattributed__:')) {
      unattributed.llmCalls += totals.llmCalls;
      unattributed.inputTokens += totals.inputTokens;
      unattributed.outputTokens += totals.outputTokens;
      continue;
    }

    const thread = input.threads.get(threadId);
    if (!thread) {
      // We had llm_calls for a thread_id that isn't in session_threads. Treat
      // like unattributed.
      unattributed.llmCalls += totals.llmCalls;
      unattributed.inputTokens += totals.inputTokens;
      unattributed.outputTokens += totals.outputTokens;
      continue;
    }

    const category = categorizeThread(thread);

    const catBucket = byCategory[category];
    catBucket.threads += 1;
    catBucket.llmCalls += totals.llmCalls;
    catBucket.inputTokens += totals.inputTokens;
    catBucket.outputTokens += totals.outputTokens;

    // By-user roll-up. Email comes from user lookup; thread.userEmail is
    // best-effort but might be stale if the user row was updated.
    const userId = thread.userId;
    const email = input.users.get(userId)?.email ?? thread.userEmail;
    const u = byUser.get(userId) ?? {
      userId,
      email,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      threadCount: 0,
      byCategory: makeCategoryRecord(() => ({
        threads: 0,
        inputTokens: 0,
        outputTokens: 0,
      })),
    };
    u.totalInputTokens += totals.inputTokens;
    u.totalOutputTokens += totals.outputTokens;
    u.threadCount += 1;
    const ub = u.byCategory[category];
    ub.threads += 1;
    ub.inputTokens += totals.inputTokens;
    ub.outputTokens += totals.outputTokens;
    byUser.set(userId, u);

    // Daily — bucket by date of firstCallAt (UTC). Threads spanning midnights
    // attribute to first day; cheap and good enough for trend-spotting.
    const date = totals.firstCallAt.slice(0, 10);
    const day =
      daily.get(date) ?? makeCategoryRecord(() => ({ inputTokens: 0, outputTokens: 0 }));
    day[category].inputTokens += totals.inputTokens;
    day[category].outputTokens += totals.outputTokens;
    daily.set(date, day);

    // Tool leaderboard. Tokens attributed to a tool = thread input tokens
    // weighted by that tool's call share within the thread. Rough heuristic,
    // but it lets us rank "which tools are showing up alongside the spend".
    const toolTotalCalls = totals.toolHistogram.reduce((s, t) => s + t.calls, 0);
    for (const t of totals.toolHistogram) {
      const share = toolTotalCalls === 0 ? 0 : t.calls / toolTotalCalls;
      const tt = toolTotals.get(t.toolName) ?? { calls: 0, inputTokens: 0 };
      tt.calls += t.calls;
      tt.inputTokens += Math.round(totals.inputTokens * share);
      toolTotals.set(t.toolName, tt);
    }

    attributedThreads.push({
      threadId,
      sessionId: thread.sessionId,
      category,
      userId,
      userEmail: email,
      totals,
    });
  }

  // Top threads (attributed only, sorted by inputTokens desc).
  const topThreads = attributedThreads
    .slice()
    .sort((a, b) => b.totals.inputTokens - a.totals.inputTokens)
    .slice(0, topN)
    .map((t, idx) => ({
      rank: idx + 1,
      threadId: t.threadId,
      sessionId: t.sessionId,
      category: t.category,
      userId: t.userId,
      userEmail: t.userEmail,
      llmCalls: t.totals.llmCalls,
      inputTokens: t.totals.inputTokens,
      outputTokens: t.totals.outputTokens,
      topTools: t.totals.toolHistogram
        .slice()
        .sort((a, b) => b.calls - a.calls)
        .slice(0, 5),
      firstMessagePreview: '', // filled by the runner (needs message fetch)
      classification: input.classifications.get(t.threadId) ?? null,
    }));

  // Sort by-user and by-model for stable output.
  const byUserArr = Array.from(byUser.values()).sort(
    (a, b) => b.totalInputTokens - a.totalInputTokens,
  );

  const byModelArr = Array.from(byModel.entries())
    .map(([model, v]) => ({
      model,
      calls: v.calls,
      inputTokens: v.inputTokens,
      outputTokens: v.outputTokens,
      avgInputPerCall: v.calls === 0 ? 0 : Math.round(v.inputTokens / v.calls),
    }))
    .sort((a, b) => b.inputTokens - a.inputTokens);

  const dailyArr = Array.from(daily.entries())
    .map(([date, byCat]) => ({ date, byCategory: byCat }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const toolLeaderboard = Array.from(toolTotals.entries())
    .map(([toolName, v]) => ({
      toolName,
      calls: v.calls,
      inputTokens: v.inputTokens,
      share: totalInput === 0 ? 0 : v.inputTokens / totalInput,
    }))
    .sort((a, b) => b.inputTokens - a.inputTokens);

  const byModelRecord: Record<string, { calls: number; inputTokens: number; outputTokens: number }> =
    {};
  for (const [model, v] of byModel) byModelRecord[model] = v;

  return {
    meta: {
      from: isoDate(input.from),
      to: isoDate(input.to),
      env: input.env,
      generatedAt: input.generatedAt.toISOString(),
      classifierModel: input.classifierModel,
      totalThreads: attributedThreads.length,
      totalLlmCalls: totalCalls,
      joinHitRate: input.diagnostic.hitRate,
    },
    totals: {
      inputTokens: totalInput,
      outputTokens: totalOutput,
      byCategory,
      byModel: byModelRecord,
      unattributed,
    },
    byUser: byUserArr,
    byModel: byModelArr,
    topThreads,
    daily: dailyArr,
    toolLeaderboard,
  };
}

function makeCategoryRecord<T>(init: () => T): Record<Category, T> {
  const out = {} as Record<Category, T>;
  for (const c of CATEGORIES) out[c] = init();
  return out;
}

function isoDate(d: Date): string {
  return d.toISOString();
}
