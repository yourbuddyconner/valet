import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ActionContext } from '@valet/sdk';

const mocks = vi.hoisted(() => ({
  slackGet: vi.fn(),
  slackFetch: vi.fn(),
}));

vi.mock('./api.js', () => ({
  slackGet: mocks.slackGet,
  slackFetch: mocks.slackFetch,
}));

import { slackActions, resolveToSlackTimestamp } from './actions.js';

function slackResponse(data: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ ok: true, ...data }), { status: 200 });
}

function actionContext(): ActionContext {
  return {
    credentials: { bot_token: 'xoxb-token' },
    userId: 'user-1',
  };
}

describe('resolveToSlackTimestamp', () => {
  it('passes through Unix timestamps unchanged', () => {
    expect(resolveToSlackTimestamp('1774000000')).toBe('1774000000');
    expect(resolveToSlackTimestamp('1774000000.000000')).toBe('1774000000.000000');
  });

  it('converts ISO-8601 datetime to Unix seconds', () => {
    const result = resolveToSlackTimestamp('2026-05-19T00:00:00Z');
    const expected = (new Date('2026-05-19T00:00:00Z').getTime() / 1000).toFixed(6);
    expect(result).toBe(expected);
  });

  it('converts date-only string to Unix seconds', () => {
    const result = resolveToSlackTimestamp('2026-05-19');
    const expected = (new Date('2026-05-19').getTime() / 1000).toFixed(6);
    expect(result).toBe(expected);
  });

  it('converts ISO-8601 with timezone offset', () => {
    const result = resolveToSlackTimestamp('2026-05-19T08:00:00-07:00');
    const expected = (new Date('2026-05-19T08:00:00-07:00').getTime() / 1000).toFixed(6);
    expect(result).toBe(expected);
  });

  it('trims whitespace', () => {
    expect(resolveToSlackTimestamp('  1774000000  ')).toBe('1774000000');
  });

  it('throws on unparseable input', () => {
    expect(() => resolveToSlackTimestamp('not-a-date')).toThrow('Cannot parse timestamp');
  });
});

describe('slackActions list_users', () => {
  beforeEach(() => vi.clearAllMocks());

  it('paginates users.list and includes deactivated human users', async () => {
    mocks.slackGet
      .mockResolvedValueOnce(slackResponse({
        members: [
          {
            id: 'U001',
            name: 'ana',
            real_name: 'Ana Active',
            profile: { real_name: 'Ana Active', display_name: 'Ana' },
            is_bot: false,
            deleted: false,
          },
        ],
        response_metadata: { next_cursor: 'cursor-2' },
      }))
      .mockResolvedValueOnce(slackResponse({
        members: [
          {
            id: 'U999',
            name: 'richard',
            real_name: 'Richard Pringle',
            profile: { real_name: 'Richard Pringle', display_name: 'Richard' },
            is_bot: false,
            deleted: true,
          },
          {
            id: 'B001',
            name: 'deploybot',
            profile: { real_name: 'Deploy Bot', display_name: 'deploybot' },
            is_bot: true,
            deleted: false,
          },
        ],
        response_metadata: {},
      }));

    const result = await slackActions.execute('slack.list_users', {}, actionContext());

    expect(result).toEqual({
      success: true,
      data: {
        total: 2,
        members: [
          {
            id: 'U001',
            name: 'ana',
            real_name: 'Ana Active',
            display_name: 'Ana',
            email: undefined,
          },
          {
            id: 'U999',
            name: 'richard',
            real_name: 'Richard Pringle',
            display_name: 'Richard',
            email: undefined,
            deleted: true,
          },
        ],
      },
    });
    expect(mocks.slackGet).toHaveBeenNthCalledWith(1, 'users.list', 'xoxb-token', { limit: 200 });
    expect(mocks.slackGet).toHaveBeenNthCalledWith(2, 'users.list', 'xoxb-token', { limit: 200, cursor: 'cursor-2' });
  });

  it('filters users by handle, real name, display name, and email', async () => {
    mocks.slackGet
      .mockResolvedValueOnce(slackResponse({
        members: [
          {
            id: 'U001',
            name: 'ana',
            real_name: 'Ana Active',
            profile: {
              real_name: 'Ana Active',
              display_name: 'Ana',
              email: 'ana@example.com',
            },
            is_bot: false,
            deleted: false,
          },
        ],
        response_metadata: { next_cursor: 'cursor-2' },
      }))
      .mockResolvedValueOnce(slackResponse({
        members: [
          {
            id: 'U999',
            name: 'rpringle',
            real_name: 'Richard Pringle',
            profile: {
              real_name: 'Richard Pringle',
              display_name: 'Richard',
              email: 'richard@example.com',
            },
            is_bot: false,
            deleted: false,
          },
        ],
        response_metadata: {},
      }));

    const result = await slackActions.execute('slack.list_users', { filter: 'pringle' }, actionContext());

    expect(result).toEqual({
      success: true,
      data: {
        filter: 'pringle',
        total: 1,
        members: [
          {
            id: 'U999',
            name: 'rpringle',
            real_name: 'Richard Pringle',
            display_name: 'Richard',
            email: 'richard@example.com',
          },
        ],
      },
    });
    expect(mocks.slackGet).toHaveBeenCalledTimes(2);
  });
});
