import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const {
  getOrgSlackInstallMock,
  resolveUserByExternalIdMock,
  getInvocationMock,
  getSessionMock,
  decryptStringMock,
  verifySlackSignatureMock,
  checkPrivateChannelAccessMock,
  dispatchOrchestratorPromptMock,
  getChannelBindingByScopeKeyMock,
  deleteChannelBindingMock,
  getOrchestratorSessionMock,
  getOrCreateChannelThreadMock,
  getChannelThreadMappingMock,
  parseInboundMock,
  sendMessageMock,
  setThreadStatusMock,
  scopeKeyPartsMock,
} = vi.hoisted(() => ({
  getOrgSlackInstallMock: vi.fn(),
  resolveUserByExternalIdMock: vi.fn(),
  getInvocationMock: vi.fn(),
  getSessionMock: vi.fn(),
  decryptStringMock: vi.fn(),
  verifySlackSignatureMock: vi.fn(),
  checkPrivateChannelAccessMock: vi.fn(),
  dispatchOrchestratorPromptMock: vi.fn(),
  getChannelBindingByScopeKeyMock: vi.fn(),
  deleteChannelBindingMock: vi.fn(),
  getOrchestratorSessionMock: vi.fn(),
  getOrCreateChannelThreadMock: vi.fn(),
  getChannelThreadMappingMock: vi.fn(),
  parseInboundMock: vi.fn(),
  sendMessageMock: vi.fn(),
  setThreadStatusMock: vi.fn(),
  scopeKeyPartsMock: vi.fn(),
}));

vi.mock('../lib/db.js', () => ({
  getOrgSlackInstall: getOrgSlackInstallMock,
  resolveUserByExternalId: resolveUserByExternalIdMock,
  getInvocation: getInvocationMock,
  getSession: getSessionMock,
  getChannelBindingByScopeKey: getChannelBindingByScopeKeyMock,
  deleteChannelBinding: deleteChannelBindingMock,
  getOrchestratorSession: getOrchestratorSessionMock,
  getOrCreateChannelThread: getOrCreateChannelThreadMock,
  getChannelThreadMapping: getChannelThreadMappingMock,
}));

vi.mock('../lib/crypto.js', () => ({
  decryptString: decryptStringMock,
  encryptString: vi.fn().mockResolvedValue('encrypted'),
}));

vi.mock('@valet/plugin-slack/channels', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@valet/plugin-slack/channels')>();
  return {
    ...actual,
    verifySlackSignature: verifySlackSignatureMock,
  };
});

vi.mock('@valet/plugin-slack/actions', () => ({
  checkPrivateChannelAccess: checkPrivateChannelAccessMock,
}));

vi.mock('../lib/workflow-runtime.js', () => ({
  dispatchOrchestratorPrompt: dispatchOrchestratorPromptMock,
}));

vi.mock('./channel-webhooks.js', () => ({
  handleChannelCommand: vi.fn(),
}));

vi.mock('../services/slack.js', () => ({
  getSlackUserInfo: vi.fn(),
  getSlackBotInfo: vi.fn(),
}));

vi.mock('../services/slack-threads.js', () => ({
  buildThreadContext: vi.fn(),
  buildDmContext: vi.fn(),
}));

vi.mock('../lib/db/channel-threads.js', () => ({
  updateThreadCursor: vi.fn(),
}));

vi.mock('../channels/registry.js', () => ({
  channelRegistry: {
    getTransport: vi.fn(() => ({
      parseInbound: parseInboundMock,
      scopeKeyParts: scopeKeyPartsMock,
      sendMessage: sendMessageMock,
      setThreadStatus: setThreadStatusMock,
    })),
  },
}));

import { slackEventsRouter } from './slack-events.js';

function buildApp() {
  const app = new Hono();
  app.use('*', async (c, next) => {
    (c as any).set('db', {} as any);
    await next();
  });
  app.route('/', slackEventsRouter);
  return app;
}

function buildInteractiveRequest(payload: Record<string, unknown>) {
  return new Request('http://localhost/slack/interactive', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-slack-signature': 'v0=test',
      'x-slack-request-timestamp': '1234567890',
    },
    body: new URLSearchParams({
      payload: JSON.stringify(payload),
    }).toString(),
  });
}

