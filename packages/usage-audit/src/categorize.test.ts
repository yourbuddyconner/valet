import { describe, expect, it } from 'vitest';
import { categorizeThread } from './categorize.js';
import type { ThreadRow } from './types.js';

function row(over: Partial<ThreadRow>): ThreadRow {
  return {
    threadId: 'th-1',
    sessionId: 's-1',
    userId: 'u-1',
    userEmail: null,
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

describe('categorizeThread', () => {
  it('classifies trigger-originated threads as automation-trigger (even on orchestrator sessions)', () => {
    expect(categorizeThread(row({ originTriggerId: 't-1' }))).toBe('automation-trigger');
    expect(
      categorizeThread(row({ originTriggerId: 't-1', isOrchestrator: true, hasUserMessage: true })),
    ).toBe('automation-trigger');
  });

  it('classifies orchestrator threads with a user message as orchestrator-chat', () => {
    expect(categorizeThread(row({ isOrchestrator: true, hasUserMessage: true }))).toBe(
      'orchestrator-chat',
    );
    // Channel mapping is auxiliary signal; not load-bearing.
    expect(
      categorizeThread(row({ isOrchestrator: true, hasUserMessage: true, hasChannelMapping: false })),
    ).toBe('orchestrator-chat');
  });

  it('classifies orchestrator threads with no user message as orchestrator-internal', () => {
    expect(categorizeThread(row({ isOrchestrator: true, hasUserMessage: false }))).toBe(
      'orchestrator-internal',
    );
  });

  it('classifies non-orchestrator threads as ad-hoc regardless of user message presence', () => {
    expect(categorizeThread(row({}))).toBe('ad-hoc');
    expect(categorizeThread(row({ hasUserMessage: true }))).toBe('ad-hoc');
  });
});
