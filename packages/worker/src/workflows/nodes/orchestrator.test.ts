import { describe, it, expect, vi, beforeEach } from 'vitest';

const dispatchMock = vi.fn();
const pollMock = vi.fn();

vi.mock('../../services/orchestrator.js', () => ({
  dispatchOrchestratorPrompt: (...args: unknown[]) => dispatchMock(...args),
}));

vi.mock('../polling.js', () => ({
  pollSessionUntilIdle: (...args: unknown[]) => pollMock(...args),
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
    params: { executionId: 'exec-1', workflowId: 'wf-1', userId: 'user-1' } as WorkflowRunParams,
    env: {} as Env,
    // Passthrough step.do stub — supports the 2-arg (name, fn) and
    // 3-arg (name, config, fn) signatures the CF runtime exposes.
    step: {
      do: async (_name: string, configOrFn: unknown, maybeFn?: () => Promise<unknown>) => {
        const fn = (typeof configOrFn === 'function' ? configOrFn : maybeFn) as () => Promise<unknown>;
        return fn();
      },
    } as unknown as WorkflowStep,
  };
}

beforeEach(() => {
  dispatchMock.mockReset();
  pollMock.mockReset();
});

describe('executeOrchestrator', () => {
  it('dispatches a rendered prompt and returns dispatch metadata in fire-and-forget mode', async () => {
    dispatchMock.mockResolvedValue({ dispatched: true, sessionId: 'orchestrator:user-1' });
    const node: OrchestratorNode = {
      id: 'orch', type: 'orchestrator', prompt: 'hi {{trigger.data.name}}',
    };
    const out = await executeOrchestrator(args(node, { name: 'world' }));
    expect(out).toEqual({ dispatched: true, sessionId: 'orchestrator:user-1' });
    expect(dispatchMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      userId: 'user-1',
      content: 'hi world',
    }));
    expect(pollMock).not.toHaveBeenCalled();
  });

  it('forwards forceNewThread', async () => {
    dispatchMock.mockResolvedValue({ dispatched: true, sessionId: 'orchestrator:user-1' });
    const node: OrchestratorNode = {
      id: 'orch', type: 'orchestrator', prompt: 'go', forceNewThread: true,
    };
    await executeOrchestrator(args(node));
    expect(dispatchMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      forceNewThread: true,
    }));
  });

  it('polls until idle when wait.mode is until_idle and returns finalStatus', async () => {
    dispatchMock.mockResolvedValue({ dispatched: true, sessionId: 'orchestrator:user-1' });
    pollMock.mockResolvedValue('idle');
    const node: OrchestratorNode = {
      id: 'orch', type: 'orchestrator', prompt: 'go', wait: { mode: 'until_idle', timeout: '1h' },
    };
    const out = await executeOrchestrator(args(node));
    expect(out).toMatchObject({ dispatched: true, finalStatus: 'idle', waited: true });
    expect(pollMock).toHaveBeenCalled();
  });

  it('returns without polling when dispatch is rejected', async () => {
    dispatchMock.mockResolvedValue({ dispatched: false, sessionId: 'orchestrator:user-1', reason: 'orchestrator_not_configured' });
    const node: OrchestratorNode = {
      id: 'orch', type: 'orchestrator', prompt: 'go', wait: { mode: 'until_idle' },
    };
    const out = await executeOrchestrator(args(node));
    expect(out).toEqual({ dispatched: false, sessionId: 'orchestrator:user-1', reason: 'orchestrator_not_configured' });
    expect(pollMock).not.toHaveBeenCalled();
  });
});
