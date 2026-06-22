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

function slackFailure(error: string): Response {
  return new Response(JSON.stringify({ ok: false, error }), { status: 200 });
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

describe('slackActions usergroups', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lists usergroups with counts by default and slims Slack metadata', async () => {
    mocks.slackGet.mockResolvedValueOnce(slackResponse({
      usergroups: [
        {
          id: 'S001',
          team_id: 'T001',
          name: 'Database On-call',
          handle: 'db-oncall',
          description: 'Current database responders',
          is_disabled: false,
          date_update: 1774000000,
          user_count: '2',
          users: ['U001', 'U002'],
        },
      ],
    }));

    const result = await slackActions.execute('slack.list_usergroups', { include_users: true }, actionContext());

    expect(result).toEqual({
      success: true,
      data: {
        total: 1,
        usergroups: [
          {
            id: 'S001',
            team_id: 'T001',
            name: 'Database On-call',
            handle: 'db-oncall',
            description: 'Current database responders',
            is_disabled: false,
            date_update: 1774000000,
            user_count: 2,
            users: ['U001', 'U002'],
          },
        ],
      },
    });
    expect(mocks.slackGet).toHaveBeenCalledWith('usergroups.list', 'xoxb-token', {
      include_count: true,
      include_users: true,
    });
  });

  it('lists users in a usergroup', async () => {
    mocks.slackGet.mockResolvedValueOnce(slackResponse({ users: ['U001', 'U002'] }));

    const result = await slackActions.execute('slack.list_usergroup_users', { usergroup: 'S001' }, actionContext());

    expect(result).toEqual({
      success: true,
      data: {
        usergroup: 'S001',
        total: 2,
        users: ['U001', 'U002'],
      },
    });
    expect(mocks.slackGet).toHaveBeenCalledWith('usergroups.users.list', 'xoxb-token', { usergroup: 'S001' });
  });

  it('updates usergroup metadata and requires at least one editable field', async () => {
    const missingFields = await slackActions.execute('slack.update_usergroup', { usergroup: 'S001' }, actionContext());
    expect(missingFields).toEqual({
      success: false,
      error: 'Provide at least one usergroup field to update',
    });

    mocks.slackFetch.mockResolvedValueOnce(slackResponse({
      usergroup: {
        id: 'S001',
        team_id: 'T001',
        name: 'SME On-call',
        handle: 'sme-oncall',
        description: 'Current SME responder',
        user_count: 1,
      },
    }));

    const result = await slackActions.execute('slack.update_usergroup', {
      usergroup: 'S001',
      name: 'SME On-call',
      handle: 'sme-oncall',
      description: 'Current SME responder',
    }, actionContext());

    expect(result).toEqual({
      success: true,
      data: {
        usergroup: {
          id: 'S001',
          team_id: 'T001',
          name: 'SME On-call',
          handle: 'sme-oncall',
          description: 'Current SME responder',
          user_count: 1,
        },
      },
    });
    expect(mocks.slackFetch).toHaveBeenCalledWith('usergroups.update', 'xoxb-token', {
      usergroup: 'S001',
      name: 'SME On-call',
      handle: 'sme-oncall',
      description: 'Current SME responder',
    });
  });

  it('adds users idempotently by unioning with current members', async () => {
    mocks.slackGet.mockResolvedValueOnce(slackResponse({ users: ['U001', 'U002'] }));
    mocks.slackFetch.mockResolvedValueOnce(slackResponse({
      usergroup: {
        id: 'S001',
        users: ['U001', 'U002', 'U003'],
        user_count: 3,
      },
    }));

    const result = await slackActions.execute('slack.add_usergroup_users', {
      usergroup: 'S001',
      users: ['U002', 'U003', 'U003'],
    }, actionContext());

    expect(result).toEqual({
      success: true,
      data: {
        changed: true,
        usergroup: 'S001',
        added: ['U003'],
        skipped: ['U002'],
        users: ['U001', 'U002', 'U003'],
        slack_usergroup: {
          id: 'S001',
          users: ['U001', 'U002', 'U003'],
          user_count: 3,
        },
      },
    });
    expect(mocks.slackGet).toHaveBeenCalledWith('usergroups.users.list', 'xoxb-token', { usergroup: 'S001' });
    expect(mocks.slackFetch).toHaveBeenCalledWith('usergroups.users.update', 'xoxb-token', {
      usergroup: 'S001',
      users: ['U001', 'U002', 'U003'],
    });
  });

  it('does not call Slack update when add_usergroup_users has no membership changes', async () => {
    mocks.slackGet.mockResolvedValueOnce(slackResponse({ users: ['U001', 'U002'] }));

    const result = await slackActions.execute('slack.add_usergroup_users', {
      usergroup: 'S001',
      users: ['U002'],
    }, actionContext());

    expect(result).toEqual({
      success: true,
      data: {
        changed: false,
        usergroup: 'S001',
        added: [],
        skipped: ['U002'],
        users: ['U001', 'U002'],
      },
    });
    expect(mocks.slackFetch).not.toHaveBeenCalled();
  });

  it('removes users idempotently and refuses to empty a usergroup', async () => {
    mocks.slackGet.mockResolvedValueOnce(slackResponse({ users: ['U001', 'U002', 'U003'] }));
    mocks.slackFetch.mockResolvedValueOnce(slackResponse({
      usergroup: {
        id: 'S001',
        users: ['U001', 'U003'],
        user_count: 2,
      },
    }));

    const result = await slackActions.execute('slack.remove_usergroup_users', {
      usergroup: 'S001',
      users: ['U002', 'U999'],
    }, actionContext());

    expect(result).toEqual({
      success: true,
      data: {
        changed: true,
        usergroup: 'S001',
        removed: ['U002'],
        skipped: ['U999'],
        users: ['U001', 'U003'],
        slack_usergroup: {
          id: 'S001',
          users: ['U001', 'U003'],
          user_count: 2,
        },
      },
    });
    expect(mocks.slackFetch).toHaveBeenCalledWith('usergroups.users.update', 'xoxb-token', {
      usergroup: 'S001',
      users: ['U001', 'U003'],
    });

    vi.clearAllMocks();
    mocks.slackGet.mockResolvedValueOnce(slackResponse({ users: ['U001'] }));

    const emptyResult = await slackActions.execute('slack.remove_usergroup_users', {
      usergroup: 'S001',
      users: ['U001'],
    }, actionContext());

    expect(emptyResult).toEqual({
      success: false,
      error: 'Cannot remove all users from a Slack user group; disable the user group in Slack instead',
    });
    expect(mocks.slackFetch).not.toHaveBeenCalled();
  });

  it('returns Slack API errors from membership reads before attempting updates', async () => {
    mocks.slackGet.mockResolvedValueOnce(slackFailure('missing_scope'));

    const result = await slackActions.execute('slack.add_usergroup_users', {
      usergroup: 'S001',
      users: ['U001'],
    }, actionContext());

    expect(result).toEqual({
      success: false,
      error: 'Slack API error: missing_scope',
    });
    expect(mocks.slackFetch).not.toHaveBeenCalled();
  });
});
