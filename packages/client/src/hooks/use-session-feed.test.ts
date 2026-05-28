import { describe, it, expect } from 'vitest';
import { mergeFeed, buildChatRenderPlan } from './use-session-feed';
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

describe('buildChatRenderPlan', () => {
  it('groups an agent_prompt step + its messages into one step-container', () => {
    const messages = [
      mkMessage({ id: 'prompt', role: 'user', createdAt: new Date(100), workflowExecutionId: 'ex', workflowStepId: 'assess', workflowIterationPath: '' }),
      mkMessage({ id: 'turn', role: 'assistant', createdAt: new Date(300), workflowExecutionId: 'ex', workflowStepId: 'assess', workflowIterationPath: '' }),
    ];
    const steps = [
      mkStep({ stepId: 'assess', startedAt: '1970-01-01T00:00:00.150Z' }),
    ];
    const plan = buildChatRenderPlan(mergeFeed(messages, steps));
    expect(plan).toHaveLength(1);
    expect(plan[0].kind).toBe('step-container');
    const c = plan[0] as Extract<typeof plan[0], { kind: 'step-container' }>;
    expect(c.messages.map((m) => m.id)).toEqual(['prompt', 'turn']);
    expect(c.step?.stepId).toBe('assess');
  });

  it('renders a non-agent step (no messages) as a step card', () => {
    const steps = [mkStep({ stepId: 'bash-1', startedAt: '1970-01-01T00:00:01Z' })];
    const plan = buildChatRenderPlan(mergeFeed([], steps));
    expect(plan).toHaveLength(1);
    expect(plan[0].kind).toBe('step');
  });

  it('keeps plain chat messages in a messages run, separate from step containers', () => {
    const messages = [
      mkMessage({ id: 'u1', role: 'user', createdAt: new Date(50) }),
      mkMessage({ id: 'p', role: 'user', createdAt: new Date(200), workflowExecutionId: 'ex', workflowStepId: 'assess', workflowIterationPath: '' }),
      mkMessage({ id: 'u2', role: 'user', createdAt: new Date(500) }),
    ];
    const steps = [mkStep({ stepId: 'assess', startedAt: '1970-01-01T00:00:00.150Z' })];
    const plan = buildChatRenderPlan(mergeFeed(messages, steps));
    // u1 (messages) → container(assess) → u2 (messages)
    expect(plan.map((i) => i.kind)).toEqual(['messages', 'step-container', 'messages']);
  });

  it('emits each container once even with multiple attributed messages', () => {
    const messages = [
      mkMessage({ id: 'p', role: 'user', createdAt: new Date(100), workflowExecutionId: 'ex', workflowStepId: 's', workflowIterationPath: 'L:i0' }),
      mkMessage({ id: 't', role: 'assistant', createdAt: new Date(200), workflowExecutionId: 'ex', workflowStepId: 's', workflowIterationPath: 'L:i0' }),
    ];
    const steps = [mkStep({ stepId: 's', iterationPath: 'L:i0', startedAt: '1970-01-01T00:00:00.050Z' })];
    const plan = buildChatRenderPlan(mergeFeed(messages, steps));
    const containers = plan.filter((i) => i.kind === 'step-container');
    expect(containers).toHaveLength(1);
  });

  it('separates loop iterations into distinct containers by iterationPath', () => {
    const messages = [
      mkMessage({ id: 'p0', role: 'user', createdAt: new Date(100), workflowExecutionId: 'ex', workflowStepId: 's', workflowIterationPath: 'L:i0' }),
      mkMessage({ id: 'p1', role: 'user', createdAt: new Date(300), workflowExecutionId: 'ex', workflowStepId: 's', workflowIterationPath: 'L:i1' }),
    ];
    const steps = [
      mkStep({ stepId: 's', iterationPath: 'L:i0', startedAt: '1970-01-01T00:00:00.050Z' }),
      mkStep({ stepId: 's', iterationPath: 'L:i1', startedAt: '1970-01-01T00:00:00.250Z' }),
    ];
    const plan = buildChatRenderPlan(mergeFeed(messages, steps));
    const containers = plan.filter((i) => i.kind === 'step-container');
    expect(containers).toHaveLength(2);
  });
});
