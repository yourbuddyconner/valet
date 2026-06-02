import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const {
  getCredentialMock,
  getUserTelegramConfigMock,
  getInvocationMock,
  getChannelBindingByScopeKeyMock,
  getOrchestratorSessionMock,
  getSessionMock,
} = vi.hoisted(() => ({
  getCredentialMock: vi.fn(),
  getUserTelegramConfigMock: vi.fn(),
  getInvocationMock: vi.fn(),
  getChannelBindingByScopeKeyMock: vi.fn(),
  getOrchestratorSessionMock: vi.fn(),
  getSessionMock: vi.fn(),
}));

vi.mock('../services/credentials.js', () => ({
  getCredential: getCredentialMock,
}));

vi.mock('../lib/db.js', () => ({
  getUserTelegramConfig: getUserTelegramConfigMock,
  getInvocation: getInvocationMock,
  getChannelBindingByScopeKey: getChannelBindingByScopeKeyMock,
  getOrchestratorSession: getOrchestratorSessionMock,
  getSession: getSessionMock,
}));

vi.mock('../channels/registry.js', () => ({
  channelRegistry: {
    getTransport: vi.fn(() => ({})),
  },
}));

vi.mock('../lib/workflow-runtime.js', () => ({
  dispatchOrchestratorPrompt: vi.fn(),
}));

import { channelWebhooksRouter } from './channel-webhooks.js';

function buildApp() {
  const app = new Hono();
  app.use('*', async (c, next) => {
    (c as any).set('db', {} as any);
    await next();
  });
  app.route('/', channelWebhooksRouter);
  return app;
}

describe('channelWebhooksRouter Telegram callback_query', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getCredentialMock.mockResolvedValue({ ok: true, credential: { accessToken: 'telegram-token' } });
    getUserTelegramConfigMock.mockResolvedValue({ ownerTelegramUserId: 'tg-owner' });
    getInvocationMock.mockResolvedValue(null);
    getSessionMock.mockResolvedValue({ id: 'session-bound', userId: 'user-1', status: 'running' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('routes question button callbacks to the bound Telegram session before falling back to the orchestrator', async () => {
    const app = buildApp();
    const forwardedRequests: Request[] = [];
    const doFetch = vi.fn(async (request: Request) => {
      forwardedRequests.push(request);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const env = {
      SESSIONS: {
        idFromName: vi.fn((name: string) => `id:${name}`),
        get: vi.fn(() => ({ fetch: doFetch })),
      },
      DB: {},
    };
    const executionCtx = { waitUntil: vi.fn((promise: Promise<unknown>) => promise) };
    getChannelBindingByScopeKeyMock.mockResolvedValue({
      id: 'binding-1',
      sessionId: 'session-bound',
      queueMode: 'steer',
    });
    getOrchestratorSessionMock.mockResolvedValue({ id: 'orchestrator:user-1' });

    const res = await app.request(
      '/telegram/webhook/user-1',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          update_id: 1,
          callback_query: {
            id: 'callback-1',
            data: 'option_0|q-telegram',
            from: { id: 'tg-owner' },
            message: {
              message_id: 42,
              chat: { id: 12345, type: 'private' },
            },
          },
        }),
      },
      env as any,
      executionCtx as any,
    );

    expect(res.status).toBe(200);
    await Promise.all(executionCtx.waitUntil.mock.calls.map(([promise]) => promise));

    expect(getChannelBindingByScopeKeyMock).toHaveBeenCalledWith(expect.anything(), 'user:user-1:telegram:12345');
    expect(env.SESSIONS.idFromName).toHaveBeenCalledWith('session-bound');
    expect(env.SESSIONS.idFromName).not.toHaveBeenCalledWith('orchestrator:user-1');
    expect(doFetch).toHaveBeenCalled();
    expect(forwardedRequests[0]?.url).toBe('https://session/prompt-resolved');
    const forwarded = forwardedRequests[0];
    await expect(forwarded.json()).resolves.toMatchObject({
      promptId: 'q-telegram',
      actionId: 'option_0',
      resolvedBy: 'user-1',
    });
  });
});
