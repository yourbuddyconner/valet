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
    ...over,
  };
}

describe('categorizeThread', () => {
  it('classifies trigger-originated threads as automation-trigger (even on orchestrator sessions)', () => {
    expect(categorizeThread(row({ originTriggerId: 't-1' }))).toBe('automation-trigger');
    expect(
      categorizeThread(row({ originTriggerId: 't-1', isOrchestrator: true, originChannelType: 'slack' })),
    ).toBe('automation-trigger');
  });

  it('classifies orchestrator threads with a channel as orchestrator-chat', () => {
    expect(categorizeThread(row({ isOrchestrator: true, originChannelType: 'slack' }))).toBe(
      'orchestrator-chat',
    );
  });

  it('classifies orchestrator threads with no channel and no trigger as orchestrator-internal', () => {
    expect(categorizeThread(row({ isOrchestrator: true }))).toBe('orchestrator-internal');
  });

  it('classifies everything else as ad-hoc', () => {
    expect(categorizeThread(row({}))).toBe('ad-hoc');
    expect(categorizeThread(row({ originChannelType: 'web' }))).toBe('ad-hoc');
  });
});
