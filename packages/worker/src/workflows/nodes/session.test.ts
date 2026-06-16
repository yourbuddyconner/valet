import { describe, it, expect, vi, beforeEach } from 'vitest';

const createSessionMock = vi.fn();
const assertSessionAccessMock = vi.fn();
const getUserByIdMock = vi.fn();
const pollMock = vi.fn();
const createThreadMock = vi.fn();

vi.mock('../../services/sessions.js', () => ({
  createSession: (...args: unknown[]) => createSessionMock(...args),
}));

vi.mock('../../lib/db/sessions.js', () => ({
  assertSessionAccess: (...args: unknown[]) => assertSessionAccessMock(...args),
}));

vi.mock('../../lib/db/users.js', () => ({
  getUserById: (...args: unknown[]) => getUserByIdMock(...args),
}));

vi.mock('../../lib/db/threads.js', () => ({
  createThread: (...args: unknown[]) => createThreadMock(...args),
}));

vi.mock('../polling.js', () => ({
  pollSessionUntilIdle: (...args: unknown[]) => pollMock(...args),
}));

// Minimal drizzle insert stub for the spawned-session lookup row that
// session.executeStart now writes. The chained insert/values/
// onConflictDoNothing/run all no-op for the test.
const noopChain = {
  values: () => noopChain,
  onConflictDoNothing: () => noopChain,
  run: async () => undefined,
};
vi.mock('../../lib/drizzle.js', () => ({
  getDb: () => ({ insert: () => noopChain } as unknown),
}));

import { executeSession } from './session.js';
import type { SessionNode, WorkflowDagState } from '@valet/shared';
import type { WorkflowRunParams } from '../types.js';
import type { Env } from '../../env.js';
import type { WorkflowStep } from 'cloudflare:workers';

function buildArgs(node: SessionNode, sessionDoMock?: ReturnType<typeof vi.fn>) {
  const fullState: WorkflowDagState = {
    trigger: { type: 'manual', timestamp: '2026-06-12T00:00:00.000Z', data: {}, metadata: {} },
    inputs: {},
    nodes: {},
    skipped: {},
  };
  const fetchMock = sessionDoMock ?? vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
  const env = {
    DB: {},
    SESSIONS: {
      idFromName: (s: string) => s,
      get: () => ({ fetch: fetchMock }),
    },
  } as unknown as Env;
  return {
    node,
    state: fullState,
    params: { executionId: 'exec-1', workflowId: 'wf-1', userId: 'user-1' } as WorkflowRunParams,
    env,
    // Passthrough step.do stub — runs the callback inline and returns
    // its value. session.ts uses step.do to cache createSession +
    // createThread side effects.
    step: {
      // Passthrough stub: supports the 2-arg (name, fn) and 3-arg
      // (name, config, fn) signatures the CF runtime exposes.
      do: async (_name: string, configOrFn: unknown, maybeFn?: () => Promise<unknown>) => {
        const fn = (typeof configOrFn === 'function' ? configOrFn : maybeFn) as () => Promise<unknown>;
        return fn();
      },
    } as unknown as WorkflowStep,
    fetchMock,
  };
}

beforeEach(() => {
  createSessionMock.mockReset();
  assertSessionAccessMock.mockReset();
  getUserByIdMock.mockReset();
  pollMock.mockReset();
  createThreadMock.mockReset();
  getUserByIdMock.mockResolvedValue({ id: 'user-1', email: 'u@example.com' });
  createThreadMock.mockResolvedValue({ id: 'thread-mock', sessionId: 'sess-mock' });
});

describe('executeSession — start mode', () => {
  it('pre-allocates the sessionId, records the spawn, and threads presetSessionId into createSession', async () => {
    createSessionMock.mockResolvedValue({
      ok: true,
      session: { id: 'ignored-mock-id', status: 'initializing' },
    });
    const node: SessionNode = {
      id: 's', type: 'session', mode: 'start',
      prompt: 'do the thing', workspace: 'main',
    };
    const a = buildArgs(node);
    const out = await executeSession(a);
    // sessionId comes from the alloc-id step.do (pre-allocated UUID),
    // NOT from the createSession mock's return — the workflow owns
    // the id so a retry can collide cleanly on the existing PK.
    expect(out.mode).toBe('start');
    expect(typeof out.sessionId).toBe('string');
    expect(out.sessionId.length).toBeGreaterThan(0);
    expect(out.status).toBe('initializing');
    expect(createSessionMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      userId: 'user-1',
      userEmail: 'u@example.com',
      workspace: 'main',
      initialPrompt: 'do the thing',
      presetSessionId: out.sessionId,
    }), expect.anything());
  });

  it('polls when wait.mode is until_idle', async () => {
    createSessionMock.mockResolvedValue({ ok: true, session: { id: 'ignored-mock-id', status: 'initializing' } });
    pollMock.mockResolvedValue('idle');
    const node: SessionNode = {
      id: 's', type: 'session', mode: 'start', prompt: 'go', workspace: 'main',
      wait: { mode: 'until_idle', timeout: '1h' },
    };
    const out = await executeSession(buildArgs(node));
    expect(pollMock).toHaveBeenCalled();
    expect(out.finalStatus).toBe('idle');
  });

  it('throws when createSession rejects', async () => {
    createSessionMock.mockResolvedValue({ ok: false, reason: 'rate_limited', message: 'too many' });
    const node: SessionNode = {
      id: 's', type: 'session', mode: 'start', prompt: 'go', workspace: 'main',
    };
    await expect(executeSession(buildArgs(node))).rejects.toThrow(/rate_limited.*too many/);
  });
});

