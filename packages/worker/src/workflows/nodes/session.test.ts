import { describe, it, expect, vi, beforeEach } from 'vitest';

const createSessionMock = vi.fn();
const assertSessionAccessMock = vi.fn();
const getUserByIdMock = vi.fn();
const pollMock = vi.fn();
const createThreadMock = vi.fn();
const fetchMessagesFromDOMock = vi.fn();
const parseOrRepairStructuredJsonMock = vi.fn();

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

vi.mock('../../services/session-cross.js', () => ({
  fetchMessagesFromDO: (...args: unknown[]) => fetchMessagesFromDOMock(...args),
}));

vi.mock('../polling.js', () => ({
  pollSessionUntilIdle: (...args: unknown[]) => pollMock(...args),
}));

vi.mock('../../lib/llm/structured-output.js', () => ({
  parseOrRepairStructuredJson: (...args: unknown[]) => parseOrRepairStructuredJsonMock(...args),
}));

vi.mock('../output-repair.js', () => ({
  assembleWorkflowOutputRepairEnv: async (env: unknown) => env,
  resolveWorkflowOutputRepairModel: async (params: { explicitModel?: string }) => params.explicitModel,
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
  getDb: () => ({ insert: () => noopChain }),
}));

import { executeSession } from './session.js';
import type { SessionNode, WorkflowDagState } from '@valet/shared';
import type { WorkflowRunParams } from '../types.js';
import type { Env } from '../../env.js';
import type { WorkflowStep } from 'cloudflare:workers';

type DurableObjectFetch = ReturnType<Env['SESSIONS']['get']>['fetch'];
type DurableObjectFetchMock = ReturnType<typeof vi.fn<DurableObjectFetch>>;

function durableObjectId(name: string): ReturnType<Env['SESSIONS']['idFromName']> {
  return {
    toString: () => name,
    equals: (other) => other.toString() === name,
    name,
  };
}

function buildArgs(node: SessionNode, sessionDoMock?: DurableObjectFetchMock) {
  const fullState: WorkflowDagState = {
    trigger: { type: 'manual', timestamp: '2026-06-12T00:00:00.000Z', data: {}, metadata: {} },
    nodes: {},
    skipped: {},
  };
  const fetchMock = sessionDoMock ?? vi.fn<DurableObjectFetch>().mockResolvedValue(new Response('ok', { status: 200 }));
  const sessionStub: ReturnType<Env['SESSIONS']['get']> = {
    id: durableObjectId('stub-session'),
    fetch: (input, init) => fetchMock(input, init),
    connect: () => {
      throw new Error('connect is not implemented in the session node test stub');
    },
  };
  let sessionNamespace: Env['SESSIONS'];
  sessionNamespace = {
    idFromName: durableObjectId,
    idFromString: durableObjectId,
    newUniqueId: () => durableObjectId('unique-do-id'),
    get: () => sessionStub,
    getByName: () => sessionStub,
    jurisdiction: () => sessionNamespace,
  };
  const env = {
    DB: {} as Env['DB'],
    SESSIONS: sessionNamespace,
    EVENT_BUS: {} as Env['EVENT_BUS'],
    WORKFLOW_INTERPRETER: {} as Env['WORKFLOW_INTERPRETER'],
    STORAGE: {} as Env['STORAGE'],
    ENCRYPTION_KEY: 'test',
    GOOGLE_CLIENT_ID: 'test',
    GOOGLE_CLIENT_SECRET: 'test',
    MODAL_BACKEND_URL: 'http://modal.test',
    FRONTEND_URL: 'http://client.test',
  } satisfies Env;
  const params: WorkflowRunParams = {
    executionId: 'exec-1',
    workflowId: 'wf-1',
    userId: 'user-1',
    trigger: fullState.trigger,
    definition: { version: 'dag/v1', nodes: [node], edges: [] },
  };
  return {
    node,
    state: fullState,
    params,
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
    } as WorkflowStep,
    fetchMock,
  };
}