function buildMentionEventRequest(channelId: string, channelType: string, userId: string) {
  return new Request('http://localhost/slack/events', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-slack-signature': 'v0=test',
      'x-slack-request-timestamp': String(Math.floor(Date.now() / 1000)),
    },
    body: JSON.stringify({
      type: 'event_callback',
      team_id: 'T123',
      event: {
        type: 'app_mention',
        user: userId,
        text: '<@UBOTID> hello',
        channel: channelId,
        channel_type: channelType,
        ts: '1234567890.123456',
      },
    }),
  });
}

describe('slackEventsRouter /slack/interactive', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    getOrgSlackInstallMock.mockResolvedValue({
      signingSecret: 'decrypted-secret',
      botToken: 'decrypted-bot',
      teamId: 'T123',
      botUserId: 'B123',
      teamName: null,
      appId: null,
      configuredBy: 'user-1',
    });
    verifySlackSignatureMock.mockReturnValue(true);
    parseInboundMock.mockResolvedValue({
      channelType: 'slack',
      channelId: 'C_PRIVATE',
      senderId: 'UMENTIONER',
      senderName: 'Test User',
      text: '@Bot hello',
      attachments: [],
      messageId: '1234567890.123456',
      metadata: {
        teamId: 'T123',
        slackEventType: 'app_mention',
        slackChannelType: 'group',
      },
    });
    scopeKeyPartsMock.mockReturnValue({ channelType: 'slack', channelId: 'T123:C_PRIVATE' });
  });

  it('returns an explicit Slack error when a linked non-owner clicks a prompt button', async () => {
    resolveUserByExternalIdMock.mockResolvedValue('user-2');
    getSessionMock.mockResolvedValue({ id: 'orchestrator:user-1', userId: 'user-1' });

    const app = buildApp();
    const waitUntil = vi.fn();
    const res = await app.fetch(
      buildInteractiveRequest({
        type: 'block_actions',
        team: { id: 'T123' },
        user: { id: 'U123' },
        actions: [
          { action_id: 'approve', value: 'orchestrator:user-1:prompt-1' },
        ],
      }),
      {
        DB: {},
        ENCRYPTION_KEY: 'test-key',
        SLACK_SIGNING_SECRET: 'fallback-secret',
      } as any,
      { waitUntil } as any,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      response_type: 'ephemeral',
      replace_original: false,
      text: 'Only the session owner can respond to this prompt.',
    });
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it('accepts owner clicks and forwards the resolution to the session DO', async () => {
    resolveUserByExternalIdMock.mockResolvedValue('user-1');
    getSessionMock.mockResolvedValue({ id: 'orchestrator:user-1', userId: 'user-1' });

    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }));
    const app = buildApp();
    const waitUntil = vi.fn((promise: Promise<unknown>) => promise);
    const res = await app.fetch(
      buildInteractiveRequest({
        type: 'block_actions',
        team: { id: 'T123' },
        user: { id: 'U123' },
        actions: [
          { action_id: 'approve', value: 'orchestrator:user-1:prompt-1' },
        ],
      }),
      {
        DB: {},
        ENCRYPTION_KEY: 'test-key',
        SLACK_SIGNING_SECRET: 'fallback-secret',
        SESSIONS: {
          idFromName: vi.fn((name: string) => `do:${name}`),
          get: vi.fn(() => ({ fetch: fetchMock })),
        },
      } as any,
      { waitUntil } as any,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(waitUntil).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();

    const forwardedRequest = fetchMock.mock.calls[0][0] as Request;
    expect(forwardedRequest.url).toBe('https://session/prompt-resolved');
    expect(await forwardedRequest.json()).toEqual({
      promptId: 'prompt-1',
      actionId: 'approve',
      resolvedBy: 'user-1',
    });
  });

  it('replaces Slack processing state with an error when the session DO rejects the click', async () => {
    resolveUserByExternalIdMock.mockResolvedValue('user-1');
    getSessionMock.mockResolvedValue({ id: 'orchestrator:user-1', userId: 'user-1' });

    const responseUrlFetch = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ ok: true }));
    vi.stubGlobal('fetch', responseUrlFetch);

    const doFetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: 'This prompt has expired.' }),
      { status: 410, headers: { 'content-type': 'application/json' } },
    ));
    const app = buildApp();
    const waitUntilPromises: Array<Promise<unknown>> = [];
    const waitUntil = vi.fn((promise: Promise<unknown>) => {
      waitUntilPromises.push(promise);
    });

    const res = await app.fetch(
      buildInteractiveRequest({
        type: 'block_actions',
        team: { id: 'T123' },
        user: { id: 'U123' },
        response_url: 'https://hooks.slack.com/actions/response',
        message: {
          text: 'Action requires approval',
          blocks: [
            { type: 'section', text: { type: 'mrkdwn', text: 'Approve?' } },
            { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Allow' } }] },
          ],
        },
        actions: [
          { action_id: 'allow_session', value: 'orchestrator:user-1:prompt-1' },
        ],
      }),
      {
        DB: {},
        ENCRYPTION_KEY: 'test-key',
        SLACK_SIGNING_SECRET: 'fallback-secret',
        SESSIONS: {
          idFromName: vi.fn((name: string) => `do:${name}`),
          get: vi.fn(() => ({ fetch: doFetchMock })),
        },
      } as any,
      { waitUntil } as any,
    );

    await Promise.all(waitUntilPromises);

    expect(res.status).toBe(200);
    expect(responseUrlFetch).toHaveBeenCalledTimes(2);
    const processingBody = JSON.parse((responseUrlFetch.mock.calls[0][1]).body as string);
    const rejectedBody = JSON.parse((responseUrlFetch.mock.calls[1][1]).body as string);
    expect(processingBody.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'context' }),
    ]));
    expect(rejectedBody.replace_original).toBe(true);
    expect(JSON.stringify(rejectedBody.blocks)).toContain('This prompt has expired.');
  });

  it('replaces Slack processing state with an error when the session DO is unreachable', async () => {
    resolveUserByExternalIdMock.mockResolvedValue('user-1');
    getSessionMock.mockResolvedValue({ id: 'orchestrator:user-1', userId: 'user-1' });

    const responseUrlFetch = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ ok: true }));
    vi.stubGlobal('fetch', responseUrlFetch);

    const doFetchMock = vi.fn().mockRejectedValue(new Error('DO unreachable'));
    const app = buildApp();
    const waitUntilPromises: Array<Promise<unknown>> = [];
    const waitUntil = vi.fn((promise: Promise<unknown>) => {
      waitUntilPromises.push(promise);
    });

    const res = await app.fetch(
      buildInteractiveRequest({
        type: 'block_actions',
        team: { id: 'T123' },
        user: { id: 'U123' },
        response_url: 'https://hooks.slack.com/actions/response',
        message: {
          text: 'Action requires approval',
          blocks: [
            { type: 'section', text: { type: 'mrkdwn', text: 'Approve?' } },
            { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Allow' } }] },
          ],
        },
        actions: [
          { action_id: 'allow_session', value: 'orchestrator:user-1:prompt-1' },
        ],
      }),
      {
        DB: {},
        ENCRYPTION_KEY: 'test-key',
        SLACK_SIGNING_SECRET: 'fallback-secret',
        SESSIONS: {
          idFromName: vi.fn((name: string) => `do:${name}`),
          get: vi.fn(() => ({ fetch: doFetchMock })),
        },
      } as any,
      { waitUntil } as any,
    );

    await Promise.all(waitUntilPromises);

    expect(res.status).toBe(200);
    expect(responseUrlFetch).toHaveBeenCalledTimes(2);
    const processingBody = JSON.parse((responseUrlFetch.mock.calls[0][1]).body as string);
    const rejectedBody = JSON.parse((responseUrlFetch.mock.calls[1][1]).body as string);
    expect(processingBody.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'context' }),
    ]));
    expect(rejectedBody.replace_original).toBe(true);
    expect(JSON.stringify(rejectedBody.blocks)).toContain('The session could not be reached.');
  });
});

