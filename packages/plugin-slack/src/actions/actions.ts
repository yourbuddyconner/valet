import { z } from 'zod';
import type { ActionDefinition, ActionSource, ActionContext, ActionResult } from '@valet/sdk';
import { slackFetch, slackGet } from './api.js';
import { checkPrivateChannelAccess } from './channel-access.js';

/** Build a descriptive error from a Slack API response. */
async function slackError(res: Response, data?: { ok: boolean; error?: string }): Promise<ActionResult> {
  if (data && !data.ok) return { success: false, error: `Slack API error: ${data.error || 'unknown'}` };
  return { success: false, error: `Slack API ${res.status}: ${res.statusText}` };
}

/** Guard that checks private channel membership. Returns an error ActionResult if denied, or null if allowed. */
async function guardPrivateChannel(token: string, channelId: string, ctx: ActionContext): Promise<ActionResult | null> {
  const result = await checkPrivateChannelAccess(token, channelId, ctx.credentials.owner_slack_user_id);
  if (!result.allowed) {
    return { success: false, error: result.error || 'Access denied' };
  }
  return null;
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
  description: 'List Slack channels. By default lists only channels the bot has joined. Set scope to "all" to discover all public channels in the workspace. Use prefix to filter by channel name prefix (e.g. "eng-" or "team-").',
  riskLevel: 'low',
  params: z.object({
    scope: z.enum(['joined', 'all']).optional().describe('Which channels to list: "joined" (default) = bot member channels, "all" = all public channels'),
    prefix: z.string().optional().describe('Filter channels whose name starts with this prefix'),
  }),
};

const readHistory: ActionDefinition = {
  id: 'slack.read_history',
  name: 'Read History',
  description: 'Read recent messages from a Slack channel the bot has joined. Use list_channels to get channel IDs. Each message ts can be used as thread_ts for replies.',
  riskLevel: 'low',
  params: z.object({
    channel: z.string().describe('Channel ID (C...)'),
    limit: z.number().int().min(1).max(100).optional().describe('Max messages (default 20)'),
  }),
};

const readThread: ActionDefinition = {
  id: 'slack.read_thread',
  name: 'Read Thread',
  description: 'Read all replies in a Slack thread. Bot must be a member of the channel.',
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
async function openAndSendDM(
  token: string,
  userId: string,
  text: string,
  callerIdentity?: { name: string; avatar?: string },
): Promise<ActionResult> {
  const openRes = await slackFetch('conversations.open', token, { users: userId });
  if (!openRes.ok) return slackError(openRes);
  const openData = (await openRes.json()) as { ok: boolean; error?: string; channel?: { id?: string } };
  if (!openData.ok || !openData.channel?.id) return slackError(openRes, openData);

  const body: Record<string, unknown> = { channel: openData.channel.id, text };
  if (callerIdentity?.name) body.username = callerIdentity.name;
  if (callerIdentity?.avatar) body.icon_url = callerIdentity.avatar;

  const res = await slackFetch('chat.postMessage', token, body);
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
        return openAndSendDM(token, ownerSlackId, p.text, ctx.callerIdentity);
      }

      case 'slack.dm_user': {
        const p = dmUser.params.parse(params);
        return openAndSendDM(token, p.user, p.text, ctx.callerIdentity);
      }

      case 'slack.post_message': {
        const p = postMessage.params.parse(params);
        // Slack's chat.postMessage natively accepts #channel-name, so just pass it through.
        // Strip leading # if present — Slack wants bare name or ID.
        const channel = p.channel.replace(/^#/, '');
        // Only check channels identified by ID (C.../G...) — names resolve to public channels only
        const isChannelId = /^[CG]/.test(channel);
        if (isChannelId) {
          const denied = await guardPrivateChannel(token, channel, ctx);
          if (denied) return denied;
        }
        const body: Record<string, unknown> = { channel, text: p.text };
        if (p.thread_ts) body.thread_ts = p.thread_ts;
        if (ctx.callerIdentity?.name) body.username = ctx.callerIdentity.name;
        if (ctx.callerIdentity?.avatar) body.icon_url = ctx.callerIdentity.avatar;

        const res = await slackFetch('chat.postMessage', token, body);
        if (!res.ok) return slackError(res);
        const data = (await res.json()) as { ok: boolean; error?: string; ts?: string; channel?: string };
        if (!data.ok) return slackError(res, data);

        return { success: true, data: { ts: data.ts, channel: data.channel } };
      }

      case 'slack.add_reaction': {
        const p = addReaction.params.parse(params);
        const denied = await guardPrivateChannel(token, p.channel, ctx);
        if (denied) return denied;
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
        const p = listChannels.params.parse(params);
        const wantAll = p.scope === 'all';

        // users.conversations = only joined channels (public + private)
        // conversations.list = all visible channels (public only when scope=all)
        const method = wantAll ? 'conversations.list' : 'users.conversations';
        const types = wantAll ? 'public_channel' : 'public_channel,private_channel';

        // Paginate to collect all results (Slack caps at 200 per page)
        const allChannels: Record<string, unknown>[] = [];
        let cursor: string | undefined;
        do {
          const q: Record<string, unknown> = { types, limit: 200, exclude_archived: true };
          if (cursor) q.cursor = cursor;
          const res = await slackGet(method, token, q);
          if (!res.ok) return slackError(res);
          const data = (await res.json()) as {
            ok: boolean; error?: string; channels?: unknown[];
            response_metadata?: { next_cursor?: string };
          };
          if (!data.ok) return slackError(res, data);
          allChannels.push(...(data.channels || []).map((ch) => ch as Record<string, unknown>));
          cursor = data.response_metadata?.next_cursor || undefined;
        } while (cursor);

        let channels = allChannels.map(slimChannel);

        // Client-side prefix filter
        if (p.prefix) {
          const pfx = p.prefix.toLowerCase();
          channels = channels.filter((ch) => typeof ch.name === 'string' && ch.name.toLowerCase().startsWith(pfx));
        }

        // Filter out private channels the owner doesn't have access to
        const ownerSlackUserId = ctx.credentials.owner_slack_user_id;
        if (ownerSlackUserId) {
          const privateChannels = channels.filter((ch) => ch.is_private === true);
          if (privateChannels.length > 0) {
            const accessChecks = await Promise.all(
              privateChannels.map(async (ch) => {
                const result = await checkPrivateChannelAccess(token, ch.id as string, ownerSlackUserId);
                return { id: ch.id, allowed: result.allowed };
              }),
            );
            const deniedIds = new Set(accessChecks.filter((c) => !c.allowed).map((c) => c.id));
            channels = channels.filter((ch) => !deniedIds.has(ch.id));
          }
        } else {
          // No linked identity — filter out all private channels
          channels = channels.filter((ch) => ch.is_private !== true);
        }

        return { success: true, data: { channels, total: channels.length } };
      }

      case 'slack.read_history': {
        const p = readHistory.params.parse(params);
        const denied = await guardPrivateChannel(token, p.channel, ctx);
        if (denied) return denied;
        const res = await slackGet('conversations.history', token, {
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
        const denied = await guardPrivateChannel(token, p.channel, ctx);
        if (denied) return denied;
        const res = await slackGet('conversations.replies', token, {
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
        const res = await slackGet('users.list', token, { limit: 200 });
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
