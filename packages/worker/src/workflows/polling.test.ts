import { describe, it, expect, vi, beforeEach } from 'vitest';

const getSessionMock = vi.fn();
vi.mock('../lib/db/sessions.js', () => ({
  getSession: (...args: unknown[]) => getSessionMock(...args),
}));
vi.mock('../lib/drizzle.js', () => ({
  getDb: () => ({} as unknown),
}));

import { pollSessionUntilIdle, pollThreadUntilIdle } from './polling.js';
import type { Env } from '../env.js';
import type { WorkflowSleepDuration, WorkflowStep, WorkflowStepConfig } from 'cloudflare:workers';
import type { D1Database, DurableObjectId, DurableObjectNamespace, DurableObjectStub, R2Bucket, Workflow } from '@cloudflare/workers-types';

interface StepCall { name: string; type: 'do' | 'sleep'; ms?: number }

function makeStep(): { step: WorkflowStep; calls: StepCall[] } {
  const calls: StepCall[] = [];
  const step = {
    async do<T>(name: string, configOrFn: WorkflowStepConfig | (() => Promise<T>), maybeFn?: () => Promise<T>): Promise<T> {
      calls.push({ name, type: 'do' });
      const fn = typeof configOrFn === 'function' ? configOrFn : maybeFn!;
      return fn();
    },
    async sleep(name: string, ms: WorkflowSleepDuration) {
      calls.push({ name, type: 'sleep', ms: typeof ms === 'number' ? ms : 0 });
    },
    async sleepUntil() {},
    async waitForEvent() { throw new Error('not used'); },
  } satisfies WorkflowStep;
  return { step, calls };
}

const env = {} as Env;

function makeThreadEnv(responses: Array<{ ok?: boolean; status?: number; body: unknown }>): Env {
  const fetchMock = vi.fn(async () => {
    const next = responses.shift() ?? { body: { status: 'idle' } };
    return Response.json(next.body, { status: next.status ?? (next.ok === false ? 500 : 200) });
  });
  const objectId: DurableObjectId = {
    name: 'orchestrator:user-1',
    toString: () => 'orchestrator:user-1',
    equals: (other) => other.toString() === 'orchestrator:user-1',
  };
  const sessionStub: DurableObjectStub = {
    id: objectId,
    fetch: fetchMock,
    connect: () => {
      throw new Error('connect is not used in polling tests');
    },
  };
  const sessions: DurableObjectNamespace = {
    newUniqueId: () => objectId,
    idFromName: () => objectId,
    idFromString: () => objectId,
    get: () => sessionStub,
    getByName: () => sessionStub,
    jurisdiction: () => sessions,
  };
  return {
    SESSIONS: sessions,
    EVENT_BUS: {} as DurableObjectNamespace,
    WORKFLOW_INTERPRETER: {} as Workflow,
    DB: {} as D1Database,
    STORAGE: {} as R2Bucket,
    ENCRYPTION_KEY: 'test',
    GOOGLE_CLIENT_ID: 'test',
    GOOGLE_CLIENT_SECRET: 'test',
    MODAL_BACKEND_URL: 'https://modal.example/{label}',
    FRONTEND_URL: 'https://client.example',
  };
}

function makeSessionStatusEnv(responses: Array<{ ok?: boolean; status?: number; body: unknown }>): Env {
  const fetchMock = vi.fn(async () => {
    const next = responses.shift() ?? {
      body: {
        lifecycleStatus: 'running',
        runnerConnected: true,
        runnerBusy: false,
        queuedPrompts: 0,
      },
    };
    return Response.json(next.body, { status: next.status ?? (next.ok === false ? 500 : 200) });
  });
  const objectId: DurableObjectId = {
    name: 'sess-1',
    toString: () => 'sess-1',
    equals: (other) => other.toString() === 'sess-1',
  };
  const sessionStub: DurableObjectStub = {
    id: objectId,
    fetch: fetchMock,
    connect: () => {
      throw new Error('connect is not used in polling tests');
    },
  };
  const sessions: DurableObjectNamespace = {
    newUniqueId: () => objectId,
    idFromName: () => objectId,
    idFromString: () => objectId,
    get: () => sessionStub,
    getByName: () => sessionStub,
    jurisdiction: () => sessions,
  };
  return {
    SESSIONS: sessions,
    EVENT_BUS: {} as DurableObjectNamespace,
    WORKFLOW_INTERPRETER: {} as Workflow,
    DB: {} as D1Database,
    STORAGE: {} as R2Bucket,
    ENCRYPTION_KEY: 'test',
    GOOGLE_CLIENT_ID: 'test',
    GOOGLE_CLIENT_SECRET: 'test',
    MODAL_BACKEND_URL: 'https://modal.example/{label}',
    FRONTEND_URL: 'https://client.example',
  };
}

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

  it('returns idle when the live session runner is no longer busy even if lifecycle remains running', async () => {
    getSessionMock.mockResolvedValue({ status: 'running' });
    const { step, calls } = makeStep();
    const result = await pollSessionUntilIdle(makeSessionStatusEnv([
      {
        body: {
          lifecycleStatus: 'running',
          runnerConnected: true,
          runnerBusy: false,
          queuedPrompts: 0,
        },
      },
    ]), step, {
      sessionId: 'sess-1',
      pollKey: 'k',
      timeoutMs: 60_000,
    });
    expect(result).toBe('idle');
    expect(calls.filter((c) => c.type === 'sleep')).toHaveLength(0);
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

describe('pollThreadUntilIdle', () => {
  it('returns idle immediately when the thread has no queued or processing prompts', async () => {
    const { step, calls } = makeStep();
    const result = await pollThreadUntilIdle(makeThreadEnv([
      { body: { threadId: 'thread-1', status: 'idle', queuedPrompts: 0, processingPrompts: 0 } },
    ]), step, {
      sessionId: 'orchestrator:user-1',
      threadId: 'thread-1',
      pollKey: 'thread',
      timeoutMs: 60_000,
    });

    expect(result).toBe('idle');
    expect(calls.filter((c) => c.type === 'sleep')).toHaveLength(0);
  });

  it('polls while the thread has queued or processing prompts', async () => {
    const { step, calls } = makeStep();
    const result = await pollThreadUntilIdle(makeThreadEnv([
      { body: { threadId: 'thread-1', status: 'working', queuedPrompts: 0, processingPrompts: 1 } },
      { body: { threadId: 'thread-1', status: 'idle', queuedPrompts: 0, processingPrompts: 0 } },
    ]), step, {
      sessionId: 'orchestrator:user-1',
      threadId: 'thread-1',
      pollKey: 'thread',
      timeoutMs: 60_000,
      initialIntervalMs: 100,
      maxIntervalMs: 100,
    });

    expect(result).toBe('idle');
    expect(calls.map((c) => c.name)).toEqual([
      'thread:check:0',
      'thread:sleep:0',
      'thread:check:1',
    ]);
  });

  it('throws when the SessionAgent thread status endpoint fails', async () => {
    const { step } = makeStep();
    await expect(pollThreadUntilIdle(makeThreadEnv([
      { ok: false, status: 500, body: { error: 'boom' } },
    ]), step, {
      sessionId: 'orchestrator:user-1',
      threadId: 'thread-1',
      pollKey: 'thread',
      timeoutMs: 60_000,
    })).rejects.toThrow(/thread status check failed/);
  });
});