describe('private channel access control on inbound mentions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getOrgSlackInstallMock.mockResolvedValue({
      signingSecret: 'decrypted-secret',
      botToken: 'decrypted-token',
      teamId: 'T123',
      botUserId: 'B123',
      teamName: null,
      appId: null,
      configuredBy: 'user-1',
    });
    verifySlackSignatureMock.mockReturnValue(true);
    resolveUserByExternalIdMock.mockResolvedValue('user-1');
    parseInboundMock.mockResolvedValue({
      channelType: 'slack',
      channelId: 'C_PRIVATE',
      senderId: 'UMENTIONER',
      senderName: 'Test User',
      text: '@Bot hello',
      attachments: [],
      messageId: '1234567890.123456',
      metadata: {
        teamId: 'T123',
        slackEventType: 'app_mention',
        slackChannelType: 'group',
      },
    });
    scopeKeyPartsMock.mockReturnValue({ channelType: 'slack', channelId: 'T123:C_PRIVATE' });
  });

  it('silently ignores app_mention from a private channel when user is not a member', async () => {
    checkPrivateChannelAccessMock.mockResolvedValue({
      allowed: false,
      isPrivate: true,
      error: 'Access denied: you are not a member of this private channel',
    });

    const app = buildApp();
    const res = await app.fetch(
      buildMentionEventRequest('C_PRIVATE', 'group', 'UMENTIONER'),
      { DB: {}, ENCRYPTION_KEY: 'k', SLACK_SIGNING_SECRET: 's' } as any,
      { waitUntil: vi.fn() } as any,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(dispatchOrchestratorPromptMock).not.toHaveBeenCalled();
  });

  it('silently ignores app_mention from a private channel even when user is a member', async () => {
    checkPrivateChannelAccessMock.mockResolvedValue({ allowed: true, isPrivate: true });

    const app = buildApp();
    const res = await app.fetch(
      buildMentionEventRequest('C_PRIVATE', 'group', 'UMENTIONER'),
      { DB: {}, ENCRYPTION_KEY: 'k', SLACK_SIGNING_SECRET: 's' } as any,
      { waitUntil: vi.fn() } as any,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(getOrchestratorSessionMock).not.toHaveBeenCalled();
    expect(dispatchOrchestratorPromptMock).not.toHaveBeenCalled();
  });
});

