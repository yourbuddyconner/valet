import { z } from 'zod';
import type { ActionDefinition, ActionSource, ActionContext, ActionResult } from '@valet/sdk';
import { slackFetch, slackGet } from './api.js';
import { checkPrivateChannelAccess } from './channel-access.js';
import { buildContentBlocks, SLACK_TEXT_LIMIT } from '../message-chunking.js';

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
  description: 'Read recent messages from a Slack channel the bot has joined. Use list_channels to get channel IDs. Each message ts can be used as thread_ts for replies. Use oldest/latest to narrow to a time window.',
  riskLevel: 'low',
  params: z.object({
    channel: z.string().describe('Channel ID (C...)'),
    limit: z.number().int().min(1).max(200).optional().describe('Max messages per page (default 100, max 200)'),
    cursor: z.string().optional().describe('Pagination cursor from a previous response\'s next_cursor'),
    oldest: z.string().optional().describe('Only messages after this Unix ts (e.g. "1774000000.000000"). Inclusive.'),
    latest: z.string().optional().describe('Only messages before this Unix ts. Inclusive. Defaults to now.'),
    filter: z.string().optional().describe('Case-insensitive keyword filter applied client-side. Only messages whose text contains this substring are returned. Pagination still advances through all messages — use has_more/next_cursor to continue.'),
    threads_only: z.boolean().optional().describe('When true, only return messages that have thread replies (reply_count > 0). Useful for finding discussions in noisy alert channels.'),
  }),
};

