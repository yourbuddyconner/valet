import { z } from 'zod';
import type { ActionDefinition, ActionSource, ActionContext, ActionResult } from '@valet/sdk';
import { slackFetch } from './api.js';

/** Build a descriptive error from a Slack API response. */
async function slackError(res: Response, data?: { ok: boolean; error?: string }): Promise<ActionResult> {
  if (data && !data.ok) return { success: false, error: `Slack API error: ${data.error || 'unknown'}` };
  return { success: false, error: `Slack API ${res.status}: ${res.statusText}` };
}

// ─── Action Definitions ──────────────────────────────────────────────────────

const listChannels: ActionDefinition = {
  id: 'slack.list_channels',
  name: 'List Channels',
  description: 'List Slack channels in the workspace',
  riskLevel: 'low',
  params: z.object({
    types: z.string().optional().describe('Comma-separated channel types: public_channel, private_channel, mpim, im'),
    limit: z.number().int().min(1).max(1000).optional().describe('Max results (default 200)'),
    cursor: z.string().optional().describe('Pagination cursor'),
    exclude_archived: z.boolean().optional().describe('Exclude archived channels (default true)'),
  }),
};

const getChannelInfo: ActionDefinition = {
  id: 'slack.get_channel_info',
  name: 'Get Channel Info',
  description: 'Get detailed information about a Slack channel',
  riskLevel: 'low',
  params: z.object({
    channel: z.string().describe('Channel ID'),
  }),
};

const readHistory: ActionDefinition = {
  id: 'slack.read_history',
  name: 'Read History',
  description: 'Read message history from a Slack channel',
  riskLevel: 'low',
  params: z.object({
    channel: z.string().describe('Channel ID'),
    limit: z.number().int().min(1).max(1000).optional().describe('Max messages (default 20)'),
    oldest: z.string().optional().describe('Start of time range (Unix ts)'),
    latest: z.string().optional().describe('End of time range (Unix ts)'),
    cursor: z.string().optional().describe('Pagination cursor'),
  }),
};

const postMessage: ActionDefinition = {
  id: 'slack.post_message',
  name: 'Post Message',
  description: 'Post a message to a Slack channel',
  riskLevel: 'high',
  params: z.object({
    channel: z.string().describe('Channel ID'),
    text: z.string().describe('Message text'),
    unfurl_links: z.boolean().optional(),
    unfurl_media: z.boolean().optional(),
  }),
};

const replyToThread: ActionDefinition = {
  id: 'slack.reply_to_thread',
  name: 'Reply to Thread',
  description: 'Reply to a specific message thread in Slack',
  riskLevel: 'high',
  params: z.object({
    channel: z.string().describe('Channel ID'),
    thread_ts: z.string().describe('Thread timestamp to reply to'),
    text: z.string().describe('Reply text'),
  }),
};

const addReaction: ActionDefinition = {
  id: 'slack.add_reaction',
  name: 'Add Reaction',
  description: 'Add an emoji reaction to a message',
  riskLevel: 'low',
  params: z.object({
    channel: z.string().describe('Channel ID'),
    timestamp: z.string().describe('Message timestamp'),
    name: z.string().describe('Emoji name without colons (e.g. "thumbsup")'),
  }),
};

const listUsers: ActionDefinition = {
  id: 'slack.list_users',
  name: 'List Users',
  description: 'List users in the Slack workspace',
  riskLevel: 'low',
  params: z.object({
    limit: z.number().int().min(1).max(1000).optional().describe('Max results (default 200)'),
    cursor: z.string().optional().describe('Pagination cursor'),
  }),
};

const getUserInfo: ActionDefinition = {
  id: 'slack.get_user_info',
  name: 'Get User Info',
  description: 'Get profile information for a Slack user',
  riskLevel: 'low',
  params: z.object({
    user: z.string().describe('User ID'),
  }),
};

