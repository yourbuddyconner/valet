import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { D1Database } from '@cloudflare/workers-types';
import type { Env, Variables } from '../env.js';
import { errorHandler } from '../middleware/error-handler.js';

const {
  assertSessionAccessMock,
  getCurrentOrchestratorSessionMock,
  getThreadMock,
  getThreadMessagesMock,
  listThreadsMock,
  createThreadMock,
  updateThreadStatusMock,
} = vi.hoisted(() => ({
  assertSessionAccessMock: vi.fn(),
  getCurrentOrchestratorSessionMock: vi.fn(),
  getThreadMock: vi.fn(),
  getThreadMessagesMock: vi.fn(),
  listThreadsMock: vi.fn(),
  createThreadMock: vi.fn(),
  updateThreadStatusMock: vi.fn(),
}));

vi.mock('../lib/db.js', () => ({
  assertSessionAccess: assertSessionAccessMock,
  getCurrentOrchestratorSession: getCurrentOrchestratorSessionMock,
  getThread: getThreadMock,
  getThreadMessages: getThreadMessagesMock,
  listThreads: listThreadsMock,
  createThread: createThreadMock,
  updateThreadStatus: updateThreadStatusMock,
}));

import { threadsRouter } from './threads.js';

function buildApp() {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    (c as any).set('user', { id: 'user-1', email: 'user@example.com', role: 'user' } as any);
    (c as any).set('db', {} as any);
    (c as any).set('requestId', 'req-test');
    await next();
  });
  app.route('/', threadsRouter);
  return app;
}

