import { z } from 'zod';
import type { ActionDefinition, ActionSource, ActionContext, ActionResult } from '@valet/sdk';
import { slackFetch } from './api.js';

/** Build a descriptive error from a Slack API response. */
async function slackError(res: Response, data?: { ok: boolean; error?: string }): Promise<ActionResult> {
  if (data && !data.ok) return { success: false, error: `Slack API error: ${data.error || 'unknown'}` };
  return { success: false, error: `Slack API ${res.status}: ${res.statusText}` };
}

// ─── Internal Helpers ─────────────────────────────────────────────────────────

/** Resolve a channel name (e.g. "general" or "#general") to a channel ID. Returns the input if it already looks like an ID. */
async function resolveChannelId(token: string, channelOrName: string): Promise<{ id: string } | { error: string }> {
  if (channelOrName.startsWith('C') || channelOrName.startsWith('D') || channelOrName.startsWith('G')) {
    return { id: channelOrName };
  }
  const name = channelOrName.replace(/^#/, '').toLowerCase();

  // Paginate through all channels to find the match
  let cursor: string | undefined;
  do {
    const body: Record<string, unknown> = { types: 'public_channel,private_channel', limit: 200, exclude_archived: true };
    if (cursor) body.cursor = cursor;
    const res = await slackFetch('conversations.list', token, body);
    if (!res.ok) return { error: `Failed to list channels: ${res.status}` };
    const data = (await res.json()) as { ok: boolean; channels?: Array<Record<string, unknown>>; response_metadata?: { next_cursor?: string } };
    if (!data.ok) return { error: 'Failed to list channels' };

    const match = (data.channels || []).find((ch) => String(ch.name).toLowerCase() === name);
    if (match) return { id: match.id as string };

    cursor = data.response_metadata?.next_cursor || undefined;
  } while (cursor);

  return { error: `Channel "${channelOrName}" not found` };
}

/** Resolve a user name/display name to a user ID. Returns the input if it already looks like an ID. */
async function resolveUserId(token: string, userOrName: string): Promise<{ id: string } | { error: string }> {
  if (userOrName.startsWith('U') || userOrName.startsWith('W')) {
    return { id: userOrName };
  }
  const q = userOrName.replace(/^@/, '').toLowerCase();

  let cursor: string | undefined;
  do {
    const body: Record<string, unknown> = { limit: 200 };
    if (cursor) body.cursor = cursor;
    const res = await slackFetch('users.list', token, body);
    if (!res.ok) return { error: `Failed to list users: ${res.status}` };
    const data = (await res.json()) as { ok: boolean; members?: Array<Record<string, unknown>>; response_metadata?: { next_cursor?: string } };
    if (!data.ok) return { error: 'Failed to list users' };

    const match = (data.members || []).find((m) => {
      const profile = (m.profile || {}) as Record<string, unknown>;
      return String(m.name || '').toLowerCase() === q
        || String(profile.display_name || '').toLowerCase() === q
        || String(profile.real_name || '').toLowerCase() === q;
    });
    if (match) return { id: match.id as string };

    cursor = data.response_metadata?.next_cursor || undefined;
  } while (cursor);

  return { error: `User "${userOrName}" not found` };
}

/** Batch-resolve user IDs to display names. Returns a map of ID → name. */
async function resolveUserNames(token: string, userIds: string[]): Promise<Record<string, string>> {
  const unique = [...new Set(userIds)];
  const names: Record<string, string> = {};
  for (const uid of unique) {
    const res = await slackFetch('users.info', token, { user: uid });
    if (!res.ok) continue;
    const data = (await res.json()) as { ok: boolean; user?: Record<string, unknown> };
    if (!data.ok || !data.user) continue;
    const profile = (data.user.profile || {}) as Record<string, unknown>;
    names[uid] = (profile.display_name as string) || (profile.real_name as string) || (data.user.name as string) || uid;
  }
  return names;
}

// ─── Action Definitions ──────────────────────────────────────────────────────

const dmOwner: ActionDefinition = {
  id: 'slack.dm_owner',
  name: 'DM Owner',
  description: 'Send a direct message to the session owner on Slack. No user lookup needed.',
  riskLevel: 'low',
  params: z.object({
    text: z.string().describe('Message text'),
  }),
};

const dmUser: ActionDefinition = {
  id: 'slack.dm_user',
  name: 'DM User',
  description: 'Send a direct message to any Slack workspace member by name or user ID.',
  riskLevel: 'high',
  params: z.object({
    user: z.string().describe('User ID (U...) or display name / real name'),
    text: z.string().describe('Message text'),
  }),
};

const postMessage: ActionDefinition = {
  id: 'slack.post_message',
  name: 'Post Message',
  description: 'Post a message to a Slack channel by name or ID. Include thread_ts to reply in a thread.',
  riskLevel: 'high',
  params: z.object({
    channel: z.string().describe('Channel name (e.g. "general") or channel ID (C...)'),
    text: z.string().describe('Message text'),
    thread_ts: z.string().optional().describe('Thread timestamp to reply to (omit to post as a new message)'),
  }),
};

const addReaction: ActionDefinition = {
  id: 'slack.add_reaction',
  name: 'Add Reaction',
  description: 'Add an emoji reaction to a message',
  riskLevel: 'low',
  params: z.object({
    channel: z.string().describe('Channel name or ID'),
    timestamp: z.string().describe('Message timestamp'),
    name: z.string().describe('Emoji name without colons (e.g. "thumbsup")'),
  }),
};

const listChannels: ActionDefinition = {
  id: 'slack.list_channels',
  name: 'List Channels',
  description: 'List Slack channels the bot is a member of',
  riskLevel: 'low',
  params: z.object({
    name: z.string().optional().describe('Filter channels by name (substring match)'),
  }),
};

const readHistory: ActionDefinition = {
  id: 'slack.read_history',
  name: 'Read History',
  description: 'Read recent messages from a Slack channel. User IDs are resolved to display names. Each message includes its ts which can be used as thread_ts for replies.',
  riskLevel: 'low',
  params: z.object({
    channel: z.string().describe('Channel name or ID'),
    limit: z.number().int().min(1).max(100).optional().describe('Max messages (default 20)'),
  }),
};

const readThread: ActionDefinition = {
  id: 'slack.read_thread',
  name: 'Read Thread',
  description: 'Read all replies in a Slack thread. User IDs are resolved to display names.',
  riskLevel: 'low',
  params: z.object({
    channel: z.string().describe('Channel name or ID'),
    thread_ts: z.string().describe('Timestamp of the parent message'),
  }),
};

const listUsers: ActionDefinition = {
  id: 'slack.list_users',
  name: 'List Users',
  description: 'List active human users in the Slack workspace',
  riskLevel: 'low',
  params: z.object({
    name: z.string().optional().describe('Filter users by name (substring match)'),
  }),
};

const allActions: ActionDefinition[] = [
  dmOwner,
  dmUser,
  postMessage,
  addReaction,
  listChannels,
  readHistory,
  readThread,
  listUsers,
];

// ─── Response Helpers ─────────────────────────────────────────────────────────

/** Slim a Slack user object down to essential fields. */
function slimUser(u: Record<string, unknown>): Record<string, unknown> {
  const profile = (u.profile || {}) as Record<string, unknown>;
  return {
    id: u.id,
    name: u.name,
    real_name: profile.real_name || u.real_name,
    display_name: profile.display_name || undefined,
    email: profile.email || undefined,
  };
}

/** Slim a Slack channel object down to essential fields. */
function slimChannel(ch: Record<string, unknown>): Record<string, unknown> {
  const topic = (ch.topic || {}) as Record<string, unknown>;
  const purpose = (ch.purpose || {}) as Record<string, unknown>;
  return {
    id: ch.id,
    name: ch.name,
    is_private: ch.is_private,
    num_members: ch.num_members,
    topic: topic.value || undefined,
    purpose: purpose.value || undefined,
  };
}

/** Slim a Slack message, replacing the user ID with a display name if available. */
function slimMessage(msg: Record<string, unknown>, userNames: Record<string, string>): Record<string, unknown> {
  const uid = msg.user as string | undefined;
  return {
    user: uid ? (userNames[uid] || uid) : undefined,
    text: msg.text,
    ts: msg.ts,
    thread_ts: msg.thread_ts || undefined,
    reply_count: msg.reply_count || undefined,
  };
}

/** Helper to open a DM and send a message. */
async function openAndSendDM(token: string, userId: string, text: string): Promise<ActionResult> {
  const openRes = await slackFetch('conversations.open', token, { users: userId });
  if (!openRes.ok) return slackError(openRes);
  const openData = (await openRes.json()) as { ok: boolean; error?: string; channel?: { id?: string } };
  if (!openData.ok || !openData.channel?.id) return slackError(openRes, openData);

  const res = await slackFetch('chat.postMessage', token, { channel: openData.channel.id, text });
  if (!res.ok) return slackError(res);
  const data = (await res.json()) as { ok: boolean; error?: string; ts?: string; channel?: string };
  if (!data.ok) return slackError(res, data);

  return { success: true, data: { ts: data.ts, channel: data.channel } };
}

// ─── Action Execution ────────────────────────────────────────────────────────

async function executeAction(
  actionId: string,
  params: unknown,
  ctx: ActionContext,
): Promise<ActionResult> {
  const token = ctx.credentials.bot_token || '';
  if (!token) return { success: false, error: 'Missing bot_token' };

  try {
    switch (actionId) {
      case 'slack.dm_owner': {
        const p = dmOwner.params.parse(params);
        const ownerSlackId = ctx.credentials.owner_slack_user_id;
        if (!ownerSlackId) return { success: false, error: 'Owner has not linked their Slack identity. Ask them to link it in Settings > Integrations > Slack.' };
        return openAndSendDM(token, ownerSlackId, p.text);
      }

      case 'slack.dm_user': {
        const p = dmUser.params.parse(params);
        const resolved = await resolveUserId(token, p.user);
        if ('error' in resolved) return { success: false, error: resolved.error };
        return openAndSendDM(token, resolved.id, p.text);
      }

      case 'slack.post_message': {
        const p = postMessage.params.parse(params);
        const resolved = await resolveChannelId(token, p.channel);
        if ('error' in resolved) return { success: false, error: resolved.error };

        const body: Record<string, unknown> = { channel: resolved.id, text: p.text };
        if (p.thread_ts) body.thread_ts = p.thread_ts;

        const res = await slackFetch('chat.postMessage', token, body);
        if (!res.ok) return slackError(res);
        const data = (await res.json()) as { ok: boolean; error?: string; ts?: string; channel?: string };
        if (!data.ok) return slackError(res, data);

        return { success: true, data: { ts: data.ts, channel: data.channel } };
      }

      case 'slack.add_reaction': {
        const p = addReaction.params.parse(params);
        const resolved = await resolveChannelId(token, p.channel);
        if ('error' in resolved) return { success: false, error: resolved.error };

        const res = await slackFetch('reactions.add', token, {
          channel: resolved.id,
          timestamp: p.timestamp,
          name: p.name,
        });
        if (!res.ok) return slackError(res);
        const data = (await res.json()) as { ok: boolean; error?: string };
        if (!data.ok) return slackError(res, data);

        return { success: true, data: { channel: resolved.id, timestamp: p.timestamp, name: p.name } };
      }

      case 'slack.list_channels': {
        const p = listChannels.params.parse(params);
        const allChannels: Record<string, unknown>[] = [];
        let cursor: string | undefined;

        // Paginate through all pages to ensure name filter doesn't miss results
        do {
          const body: Record<string, unknown> = { types: 'public_channel,private_channel', limit: 200, exclude_archived: true };
          if (cursor) body.cursor = cursor;

          const res = await slackFetch('conversations.list', token, body);
          if (!res.ok) return slackError(res);
          const data = (await res.json()) as { ok: boolean; error?: string; channels?: unknown[]; response_metadata?: { next_cursor?: string } };
          if (!data.ok) return slackError(res, data);

          const page = (data.channels || [])
            .map((ch) => ch as Record<string, unknown>)
            .filter((ch) => ch.is_member);
          allChannels.push(...page);

          cursor = data.response_metadata?.next_cursor || undefined;
        } while (cursor);

        let channels = allChannels.map(slimChannel);
        if (p.name) {
          const q = p.name.toLowerCase();
          channels = channels.filter((ch) => String(ch.name || '').toLowerCase().includes(q));
        }

        return { success: true, data: { channels } };
      }

      case 'slack.read_history': {
        const p = readHistory.params.parse(params);
        const resolved = await resolveChannelId(token, p.channel);
        if ('error' in resolved) return { success: false, error: resolved.error };

        const res = await slackFetch('conversations.history', token, {
          channel: resolved.id,
          limit: p.limit || 20,
        });
        if (!res.ok) return slackError(res);
        const data = (await res.json()) as { ok: boolean; error?: string; messages?: unknown[]; has_more?: boolean };
        if (!data.ok) return slackError(res, data);

        const rawMessages = (data.messages || []) as Record<string, unknown>[];
        const userIds = rawMessages.map((m) => m.user as string).filter(Boolean);
        const userNames = await resolveUserNames(token, userIds);
        const messages = rawMessages.map((m) => slimMessage(m, userNames));

        return { success: true, data: { messages, has_more: data.has_more } };
      }

      case 'slack.read_thread': {
        const p = readThread.params.parse(params);
        const resolved = await resolveChannelId(token, p.channel);
        if ('error' in resolved) return { success: false, error: resolved.error };

        const res = await slackFetch('conversations.replies', token, {
          channel: resolved.id,
          ts: p.thread_ts,
          limit: 100,
        });
        if (!res.ok) return slackError(res);
        const data = (await res.json()) as { ok: boolean; error?: string; messages?: unknown[]; has_more?: boolean };
        if (!data.ok) return slackError(res, data);

        const rawMessages = (data.messages || []) as Record<string, unknown>[];
        const userIds = rawMessages.map((m) => m.user as string).filter(Boolean);
        const userNames = await resolveUserNames(token, userIds);
        const messages = rawMessages.map((m) => slimMessage(m, userNames));

        return { success: true, data: { messages, has_more: data.has_more } };
      }

      case 'slack.list_users': {
        const p = listUsers.params.parse(params);
        const allMembers: Record<string, unknown>[] = [];
        let cursor: string | undefined;

        do {
          const body: Record<string, unknown> = { limit: 200 };
          if (cursor) body.cursor = cursor;

          const res = await slackFetch('users.list', token, body);
          if (!res.ok) return slackError(res);
          const data = (await res.json()) as { ok: boolean; error?: string; members?: unknown[]; response_metadata?: { next_cursor?: string } };
          if (!data.ok) return slackError(res, data);

          const page = (data.members || [])
            .map((m) => m as Record<string, unknown>)
            .filter((m) => !m.is_bot && !m.deleted);
          allMembers.push(...page);

          cursor = data.response_metadata?.next_cursor || undefined;
        } while (cursor);

        let members = allMembers.map(slimUser);
        if (p.name) {
          const q = p.name.toLowerCase();
          members = members.filter((m) =>
            String(m.name || '').toLowerCase().includes(q)
            || String(m.real_name || '').toLowerCase().includes(q)
            || String(m.display_name || '').toLowerCase().includes(q),
          );
        }

        return { success: true, data: { members } };
      }

      default:
        return { success: false, error: `Unknown action: ${actionId}` };
    }
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

// ─── Export ──────────────────────────────────────────────────────────────────

export const slackActions: ActionSource = {
  listActions: () => allActions,
  execute: executeAction,
};
