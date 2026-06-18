import { describe, it, expect, vi, beforeEach } from 'vitest';

const dispatchMock = vi.fn();
const pollThreadMock = vi.fn();
const getThreadMessagesMock = vi.fn();

vi.mock('../../services/orchestrator.js', () => ({
  dispatchOrchestratorPrompt: (...args: unknown[]) => dispatchMock(...args),
}));

vi.mock('../polling.js', () => ({
  pollThreadUntilIdle: (...args: unknown[]) => pollThreadMock(...args),
}));

vi.mock('../../lib/db/messages.js', () => ({
  getThreadMessages: (...args: unknown[]) => getThreadMessagesMock(...args),
}));

vi.mock('../../lib/drizzle.js', () => ({
  getDb: () => 'db',
}));

import { executeOrchestrator } from './orchestrator.js';
import type { OrchestratorNode, WorkflowDagState } from '@valet/shared';
import type { WorkflowRunParams } from '../types.js';
import type { Env } from '../../env.js';
import type { WorkflowStep } from 'cloudflare:workers';

function args(node: OrchestratorNode, triggerData: Record<string, unknown> = {}) {
  const fullState: WorkflowDagState = {
    trigger: { type: 'manual', timestamp: '2026-06-12T00:00:00.000Z', data: triggerData, metadata: {} },
    nodes: {},
    skipped: {},
  };
  return {
    node,
    state: fullState,
    params: {
      executionId: 'exec-1',
      workflowId: 'wf-1',
      userId: 'user-1',
      trigger: fullState.trigger,
      definition: { version: 'dag/v1', nodes: [node], edges: [] },
    } as WorkflowRunParams,
    env: {} as Env,
    // Passthrough step.do stub — supports the 2-arg (name, fn) and
    // 3-arg (name, config, fn) signatures the CF runtime exposes.
    step: {
      do: async (_name: string, configOrFn: unknown, maybeFn?: () => Promise<unknown>) => {
        const fn = (typeof configOrFn === 'function' ? configOrFn : maybeFn) as () => Promise<unknown>;
        return fn();
      },
      sleep: async () => {},
      sleepUntil: async () => {},
      waitForEvent: async () => { throw new Error('waitForEvent is not used in orchestrator tests'); },
    } satisfies WorkflowStep,
  };
}

beforeEach(() => {
  dispatchMock.mockReset();
  pollThreadMock.mockReset();
  getThreadMessagesMock.mockReset();
});

