import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env, Variables } from '../env.js';
import { errorHandler } from '../middleware/error-handler.js';

const {
  assertSessionAccessMock,
  getCurrentOrchestratorSessionMock,
  getThreadMock,
  getSessionMessagesMock,
  getThreadMessagesMock,
  getOrgSettingsMock,
  getUserSessionsMock,
} = vi.hoisted(() => ({
  assertSessionAccessMock: vi.fn(),
  getCurrentOrchestratorSessionMock: vi.fn(),
  getThreadMock: vi.fn(),
  getSessionMessagesMock: vi.fn(),
  getThreadMessagesMock: vi.fn(),
  getOrgSettingsMock: vi.fn(),
  getUserSessionsMock: vi.fn(),
}));

vi.mock('../lib/db.js', () => ({
  assertSessionAccess: assertSessionAccessMock,
  getCurrentOrchestratorSession: getCurrentOrchestratorSessionMock,
  getThread: getThreadMock,
  getSessionMessages: getSessionMessagesMock,
  getThreadMessages: getThreadMessagesMock,
  getOrgSettings: getOrgSettingsMock,
  getUserSessions: getUserSessionsMock,
}));

vi.mock('../services/sessions.js', () => ({
  createSession: vi.fn(),
  getEnrichedChildSessions: vi.fn(),
  getSessionWithStatus: vi.fn(),
  issueSandboxToken: vi.fn(),
  joinSessionViaShareLink: vi.fn(),
  sendSessionMessage: vi.fn(),
}));

vi.mock('../services/model-catalog.js', () => ({
  resolveAvailableModels: vi.fn().mockResolvedValue([]),
}));

import { sessionsRouter } from './sessions.js';
import * as sessionService from '../services/sessions.js';

function buildApp() {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    (c as any).set('user', { id: 'user-1', email: 'user@example.com', role: 'user' } as any);
    (c as any).set('db', {} as any);
    (c as any).set('requestId', 'req-test');
    await next();
  });
  app.route('/', sessionsRouter);
  return app;
}

