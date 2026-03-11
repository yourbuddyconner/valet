import { z } from 'zod';
import type { ActionDefinition, ActionSource, ActionContext, ActionResult } from '@valet/sdk';
import { slackFetch } from './api.js';

/** Build a descriptive error from a Slack API response. */
async function slackError(res: Response, data?: { ok: boolean; error?: string }): Promise<ActionResult> {
  if (data && !data.ok) return { success: false, error: `Slack API error: ${data.error || 'unknown'}` };
  return { success: false, error: `Slack API ${res.status}: ${res.statusText}` };
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
  description: 'Send a direct message to a Slack user by their user ID (U...). Use list_users to find IDs.',
  riskLevel: 'low',
  params: z.object({
    user: z.string().describe('User ID (U...)'),
    text: z.string().describe('Message text'),
  }),
};

const postMessage: ActionDefinition = {
  id: 'slack.post_message',
  name: 'Post Message',
  description: 'Post a message to a Slack channel. Accepts #channel-name or channel ID. Include thread_ts to reply in a thread.',
  riskLevel: 'low',
  params: z.object({
    channel: z.string().describe('Channel name (e.g. "#general" or "general") or channel ID (C...)'),
    text: z.string().describe('Message text'),
    thread_ts: z.string().optional().describe('Thread timestamp to reply to'),
  }),
};

const addReaction: ActionDefinition = {
  id: 'slack.add_reaction',
  name: 'Add Reaction',
  description: 'Add an emoji reaction to a message',
  riskLevel: 'low',
  params: z.object({
    channel: z.string().describe('Channel ID (C...)'),
    timestamp: z.string().describe('Message timestamp'),
    name: z.string().describe('Emoji name without colons (e.g. "thumbsup")'),
  }),
};

const listChannels: ActionDefinition = {
  id: 'slack.list_channels',
  name: 'List Channels',
  description: 'List Slack channels the bot is a member of. Returns channel IDs needed for read_history, read_thread, and add_reaction.',
  riskLevel: 'low',
  params: z.object({}),
};

const readHistory: ActionDefinition = {
  id: 'slack.read_history',
  name: 'Read History',
  description: 'Read recent messages from a Slack channel. Use list_channels to get the channel ID. Each message ts can be used as thread_ts for replies.',
  riskLevel: 'low',
  params: z.object({
    channel: z.string().describe('Channel ID (C...)'),
    limit: z.number().int().min(1).max(100).optional().describe('Max messages (default 20)'),
  }),
};

const readThread: ActionDefinition = {
  id: 'slack.read_thread',
  name: 'Read Thread',
  description: 'Read all replies in a Slack thread.',
  riskLevel: 'low',
  params: z.object({
    channel: z.string().describe('Channel ID (C...)'),
    thread_ts: z.string().describe('Timestamp of the parent message'),
  }),
};

const listUsers: ActionDefinition = {
  id: 'slack.list_users',
  name: 'List Users',
  description: 'List active human users in the Slack workspace. Returns user IDs needed for dm_user.',
  riskLevel: 'low',
  params: z.object({}),
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

function slimMessage(msg: Record<string, unknown>): Record<string, unknown> {
  return {
    user: msg.user,
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
        return openAndSendDM(token, p.user, p.text);
      }

      case 'slack.post_message': {
        const p = postMessage.params.parse(params);
        // Slack's chat.postMessage natively accepts #channel-name, so just pass it through.
        // Strip leading # if present — Slack wants bare name or ID.
        const channel = p.channel.replace(/^#/, '');
        const body: Record<string, unknown> = { channel, text: p.text };
        if (p.thread_ts) body.thread_ts = p.thread_ts;

        const res = await slackFetch('chat.postMessage', token, body);
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

        return { success: true, data: { channel: p.channel, timestamp: p.timestamp, name: p.name } };
      }

      case 'slack.list_channels': {
        // Single page — bot typically isn't in hundreds of channels
        const res = await slackFetch('conversations.list', token, {
          types: 'public_channel,private_channel',
          limit: 200,
          exclude_archived: true,
        });
        if (!res.ok) return slackError(res);
        const data = (await res.json()) as { ok: boolean; error?: string; channels?: unknown[] };
        if (!data.ok) return slackError(res, data);

        const channels = (data.channels || [])
          .map((ch) => ch as Record<string, unknown>)
          .filter((ch) => ch.is_member)
          .map(slimChannel);

        return { success: true, data: { channels } };
      }

      case 'slack.read_history': {
        const p = readHistory.params.parse(params);
        const res = await slackFetch('conversations.history', token, {
          channel: p.channel,
          limit: p.limit || 20,
        });
        if (!res.ok) return slackError(res);
        const data = (await res.json()) as { ok: boolean; error?: string; messages?: unknown[]; has_more?: boolean };
        if (!data.ok) return slackError(res, data);

        const messages = (data.messages || []).map((m) => slimMessage(m as Record<string, unknown>));
        return { success: true, data: { messages, has_more: data.has_more } };
      }

      case 'slack.read_thread': {
        const p = readThread.params.parse(params);
        const res = await slackFetch('conversations.replies', token, {
          channel: p.channel,
          ts: p.thread_ts,
          limit: 100,
        });
        if (!res.ok) return slackError(res);
        const data = (await res.json()) as { ok: boolean; error?: string; messages?: unknown[]; has_more?: boolean };
        if (!data.ok) return slackError(res, data);

        const messages = (data.messages || []).map((m) => slimMessage(m as Record<string, unknown>));
        return { success: true, data: { messages, has_more: data.has_more } };
      }

      case 'slack.list_users': {
        // Single page — most workspaces under 200 humans
        const res = await slackFetch('users.list', token, { limit: 200 });
        if (!res.ok) return slackError(res);
        const data = (await res.json()) as { ok: boolean; error?: string; members?: unknown[] };
        if (!data.ok) return slackError(res, data);

        const members = (data.members || [])
          .map((m) => m as Record<string, unknown>)
          .filter((m) => !m.is_bot && !m.deleted)
          .map(slimUser);

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