describe('executeOrchestrator', () => {
  it('dispatches a rendered prompt and returns dispatch metadata in fire-and-forget mode', async () => {
    dispatchMock.mockResolvedValue({ dispatched: true, sessionId: 'orchestrator:user-1', threadId: 'thread-1' });
    const node: OrchestratorNode = {
      id: 'orch', type: 'orchestrator', prompt: 'hi {{trigger.data.name}}',
    };
    const out = await executeOrchestrator(args(node, { name: 'world' }));
    expect(out).toEqual({ dispatched: true, sessionId: 'orchestrator:user-1', threadId: 'thread-1' });
    expect(dispatchMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      userId: 'user-1',
      content: 'hi world',
      forceNewThread: true,
      threadOrigin: expect.objectContaining({
        originType: 'automation',
        originTriggerType: 'manual',
        originTriggerId: 'exec-1',
      }),
    }));
    expect(pollThreadMock).not.toHaveBeenCalled();
  });

  it('always forces a new automation thread', async () => {
    dispatchMock.mockResolvedValue({ dispatched: true, sessionId: 'orchestrator:user-1', threadId: 'thread-1' });
    const node: OrchestratorNode = {
      id: 'orch', type: 'orchestrator', prompt: 'go',
    };
    await executeOrchestrator(args(node));
    expect(dispatchMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      forceNewThread: true,
      threadOrigin: expect.objectContaining({ originType: 'automation' }),
    }));
  });

  it('polls until idle when wait.mode is until_idle and returns finalStatus', async () => {
    dispatchMock.mockResolvedValue({ dispatched: true, sessionId: 'orchestrator:user-1', threadId: 'thread-1' });
    pollThreadMock.mockResolvedValue('idle');
    getThreadMessagesMock.mockResolvedValue([]);
    const node: OrchestratorNode = {
      id: 'orch', type: 'orchestrator', prompt: 'go', wait: { mode: 'until_idle', timeout: '1h' },
    };
    const out = await executeOrchestrator(args(node));
    expect(out).toMatchObject({ dispatched: true, threadId: 'thread-1', finalStatus: 'idle', waited: true });
    expect(pollThreadMock).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({
      sessionId: 'orchestrator:user-1',
      threadId: 'thread-1',
    }));
  });

  it('returns the last thread message after waiting until idle', async () => {
    dispatchMock.mockResolvedValue({ dispatched: true, sessionId: 'orchestrator:user-1', threadId: 'thread-1' });
    pollThreadMock.mockResolvedValue('idle');
    const userMessage = {
      id: 'msg-user',
      sessionId: 'orchestrator:user-1',
      role: 'user',
      content: 'go',
      createdAt: new Date('2026-06-12T00:00:00.000Z'),
    };
    const assistantMessage = {
      id: 'msg-assistant',
      sessionId: 'orchestrator:user-1',
      role: 'assistant',
      content: 'investigation complete',
      threadId: 'thread-1',
      createdAt: new Date('2026-06-12T00:00:03.000Z'),
    };
    getThreadMessagesMock.mockResolvedValue([userMessage, assistantMessage]);
    const expectedAssistantMessage = {
      ...assistantMessage,
      createdAt: '2026-06-12T00:00:03.000Z',
    };

    const node: OrchestratorNode = {
      id: 'orch', type: 'orchestrator', prompt: 'go', wait: { mode: 'until_idle' },
    };
    const out = await executeOrchestrator(args(node));

    expect(out).toMatchObject({
      dispatched: true,
      threadId: 'thread-1',
      finalStatus: 'idle',
      waited: true,
      lastMessage: expectedAssistantMessage,
    });
  });

  it('returns the full thread transcript when resultMode is transcript', async () => {
    dispatchMock.mockResolvedValue({ dispatched: true, sessionId: 'orchestrator:user-1', threadId: 'thread-1' });
    pollThreadMock.mockResolvedValue('idle');
    const transcript = [
      {
        id: 'msg-user',
        sessionId: 'orchestrator:user-1',
        role: 'user',
        content: 'go',
        threadId: 'thread-1',
        createdAt: new Date('2026-06-12T00:00:00.000Z'),
      },
      {
        id: 'msg-assistant',
        sessionId: 'orchestrator:user-1',
        role: 'assistant',
        content: 'investigation complete',
        threadId: 'thread-1',
        createdAt: new Date('2026-06-12T00:00:03.000Z'),
      },
    ];
    getThreadMessagesMock.mockResolvedValue(transcript);
    const expectedTranscript = [
      { ...transcript[0], createdAt: '2026-06-12T00:00:00.000Z' },
      { ...transcript[1], createdAt: '2026-06-12T00:00:03.000Z' },
    ];

    const node: OrchestratorNode = {
      id: 'orch', type: 'orchestrator', prompt: 'go', wait: { mode: 'until_idle' }, resultMode: 'transcript',
    };
    const out = await executeOrchestrator(args(node));

    expect(out).toMatchObject({
      dispatched: true,
      threadId: 'thread-1',
      finalStatus: 'idle',
      waited: true,
      lastMessage: expectedTranscript[1],
      transcript: expectedTranscript,
    });
  });

  it('returns without polling when dispatch is rejected', async () => {
    dispatchMock.mockResolvedValue({ dispatched: false, sessionId: 'orchestrator:user-1', reason: 'orchestrator_not_configured' });
    const node: OrchestratorNode = {
      id: 'orch', type: 'orchestrator', prompt: 'go', wait: { mode: 'until_idle' },
    };
    const out = await executeOrchestrator(args(node));
    expect(out).toEqual({ dispatched: false, sessionId: 'orchestrator:user-1', reason: 'orchestrator_not_configured' });
    expect(pollThreadMock).not.toHaveBeenCalled();
  });
});