describe('sessionsRouter GET /:id/messages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getOrgSettingsMock.mockResolvedValue({});
    getCurrentOrchestratorSessionMock.mockResolvedValue(null);
    getUserSessionsMock.mockResolvedValue({ sessions: [], hasMore: false });
    getThreadMessagesMock.mockResolvedValue([]);
  });

  it('resolves the orchestrator alias to the current orchestrator session', async () => {
    getCurrentOrchestratorSessionMock.mockResolvedValue({
      id: 'orchestrator:user-1:new',
      userId: 'user-1',
      purpose: 'orchestrator',
      isOrchestrator: true,
    });

    assertSessionAccessMock.mockResolvedValue({
      id: 'orchestrator:user-1:new',
      userId: 'user-1',
      purpose: 'orchestrator',
      isOrchestrator: true,
    });

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ messages: [] }), { status: 200 })
    );

    const app = buildApp();
    const res = await app.fetch(
      new Request('http://localhost/orchestrator/messages'),
      {
        DB: {},
        SESSIONS: {
          idFromName: vi.fn((name: string) => `do:${name}`),
          get: vi.fn(() => ({ fetch: fetchMock })),
        },
      } as any
    );

    expect(res.status).toBe(200);
    expect(getCurrentOrchestratorSessionMock).toHaveBeenCalledWith({}, 'user-1');
    expect(assertSessionAccessMock).toHaveBeenCalledWith({}, 'orchestrator:user-1:new', 'user-1', 'viewer');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to the thread owning orchestrator session when a rotated thread is requested', async () => {
    getCurrentOrchestratorSessionMock.mockResolvedValue({
      id: 'orchestrator:user-1:new',
      userId: 'user-1',
      purpose: 'orchestrator',
      isOrchestrator: true,
    });

    assertSessionAccessMock
      .mockResolvedValueOnce({
        id: 'orchestrator:user-1:new',
        userId: 'user-1',
        purpose: 'orchestrator',
        isOrchestrator: true,
      })
      .mockResolvedValueOnce({
        id: 'orchestrator:user-1:old',
        userId: 'user-1',
        purpose: 'orchestrator',
        isOrchestrator: true,
      });

    getThreadMock.mockResolvedValue({
      id: 'thread-1',
      sessionId: 'orchestrator:user-1:old',
    });

    getThreadMessagesMock.mockResolvedValue([
      {
        id: 'msg-1',
        sessionId: 'orchestrator:user-1:old',
        role: 'user',
        content: 'historic message',
        threadId: 'thread-1',
        createdAt: new Date('2026-03-31T12:00:00Z'),
      },
    ]);

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ messages: [] }), { status: 200 })
    );

    const app = buildApp();
    const res = await app.fetch(
      new Request('http://localhost/orchestrator/messages?threadId=thread-1'),
      {
        DB: {},
        SESSIONS: {
          idFromName: vi.fn((name: string) => `do:${name}`),
          get: vi.fn(() => ({ fetch: fetchMock })),
        },
      } as any
    );

    expect(res.status).toBe(200);
    expect(getThreadMessagesMock).toHaveBeenCalledWith({}, 'thread-1', {});
    expect(await res.json()).toEqual({
      messages: [
        {
          id: 'msg-1',
          sessionId: 'orchestrator:user-1:old',
          role: 'user',
          content: 'historic message',
          threadId: 'thread-1',
          createdAt: '2026-03-31T12:00:00.000Z',
        },
      ],
    });
  });

  it('merges live DO messages with archived orchestrator thread history on refresh', async () => {
    getCurrentOrchestratorSessionMock.mockResolvedValue({
      id: 'orchestrator:user-1:new',
      userId: 'user-1',
      purpose: 'orchestrator',
      isOrchestrator: true,
    });

    assertSessionAccessMock
      .mockResolvedValueOnce({
        id: 'orchestrator:user-1:new',
        userId: 'user-1',
        purpose: 'orchestrator',
        isOrchestrator: true,
      })
      .mockResolvedValueOnce({
        id: 'orchestrator:user-1:old',
        userId: 'user-1',
        purpose: 'orchestrator',
        isOrchestrator: true,
      });

    getThreadMock.mockResolvedValue({
      id: 'thread-1',
      sessionId: 'orchestrator:user-1:old',
    });

    getThreadMessagesMock.mockResolvedValue([
      {
        id: 'msg-old',
        sessionId: 'orchestrator:user-1:old',
        role: 'user',
        content: 'historic message',
        threadId: 'thread-1',
        createdAt: new Date('2026-03-31T12:00:00Z'),
      },
    ]);

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        messages: [
          {
            id: 'msg-new',
            sessionId: 'orchestrator:user-1:new',
            role: 'assistant',
            content: 'new resumed message',
            threadId: 'thread-1',
            createdAt: '2026-03-31T12:05:00.000Z',
          },
        ],
      }), { status: 200 })
    );

    const app = buildApp();
    const res = await app.fetch(
      new Request('http://localhost/orchestrator/messages?threadId=thread-1'),
      {
        DB: {},
        SESSIONS: {
          idFromName: vi.fn((name: string) => `do:${name}`),
          get: vi.fn(() => ({ fetch: fetchMock })),
        },
      } as any
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      messages: [
        {
          id: 'msg-old',
          sessionId: 'orchestrator:user-1:old',
          role: 'user',
          content: 'historic message',
          threadId: 'thread-1',
          createdAt: '2026-03-31T12:00:00.000Z',
        },
        {
          id: 'msg-new',
          sessionId: 'orchestrator:user-1:new',
          role: 'assistant',
          content: 'new resumed message',
          threadId: 'thread-1',
          createdAt: '2026-03-31T12:05:00.000Z',
        },
      ],
    });
  });
});

