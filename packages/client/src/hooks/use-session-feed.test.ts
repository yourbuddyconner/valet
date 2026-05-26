import { describe, it, expect } from 'vitest';
import { mergeFeed } from './use-session-feed';
import type { ExecutionStepTrace } from '@/api/executions';
import type { Message } from '@valet/shared';

function mkMessage(over: Partial<Message> & { id: string; createdAt: Date }): Message {
  return {
    sessionId: 'sess',
    role: 'user',
    content: 'hi',
    ...over,
  } as Message;
}

function mkStep(over: Partial<ExecutionStepTrace> & { stepId: string }): ExecutionStepTrace {
  return {
    id: `r-${Math.random()}`,
    executionId: 'ex',
    stepId: over.stepId,
    attempt: over.attempt ?? 1,
    iterationPath: over.iterationPath ?? '',
    status: over.status ?? 'completed',
    input: over.input ?? null,
    output: over.output ?? null,
    error: over.error ?? null,
    startedAt: over.startedAt ?? null,
    completedAt: over.completedAt ?? null,
    createdAt: over.createdAt ?? '',
    workflowStepIndex: over.workflowStepIndex ?? null,
    sequence: over.sequence ?? 0,
  };
}

describe('mergeFeed', () => {
  it('interleaves messages and step rows by timestamp', () => {
    const messages = [
      mkMessage({ id: 'm1', createdAt: new Date(100) }),
      mkMessage({ id: 'm2', createdAt: new Date(300) }),
    ];
    const steps = [
      mkStep({ stepId: 'A', startedAt: '1970-01-01T00:00:00.200Z' }),
    ];
    const feed = mergeFeed(messages, steps);
    expect(feed.map((x) => x.kind)).toEqual(['message', 'step', 'message']);
  });

  it('prefers step.startedAt over createdAt for ordering', () => {
    const messages: Message[] = [];
    const steps = [
      mkStep({ stepId: 'late_createdAt_early_startedAt',
              startedAt: '1970-01-01T00:00:00.100Z',
              createdAt: '1970-01-01T00:00:01.000Z' }),
      mkStep({ stepId: 'early_createdAt_late_startedAt',
              startedAt: '1970-01-01T00:00:00.500Z',
              createdAt: '1970-01-01T00:00:00.001Z' }),
    ];
    const feed = mergeFeed(messages, steps);
    expect(feed.map((x) => x.kind === 'step' ? x.step.stepId : '')).toEqual([
      'late_createdAt_early_startedAt',
      'early_createdAt_late_startedAt',
    ]);
  });

  it('returns only messages when steps is empty', () => {
    const messages = [mkMessage({ id: 'm1', createdAt: new Date(1) })];
    expect(mergeFeed(messages, [])).toHaveLength(1);
  });

  it('returns only steps when messages is empty', () => {
    const steps = [mkStep({ stepId: 's', startedAt: '1970-01-01T00:00:01Z' })];
    expect(mergeFeed([], steps)).toHaveLength(1);
  });
});