describe('executeSession — prompt mode', () => {
  it('sends a prompt to an existing session via the DO', async () => {
    assertSessionAccessMock.mockResolvedValue({ id: 'sess-1', status: 'idle' });
    const node: SessionNode = {
      id: 's', type: 'session', mode: 'prompt',
      sessionId: 'sess-1', prompt: 'follow-up',
    };
    const a = buildArgs(node);
    const out = await executeSession(a);
    expect(out).toMatchObject({ mode: 'prompt', sessionId: 'sess-1', status: 'queued' });
    expect(a.fetchMock).toHaveBeenCalled();
    const sent = (a.fetchMock.mock.calls[0]![0] as Request).clone();
    const body = await sent.json() as Record<string, unknown>;
    expect(body.content).toBe('follow-up');
  });

  it('forwards threadId when provided', async () => {
    assertSessionAccessMock.mockResolvedValue({ id: 'sess-1', status: 'running' });
    const node: SessionNode = {
      id: 's', type: 'session', mode: 'prompt',
      sessionId: 'sess-1', prompt: 'go', threadId: 'thread-9',
    };
    const a = buildArgs(node);
    const out = await executeSession(a);
    expect(out.threadId).toBe('thread-9');
    const sent = (a.fetchMock.mock.calls[0]![0] as Request).clone();
    const body = await sent.json() as Record<string, unknown>;
    expect(body.threadId).toBe('thread-9');
  });

  it('rejects when both threadId and forceNewThread are set', async () => {
    assertSessionAccessMock.mockResolvedValue({ id: 'sess-1', status: 'idle' });
    const node: SessionNode = {
      id: 's', type: 'session', mode: 'prompt',
      sessionId: 'sess-1', prompt: 'go', threadId: 't', forceNewThread: true,
    };
    await expect(executeSession(buildArgs(node))).rejects.toThrow(/cannot set both/);
  });

  it('treats an empty-string threadId template as absent and allows forceNewThread', async () => {
    assertSessionAccessMock.mockResolvedValue({ id: 'sess-1', status: 'idle' });
    const node: SessionNode = {
      id: 's', type: 'session', mode: 'prompt',
      sessionId: 'sess-1', prompt: 'go', threadId: '{{trigger.missing}}', forceNewThread: true,
    };
    const out = await executeSession(buildArgs(node));
    expect(out.threadId).toBeDefined();
    // New thread was actually created via createThread, not echoed.
    expect(createThreadMock).toHaveBeenCalled();
  });

  it('creates a fresh thread and dispatches into it when forceNewThread is true', async () => {
    assertSessionAccessMock.mockResolvedValue({ id: 'sess-1', status: 'idle' });
    const node: SessionNode = {
      id: 's', type: 'session', mode: 'prompt',
      sessionId: 'sess-1', prompt: 'go', forceNewThread: true,
    };
    const a = buildArgs(node);
    const out = await executeSession(a);
    expect(createThreadMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ sessionId: 'sess-1' }));
    expect(out.threadId).toBeDefined();
    const sent = (a.fetchMock.mock.calls[0]![0] as Request).clone();
    const body = await sent.json() as Record<string, unknown>;
    expect(body.threadId).toBe(out.threadId);
    expect(body.forceNewThread).toBeUndefined();
  });

  it('rejects when the target session is not active', async () => {
    assertSessionAccessMock.mockResolvedValue({ id: 'sess-1', status: 'terminated' });
    const node: SessionNode = {
      id: 's', type: 'session', mode: 'prompt', sessionId: 'sess-1', prompt: 'go',
    };
    await expect(executeSession(buildArgs(node))).rejects.toThrow(/not active.*terminated/);
  });

  it('rejects with auth error when assertSessionAccess throws', async () => {
    assertSessionAccessMock.mockRejectedValue(new Error('NotFound'));
    const node: SessionNode = {
      id: 's', type: 'session', mode: 'prompt', sessionId: 'sess-missing', prompt: 'go',
    };
    await expect(executeSession(buildArgs(node))).rejects.toThrow();
  });
});
