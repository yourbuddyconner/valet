import { describe, it, expect, vi, beforeEach } from 'vitest';

const dispatchMock = vi.fn();
const pollThreadMock = vi.fn();

vi.mock('../../services/orchestrator.js', () => ({
  dispatchOrchestratorPrompt: (...args: unknown[]) => dispatchMock(...args),
}));

vi.mock('../polling.js', () => ({
  pollThreadUntilIdle: (...args: unknown[]) => pollThreadMock(...args),
}));

import { executeOrchestrator } from './orchestrator.js';
import type { OrchestratorNode, WorkflowDagState } from '@valet/shared';
import type { WorkflowRunParams } from '../types.js';
import type { Env } from '../../env.js';
import type { WorkflowStep } from 'cloudflare:workers';

function args(node: OrchestratorNode, triggerData: Record<string, unknown> = {}) {
  const fullState: WorkflowDagState = {
    trigger: { type: 'manual', timestamp: '2026-06-12T00:00:00.000Z', data: triggerData, metadata: {} },
    inputs: {},
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
      inputs: {},
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