describe('threadsRouter POST /:sessionId/threads/:threadId/continue', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    getCurrentOrchestratorSessionMock.mockResolvedValue(null);
    getThreadMessagesMock.mockResolvedValue([]);
    listThreadsMock.mockResolvedValue({ threads: [], hasMore: false });
  });

  it('resolves the orchestrator alias to the current orchestrator session when listing threads', async () => {
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

    const app = buildApp();
    const res = await app.fetch(
      new Request('http://localhost/orchestrator/threads'),
      { DB: {} } as any
    );

    expect(res.status).toBe(200);
    expect(getCurrentOrchestratorSessionMock).toHaveBeenCalledWith({}, 'user-1');
    expect(assertSessionAccessMock).toHaveBeenCalledWith({}, 'orchestrator:user-1:new', 'user-1', 'viewer');
    expect(listThreadsMock).toHaveBeenCalledWith({}, 'orchestrator:user-1:new', {
      limit: 20,
      userId: 'user-1',
    });
  });

  it('returns 404 when the orchestrator alias cannot be resolved', async () => {
    const app = buildApp();
    const res = await app.fetch(
      new Request('http://localhost/orchestrator/threads'),
      { DB: {} } as any
    );

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({
      error: "Session with id 'orchestrator' not found",
    });
  });

  it('returns numbered thread-history pagination metadata when page params are provided', async () => {
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

    listThreadsMock.mockResolvedValue({
      threads: [
        {
          id: 'thread-page-2',
          sessionId: 'orchestrator:user-1:new',
          status: 'active',
          messageCount: 5,
          summaryAdditions: 0,
          summaryDeletions: 0,
          summaryFiles: 0,
          createdAt: new Date('2026-04-01T10:00:00Z'),
          lastActiveAt: new Date('2026-04-01T10:05:00Z'),
        },
      ],
      hasMore: true,
      page: 2,
      pageSize: 30,
      totalCount: 65,
      totalPages: 3,
    });

    const app = buildApp();
    const res = await app.fetch(
      new Request('http://localhost/orchestrator/threads?page=2&pageSize=30'),
      { DB: {} } as any
    );

    expect(res.status).toBe(200);
    expect(listThreadsMock).toHaveBeenCalledWith({}, 'orchestrator:user-1:new', {
      limit: 30,
      page: 2,
      pageSize: 30,
      userId: 'user-1',
    });
    expect(await res.json()).toEqual({
      threads: [
        {
          id: 'thread-page-2',
          sessionId: 'orchestrator:user-1:new',
          status: 'active',
          messageCount: 5,
          summaryAdditions: 0,
          summaryDeletions: 0,
          summaryFiles: 0,
          createdAt: '2026-04-01T10:00:00.000Z',
          lastActiveAt: '2026-04-01T10:05:00.000Z',
        },
      ],
      hasMore: true,
      page: 2,
      pageSize: 30,
      totalCount: 65,
      totalPages: 3,
    });
  });

  it('merges historical and resumed messages by durable thread id in thread detail', async () => {
    const thread = {
      id: 'thread-detail',
      sessionId: 'orchestrator:user-1:old',
      status: 'active',
      opencodeSessionId: 'persisted-thread',
    };

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

    getThreadMock.mockResolvedValue(thread);
    getThreadMessagesMock.mockResolvedValue([
      {
        id: 'msg-old',
        sessionId: 'orchestrator:user-1:old',
        role: 'user',
        content: 'old message',
        threadId: 'thread-detail',
        createdAt: new Date('2026-04-01T10:00:00Z'),
      },
      {
        id: 'msg-new',
        sessionId: 'orchestrator:user-1:new',
        role: 'assistant',
        content: 'new message',
        threadId: 'thread-detail',
        createdAt: new Date('2026-04-01T10:05:00Z'),
      },
    ]);

    const app = buildApp();
    const res = await app.fetch(
      new Request('http://localhost/orchestrator/threads/thread-detail'),
      { DB: {} } as any
    );

    expect(res.status).toBe(200);
    expect(getThreadMessagesMock).toHaveBeenCalledWith({}, 'thread-detail');
    expect(await res.json()).toEqual({
      thread,
      messages: [
        {
          id: 'msg-old',
          sessionId: 'orchestrator:user-1:old',
          role: 'user',
          content: 'old message',
          threadId: 'thread-detail',
          createdAt: '2026-04-01T10:00:00.000Z',
        },
        {
          id: 'msg-new',
          sessionId: 'orchestrator:user-1:new',
          role: 'assistant',
          content: 'new message',
          threadId: 'thread-detail',
          createdAt: '2026-04-01T10:05:00.000Z',
        },
      ],
    });
  });

  it('returns the existing thread for orchestrator resume instead of creating a new thread', async () => {
    const existingThread = {
      id: 'thread-1',
      sessionId: 'orchestrator:user-1:old',
      status: 'active',
      opencodeSessionId: 'persisted-thread-1',
    };

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

    getThreadMock.mockResolvedValue(existingThread);

    const emptyDbMock = {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({
          all: vi.fn().mockResolvedValue({ results: [] }),
        })),
      })),
    } as unknown as Pick<D1Database, 'prepare'>;

    const app = buildApp();
    const res = await app.fetch(
      new Request('http://localhost/orchestrator/threads/thread-1/continue', {
        method: 'POST',
      }),
      { DB: emptyDbMock } as any
    );

    expect(res.status).toBe(200);
    expect(createThreadMock).not.toHaveBeenCalled();
    expect(await res.json()).toEqual({
      thread: existingThread,
      resumed: true,
    });
  });

  it('reactivates an archived thread before resuming it', async () => {
    const archivedThread = {
      id: 'thread-2',
      sessionId: 'orchestrator:user-1:old',
      status: 'archived',
      opencodeSessionId: 'persisted-thread-2',
    };

    const reactivatedThread = {
      ...archivedThread,
      status: 'active',
    };

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

    getThreadMock
      .mockResolvedValueOnce(archivedThread)
      .mockResolvedValueOnce(reactivatedThread);

    const emptyDbMock = {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({
          all: vi.fn().mockResolvedValue({ results: [] }),
        })),
      })),
    } as unknown as Pick<D1Database, 'prepare'>;

    const app = buildApp();
    const res = await app.fetch(
      new Request('http://localhost/orchestrator/threads/thread-2/continue', {
        method: 'POST',
      }),
      { DB: emptyDbMock } as any
    );

    expect(res.status).toBe(200);
    expect(createThreadMock).not.toHaveBeenCalled();
    expect(updateThreadStatusMock).toHaveBeenCalledWith(emptyDbMock, 'thread-2', 'active');
    expect(await res.json()).toEqual({
      thread: reactivatedThread,
      resumed: true,
    });
  });

  it('returns continuation context for legacy threads without a persisted OpenCode session', async () => {
    const legacyThread = {
      id: 'thread-3',
      sessionId: 'orchestrator:user-1:old',
      status: 'active',
      opencodeSessionId: undefined,
    };

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

    getThreadMock.mockResolvedValue(legacyThread);

    const dbMock = {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({
          all: vi.fn().mockResolvedValue({
            results: [
              { role: 'assistant', content: 'Earlier answer' },
              { role: 'user', content: 'Earlier question' },
            ],
          }),
        })),
      })),
    } as unknown as Pick<D1Database, 'prepare'>;

    const app = buildApp();
    const res = await app.fetch(
      new Request('http://localhost/orchestrator/threads/thread-3/continue', {
        method: 'POST',
      }),
      { DB: dbMock } as any
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      thread: legacyThread,
      resumed: true,
      continuationContext: '[user]: Earlier question\n[assistant]: Earlier answer',
    });
  });
});
