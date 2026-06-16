import { describe, it, expect, vi } from 'vitest';
import { executeWait } from './wait.js';
import type { WaitNode, WorkflowDagState } from '@valet/shared';
import type { WorkflowRunParams } from '../types.js';
import type { Env } from '../../env.js';
import type { WorkflowStep } from 'cloudflare:workers';

function makeStep(sleepSpy: ReturnType<typeof vi.fn>): WorkflowStep {
  return {
    // Passthrough step.do — wait now wraps setExecutionStatus calls
    // and the resumedAt capture, both of which need a working stub.
    async do(_name: string, fn: () => Promise<unknown>) { return fn(); },
    sleep: sleepSpy,
    async sleepUntil() {},
    async waitForEvent() { throw new Error('not used'); },
  } as unknown as WorkflowStep;
}

function args(node: WaitNode, stepSleep: ReturnType<typeof vi.fn>) {
  const state: WorkflowDagState = {
    trigger: { type: 'manual', timestamp: '2026-06-12T00:00:00.000Z', data: {}, metadata: {} },
    inputs: {},
    nodes: {},
    skipped: {},
  };
  return {
    node,
    state,
    params: {} as WorkflowRunParams,
    env: {} as Env,
    step: makeStep(stepSleep),
  };
}

describe('executeWait', () => {
  it('calls step.sleep with the deterministic key and duration in ms', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const node: WaitNode = { id: 'pause', type: 'wait', mode: 'duration', duration: '5s' };
    const result = await executeWait(args(node, sleep));
    expect(sleep).toHaveBeenCalledWith('wait:pause', 5000);
    expect(result.mode).toBe('duration');
    expect(typeof result.resumedAt).toBe('string');
  });

  it('renders the duration template against runtime state', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const node: WaitNode = { id: 'pause', type: 'wait', mode: 'duration', duration: '{{trigger.data.delay}}' };
    const base = args(node, sleep);
    base.state.trigger = { type: 'manual', timestamp: '2026-06-12T00:00:00.000Z', data: { delay: '10m' }, metadata: {} };
    await executeWait(base);
    expect(sleep).toHaveBeenCalledWith('wait:pause', 600000);
  });

  it('throws when the rendered duration is unparseable', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const node: WaitNode = { id: 'pause', type: 'wait', mode: 'duration', duration: 'banana' };
    await expect(executeWait(args(node, sleep))).rejects.toThrow(/not parseable/);
  });
});
