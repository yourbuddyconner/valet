import { describe, expect, it } from 'vitest';
import { generateReport } from './report.js';
import type { Attribution, LabelDimension, LabelEntry } from './types.js';

function emptyByCategory() {
  return {
    'automation-trigger': { threads: 0, llmCalls: 0, inputTokens: 0, outputTokens: 0 },
    'orchestrator-chat': { threads: 0, llmCalls: 0, inputTokens: 0, outputTokens: 0 },
    'orchestrator-internal': { threads: 0, llmCalls: 0, inputTokens: 0, outputTokens: 0 },
    'ad-hoc': { threads: 0, llmCalls: 0, inputTokens: 0, outputTokens: 0 },
  } as const;
}

function baseAttribution(): Attribution {
  return {
    meta: {
      from: '2026-06-10',
      to: '2026-06-17',
      env: 'dev',
      generatedAt: '2026-06-17T16:00:00.000Z',
      classifierModel: 'haiku',
      totalThreads: 2,
      totalLlmCalls: 30,
      joinHitRate: 0.92,
    },
    totals: {
      inputTokens: 10_000_000,
      outputTokens: 200_000,
      byCategory: {
        'automation-trigger': { threads: 0, llmCalls: 0, inputTokens: 0, outputTokens: 0 },
        'orchestrator-chat': { threads: 1, llmCalls: 20, inputTokens: 8_000_000, outputTokens: 150_000 },
        'orchestrator-internal': { threads: 0, llmCalls: 0, inputTokens: 0, outputTokens: 0 },
        'ad-hoc': { threads: 1, llmCalls: 10, inputTokens: 2_000_000, outputTokens: 50_000 },
      },
      byModel: {},
      unattributed: { llmCalls: 0, inputTokens: 0, outputTokens: 0 },
    },
    byUser: [
      {
        userId: 'u-1',
        email: 'a@example.com',
        totalInputTokens: 10_000_000,
        totalOutputTokens: 200_000,
        threadCount: 2,
        byCategory: emptyByCategory(),
      },
    ],
    byModel: [
      { model: 'claude-sonnet-4-6', calls: 30, inputTokens: 10_000_000, outputTokens: 200_000, avgInputPerCall: 333_333 },
    ],
    topThreads: [
      {
        rank: 1,
        threadId: 'th-1',
        sessionId: 's-1',
        category: 'orchestrator-chat',
        userId: 'u-1',
        userEmail: 'a@example.com',
        llmCalls: 20,
        inputTokens: 8_000_000,
        outputTokens: 150_000,
        topTools: [{ toolName: 'edit', calls: 12 }],
        firstMessagePreview: '',
        classification: {
          taskType: 'feature-impl',
          costDriver: 'long-tool-loop',
          outcome: 'completed',
          summary: 'shipped the usage audit',
          confidence: 'high',
        },
      },
    ],
    daily: [
      {
        date: '2026-06-17',
        byCategory: {
          'automation-trigger': { inputTokens: 0, outputTokens: 0 },
          'orchestrator-chat': { inputTokens: 8_000_000, outputTokens: 150_000 },
          'orchestrator-internal': { inputTokens: 0, outputTokens: 0 },
          'ad-hoc': { inputTokens: 2_000_000, outputTokens: 50_000 },
        },
      },
    ],
    toolLeaderboard: [{ toolName: 'edit', calls: 12, inputTokens: 5_000_000, share: 0.5 }],
  };
}

function emptyIntroduced(): Record<LabelDimension, LabelEntry[]> {
  return { taskType: [], costDriver: [], outcome: [] };
}

describe('generateReport', () => {
  it('renders headline + tables', () => {
    const out = generateReport({
      attribution: baseAttribution(),
      labelsIntroduced: emptyIntroduced(),
      threadFirstMessages: new Map([['th-1', 'help me ship the audit']]),
    });
    expect(out).toContain('# LLM Usage Audit — 2026-06-10 to 2026-06-17 (dev)');
    expect(out).toContain('## Headline');
    expect(out).toContain('## By category');
    expect(out).toContain('orchestrator-chat');
    expect(out).toContain('## By user');
    expect(out).toContain('## By model');
    expect(out).toContain('## Top 1 threads');
    expect(out).toContain('help me ship the audit');
    expect(out).toContain('## Cost-driver analysis');
    expect(out).toContain('long-tool-loop');
    expect(out).toContain('## Daily burn-down');
    expect(out).toContain('## Tool-call leaderboard');
    expect(out).toContain('## Methodology');
  });

  it('omits the "labels introduced" section when none were introduced', () => {
    const out = generateReport({
      attribution: baseAttribution(),
      labelsIntroduced: emptyIntroduced(),
      threadFirstMessages: new Map(),
    });
    expect(out).not.toContain('## Labels introduced');
  });

  it('reports unattributed bucket when present', () => {
    const a = baseAttribution();
    a.totals.unattributed = { llmCalls: 5, inputTokens: 500_000, outputTokens: 5_000 };
    const out = generateReport({
      attribution: a,
      labelsIntroduced: emptyIntroduced(),
      threadFirstMessages: new Map(),
    });
    expect(out).toMatch(/Unattributed: \d/);
    expect(out).toContain('_unattributed_');
  });

  it('escapes pipes in user-controlled strings to keep table rows valid', () => {
    const a = baseAttribution();
    a.topThreads[0]!.classification!.summary = 'an evil | summary | with pipes';
    const out = generateReport({
      attribution: a,
      labelsIntroduced: emptyIntroduced(),
      threadFirstMessages: new Map(),
    });
    expect(out).toContain('an evil \\| summary \\| with pipes');
  });
});
