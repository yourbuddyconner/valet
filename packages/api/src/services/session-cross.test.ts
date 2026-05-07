import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getSessionMock, getCredentialMock } = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  getCredentialMock: vi.fn(),
}));

vi.mock('../lib/db.js', () => ({
  getSession: getSessionMock,
  getSessionGitState: vi.fn(),
  createSession: vi.fn(),
  createSessionGitState: vi.fn(),
  getUserById: vi.fn(),
  getSessionChannelBindings: vi.fn(),
  listUserChannelBindings: vi.fn(),
}));

vi.mock('../lib/db/sessions.js', () => ({
  getChildSessions: vi.fn(),
}));

vi.mock('./credentials.js', () => ({
  getCredential: getCredentialMock,
}));

import { forwardMessages, getSessionMessages, terminateChild } from './session-cross.js';

describe('session-cross message access', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSessionMock.mockResolvedValue({
      id: 'child-1',
      userId: 'user-1',
      title: 'Child Session',
      workspace: 'repo',
    });
  });

  it('preserves full message payloads when reading another session', async () => {
    const env = {
      SESSIONS: {
        idFromName: vi.fn((name: string) => `do:${name}`),
        get: vi.fn(() => ({
          fetch: vi.fn().mockResolvedValue(
            new Response(
              JSON.stringify({
                messages: [
                  {
                    id: 'msg-1',
                    sessionId: 'child-1',
                    role: 'assistant',
                    content: "That's the complete audit.",
                    parts: [
                      { type: 'text', text: 'Full report body' },
                      { type: 'finish', reason: 'end_turn' },
                    ],
                    authorName: 'Worker',
                    channelType: 'thread',
                    channelId: 'thread-1',
                    threadId: 'thread-1',
                    createdAt: '2026-04-06T12:00:00.000Z',
                  },
                ],
              }),
            ),
          ),
        })),
      },
    } as any;

    const result = await getSessionMessages(env, {} as any, 'user-1', 'child-1');

    expect(result).toEqual({
      messages: [
        {
          id: 'msg-1',
          sessionId: 'child-1',
          role: 'assistant',
          content: "That's the complete audit.",
          parts: [
            { type: 'text', text: 'Full report body' },
            { type: 'finish', reason: 'end_turn' },
          ],
          authorName: 'Worker',
          channelType: 'thread',
          channelId: 'thread-1',
          threadId: 'thread-1',
          createdAt: '2026-04-06T12:00:00.000Z',
        },
      ],
    });
  });

  it('preserves full message payloads when forwarding another session', async () => {
    const env = {
      SESSIONS: {
        idFromName: vi.fn((name: string) => `do:${name}`),
        get: vi.fn(() => ({
          fetch: vi.fn().mockResolvedValue(
            new Response(
              JSON.stringify({
                messages: [
                  {
                    id: 'msg-2',
                    sessionId: 'child-1',
                    role: 'assistant',
                    content: 'forward me',
                    parts: [{ type: 'text', text: 'verbatim body' }],
                    createdAt: '2026-04-06T12:01:00.000Z',
                  },
                ],
              }),
            ),
          ),
        })),
      },
    } as any;

    const result = await forwardMessages(env, {} as any, 'user-1', 'child-1');

    expect(result).toEqual({
      messages: [
        {
          id: 'msg-2',
          sessionId: 'child-1',
          role: 'assistant',
          content: 'forward me',
          parts: [{ type: 'text', text: 'verbatim body' }],
          createdAt: '2026-04-06T12:01:00.000Z',
        },
      ],
      sessionTitle: 'Child Session',
      sourceSessionId: 'child-1',
    });
  });
});

describe('terminateChild', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSessionMock.mockResolvedValue({
      id: 'child-1',
      userId: 'user-1',
      parentSessionId: 'orch-1',
    });
  });

  it('sends reason terminated_by_parent to the child DO', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true })));
    const env = {
      SESSIONS: {
        idFromName: vi.fn(() => 'do-id'),
        get: vi.fn(() => ({ fetch: fetchMock })),
      },
    } as any;

    await terminateChild({} as any, env, 'orch-1', 'user-1', 'child-1');

    const call = fetchMock.mock.calls[0][0] as Request;
    const body = await call.json() as { reason: string };
    expect(body.reason).toBe('terminated_by_parent');
  });
});