const readThread: ActionDefinition = {
  id: 'slack.read_thread',
  name: 'Read Thread',
  description: 'Read replies in a Slack thread. Bot must be a member of the channel.',
  riskLevel: 'low',
  params: z.object({
    channel: z.string().describe('Channel ID (C...)'),
    thread_ts: z.string().describe('Timestamp of the parent message'),
    limit: z.number().int().min(1).max(200).optional().describe('Max replies per page (default 100, max 200)'),
    cursor: z.string().optional().describe('Pagination cursor from a previous response\'s next_cursor'),
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
  addReaction,
  listChannels,
  readHistory,
  readThread,
  listUsers,
];

// ─── Slack Entity Resolution ────────────────────────────────────────────────

const SLACK_USER_MENTION_RE = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g;
const SLACK_CHANNEL_MENTION_RE = /<#([C][A-Z0-9]+)(?:\|([^>]*))?>/g;

/** Module-level caches — survive across requests within a worker isolate. */
const userCache = new Map<string, string>();
const channelCache = new Map<string, string>();
const botCache = new Map<string, string>();

function formatUserDisplay(uid: string, user: Record<string, unknown>): string {
  const profile = (user.profile || {}) as Record<string, unknown>;
  const handle = ((profile.display_name as string) || (user.name as string) || uid);
  const realName = ((profile.real_name as string) || (user.real_name as string) || '');
  if (realName && realName !== handle) {
    return `@${handle} <${realName}> (${uid})`;
  }
  return `@${handle} (${uid})`;
}

/** Resolve all Slack entity references in messages — users, channels, bots.
 *  Adds `user_display` / `bot_display` fields and resolves mentions in text. Raw IDs are preserved. */
async function resolveAndEnrichMessages(token: string, messages: Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
  // Collect IDs to resolve
  const userIds = new Set<string>();
  const channelIds = new Set<string>();
  const botIds = new Set<string>();

  for (const msg of messages) {
    if (typeof msg.user === 'string' && /^[UW]/.test(msg.user)) userIds.add(msg.user);
    if (typeof msg.bot_id === 'string') botIds.add(msg.bot_id as string);
    if (typeof msg.text === 'string') {
      for (const m of msg.text.matchAll(SLACK_USER_MENTION_RE)) userIds.add(m[1]);
      for (const m of msg.text.matchAll(SLACK_CHANNEL_MENTION_RE)) {
        // If the label is already present (e.g. <#C123|general>), cache it directly
        if (m[2]) {
          channelCache.set(m[1], `#${m[2]}`);
        } else {
          channelIds.add(m[1]);
        }
      }
    }
  }

  // Fetch uncached entities in parallel
  const fetches: Promise<void>[] = [];

  for (const uid of userIds) {
    if (userCache.has(uid)) continue;
    fetches.push(
      slackGet('users.info', token, { user: uid }).then(async (res) => {
        if (!res.ok) return;
        const data = (await res.json()) as { ok: boolean; user?: Record<string, unknown> };
        if (data.ok && data.user) userCache.set(uid, formatUserDisplay(uid, data.user));
      }).catch(() => {}),
    );
  }

  for (const cid of channelIds) {
    if (channelCache.has(cid)) continue;
    fetches.push(
      slackGet('conversations.info', token, { channel: cid }).then(async (res) => {
        if (!res.ok) return;
        const data = (await res.json()) as { ok: boolean; channel?: Record<string, unknown> };
        if (data.ok && data.channel) channelCache.set(cid, `#${data.channel.name} (${cid})`);
      }).catch(() => {}),
    );
  }

  for (const bid of botIds) {
    if (botCache.has(bid)) continue;
    fetches.push(
      slackGet('bots.info', token, { bot: bid }).then(async (res) => {
        if (!res.ok) return;
        const data = (await res.json()) as { ok: boolean; bot?: Record<string, unknown> };
        if (data.ok && data.bot) botCache.set(bid, (data.bot.name as string) || bid);
      }).catch(() => {}),
    );
  }

  if (fetches.length > 0) await Promise.all(fetches);

  // Enrich messages from caches
  return messages.map((msg) => {
    const enriched = { ...msg };

    if (typeof msg.user === 'string') {
      const display = userCache.get(msg.user);
      if (display) enriched.user_display = display;
    }

    if (typeof msg.bot_id === 'string') {
      const name = botCache.get(msg.bot_id as string);
      if (name) enriched.bot_display = name;
    }

    if (typeof msg.text === 'string') {
      let text = msg.text as string;
      text = text.replace(SLACK_USER_MENTION_RE, (_match, uid: string) => {
        return userCache.get(uid) || `@${uid}`;
      });
      text = text.replace(SLACK_CHANNEL_MENTION_RE, (_match, cid: string, label?: string) => {
        return channelCache.get(cid) || (label ? `#${label}` : `#${cid}`);
      });
      enriched.text = text;
    }

    return enriched;
  });
}

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
  const reply_count = typeof msg.reply_count === 'number' ? msg.reply_count : undefined;
  return {
    user: msg.user,
    // bot_id present (without user) = message posted by a bot/integration
    bot_id: msg.bot_id || undefined,
    text: msg.text,
    ts: msg.ts,
    // thread_ts present + different from ts = this is a reply surfaced into the channel
    thread_ts: msg.thread_ts || undefined,
    // reply_count > 0 = this message is a thread parent with replies (worth reading via read_thread)
    reply_count,
    reply_users_count: reply_count !== undefined
      ? (typeof msg.reply_users_count === 'number' ? msg.reply_users_count : undefined)
      : undefined,
  };
}

/** Helper to open a DM and send a message. Long texts use markdown blocks
 *  (which render tables natively) to stay in a single API call. */
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

  // For long messages, use blocks so Slack doesn't split into separate threads.
  // Prefers markdown blocks (native table/formatting support), falls back to
  // section blocks for very long messages (> 12K).
  if (text.length > SLACK_TEXT_LIMIT) {
    body.blocks = buildContentBlocks(text, text);
    body.text = text.slice(0, SLACK_TEXT_LIMIT); // notification fallback
  }

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
        const query: Record<string, unknown> = {
          channel: p.channel,
          limit: p.limit || 100,
        };
        if (p.cursor) query.cursor = p.cursor;
        if (p.oldest) query.oldest = p.oldest;
        if (p.latest) query.latest = p.latest;
        if (p.oldest || p.latest) query.inclusive = true;
        const res = await slackGet('conversations.history', token, query);
        if (!res.ok) return slackError(res);
        const data = (await res.json()) as { ok: boolean; error?: string; messages?: unknown[]; has_more?: boolean; response_metadata?: { next_cursor?: string } };
        if (!data.ok) return slackError(res, data);

        let messages = (data.messages || []).map((m) => slimMessage(m as Record<string, unknown>));
        const fetched = messages.length;
        if (p.filter) {
          const kw = p.filter.toLowerCase();
          messages = messages.filter((m) => typeof m.text === 'string' && m.text.toLowerCase().includes(kw));
        }
        if (p.threads_only) {
          messages = messages.filter((m) => typeof m.reply_count === 'number' && m.reply_count > 0);
        }

        messages = await resolveAndEnrichMessages(token, messages);

        const next_cursor = data.response_metadata?.next_cursor || undefined;
        const filtered = p.filter || p.threads_only;
        // Put pagination metadata first — large message arrays may be truncated by tool output limits
        return { success: true, data: { has_more: data.has_more, next_cursor, ...(filtered ? { fetched } : {}), total: messages.length, messages } };
      }

      case 'slack.read_thread': {
        const p = readThread.params.parse(params);
        const denied = await guardPrivateChannel(token, p.channel, ctx);
        if (denied) return denied;
        const query: Record<string, unknown> = {
          channel: p.channel,
          ts: p.thread_ts,
          limit: p.limit || 100,
        };
        if (p.cursor) query.cursor = p.cursor;
        const res = await slackGet('conversations.replies', token, query);
        if (!res.ok) return slackError(res);
        const data = (await res.json()) as { ok: boolean; error?: string; messages?: unknown[]; has_more?: boolean; response_metadata?: { next_cursor?: string } };
        if (!data.ok) return slackError(res, data);

        const messages = await resolveAndEnrichMessages(
          token,
          (data.messages || []).map((m) => slimMessage(m as Record<string, unknown>)),
        );

        const next_cursor = data.response_metadata?.next_cursor || undefined;
        return { success: true, data: { has_more: data.has_more, next_cursor, total: messages.length, messages } };
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
