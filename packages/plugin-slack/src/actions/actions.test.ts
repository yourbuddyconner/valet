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
import { SLACK_TEXT_LIMIT } from '../message-chunking.js';

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

  it('serializes usergroup channel fields as comma-separated Slack API strings', async () => {
    mocks.slackFetch.mockResolvedValueOnce(slackResponse({
      usergroup: {
        id: 'S001',
        prefs: {
          channels: ['C001', 'C002'],
          groups: [],
        },
      },
    }));

    const result = await slackActions.execute('slack.update_usergroup', {
      usergroup: 'S001',
      channels: ['C001', ' C002 ', 'C001', ''],
      additional_channels: [],
      team_id: 'T001',
    }, actionContext());

    expect(result.success).toBe(true);
    expect(mocks.slackFetch).toHaveBeenCalledWith('usergroups.update', 'xoxb-token', {
      usergroup: 'S001',
      team_id: 'T001',
      channels: 'C001,C002',
      additional_channels: '',
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

  it('does not call Slack update when remove_usergroup_users has no membership changes', async () => {
    mocks.slackGet.mockResolvedValueOnce(slackResponse({ users: ['U001', 'U002'] }));

    const result = await slackActions.execute('slack.remove_usergroup_users', {
      usergroup: 'S001',
      users: ['U999', ' U999 ', ''],
    }, actionContext());

    expect(result).toEqual({
      success: true,
      data: {
        changed: false,
        usergroup: 'S001',
        removed: [],
        skipped: ['U999'],
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

describe('slackActions send_message', () => {
  beforeEach(() => {
    mocks.slackGet.mockReset();
    mocks.slackFetch.mockReset();
  });

  // guardPrivateChannel calls conversations.info via slackGet before posting;
  // a public channel passes the guard so the chat.postMessage body can be asserted.
  function mockPublicChannel(): void {
    mocks.slackGet.mockResolvedValueOnce(slackResponse({ channel: { is_private: false } }));
  }

  it('does not set unfurl flags when the params are omitted', async () => {
    mockPublicChannel();
    mocks.slackFetch.mockResolvedValueOnce(slackResponse({ ts: '1780887543.189519', channel: 'C001' }));

    const result = await slackActions.execute('slack.send_message', {
      channel: 'C001',
      text: 'hello',
    }, actionContext());

    expect(result).toEqual({
      success: true,
      data: { ok: true, ts: '1780887543.189519', channel: 'C001' },
    });
    const body = mocks.slackFetch.mock.calls[0][2] as Record<string, unknown>;
    expect(body).toEqual({ channel: 'C001', text: 'hello' });
    expect(body).not.toHaveProperty('unfurl_links');
    expect(body).not.toHaveProperty('unfurl_media');
  });

  it('forwards unfurl_links=false to chat.postMessage to suppress link embeds', async () => {
    mockPublicChannel();
    mocks.slackFetch.mockResolvedValueOnce(slackResponse({ ts: '1780887543.189519', channel: 'C001' }));

    await slackActions.execute('slack.send_message', {
      channel: 'C001',
      text: 'VALET-123 https://linear.app/acme/issue/VALET-123',
      unfurl_links: false,
      unfurl_media: false,
    }, actionContext());

    expect(mocks.slackFetch).toHaveBeenCalledWith('chat.postMessage', 'xoxb-token', {
      channel: 'C001',
      text: 'VALET-123 https://linear.app/acme/issue/VALET-123',
      unfurl_links: false,
      unfurl_media: false,
    });
  });

  it('forwards unfurl_links=true when explicitly requested', async () => {
    mockPublicChannel();
    mocks.slackFetch.mockResolvedValueOnce(slackResponse({ ts: '1780887543.189519', channel: 'C001' }));

    await slackActions.execute('slack.send_message', {
      channel: 'C001',
      text: 'check this out https://example.com',
      unfurl_links: true,
    }, actionContext());

    const body = mocks.slackFetch.mock.calls[0][2] as Record<string, unknown>;
    expect(body.unfurl_links).toBe(true);
    expect(body).not.toHaveProperty('unfurl_media');
  });
});

describe('slackActions update_message', () => {
  beforeEach(() => {
    mocks.slackGet.mockReset();
    mocks.slackFetch.mockReset();
  });

  function mockPublicChannel(): void {
    mocks.slackGet.mockResolvedValueOnce(slackResponse({ channel: { is_private: false } }));
  }

  it('edits via chat.update and clears blocks so short text fully replaces block-formatted content', async () => {
    mockPublicChannel();
    mocks.slackFetch.mockResolvedValueOnce(slackResponse({ ts: '1780887543.189519', channel: 'C001', text: 'fixed' }));

    const result = await slackActions.execute('slack.update_message', {
      channel: 'C001',
      ts: '1780887543.189519',
      text: 'fixed',
    }, actionContext());

    expect(mocks.slackFetch).toHaveBeenCalledWith('chat.update', 'xoxb-token', {
      channel: 'C001',
      ts: '1780887543.189519',
      text: 'fixed',
      blocks: [],
    });
    expect(result).toEqual({
      success: true,
      data: { ok: true, ts: '1780887543.189519', channel: 'C001', text: 'fixed' },
    });
  });

  it('chunks long replacement text into blocks with a truncated notification fallback', async () => {
    mockPublicChannel();
    mocks.slackFetch.mockResolvedValueOnce(slackResponse({ ts: '1780887543.189519', channel: 'C001' }));

    const longText = 'x'.repeat(SLACK_TEXT_LIMIT + 100);
    await slackActions.execute('slack.update_message', {
      channel: 'C001',
      ts: '1780887543.189519',
      text: longText,
    }, actionContext());

    const body = mocks.slackFetch.mock.calls[0][2] as Record<string, unknown>;
    expect(Array.isArray(body.blocks)).toBe(true);
    expect((body.blocks as unknown[]).length).toBeGreaterThan(0);
    expect(body.text).toBe(longText.slice(0, SLACK_TEXT_LIMIT));
  });

  it('maps cant_update_message to an own-messages-only error', async () => {
    mockPublicChannel();
    mocks.slackFetch.mockResolvedValueOnce(slackFailure('cant_update_message'));

    const result = await slackActions.execute('slack.update_message', {
      channel: 'C001',
      ts: '1780887543.189519',
      text: 'nope',
    }, actionContext());

    expect(result.success).toBe(false);
    expect(result.error).toContain('can only edit its own messages');
  });

  it('denies private channels without a linked owner identity before calling chat.update', async () => {
    mocks.slackGet.mockResolvedValueOnce(slackResponse({ channel: { is_private: true } }));

    const result = await slackActions.execute('slack.update_message', {
      channel: 'C0PRIVATE',
      ts: '1780887543.189519',
      text: 'edit',
    }, actionContext());

    expect(result.success).toBe(false);
    expect(mocks.slackFetch).not.toHaveBeenCalled();
  });
});

describe('slackActions delete_message', () => {
  beforeEach(() => {
    mocks.slackGet.mockReset();
    mocks.slackFetch.mockReset();
  });

  function mockPublicChannel(): void {
    mocks.slackGet.mockResolvedValueOnce(slackResponse({ channel: { is_private: false } }));
  }

  it('deletes via chat.delete and returns the deleted ts/channel', async () => {
    mockPublicChannel();
    mocks.slackFetch.mockResolvedValueOnce(slackResponse({ ts: '1780887543.189519', channel: 'C001' }));

    const result = await slackActions.execute('slack.delete_message', {
      channel: 'C001',
      ts: '1780887543.189519',
    }, actionContext());

    expect(mocks.slackFetch).toHaveBeenCalledWith('chat.delete', 'xoxb-token', {
      channel: 'C001',
      ts: '1780887543.189519',
    });
    expect(result).toEqual({
      success: true,
      data: { ok: true, ts: '1780887543.189519', channel: 'C001' },
    });
  });

  it('maps cant_delete_message to an own-messages-only error', async () => {
    mockPublicChannel();
    mocks.slackFetch.mockResolvedValueOnce(slackFailure('cant_delete_message'));

    const result = await slackActions.execute('slack.delete_message', {
      channel: 'C001',
      ts: '1780887543.189519',
    }, actionContext());

    expect(result.success).toBe(false);
    expect(result.error).toContain('can only delete its own messages');
  });

  it('denies private channels without a linked owner identity before calling chat.delete', async () => {
    mocks.slackGet.mockResolvedValueOnce(slackResponse({ channel: { is_private: true } }));

    const result = await slackActions.execute('slack.delete_message', {
      channel: 'C0PRIVATE',
      ts: '1780887543.189519',
    }, actionContext());

    expect(result.success).toBe(false);
    expect(mocks.slackFetch).not.toHaveBeenCalled();
  });
});
