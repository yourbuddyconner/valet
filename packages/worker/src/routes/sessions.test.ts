import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const {
  assertSessionAccessMock,
  getThreadMock,
  getSessionMessagesMock,
  getThreadMessagesMock,
  getOrgSettingsMock,
  getUserSessionsMock,
} = vi.hoisted(() => ({
  assertSessionAccessMock: vi.fn(),
  getThreadMock: vi.fn(),
  getSessionMessagesMock: vi.fn(),
  getThreadMessagesMock: vi.fn(),
  getOrgSettingsMock: vi.fn(),
  getUserSessionsMock: vi.fn(),
}));

vi.mock('../lib/db.js', () => ({
  assertSessionAccess: assertSessionAccessMock,
  getThread: getThreadMock,
  getSessionMessages: getSessionMessagesMock,
  getThreadMessages: getThreadMessagesMock,
  getOrgSettings: getOrgSettingsMock,
  getUserSessions: getUserSessionsMock,
}));

vi.mock('../services/sessions.js', () => ({
  createSession: vi.fn(),
  joinSessionViaShareLink: vi.fn(),
  getSessionWithStatus: vi.fn(),
  issueSandboxToken: vi.fn(),
  sendSessionMessage: vi.fn(),
}));

vi.mock('../services/model-catalog.js', () => ({
  resolveAvailableModels: vi.fn().mockResolvedValue([]),
}));

import { sessionsRouter } from './sessions.js';

function buildApp() {
  const app = new Hono();
  app.use('*', async (c, next) => {
    (c as any).set('user', { id: 'user-1', email: 'user@example.com', role: 'user' } as any);
    (c as any).set('db', {} as any);
    await next();
  });
  app.route('/', sessionsRouter);
  return app;
}

describe('sessionsRouter GET /:id/messages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getOrgSettingsMock.mockResolvedValue({});
    getUserSessionsMock.mockResolvedValue({ sessions: [], hasMore: false });
    getThreadMessagesMock.mockResolvedValue([]);
  });

  it('falls back to the thread owning orchestrator session when a rotated thread is requested', async () => {
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
      new Request('http://localhost/orchestrator:user-1:new/messages?threadId=thread-1'),
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
});