describe('personal orchestrator Slack surface policy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getOrgSlackInstallMock.mockResolvedValue({
      signingSecret: 'decrypted-secret',
      botToken: 'decrypted-token',
      teamId: 'T123',
      botUserId: 'B123',
      teamName: null,
      appId: null,
      configuredBy: 'user-1',
    });
    verifySlackSignatureMock.mockReturnValue(true);
    resolveUserByExternalIdMock.mockResolvedValue('user-1');
    scopeKeyPartsMock.mockReturnValue({ channelType: 'slack', channelId: 'D123' });
  });

  it('silently ignores public-channel mentions before personal orchestrator resolution', async () => {
    parseInboundMock.mockResolvedValue({
      channelType: 'slack',
      channelId: 'C_PUBLIC',
      senderId: 'UMENTIONER',
      senderName: 'Test User',
      text: '@Bot hello',
      attachments: [],
      messageId: '1234567890.123456',
      metadata: {
        teamId: 'T123',
        slackEventType: 'app_mention',
        slackChannelType: 'channel',
      },
    });

    const app = buildApp();
    const res = await app.fetch(
      buildMentionEventRequest('C_PUBLIC', 'channel', 'UMENTIONER'),
      { DB: {}, ENCRYPTION_KEY: 'k', SLACK_SIGNING_SECRET: 's' } as any,
      { waitUntil: vi.fn() } as any,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(resolveUserByExternalIdMock).not.toHaveBeenCalled();
    expect(getOrchestratorSessionMock).not.toHaveBeenCalled();
    expect(dispatchOrchestratorPromptMock).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('still routes Slack DMs to the personal orchestrator', async () => {
    parseInboundMock.mockResolvedValue({
      channelType: 'slack',
      channelId: 'D123',
      senderId: 'UDM',
      senderName: 'DM User',
      text: 'hello from dm',
      attachments: [],
      messageId: '1234567890.123456',
      metadata: {
        teamId: 'T123',
        slackEventType: 'message',
        slackChannelType: 'im',
      },
    });
    getChannelBindingByScopeKeyMock.mockResolvedValue(null);
    getOrchestratorSessionMock.mockResolvedValue({ id: 'orchestrator:user-1' });
    getOrCreateChannelThreadMock.mockResolvedValue('thread-uuid-dm');
    getChannelThreadMappingMock.mockResolvedValue(null);
    dispatchOrchestratorPromptMock.mockResolvedValue({ dispatched: true });

    const app = buildApp();
    const waitUntil = vi.fn();
    const res = await app.fetch(
      new Request('http://localhost/slack/events', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-slack-signature': 'v0=test',
          'x-slack-request-timestamp': String(Math.floor(Date.now() / 1000)),
        },
        body: JSON.stringify({
          type: 'event_callback',
          team_id: 'T123',
          event: {
            type: 'message',
            user: 'UDM',
            text: 'hello from dm',
            channel: 'D123',
            channel_type: 'im',
            ts: '1234567890.123456',
          },
        }),
      }),
      { DB: {}, ENCRYPTION_KEY: 'k', SLACK_SIGNING_SECRET: 's' } as any,
      { waitUntil } as any,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(resolveUserByExternalIdMock).toHaveBeenCalledOnce();
    expect(dispatchOrchestratorPromptMock).toHaveBeenCalledOnce();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('passes scopeKey from scopeKeyParts to dispatchOrchestratorPrompt', async () => {
    parseInboundMock.mockResolvedValue({
      channelType: 'slack',
      channelId: 'D123',
      senderId: 'UDM',
      senderName: 'DM User',
      text: 'hello',
      attachments: [],
      messageId: '1234567890.123456',
      metadata: {
        teamId: 'T456',
        slackEventType: 'message',
        slackChannelType: 'im',
      },
    });
    scopeKeyPartsMock.mockReturnValue({ channelType: 'slack', channelId: 'T456:D123' });
    getChannelBindingByScopeKeyMock.mockResolvedValue(null);
    getOrchestratorSessionMock.mockResolvedValue({ id: 'orchestrator:user-1' });
    getOrCreateChannelThreadMock.mockResolvedValue('thread-uuid');
    getChannelThreadMappingMock.mockResolvedValue(null);
    dispatchOrchestratorPromptMock.mockResolvedValue({ dispatched: true });

    const app = buildApp();
    await app.fetch(
      new Request('http://localhost/slack/events', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-slack-signature': 'v0=test',
          'x-slack-request-timestamp': String(Math.floor(Date.now() / 1000)),
        },
        body: JSON.stringify({
          type: 'event_callback',
          team_id: 'T456',
          event: { type: 'message', user: 'UDM', text: 'hello', channel: 'D123', channel_type: 'im', ts: '1234567890.123456' },
        }),
      }),
      { DB: {}, ENCRYPTION_KEY: 'k', SLACK_SIGNING_SECRET: 's' } as any,
      { waitUntil: vi.fn() } as any,
    );

    expect(dispatchOrchestratorPromptMock).toHaveBeenCalledOnce();
    expect(dispatchOrchestratorPromptMock.mock.calls[0][1]).toMatchObject({
      scopeKey: 'user:user-1:slack:T456:D123',
    });
  });
});

