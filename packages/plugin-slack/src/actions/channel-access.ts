import { slackGet } from './api.js';

export interface ChannelAccessResult {
  allowed: boolean;
  isPrivate: boolean;
  error?: string;
}

/**
 * Check if a user has access to a Slack channel.
 * Public channels, DMs, and group DMs are always allowed.
 * Private channels require the user to be a member (via conversations.members).
 *
 * NOTE: Org orchestrators may need an exemption here in the future,
 * since they aren't tied to a single user.
 */
export async function checkPrivateChannelAccess(
  token: string,
  channelId: string,
  ownerSlackUserId: string | undefined,
): Promise<ChannelAccessResult> {
  // 1. Get channel info
  const infoRes = await slackGet('conversations.info', token, { channel: channelId });
  const infoData = (await infoRes.json()) as {
    ok: boolean;
    error?: string;
    channel?: { is_private?: boolean; is_im?: boolean; is_mpim?: boolean };
  };

  if (!infoData.ok) {
    return { allowed: false, isPrivate: false, error: `Slack API error checking channel: ${infoData.error}` };
  }

  const channel = infoData.channel;
  if (!channel) {
    return { allowed: false, isPrivate: false, error: 'Slack API error checking channel: no channel data' };
  }

  // 2. DMs and group DMs are always allowed
  if (channel.is_im || channel.is_mpim) {
    return { allowed: true, isPrivate: false };
  }

  // 3. Public channels are always allowed
  if (!channel.is_private) {
    return { allowed: true, isPrivate: false };
  }

  // 4. Private channel — need owner's Slack identity
  if (!ownerSlackUserId) {
    return {
      allowed: false,
      isPrivate: true,
      error: 'Owner has not linked their Slack identity. Link it in Settings > Integrations > Slack.',
    };
  }

  // 5. Check membership via paginated conversations.members
  let cursor: string | undefined;
  do {
    const params: Record<string, unknown> = { channel: channelId, limit: 200 };
    if (cursor) params.cursor = cursor;

    const membersRes = await slackGet('conversations.members', token, params);
    const membersData = (await membersRes.json()) as {
      ok: boolean;
      error?: string;
      members?: string[];
      response_metadata?: { next_cursor?: string };
    };

    if (!membersData.ok) {
      return { allowed: false, isPrivate: true, error: `Slack API error checking membership: ${membersData.error}` };
    }

    if (membersData.members?.includes(ownerSlackUserId)) {
      return { allowed: true, isPrivate: true };
    }

    cursor = membersData.response_metadata?.next_cursor || undefined;
  } while (cursor);

  return {
    allowed: false,
    isPrivate: true,
    error: 'Access denied: you are not a member of this private channel',
  };
}