describe('sessionsRouter orchestrator alias routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getCurrentOrchestratorSessionMock.mockResolvedValue(null);
  });

  it('returns 404 when the orchestrator alias cannot be resolved', async () => {
    const app = buildApp();
    const res = await app.fetch(
      new Request('http://localhost/orchestrator'),
      { DB: {} } as any
    );

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({
      error: "Session with id 'orchestrator' not found",
    });
  });

  it('resolves the orchestrator alias before loading session details', async () => {
    getCurrentOrchestratorSessionMock.mockResolvedValue({
      id: 'orchestrator:user-1:new',
      userId: 'user-1',
      purpose: 'orchestrator',
      isOrchestrator: true,
    });

    vi.mocked(sessionService.getSessionWithStatus).mockResolvedValue({
      session: { id: 'orchestrator:user-1:new' },
      status: { sessionId: 'orchestrator:user-1:new' },
    } as any);

    const app = buildApp();
    const res = await app.fetch(
      new Request('http://localhost/orchestrator'),
      { DB: {} } as any
    );

    expect(res.status).toBe(200);
    expect(sessionService.getSessionWithStatus).toHaveBeenCalledWith(
      expect.objectContaining({ DB: {} }),
      'orchestrator:user-1:new',
      'user-1'
    );
  });

  it('resolves the orchestrator alias before issuing sandbox tokens', async () => {
    getCurrentOrchestratorSessionMock.mockResolvedValue({
      id: 'orchestrator:user-1:new',
      userId: 'user-1',
      purpose: 'orchestrator',
      isOrchestrator: true,
    });

    vi.mocked(sessionService.issueSandboxToken).mockResolvedValue({
      token: 'sandbox-token',
      expiresAt: '2026-04-06T00:00:00.000Z',
    } as any);

    const app = buildApp();
    const res = await app.fetch(
      new Request('http://localhost/orchestrator/sandbox-token'),
      { DB: {} } as any
    );

    expect(res.status).toBe(200);
    expect(sessionService.issueSandboxToken).toHaveBeenCalledWith(
      expect.objectContaining({ DB: {} }),
      'orchestrator:user-1:new',
      'user-1'
    );
  });

  it('resolves the orchestrator alias before loading child sessions', async () => {
    getCurrentOrchestratorSessionMock.mockResolvedValue({
      id: 'orchestrator:user-1:new',
      userId: 'user-1',
      purpose: 'orchestrator',
      isOrchestrator: true,
    });

    vi.mocked(sessionService.getEnrichedChildSessions).mockResolvedValue({
      sessions: [],
      hasMore: false,
    } as any);

    const app = buildApp();
    const res = await app.fetch(
      new Request('http://localhost/orchestrator/children?hideTerminated=true'),
      { DB: {} } as any
    );

    expect(res.status).toBe(200);
    expect(sessionService.getEnrichedChildSessions).toHaveBeenCalledWith(
      expect.objectContaining({ DB: {} }),
      'orchestrator:user-1:new',
      'user-1',
      {
        cursor: undefined,
        hideTerminated: true,
        limit: undefined,
        status: undefined,
      }
    );
  });

  it('resolves the orchestrator alias before proxying client websocket connections', async () => {
    getCurrentOrchestratorSessionMock.mockResolvedValue({
      id: 'orchestrator:user-1:new',
      userId: 'user-1',
      purpose: 'orchestrator',
      isOrchestrator: true,
    });

    assertSessionAccessMock.mockResolvedValue({
      id: 'orchestrator:user-1:new',
      userId: 'user-1',
      purpose: 'orchestrator',
      isOrchestrator: true,
    });

    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const idFromName = vi.fn((name: string) => `do:${name}`);

    const app = buildApp();
    const res = await app.fetch(
      new Request('http://localhost/orchestrator/ws?role=client', {
        headers: { upgrade: 'websocket' },
      }),
      {
        DB: {},
        SESSIONS: {
          idFromName,
          get: vi.fn(() => ({ fetch: fetchMock })),
        },
      } as any
    );

    expect(res.status).toBe(200);
    expect(assertSessionAccessMock).toHaveBeenCalledWith({}, 'orchestrator:user-1:new', 'user-1', 'viewer');
    expect(idFromName).toHaveBeenCalledWith('orchestrator:user-1:new');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
