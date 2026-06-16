import { describe, it, expect, vi, beforeEach } from 'vitest';

const getSessionMock = vi.fn();
vi.mock('../lib/db/sessions.js', () => ({
  getSession: (...args: unknown[]) => getSessionMock(...args),
}));
vi.mock('../lib/drizzle.js', () => ({
  getDb: () => ({} as unknown),
}));

import { pollSessionUntilIdle } from './polling.js';
import type { Env } from '../env.js';
import type { WorkflowStep, WorkflowStepConfig } from 'cloudflare:workers';

interface StepCall { name: string; type: 'do' | 'sleep'; ms?: number }

function makeStep(): { step: WorkflowStep; calls: StepCall[] } {
  const calls: StepCall[] = [];
  const step = {
    async do<T>(name: string, configOrFn: WorkflowStepConfig | (() => Promise<T>), maybeFn?: () => Promise<T>): Promise<T> {
      calls.push({ name, type: 'do' });
      const fn = typeof configOrFn === 'function' ? configOrFn : maybeFn!;
      return fn();
    },
    async sleep(name: string, ms: number) {
      calls.push({ name, type: 'sleep', ms: typeof ms === 'number' ? ms : 0 });
    },
    async sleepUntil() {},
    async waitForEvent() { throw new Error('not used'); },
  } as unknown as WorkflowStep;
  return { step, calls };
}

const env = {} as Env;

beforeEach(() => {
  getSessionMock.mockReset();
});

describe('pollSessionUntilIdle', () => {
  it('returns idle immediately when the first check observes it', async () => {
    getSessionMock.mockResolvedValue({ status: 'idle' });
    const { step, calls } = makeStep();
    const result = await pollSessionUntilIdle(env, step, {
      sessionId: 'sess-1',
      pollKey: 'k',
      timeoutMs: 60_000,
    });
    expect(result).toBe('idle');
    expect(calls.filter((c) => c.type === 'sleep')).toHaveLength(0);
  });

  it('returns hibernated as a successful terminal state', async () => {
    getSessionMock.mockResolvedValue({ status: 'hibernated' });
    const { step } = makeStep();
    const result = await pollSessionUntilIdle(env, step, {
      sessionId: 'sess-1', pollKey: 'k', timeoutMs: 60_000,
    });
    expect(result).toBe('hibernated');
  });

  it('throws when the session has been deleted (not_found)', async () => {
    getSessionMock.mockResolvedValue(null);
    const { step } = makeStep();
    await expect(pollSessionUntilIdle(env, step, {
      sessionId: 'sess-gone', pollKey: 'k', timeoutMs: 60_000,
    })).rejects.toThrow(/no longer exists/);
  });

  it('resolves on `terminated` — the normal end-of-life session status', async () => {
    getSessionMock.mockResolvedValue({ status: 'terminated' });
    const { step } = makeStep();
    const result = await pollSessionUntilIdle(env, step, {
      sessionId: 'sess-1', pollKey: 'k', timeoutMs: 60_000,
    });
    expect(result).toBe('terminated');
  });

  it('throws on catastrophic failure states (archived/error)', async () => {
    getSessionMock.mockResolvedValue({ status: 'archived' });
    const { step } = makeStep();
    await expect(pollSessionUntilIdle(env, step, {
      sessionId: 'sess-1', pollKey: 'k', timeoutMs: 60_000,
    })).rejects.toThrow(/terminal failure state: archived/);
  });

  it('polls with exponential backoff until idle, capped at maxIntervalMs', async () => {
    let calls = 0;
    getSessionMock.mockImplementation(async () => {
      calls++;
      return calls < 4 ? { status: 'running' } : { status: 'idle' };
    });
    const { step, calls: stepCalls } = makeStep();
    const result = await pollSessionUntilIdle(env, step, {
      sessionId: 'sess-1', pollKey: 'k',
      timeoutMs: 60_000,
      initialIntervalMs: 100,
      maxIntervalMs: 400,
    });
    expect(result).toBe('idle');
    const sleeps = stepCalls.filter((c) => c.type === 'sleep').map((c) => c.ms!);
    expect(sleeps).toEqual([100, 200, 400]);
  });

  it('returns timed_out when timeout elapses before idle', async () => {
    getSessionMock.mockResolvedValue({ status: 'running' });
    const { step } = makeStep();
    const result = await pollSessionUntilIdle(env, step, {
      sessionId: 'sess-1', pollKey: 'k',
      timeoutMs: 250,
      initialIntervalMs: 100,
      maxIntervalMs: 100,
    });
    expect(result).toBe('timed_out');
  });

  it('uses unique step names per iteration so replay caches each step independently', async () => {
    let i = 0;
    getSessionMock.mockImplementation(async () => i++ < 2 ? { status: 'running' } : { status: 'idle' });
    const { step, calls } = makeStep();
    await pollSessionUntilIdle(env, step, {
      sessionId: 'sess-1', pollKey: 'k',
      timeoutMs: 10_000, initialIntervalMs: 10, maxIntervalMs: 10,
    });
    const names = calls.map((c) => c.name);
    expect(names).toEqual([
      'k:check:0', 'k:sleep:0',
      'k:check:1', 'k:sleep:1',
      'k:check:2',
    ]);
  });
});
