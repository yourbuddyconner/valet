import { describe, expect, it } from 'vitest';
import { buildAttribution } from './attribution.js';
import type { Classification, ThreadRow, ThreadTotals } from './types.js';

function thread(over: Partial<ThreadRow>): ThreadRow {
  return {
    threadId: 'th-1',
    sessionId: 's-1',
    userId: 'u-1',
    userEmail: 'one@example.com',
    isOrchestrator: false,
    purpose: 'interactive',
    originType: null,
    originChannelType: null,
    originChannelId: null,
    originTriggerId: null,
    originTriggerType: null,
    threadTitle: null,
    sessionTitle: null,
    hasUserMessage: false,
    hasChannelMapping: false,
    ...over,
  };
}

function totals(threadId: string, over: Partial<ThreadTotals> = {}): ThreadTotals {
  const base: ThreadTotals = {
    threadId,
    sessionId: 's-1',
    inputTokens: 1000,
    outputTokens: 100,
    llmCalls: 5,
    toolCalls: 3,
    modelBreakdown: {},
    toolHistogram: [{ toolName: 'edit', calls: 3 }],
    firstCallAt: '2026-06-17 14:00:00',
    lastCallAt: '2026-06-17 14:10:00',
    ...over,
  };
  // Keep modelBreakdown consistent with the (possibly overridden) totals.
  if (Object.keys(base.modelBreakdown).length === 0) {
    base.modelBreakdown = {
      'claude-sonnet-4-6': {
        calls: base.llmCalls,
        inputTokens: base.inputTokens,
        outputTokens: base.outputTokens,
      },
    };
  }
  return base;
}

describe('buildAttribution', () => {
  it('rolls up by category, user, model and surfaces the unattributed bucket', () => {
    const t1 = thread({ threadId: 'th-1', userId: 'u-1', isOrchestrator: true, hasUserMessage: true });
    const t2 = thread({ threadId: 'th-2', userId: 'u-1', originTriggerId: 'tr-1' });
    const t3 = thread({ threadId: 'th-3', userId: 'u-2' });

    const tot = new Map<string, ThreadTotals>([
      ['th-1', totals('th-1', { inputTokens: 5000, llmCalls: 10 })],
      ['th-2', totals('th-2', { inputTokens: 3000, llmCalls: 5 })],
      ['th-3', totals('th-3', { inputTokens: 1000, llmCalls: 2 })],
      ['__unattributed__:s-99', totals('__unattributed__:s-99', { inputTokens: 500, llmCalls: 1 })],
    ]);

    const attr = buildAttribution({
      from: new Date('2026-06-10T00:00:00Z'),
      to: new Date('2026-06-17T00:00:00Z'),
      env: 'dev',
      generatedAt: new Date('2026-06-17T16:00:00Z'),
      classifierModel: 'haiku',
      diagnostic: { llmCallRows: 18, joinedToMessage: 17, hitRate: 17 / 18 },
      threads: new Map([
        ['th-1', t1],
        ['th-2', t2],
        ['th-3', t3],
      ]),
      totals: tot,
      users: new Map([
        ['u-1', { id: 'u-1', email: 'one@example.com' }],
        ['u-2', { id: 'u-2', email: 'two@example.com' }],
      ]),
      classifications: new Map(),
    });

    expect(attr.meta.totalThreads).toBe(3);
    expect(attr.meta.totalLlmCalls).toBe(18);
    expect(attr.totals.inputTokens).toBe(9500);

    expect(attr.totals.byCategory['orchestrator-chat'].threads).toBe(1);
    expect(attr.totals.byCategory['orchestrator-chat'].inputTokens).toBe(5000);
    expect(attr.totals.byCategory['automation-trigger'].inputTokens).toBe(3000);
    expect(attr.totals.byCategory['ad-hoc'].inputTokens).toBe(1000);
    expect(attr.totals.byCategory['orchestrator-internal'].inputTokens).toBe(0);

    expect(attr.totals.unattributed.inputTokens).toBe(500);
    expect(attr.totals.unattributed.llmCalls).toBe(1);

    expect(attr.byUser[0]!.userId).toBe('u-1');
    expect(attr.byUser[0]!.totalInputTokens).toBe(8000);
    expect(attr.byUser[1]!.userId).toBe('u-2');

    expect(attr.byModel[0]!.model).toBe('claude-sonnet-4-6');
    expect(attr.byModel[0]!.inputTokens).toBe(9500);

    expect(attr.topThreads).toHaveLength(3);
    expect(attr.topThreads[0]!.threadId).toBe('th-1');
    expect(attr.topThreads[1]!.threadId).toBe('th-2');
  });

  it('attaches classifications to top threads when available', () => {
    const classification: Classification = {
      taskType: 'debugging',
      costDriver: 'long-tool-loop',
      outcome: 'completed',
      summary: 'fixed a flaky test',
      confidence: 'high',
    };
    const attr = buildAttribution({
      from: new Date('2026-06-10T00:00:00Z'),
      to: new Date('2026-06-17T00:00:00Z'),
      env: 'dev',
      generatedAt: new Date('2026-06-17T16:00:00Z'),
      classifierModel: 'haiku',
      diagnostic: { llmCallRows: 5, joinedToMessage: 5, hitRate: 1 },
      threads: new Map([['th-1', thread({ threadId: 'th-1' })]]),
      totals: new Map([['th-1', totals('th-1')]]),
      users: new Map([['u-1', { id: 'u-1', email: 'one@example.com' }]]),
      classifications: new Map([['th-1', classification]]),
    });

    expect(attr.topThreads[0]!.classification).toEqual(classification);
  });

  it('treats analytics rows whose thread_id is missing from session_threads as unattributed', () => {
    const attr = buildAttribution({
      from: new Date('2026-06-10T00:00:00Z'),
      to: new Date('2026-06-17T00:00:00Z'),
      env: 'dev',
      generatedAt: new Date('2026-06-17T16:00:00Z'),
      classifierModel: null,
      diagnostic: { llmCallRows: 1, joinedToMessage: 1, hitRate: 1 },
      threads: new Map(), // empty — no thread_rows fetched
      totals: new Map([['th-stale', totals('th-stale')]]),
      users: new Map(),
      classifications: new Map(),
    });

    expect(attr.totals.unattributed.inputTokens).toBe(1000);
    expect(attr.meta.totalThreads).toBe(0);
  });
});