const allActions: ActionDefinition[] = [
  listChannels,
  getChannelInfo,
  readHistory,
  postMessage,
  replyToThread,
  addReaction,
  listUsers,
  getUserInfo,
];

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
      case 'slack.list_channels': {
        const p = listChannels.params.parse(params);
        const body: Record<string, unknown> = {
          types: p.types || 'public_channel,private_channel',
          limit: p.limit || 200,
          exclude_archived: p.exclude_archived ?? true,
        };
        if (p.cursor) body.cursor = p.cursor;

        const res = await slackFetch('conversations.list', token, body);
        if (!res.ok) return slackError(res);
        const data = (await res.json()) as { ok: boolean; error?: string; channels?: unknown[]; response_metadata?: { next_cursor?: string } };
        if (!data.ok) return slackError(res, data);

        return { success: true, data: { channels: data.channels, next_cursor: data.response_metadata?.next_cursor } };
      }

      case 'slack.get_channel_info': {
        const { channel } = getChannelInfo.params.parse(params);
        const res = await slackFetch('conversations.info', token, { channel });
        if (!res.ok) return slackError(res);
        const data = (await res.json()) as { ok: boolean; error?: string; channel?: unknown };
        if (!data.ok) return slackError(res, data);

        return { success: true, data: data.channel };
      }

      case 'slack.read_history': {
        const p = readHistory.params.parse(params);
        const body: Record<string, unknown> = {
          channel: p.channel,
          limit: p.limit || 20,
        };
        if (p.oldest) body.oldest = p.oldest;
        if (p.latest) body.latest = p.latest;
        if (p.cursor) body.cursor = p.cursor;

        const res = await slackFetch('conversations.history', token, body);
        if (!res.ok) return slackError(res);
        const data = (await res.json()) as { ok: boolean; error?: string; messages?: unknown[]; has_more?: boolean; response_metadata?: { next_cursor?: string } };
        if (!data.ok) return slackError(res, data);

        return { success: true, data: { messages: data.messages, has_more: data.has_more, next_cursor: data.response_metadata?.next_cursor } };
      }

      case 'slack.post_message': {
        const p = postMessage.params.parse(params);
        const body: Record<string, unknown> = {
          channel: p.channel,
          text: p.text,
        };
        if (p.unfurl_links !== undefined) body.unfurl_links = p.unfurl_links;
        if (p.unfurl_media !== undefined) body.unfurl_media = p.unfurl_media;

        const res = await slackFetch('chat.postMessage', token, body);
        if (!res.ok) return slackError(res);
        const data = (await res.json()) as { ok: boolean; error?: string; ts?: string; channel?: string };
        if (!data.ok) return slackError(res, data);

        return { success: true, data: { ts: data.ts, channel: data.channel } };
      }

      case 'slack.reply_to_thread': {
        const p = replyToThread.params.parse(params);
        const res = await slackFetch('chat.postMessage', token, {
          channel: p.channel,
          thread_ts: p.thread_ts,
          text: p.text,
        });
        if (!res.ok) return slackError(res);
        const data = (await res.json()) as { ok: boolean; error?: string; ts?: string; channel?: string };
        if (!data.ok) return slackError(res, data);

        return { success: true, data: { ts: data.ts, channel: data.channel } };
      }

      case 'slack.add_reaction': {
        const p = addReaction.params.parse(params);
        const res = await slackFetch('reactions.add', token, {
          channel: p.channel,
          timestamp: p.timestamp,
          name: p.name,
        });
        if (!res.ok) return slackError(res);
        const data = (await res.json()) as { ok: boolean; error?: string };
        if (!data.ok) return slackError(res, data);

        return { success: true };
      }

      case 'slack.list_users': {
        const p = listUsers.params.parse(params);
        const body: Record<string, unknown> = { limit: p.limit || 200 };
        if (p.cursor) body.cursor = p.cursor;

        const res = await slackFetch('users.list', token, body);
        if (!res.ok) return slackError(res);
        const data = (await res.json()) as { ok: boolean; error?: string; members?: unknown[]; response_metadata?: { next_cursor?: string } };
        if (!data.ok) return slackError(res, data);

        return { success: true, data: { members: data.members, next_cursor: data.response_metadata?.next_cursor } };
      }

      case 'slack.get_user_info': {
        const { user } = getUserInfo.params.parse(params);
        const res = await slackFetch('users.info', token, { user });
        if (!res.ok) return slackError(res);
        const data = (await res.json()) as { ok: boolean; error?: string; user?: unknown };
        if (!data.ok) return slackError(res, data);

        return { success: true, data: data.user };
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