beforeEach(() => {
  createSessionMock.mockReset();
  assertSessionAccessMock.mockReset();
  getUserByIdMock.mockReset();
  pollMock.mockReset();
  createThreadMock.mockReset();
  fetchMessagesFromDOMock.mockReset();
  parseOrRepairStructuredJsonMock.mockReset();
  getUserByIdMock.mockResolvedValue({ id: 'user-1', email: 'u@example.com' });
  createThreadMock.mockResolvedValue({ id: 'thread-mock', sessionId: 'sess-mock' });
  fetchMessagesFromDOMock.mockResolvedValue([]);
  parseOrRepairStructuredJsonMock.mockResolvedValue({ value: { repaired: true }, attempts: 1, repaired: false });
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

  it('reports a completed workflow status and preserves the observed wait status when wait.mode is until_idle', async () => {
    createSessionMock.mockResolvedValue({ ok: true, session: { id: 'ignored-mock-id', status: 'initializing' } });
    pollMock.mockResolvedValue('idle');
    const node: SessionNode = {
      id: 's', type: 'session', mode: 'start', prompt: 'go', workspace: 'main',
      wait: { mode: 'until_idle', timeout: '1h' },
    };
    const out = await executeSession(buildArgs(node));
    expect(pollMock).toHaveBeenCalled();
    expect(out.finalStatus).toBe('completed');
    expect(out.waitStatus).toBe('idle');
  });

  it('returns the final assistant response and parsed JSON output after waiting until idle', async () => {
    createSessionMock.mockResolvedValue({ ok: true, session: { id: 'ignored-mock-id', status: 'initializing' } });
    pollMock.mockResolvedValue('idle');
    fetchMessagesFromDOMock.mockResolvedValue([
      {
        id: 'msg-user',
        sessionId: 'sess-1',
        role: 'user',
        content: 'scrape',
        createdAt: '2026-06-12T00:00:00.000Z',
      },
      {
        id: 'msg-assistant',
        sessionId: 'sess-1',
        role: 'assistant',
        content: '{"companies":[{"name":"Red Barn Robotics"}],"totalCount":1}',
        createdAt: '2026-06-12T00:00:03.000Z',
      },
    ]);
    const node: SessionNode = {
      id: 's', type: 'session', mode: 'start', prompt: 'scrape', workspace: 'main',
      wait: { mode: 'until_idle' },
    };

    const out = await executeSession(buildArgs(node));

    expect(fetchMessagesFromDOMock).toHaveBeenCalledWith(expect.anything(), out.sessionId, 5000);
    expect(out).toMatchObject({
      finalStatus: 'completed',
      response: '{"companies":[{"name":"Red Barn Robotics"}],"totalCount":1}',
      output: {
        companies: [{ name: 'Red Barn Robotics' }],
        totalCount: 1,
      },
      lastMessage: {
        id: 'msg-assistant',
        role: 'assistant',
        content: '{"companies":[{"name":"Red Barn Robotics"}],"totalCount":1}',
      },
    });
  });

  it('validates and repairs the final assistant response when outputSchema is configured', async () => {
    createSessionMock.mockResolvedValue({ ok: true, session: { id: 'ignored-mock-id', status: 'initializing' } });
    pollMock.mockResolvedValue('idle');
    fetchMessagesFromDOMock.mockResolvedValue([
      {
        id: 'msg-assistant',
        sessionId: 'sess-1',
        role: 'assistant',
        content: '{"totalCount":"167"',
        createdAt: '2026-06-12T00:00:03.000Z',
      },
    ]);
    parseOrRepairStructuredJsonMock.mockResolvedValue({
      value: { totalCount: 167 },
      attempts: 2,
      repaired: true,
    });
    const outputSchema = {
      type: 'object',
      properties: { totalCount: { type: 'number' } },
      required: ['totalCount'],
    };
    const node: SessionNode = {
      id: 's', type: 'session', mode: 'start', prompt: 'scrape', workspace: 'main',
      wait: { mode: 'until_idle' },
      outputSchema,
      repairModel: 'anthropic:claude-sonnet-4-5',
    };

    const out = await executeSession(buildArgs(node));

    expect(out).toMatchObject({
      response: '{"totalCount":"167"',
      output: { totalCount: 167 },
    });
    expect(parseOrRepairStructuredJsonMock).toHaveBeenCalledWith(expect.objectContaining({
      modelId: 'anthropic:claude-sonnet-4-5',
      text: '{"totalCount":"167"',
      outputSchema,
      contextLabel: 'session node "s"',
    }));
  });

  it('returns the full session transcript when resultMode is transcript', async () => {
    createSessionMock.mockResolvedValue({ ok: true, session: { id: 'ignored-mock-id', status: 'initializing' } });
    pollMock.mockResolvedValue('idle');
    const transcript = [
      {
        id: 'msg-user',
        sessionId: 'sess-1',
        role: 'user',
        content: 'go',
        createdAt: '2026-06-12T00:00:00.000Z',
      },
      {
        id: 'msg-assistant',
        sessionId: 'sess-1',
        role: 'assistant',
        content: 'done',
        createdAt: '2026-06-12T00:00:03.000Z',
      },
    ];
    fetchMessagesFromDOMock.mockResolvedValue(transcript);
    const node: SessionNode = {
      id: 's', type: 'session', mode: 'start', prompt: 'go', workspace: 'main',
      wait: { mode: 'until_idle' },
      resultMode: 'transcript',
    };

    const out = await executeSession(buildArgs(node));

    expect(out).toMatchObject({
      finalStatus: 'completed',
      response: 'done',
      transcript,
    });
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