describe('bound-session dispatch failure handling', () => {
  const sessionFetchMock = vi.fn();

  function buildDmRequest() {
    return new Request('http://localhost/slack/events', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-slack-signature': 'v0=test',
        'x-slack-request-timestamp': String(Math.floor(Date.now() / 1000)),
      },
      body: JSON.stringify({
        type: 'event_callback',
        team_id: 'T123',
        event: { type: 'message', user: 'UDM', text: 'hello', channel: 'D123', channel_type: 'im', ts: '1234567890.123456' },
      }),
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    getOrgSlackInstallMock.mockResolvedValue({
      signingSecret: 'secret', botToken: 'token', teamId: 'T123',
      botUserId: 'B123', teamName: null, appId: null, configuredBy: 'user-1',
    });
    verifySlackSignatureMock.mockReturnValue(true);
    resolveUserByExternalIdMock.mockResolvedValue('user-1');
    parseInboundMock.mockResolvedValue({
      channelType: 'slack', channelId: 'D123', senderId: 'UDM', senderName: 'DM User',
      text: 'hello', attachments: [], messageId: '1234567890.123456',
      metadata: { teamId: 'T123', slackEventType: 'message', slackChannelType: 'im' },
    });
    scopeKeyPartsMock.mockReturnValue({ channelType: 'slack', channelId: 'T123:D123' });
    getChannelBindingByScopeKeyMock.mockResolvedValue({
      id: 'binding-1', sessionId: 'child-session-1', channelType: 'slack',
      channelId: 'D123:1234567890.123456', scopeKey: 'user:user-1:slack:T123:D123',
      userId: 'user-1', orgId: 'default', queueMode: 'steer', collectDebounceMs: 3000,
      createdAt: new Date().toISOString(),
    });
    getSessionMock.mockResolvedValue({ id: 'child-session-1', status: 'running' });
    getOrchestratorSessionMock.mockResolvedValue({ id: 'orchestrator:user-1' });
    getOrCreateChannelThreadMock.mockResolvedValue('thread-uuid');
    getChannelThreadMappingMock.mockResolvedValue(null);
    sessionFetchMock.mockReset();
  });

  function buildEnvWithSession() {
    return {
      DB: {},
      ENCRYPTION_KEY: 'k',
      SLACK_SIGNING_SECRET: 's',
      SESSIONS: {
        idFromName: vi.fn((name: string) => `do:${name}`),
        get: vi.fn(() => ({ fetch: sessionFetchMock })),
      },
    } as any;
  }

  it('does NOT dispatch to orchestrator when bound session returns non-200 (non-409)', async () => {
    sessionFetchMock.mockResolvedValue(new Response('internal error', { status: 500 }));

    const app = buildApp();
    const res = await app.fetch(
      buildDmRequest(),
      buildEnvWithSession(),
      { waitUntil: vi.fn() } as any,
    );

    expect(res.status).toBe(200);
    expect(sessionFetchMock).toHaveBeenCalledOnce();
    expect(dispatchOrchestratorPromptMock).not.toHaveBeenCalled();
    expect(deleteChannelBindingMock).not.toHaveBeenCalled();
  });

  it('evicts binding and dispatches to orchestrator on 409 (session terminated)', async () => {
    sessionFetchMock.mockResolvedValue(new Response('terminated', { status: 409 }));
    dispatchOrchestratorPromptMock.mockResolvedValue({ dispatched: true });

    const app = buildApp();
    const res = await app.fetch(
      buildDmRequest(),
      buildEnvWithSession(),
      { waitUntil: vi.fn() } as any,
    );

    expect(res.status).toBe(200);
    expect(sessionFetchMock).toHaveBeenCalledOnce();
    expect(deleteChannelBindingMock).toHaveBeenCalledWith({}, 'binding-1');
    expect(dispatchOrchestratorPromptMock).toHaveBeenCalledOnce();
  });

  it('evicts binding and dispatches to orchestrator when bound session is unreachable', async () => {
    sessionFetchMock.mockRejectedValue(new Error('DO unreachable'));
    dispatchOrchestratorPromptMock.mockResolvedValue({ dispatched: true });

    const app = buildApp();
    const res = await app.fetch(
      buildDmRequest(),
      buildEnvWithSession(),
      { waitUntil: vi.fn() } as any,
    );

    expect(res.status).toBe(200);
    expect(sessionFetchMock).toHaveBeenCalledOnce();
    expect(deleteChannelBindingMock).toHaveBeenCalledWith({}, 'binding-1');
    expect(dispatchOrchestratorPromptMock).toHaveBeenCalledOnce();
  });
});
