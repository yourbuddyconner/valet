// packages/plugin-slack/src/actions/channel-access.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const slackGetMock = vi.hoisted(() => vi.fn());
vi.mock('./api.js', () => ({ slackGet: slackGetMock }));

import { checkPrivateChannelAccess } from './channel-access.js';

function mockSlackResponse(data: Record<string, unknown>) {
  return { ok: true, json: () => Promise.resolve({ ok: true, ...data }) };
}

function mockSlackError(error: string) {
  return { ok: true, json: () => Promise.resolve({ ok: false, error }) };
}

describe('checkPrivateChannelAccess', () => {
  beforeEach(() => vi.clearAllMocks());

  it('allows public channels without membership check', async () => {
    slackGetMock.mockResolvedValueOnce(
      mockSlackResponse({ channel: { id: 'C123', is_private: false, is_im: false, is_mpim: false } }),
    );

    const result = await checkPrivateChannelAccess('xoxb-token', 'C123', 'U999');
    expect(result).toEqual({ allowed: true, isPrivate: false });
    expect(slackGetMock).toHaveBeenCalledTimes(1);
    expect(slackGetMock).toHaveBeenCalledWith('conversations.info', 'xoxb-token', { channel: 'C123' });
  });

  it('allows DMs (is_im) without membership check', async () => {
    slackGetMock.mockResolvedValueOnce(
      mockSlackResponse({ channel: { id: 'D123', is_private: false, is_im: true, is_mpim: false } }),
    );

    const result = await checkPrivateChannelAccess('xoxb-token', 'D123', 'U999');
    expect(result).toEqual({ allowed: true, isPrivate: false });
    expect(slackGetMock).toHaveBeenCalledTimes(1);
  });

  it('allows group DMs (is_mpim) without membership check', async () => {
    slackGetMock.mockResolvedValueOnce(
      mockSlackResponse({ channel: { id: 'G123', is_private: false, is_im: false, is_mpim: true } }),
    );

    const result = await checkPrivateChannelAccess('xoxb-token', 'G123', 'U999');
    expect(result).toEqual({ allowed: true, isPrivate: false });
    expect(slackGetMock).toHaveBeenCalledTimes(1);
  });

  it('denies private channels when ownerSlackUserId is undefined', async () => {
    slackGetMock.mockResolvedValueOnce(
      mockSlackResponse({ channel: { id: 'C123', is_private: true, is_im: false, is_mpim: false } }),
    );

    const result = await checkPrivateChannelAccess('xoxb-token', 'C123', undefined);
    expect(result).toEqual({
      allowed: false,
      isPrivate: true,
      error: 'Owner has not linked their Slack identity. Link it in Settings > Integrations > Slack.',
    });
    expect(slackGetMock).toHaveBeenCalledTimes(1);
  });

  it('allows private channels when owner is a member', async () => {
    slackGetMock
      .mockResolvedValueOnce(
        mockSlackResponse({ channel: { id: 'C123', is_private: true, is_im: false, is_mpim: false } }),
      )
      .mockResolvedValueOnce(
        mockSlackResponse({ members: ['U001', 'U999', 'U002'], response_metadata: {} }),
      );

    const result = await checkPrivateChannelAccess('xoxb-token', 'C123', 'U999');
    expect(result).toEqual({ allowed: true, isPrivate: true });
  });

  it('denies private channels when owner is not a member', async () => {
    slackGetMock
      .mockResolvedValueOnce(
        mockSlackResponse({ channel: { id: 'C123', is_private: true, is_im: false, is_mpim: false } }),
      )
      .mockResolvedValueOnce(
        mockSlackResponse({ members: ['U001', 'U002'], response_metadata: {} }),
      );

    const result = await checkPrivateChannelAccess('xoxb-token', 'C123', 'U999');
    expect(result).toEqual({
      allowed: false,
      isPrivate: true,
      error: 'Access denied: you are not a member of this private channel',
    });
  });

  it('paginates conversations.members to find owner', async () => {
    slackGetMock
      .mockResolvedValueOnce(
        mockSlackResponse({ channel: { id: 'C123', is_private: true, is_im: false, is_mpim: false } }),
      )
      .mockResolvedValueOnce(
        mockSlackResponse({ members: ['U001', 'U002'], response_metadata: { next_cursor: 'cursor1' } }),
      )
      .mockResolvedValueOnce(
        mockSlackResponse({ members: ['U999', 'U003'], response_metadata: {} }),
      );

    const result = await checkPrivateChannelAccess('xoxb-token', 'C123', 'U999');
    expect(result).toEqual({ allowed: true, isPrivate: true });
    expect(slackGetMock).toHaveBeenCalledTimes(3);
  });

  it('handles conversations.info API error gracefully', async () => {
    slackGetMock.mockResolvedValueOnce(mockSlackError('channel_not_found'));

    const result = await checkPrivateChannelAccess('xoxb-token', 'C123', 'U999');
    expect(result).toEqual({
      allowed: false,
      isPrivate: false,
      error: 'Slack API error checking channel: channel_not_found',
    });
  });

  it('handles conversations.members API error gracefully', async () => {
    slackGetMock
      .mockResolvedValueOnce(
        mockSlackResponse({ channel: { id: 'C123', is_private: true, is_im: false, is_mpim: false } }),
      )
      .mockResolvedValueOnce(mockSlackError('not_in_channel'));

    const result = await checkPrivateChannelAccess('xoxb-token', 'C123', 'U999');
    expect(result).toEqual({
      allowed: false,
      isPrivate: true,
      error: 'Slack API error checking membership: not_in_channel',
    });
  });
});
