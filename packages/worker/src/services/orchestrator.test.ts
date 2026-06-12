import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  getDbMock,
  getOrchestratorIdentityMock,
  createThreadMock,
} = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  getOrchestratorIdentityMock: vi.fn(),
  createThreadMock: vi.fn(),
}));

vi.mock('../lib/drizzle.js', () => ({
  getDb: getDbMock,
}));

vi.mock('../lib/db.js', () => ({
  getOrchestratorIdentity: getOrchestratorIdentityMock,
  createThread: createThreadMock,
}));

import { dispatchOrchestratorPrompt } from './orchestrator.js';

describe('dispatchOrchestratorPrompt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getDbMock.mockReturnValue({});
    getOrchestratorIdentityMock.mockResolvedValue({
      id: 'identity-1',
      userId: 'user-1',
      name: 'Jarvis',
      handle: 'jarvis',
    });
    createThreadMock.mockResolvedValue({
      id: 'thread-scheduled',
      sessionId: 'orchestrator:user-1',
    });
  });

  it('preserves queued prompts for forced fresh-thread dispatches', async () => {
    const doFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(Response.json({ success: true }));
    const env = {
      DB: {},
      SESSIONS: {
        idFromName: vi.fn((name: string) => `do:${name}`),
        get: vi.fn(() => ({ fetch: doFetch })),
      },
    } as any;

    const result = await dispatchOrchestratorPrompt(env, {
      userId: 'user-1',
      content: 'scheduled agenda',
      forceNewThread: true,
      authorName: 'Scheduled Task',
      authorEmail: 'scheduled-task@valet.local',
    });

    expect(result.dispatched).toBe(true);
    expect(createThreadMock).toHaveBeenCalledWith(env.DB, {
      id: expect.any(String),
      sessionId: 'orchestrator:user-1',
    });

    const promptRequest = doFetch.mock.calls[1]?.[0] as Request;
    expect(promptRequest.url).toBe('http://do/prompt');
    expect(promptRequest.headers.get('X-Valet-Prompt-Queue-Policy')).toBe('append');
    await expect(promptRequest.json()).resolves.toMatchObject({
      content: expect.stringContaining('scheduled agenda'),
      threadId: 'thread-scheduled',
      authorName: 'Scheduled Task',
      authorEmail: 'scheduled-task@valet.local',
    });
  });

  it('marks forced trigger-created threads as automation origin', async () => {
    const doFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(Response.json({ success: true }));
    const env = {
      DB: {},
      SESSIONS: {
        idFromName: vi.fn((name: string) => `do:${name}`),
        get: vi.fn(() => ({ fetch: doFetch })),
      },
    } as any;

    await dispatchOrchestratorPrompt(env, {
      userId: 'user-1',
      content: 'run the daily check',
      forceNewThread: true,
      threadOrigin: {
        originType: 'automation',
        originTriggerId: 'trigger-1',
        originTriggerType: 'schedule',
      },
    });

    expect(createThreadMock).toHaveBeenCalledWith(env.DB, expect.objectContaining({
      originType: 'automation',
      originTriggerId: 'trigger-1',
      originTriggerType: 'schedule',
    }));
  });
});
