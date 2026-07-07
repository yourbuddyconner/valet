import { describe, expect, it } from 'vitest';
import { buildThreadDigest } from './digest.js';
import type { MessageRow, ThreadRow, ThreadTotals } from './types.js';

function thread(over: Partial<ThreadRow> = {}): ThreadRow {
  return {
    threadId: 'th-1',
    sessionId: 's-1',
    userId: 'u-1',
    userEmail: null,
    isOrchestrator: false,
    purpose: 'interactive',
    originType: null,
    originChannelType: 'web',
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

function totals(over: Partial<ThreadTotals> = {}): ThreadTotals {
  return {
    threadId: 'th-1',
    sessionId: 's-1',
    inputTokens: 187_000,
    outputTokens: 12_000,
    llmCalls: 23,
    toolCalls: 41,
    modelBreakdown: {},
    toolHistogram: [
      { toolName: 'edit', calls: 47 },
      { toolName: 'bash', calls: 31 },
      { toolName: 'read', calls: 28 },
    ],
    firstCallAt: '2026-06-17T14:00:00Z',
    lastCallAt: '2026-06-17T14:14:00Z',
    ...over,
  };
}

function message(over: Partial<MessageRow>): MessageRow {
  return {
    id: 'm-1',
    threadId: 'th-1',
    sessionId: 's-1',
    role: 'user',
    content: '',
    channelType: null,
    createdAt: '2026-06-17T14:00:00Z',
    ...over,
  };
}

describe('buildThreadDigest', () => {
  it('includes category, channel, duration, top tools, first user message, and last two assistant turns', () => {
    const out = buildThreadDigest({
      thread: thread(),
      totals: totals(),
      category: 'ad-hoc',
      messages: [
        message({ id: 'm-1', role: 'user', content: 'help me debug a flaky test' }),
        message({ id: 'm-2', role: 'assistant', content: 'first asst turn' }),
        message({ id: 'm-3', role: 'assistant', content: 'second asst turn' }),
        message({ id: 'm-4', role: 'assistant', content: 'third asst turn — last one' }),
      ],
    });

    expect(out).toContain('category: ad-hoc');
    expect(out).toContain('channel: web');
    expect(out).toContain('14m, 23 LLM calls, 187.0k input / 12.0k output tokens');
    expect(out).toContain('edit (47), bash (31), read (28)');
    expect(out).toContain('help me debug a flaky test');
    // Last two assistant turns, not the first
    expect(out).toContain('second asst turn');
    expect(out).toContain('third asst turn — last one');
    expect(out).not.toContain('first asst turn');
  });

  it('truncates long user content with an ellipsis', () => {
    const long = 'x'.repeat(2000);
    const out = buildThreadDigest({
      thread: thread(),
      totals: totals(),
      category: 'ad-hoc',
      messages: [message({ role: 'user', content: long })],
    });
    expect(out).toMatch(/x+…/);
    expect(out.split('\n').find((l) => l.startsWith('> '))!.length).toBeLessThanOrEqual(802);
  });

  it('handles a thread with no user message or assistant turn', () => {
    const out = buildThreadDigest({
      thread: thread(),
      totals: totals(),
      category: 'ad-hoc',
      messages: [],
    });
    expect(out).toContain('First user message:');
    expect(out).toContain('> (none)');
    expect(out).not.toContain('Last 0 assistant turn');
  });

  it('includes trigger metadata when present', () => {
    const out = buildThreadDigest({
      thread: thread({ originTriggerId: 'tr-1', originTriggerType: 'webhook' }),
      totals: totals(),
      category: 'automation-trigger',
      messages: [],
    });
    expect(out).toContain('trigger: webhook (id tr-1)');
  });

  it('includes parent session title only for orchestrator-internal threads', () => {
    const baseArgs = {
      thread: thread({ isOrchestrator: true, originChannelType: null }),
      totals: totals(),
      messages: [],
      parentSessionTitle: 'orchestrator session for conner',
    };
    expect(buildThreadDigest({ ...baseArgs, category: 'orchestrator-internal' })).toContain(
      'parent session title: orchestrator session for conner',
    );
    expect(buildThreadDigest({ ...baseArgs, category: 'orchestrator-chat' })).not.toContain(
      'parent session title',
    );
  });
});
