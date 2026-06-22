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

// ─── Timestamp Helpers ───────────────────────────────────────────────────────

/**
 * Convert an ISO-8601 datetime string or Unix timestamp to Slack's epoch format.
 * Pass-through values that already look like Unix timestamps (digits with optional decimal).
 * Throws on unparseable input so the caller can return an actionable error.
 */
export function resolveToSlackTimestamp(input: string): string {
  const trimmed = input.trim();
  // Already a Unix timestamp (e.g. "1774000000" or "1774000000.000000")
  if (/^\d+(\.\d+)?$/.test(trimmed)) return trimmed;
  // Try parsing as a date string (ISO-8601, date-only, etc.)
  const date = new Date(trimmed);
  if (isNaN(date.getTime())) {
    throw new Error(`Cannot parse timestamp "${trimmed}" — use ISO-8601 (e.g. "2026-05-19T00:00:00Z") or Unix seconds`);
  }
  return (date.getTime() / 1000).toFixed(6);
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
    oldest: z.string().optional().describe('Only messages after this time. Accepts ISO-8601 datetime (e.g. "2026-05-19T00:00:00-07:00") or Unix timestamp (e.g. "1774000000.000000"). Include a timezone offset for date-boundary accuracy — bare dates like "2026-05-19" resolve to midnight UTC. Inclusive.'),
    latest: z.string().optional().describe('Only messages before this time. Accepts ISO-8601 datetime (with timezone offset) or Unix timestamp. Inclusive. Defaults to now.'),
    filter: z.string().optional().describe('Case-insensitive keyword filter applied client-side. Only messages whose text contains this substring are returned. Pagination still advances through all messages — use has_more/next_cursor to continue.'),
    threads_only: z.boolean().optional().describe('When true, only return messages that have thread replies (reply_count > 0). Useful for finding discussions in noisy alert channels.'),
    include_subtypes: z.boolean().optional().describe(
      'When true, include system messages (joins, topic changes, etc.). Default false — only human/bot conversation.'
    ),
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
  description: 'List human users in the Slack workspace. Returns user IDs needed for dm_user. Use filter to search by ID, handle, real name, display name, or email.',
  riskLevel: 'low',
  params: z.object({
    filter: z.string().optional().describe('Case-insensitive search over user ID, handle, real name, display name, and email. Use this to avoid dumping the full user list.'),
  }),
};

const listUsergroups: ActionDefinition = {
  id: 'slack.list_usergroups',
  name: 'List User Groups',
  description: 'List Slack user groups. Use include_users only when membership IDs are needed because it can return a large result.',
  riskLevel: 'low',
  params: z.object({
    include_disabled: z.boolean().optional().describe('Include disabled user groups. Default false.'),
    include_users: z.boolean().optional().describe('Include member user IDs for each user group. Default false.'),
    include_count: z.boolean().optional().describe('Include member counts. Default true.'),
    team_id: z.string().optional().describe('Encoded team ID. Required only when using an org-level token.'),
  }),
};

const listUsergroupUsers: ActionDefinition = {
  id: 'slack.list_usergroup_users',
  name: 'List User Group Users',
  description: 'List user IDs in a Slack user group. Use list_users to resolve IDs to names if needed.',
  riskLevel: 'low',
  params: z.object({
    usergroup: z.string().min(1).describe('User group ID (S...)'),
    include_disabled: z.boolean().optional().describe('Allow listing users for disabled user groups. Default false.'),
    team_id: z.string().optional().describe('Encoded team ID. Required only when using an org-level token.'),
  }),
};

const updateUsergroup: ActionDefinition = {
  id: 'slack.update_usergroup',
  name: 'Update User Group',
  description: 'Update Slack user group metadata such as name, handle, description, or default channels. Use add_usergroup_users/remove_usergroup_users for membership changes.',
  riskLevel: 'high',
  params: z.object({
    usergroup: z.string().min(1).describe('User group ID (S...)'),
    name: z.string().optional().describe('New user group name. Must be unique among user groups.'),
    handle: z.string().optional().describe('New mention handle without @. Must be unique among channels, users, and user groups.'),
    description: z.string().optional().describe('Short user group description. Pass an empty string to clear it.'),
    channels: z.array(z.string()).optional().describe('Default channel IDs for this user group. Pass an empty array to clear defaults.'),
    additional_channels: z.array(z.string()).optional().describe('Additional channel IDs where members can add the user group. Pass an empty array to clear.'),
    enable_section: z.boolean().optional().describe('Show this user group as a sidebar section for all group members. Requires at least one default channel.'),
    team_id: z.string().optional().describe('Encoded team ID. Required only when using an org-level token.'),
  }),
};

const addUsergroupUsers: ActionDefinition = {
  id: 'slack.add_usergroup_users',
  name: 'Add User Group Users',
  description: 'Idempotently add users to a Slack user group. Existing members are skipped; Slack is only updated when membership changes. This wraps Slack\'s replace-all membership API, so avoid concurrent membership updates to the same user group.',
  riskLevel: 'high',
  params: z.object({
    usergroup: z.string().min(1).describe('User group ID (S...)'),
    users: z.array(z.string()).min(1).describe('Slack user IDs (U... or W...) to add'),
    team_id: z.string().optional().describe('Encoded team ID. Required only when using an org-level token.'),
  }),
};

const removeUsergroupUsers: ActionDefinition = {
  id: 'slack.remove_usergroup_users',
  name: 'Remove User Group Users',
  description: 'Idempotently remove users from a Slack user group. Missing members are skipped. Refuses to remove the final member because Slack requires disabling the group instead. This wraps Slack\'s replace-all membership API, so avoid concurrent membership updates to the same user group.',
  riskLevel: 'high',
  params: z.object({
    usergroup: z.string().min(1).describe('User group ID (S...)'),
    users: z.array(z.string()).min(1).describe('Slack user IDs (U... or W...) to remove'),
    team_id: z.string().optional().describe('Encoded team ID. Required only when using an org-level token.'),
  }),
};

const fetchFile: ActionDefinition = {
  id: 'slack.fetch_file',
  name: 'Fetch File',
  description: 'Download a file from Slack. For images, the content is returned visually so you can see it. For text files, the content is returned as text. Use the url from the files array in message data. IMPORTANT: Call this tool one at a time, not in parallel — each image fetch interrupts the session to deliver the image to your vision.',
  riskLevel: 'low',
  params: z.object({
    url: z.string().describe('Slack file URL (from the files array in message data)'),
  }),
};

const getPins: ActionDefinition = {
  id: 'slack.get_pins',
  name: 'Get Pins',
  description: 'Get pinned messages in a channel. Returns messages in the same format as read_history. Useful for understanding what a channel considers important.',
  riskLevel: 'low',
  params: z.object({
    channel: z.string().describe('Channel ID (C...)'),
  }),
};

const getChannelInfo: ActionDefinition = {
  id: 'slack.get_channel_info',
  name: 'Get Channel Info',
  description: 'Get detailed information about a channel: topic, purpose, member count, creation date, creator. Useful when reading a channel for the first time — save the context to memory so you do not re-fetch.',
  riskLevel: 'low',
  params: z.object({
    channel: z.string().describe('Channel ID (C...)'),
  }),
};

const getReactions: ActionDefinition = {
  id: 'slack.get_reactions',
  name: 'Get Reactions',
  description: 'Get reactions on a specific message with who reacted. Note: Slack may not return all reactors — count is always accurate but the users list can be truncated on popular messages.',
  riskLevel: 'low',
  params: z.object({
    channel: z.string().describe('Channel ID (C...)'),
    timestamp: z.string().describe('Message timestamp'),
  }),
};

const sendMessage: ActionDefinition = {
  id: 'slack.send_message',
  name: 'Send Message',
  description: 'Post a message to a Slack channel or thread. Use this to send to any channel the bot has joined — for arbitrary channel posts and threaded replies. Use channel_reply instead only when replying on the specific channel a user wrote from. Returns ts (message timestamp) and channel — save ts to thread follow-up messages under this one via thread_ts.',
  riskLevel: 'medium',
  params: z.object({
    channel: z.string().describe('Channel ID (C...) or channel name with # prefix (e.g. #proj-valet). Use list_channels to find IDs.'),
    text: z.string().describe('Message body. Supports Slack mrkdwn formatting (bold: *text*, italic: _text_, code: `code`, links: <url|label>).'),
    thread_ts: z.string().optional().describe('Post as a threaded reply under an existing message. Use the ts value returned by a previous send_message call (e.g. "1780887543.189519").'),
    blocks: z.string().optional().describe('Block Kit JSON array as a string for rich formatting. When provided, text is used as the notification fallback only.'),
  }),
};

const allActions: ActionDefinition[] = [
  dmOwner,
  dmUser,
  sendMessage,
  addReaction,
  listChannels,
  readHistory,
  readThread,
  listUsers,
  listUsergroups,
  listUsergroupUsers,
  updateUsergroup,
  addUsergroupUsers,
  removeUsergroupUsers,
  fetchFile,
  getPins,
  getChannelInfo,
  getReactions,
];

const NOISE_SUBTYPES = new Set([
  'channel_join', 'channel_leave', 'channel_topic', 'channel_purpose',
  'channel_name', 'bot_add', 'bot_remove', 'channel_archive', 'channel_unarchive',
]);

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
  const user: Record<string, unknown> = {
    id: u.id,
    name: u.name,
    real_name: profile.real_name || u.real_name,
    display_name: profile.display_name || undefined,
    email: profile.email || undefined,
  };
  if (u.deleted === true) user.deleted = true;
  return user;
}

function setDefined(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined && value !== null) target[key] = value;
}

function matchesUserFilter(user: Record<string, unknown>, filter: string): boolean {
  return ['id', 'name', 'real_name', 'display_name', 'email'].some((key) => {
    const value = user[key];
    return typeof value === 'string' && value.toLowerCase().includes(filter);
  });
}

function numericUserCount(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

function normalizeStringList(values: string[]): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

function normalizeCommaSeparatedList(values: string[]): string {
  return normalizeStringList(values).join(',');
}

function slimUsergroup(group: Record<string, unknown>): Record<string, unknown> {
  const usergroup: Record<string, unknown> = {};
  setDefined(usergroup, 'id', group.id);
  setDefined(usergroup, 'team_id', group.team_id);
  setDefined(usergroup, 'name', group.name);
  setDefined(usergroup, 'handle', group.handle);
  setDefined(usergroup, 'description', group.description);
  setDefined(usergroup, 'is_disabled', group.is_disabled);
  setDefined(usergroup, 'date_create', group.date_create);
  setDefined(usergroup, 'date_update', group.date_update);
  setDefined(usergroup, 'date_delete', group.date_delete);
  setDefined(usergroup, 'auto_type', group.auto_type);
  setDefined(usergroup, 'created_by', group.created_by);
  setDefined(usergroup, 'updated_by', group.updated_by);
  setDefined(usergroup, 'deleted_by', group.deleted_by);
  setDefined(usergroup, 'prefs', group.prefs);

  const count = numericUserCount(group.user_count);
  if (count !== undefined) usergroup.user_count = count;
  if (Array.isArray(group.users)) {
    usergroup.users = group.users.filter((user): user is string => typeof user === 'string');
  }
  return usergroup;
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

  // Extract file metadata (skip deleted/tombstone files)
  const rawFiles = Array.isArray(msg.files) ? (msg.files as Record<string, unknown>[]) : [];
  const files = rawFiles
    .filter((f) => f.mode !== 'tombstone')
    .map((f) => {
      const entry: Record<string, unknown> = {
        name: f.name,
        mimetype: f.mimetype || undefined,
        size: f.size,
        url: f.url_private,
        filetype: f.filetype,
      };
      // External files (Google Docs, etc.) have non-Slack URLs that can't be fetched via fetch_file
      if (f.is_external) entry.is_external = true;
      return entry;
    });

  // Extract reaction summary (names + counts only — get_reactions has full user lists)
  const rawReactions = Array.isArray(msg.reactions) ? (msg.reactions as Record<string, unknown>[]) : [];
  const reactions = rawReactions.map((r) => ({
    name: r.name,
    count: r.count,
  }));

  return {
    user: msg.user,
    bot_id: msg.bot_id || undefined,
    subtype: msg.subtype || undefined,
    text: msg.text,
    ts: msg.ts,
    thread_ts: msg.thread_ts || undefined,
    reply_count,
    reply_users_count: reply_count !== undefined
      ? (typeof msg.reply_users_count === 'number' ? msg.reply_users_count : undefined)
      : undefined,
    files: files.length > 0 ? files : undefined,
    reactions: reactions.length > 0 ? reactions : undefined,
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

type ReadUsergroupUsersResult =
  | { ok: true; users: string[] }
  | { ok: false; result: ActionResult };

async function readUsergroupUsers(
  token: string,
  input: { usergroup: string; include_disabled?: boolean; team_id?: string },
): Promise<ReadUsergroupUsersResult> {
  const query: Record<string, unknown> = { usergroup: input.usergroup };
  if (input.include_disabled !== undefined) query.include_disabled = input.include_disabled;
  if (input.team_id) query.team_id = input.team_id;

  const res = await slackGet('usergroups.users.list', token, query);
  if (!res.ok) return { ok: false, result: await slackError(res) };
  const data = (await res.json()) as { ok: boolean; error?: string; users?: unknown[] };
  if (!data.ok) return { ok: false, result: await slackError(res, data) };

  return {
    ok: true,
    users: (data.users || []).filter((user): user is string => typeof user === 'string'),
  };
}

async function writeUsergroupUsers(
  token: string,
  input: { usergroup: string; users: string[]; team_id?: string },
): Promise<ActionResult> {
  const body: Record<string, unknown> = {
    usergroup: input.usergroup,
    users: input.users,
  };
  if (input.team_id) body.team_id = input.team_id;

  const res = await slackFetch('usergroups.users.update', token, body);
  if (!res.ok) return slackError(res);
  const data = (await res.json()) as { ok: boolean; error?: string; usergroup?: Record<string, unknown> };
  if (!data.ok) return slackError(res, data);

  return {
    success: true,
    data: data.usergroup ? slimUsergroup(data.usergroup) : undefined,
  };
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

      case 'slack.send_message': {
        const p = sendMessage.params.parse(params);

        // Resolve #name to channel ID via conversations.list
        let channelId = p.channel;
        if (p.channel.startsWith('#')) {
          const name = p.channel.slice(1).toLowerCase();
          let cursor: string | undefined;
          let found = false;
          outer: do {
            const q: Record<string, unknown> = { types: 'public_channel,private_channel', limit: 200, exclude_archived: true };
            if (cursor) q.cursor = cursor;
            const res = await slackGet('users.conversations', token, q);
            if (!res.ok) return slackError(res);
            const data = (await res.json()) as { ok: boolean; error?: string; channels?: Record<string, unknown>[]; response_metadata?: { next_cursor?: string } };
            if (!data.ok) return slackError(res, data);
            for (const ch of (data.channels || [])) {
              if (typeof ch.name === 'string' && ch.name.toLowerCase() === name) {
                channelId = ch.id as string;
                found = true;
                break outer;
              }
            }
            cursor = data.response_metadata?.next_cursor || undefined;
          } while (cursor);
          if (!found) return { success: false, error: `Channel "${p.channel}" not found or bot is not a member. Use list_channels to find available channels.` };
        }

        const denied = await guardPrivateChannel(token, channelId, ctx);
        if (denied) return denied;

        const body: Record<string, unknown> = { channel: channelId, text: p.text };
        if (p.thread_ts) body.thread_ts = p.thread_ts;

        if (p.blocks) {
          try {
            body.blocks = JSON.parse(p.blocks);
          } catch {
            return { success: false, error: 'blocks must be valid JSON' };
          }
        }

        if (ctx.callerIdentity?.name) body.username = ctx.callerIdentity.name;
        if (ctx.callerIdentity?.avatar) body.icon_url = ctx.callerIdentity.avatar;

        if (!p.blocks && p.text.length > SLACK_TEXT_LIMIT) {
          body.blocks = buildContentBlocks(p.text, p.text);
          body.text = p.text.slice(0, SLACK_TEXT_LIMIT);
        }

        const res = await slackFetch('chat.postMessage', token, body);
        if (!res.ok) return slackError(res);
        const data = (await res.json()) as { ok: boolean; error?: string; ts?: string; channel?: string };
        if (!data.ok) return slackError(res, data);

        return { success: true, data: { ok: true, ts: data.ts, channel: data.channel } };
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
        try {
          if (p.oldest) query.oldest = resolveToSlackTimestamp(p.oldest);
          if (p.latest) query.latest = resolveToSlackTimestamp(p.latest);
        } catch (err) {
          return { success: false, error: String(err instanceof Error ? err.message : err) };
        }
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
        if (!p.include_subtypes) {
          messages = messages.filter((m) => {
            const subtype = m.subtype as string | undefined;
            return !subtype || !NOISE_SUBTYPES.has(subtype);
          });
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
        const p = listUsers.params.parse(params);

        const allMembers: Record<string, unknown>[] = [];
        let cursor: string | undefined;
        do {
          const query: Record<string, unknown> = { limit: 200 };
          if (cursor) query.cursor = cursor;
          const res = await slackGet('users.list', token, query);
          if (!res.ok) return slackError(res);
          const data = (await res.json()) as {
            ok: boolean; error?: string; members?: unknown[];
            response_metadata?: { next_cursor?: string };
          };
          if (!data.ok) return slackError(res, data);
          allMembers.push(...(data.members || []).map((m) => m as Record<string, unknown>));
          cursor = data.response_metadata?.next_cursor || undefined;
        } while (cursor);

        let members = allMembers
          .filter((m) => m.is_bot !== true && m.id !== 'USLACKBOT')
          .map(slimUser);

        const filter = p.filter?.trim();
        if (filter) {
          const normalizedFilter = filter.toLowerCase();
          members = members.filter((user) => matchesUserFilter(user, normalizedFilter));
        }

        return { success: true, data: { ...(filter ? { filter } : {}), total: members.length, members } };
      }

      case 'slack.list_usergroups': {
        const p = listUsergroups.params.parse(params);
        const query: Record<string, unknown> = {
          include_count: p.include_count ?? true,
        };
        if (p.include_disabled !== undefined) query.include_disabled = p.include_disabled;
        if (p.include_users !== undefined) query.include_users = p.include_users;
        if (p.team_id) query.team_id = p.team_id;

        const res = await slackGet('usergroups.list', token, query);
        if (!res.ok) return slackError(res);
        const data = (await res.json()) as { ok: boolean; error?: string; usergroups?: unknown[] };
        if (!data.ok) return slackError(res, data);

        const usergroups = (data.usergroups || [])
          .map((group) => slimUsergroup(group as Record<string, unknown>));
        return { success: true, data: { total: usergroups.length, usergroups } };
      }

      case 'slack.list_usergroup_users': {
        const p = listUsergroupUsers.params.parse(params);
        const read = await readUsergroupUsers(token, p);
        if (!read.ok) return read.result;

        return { success: true, data: { usergroup: p.usergroup, total: read.users.length, users: read.users } };
      }

      case 'slack.update_usergroup': {
        const p = updateUsergroup.params.parse(params);
        const body: Record<string, unknown> = { usergroup: p.usergroup };
        if (p.team_id) body.team_id = p.team_id;
        if (p.name !== undefined) body.name = p.name;
        if (p.handle !== undefined) body.handle = p.handle;
        if (p.description !== undefined) body.description = p.description;
        if (p.channels !== undefined) body.channels = normalizeCommaSeparatedList(p.channels);
        if (p.additional_channels !== undefined) body.additional_channels = normalizeCommaSeparatedList(p.additional_channels);
        if (p.enable_section !== undefined) body.enable_section = p.enable_section;

        const updateKeys = Object.keys(body).filter((key) => key !== 'usergroup' && key !== 'team_id');
        if (updateKeys.length === 0) {
          return { success: false, error: 'Provide at least one usergroup field to update' };
        }

        const res = await slackFetch('usergroups.update', token, body);
        if (!res.ok) return slackError(res);
        const data = (await res.json()) as { ok: boolean; error?: string; usergroup?: Record<string, unknown> };
        if (!data.ok) return slackError(res, data);

        return { success: true, data: { usergroup: data.usergroup ? slimUsergroup(data.usergroup) : undefined } };
      }

      case 'slack.add_usergroup_users': {
        const p = addUsergroupUsers.params.parse(params);
        const requested = normalizeStringList(p.users);
        if (requested.length === 0) return { success: false, error: 'Provide at least one Slack user ID' };

        const read = await readUsergroupUsers(token, { usergroup: p.usergroup, team_id: p.team_id });
        if (!read.ok) return read.result;

        const currentUsers = read.users;
        const current = new Set(currentUsers);
        const added = requested.filter((user) => !current.has(user));
        const skipped = requested.filter((user) => current.has(user));

        if (added.length === 0) {
          return {
            success: true,
            data: { changed: false, usergroup: p.usergroup, added: [], skipped, users: currentUsers },
          };
        }

        const users = [...currentUsers, ...added];
        const update = await writeUsergroupUsers(token, { usergroup: p.usergroup, users, team_id: p.team_id });
        if (!update.success) return update;

        return {
          success: true,
          data: {
            changed: true,
            usergroup: p.usergroup,
            added,
            skipped,
            users,
            slack_usergroup: update.data,
          },
        };
      }

      case 'slack.remove_usergroup_users': {
        const p = removeUsergroupUsers.params.parse(params);
        const requested = normalizeStringList(p.users);
        if (requested.length === 0) return { success: false, error: 'Provide at least one Slack user ID' };

        const read = await readUsergroupUsers(token, { usergroup: p.usergroup, team_id: p.team_id });
        if (!read.ok) return read.result;

        const currentUsers = read.users;
        const current = new Set(currentUsers);
        const toRemove = new Set(requested);
        const removed = currentUsers.filter((user) => toRemove.has(user));
        const skipped = requested.filter((user) => !current.has(user));

        if (removed.length === 0) {
          return {
            success: true,
            data: { changed: false, usergroup: p.usergroup, removed: [], skipped, users: currentUsers },
          };
        }

        const users = currentUsers.filter((user) => !toRemove.has(user));
        if (users.length === 0) {
          return {
            success: false,
            error: 'Cannot remove all users from a Slack user group; disable the user group in Slack instead',
          };
        }

        const update = await writeUsergroupUsers(token, { usergroup: p.usergroup, users, team_id: p.team_id });
        if (!update.success) return update;

        return {
          success: true,
          data: {
            changed: true,
            usergroup: p.usergroup,
            removed,
            skipped,
            users,
            slack_usergroup: update.data,
          },
        };
      }

      case 'slack.fetch_file': {
        const p = fetchFile.params.parse(params);

        // Only allow files.slack.com URLs
        let parsedUrl: URL;
        try {
          parsedUrl = new URL(p.url);
        } catch {
          return { success: false, error: 'Invalid URL' };
        }
        if (!parsedUrl.hostname.endsWith('.slack.com')) {
          return { success: false, error: 'This is an external file (e.g. Google Docs). Open the URL directly — it cannot be fetched through Slack. Only files hosted on Slack (files.slack.com) can be downloaded.' };
        }

        const res = await fetch(p.url, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) {
          return { success: false, error: `Failed to fetch file: ${res.status} ${res.statusText}` };
        }

        const rawContentType = res.headers.get('content-type') || 'application/octet-stream';
        const contentType = rawContentType.split(';')[0].trim();
        // Images up to 1MB get broadcast to the chat UI; larger ones return metadata only
        const MAX_IMAGE_DISPLAY = 1 * 1024 * 1024;
        const MAX_IMAGE_FETCH = 10 * 1024 * 1024;
        const MAX_TEXT_SIZE = 1 * 1024 * 1024;

        // Image files — return via the images pipeline so the user can see them in the chat UI
        if (contentType.startsWith('image/')) {
          const buf = await res.arrayBuffer();
          const filename = parsedUrl.pathname.split('/').pop() || 'image';
          if (buf.byteLength > MAX_IMAGE_FETCH) {
            return { success: false, error: `Image too large (${Math.round(buf.byteLength / 1024 / 1024)}MB). Max 10MB.` };
          }
          if (buf.byteLength > MAX_IMAGE_DISPLAY) {
            return {
              success: true,
              data: { filename, mimetype: contentType, size: buf.byteLength, note: 'Image too large to display inline in chat.' },
            };
          }
          // Safe base64 encoding that doesn't hit V8's argument limit
          const bytes = new Uint8Array(buf);
          let binary = '';
          for (let i = 0; i < bytes.length; i++) {
            binary += String.fromCharCode(bytes[i]);
          }
          const base64 = btoa(binary);
          return {
            success: true,
            data: { filename, mimetype: contentType, size: buf.byteLength },
            images: [{ data: base64, mimeType: contentType, description: filename }],
          };
        }

        // Text files — return content directly
        if (contentType.startsWith('text/') || contentType === 'application/json' || contentType === 'application/xml') {
          const text = await res.text();
          if (text.length > MAX_TEXT_SIZE) {
            return { success: false, error: `File too large for text extraction (${Math.round(text.length / 1024)}KB). Max 1MB.` };
          }
          return { success: true, data: { content: text, mimetype: contentType } };
        }

        // Other file types — return metadata only
        return {
          success: true,
          data: {
            mimetype: contentType,
            note: 'File type is not viewable. Only images and text files can be fetched.',
          },
        };
      }

      case 'slack.get_pins': {
        const p = getPins.params.parse(params);
        const denied = await guardPrivateChannel(token, p.channel, ctx);
        if (denied) return denied;

        const res = await slackGet('pins.list', token, { channel: p.channel });
        if (!res.ok) return slackError(res);
        const data = (await res.json()) as { ok: boolean; error?: string; items?: unknown[] };
        if (!data.ok) return slackError(res, data);

        const items = (data.items || []).map((item) => item as Record<string, unknown>);

        // pins.list returns items with type "message", "file", or "file_comment"
        // Only message-type pins have a .message object we can slim/enrich
        const messageItems = items
          .filter((item) => item.type === 'message' && item.message)
          .map((item) => item.message as Record<string, unknown>);

        const pins = await resolveAndEnrichMessages(
          token,
          messageItems.map((m) => slimMessage(m)),
        );

        // Surface pinned files separately (name + metadata only)
        const fileItems = items
          .filter((item) => item.type === 'file' && item.file)
          .map((item) => {
            const f = item.file as Record<string, unknown>;
            return { type: 'file', name: f.name, mimetype: f.mimetype || undefined, size: f.size, url: f.url_private };
          });

        return { success: true, data: { total: pins.length + fileItems.length, pins, ...(fileItems.length > 0 ? { files: fileItems } : {}) } };
      }

      case 'slack.get_channel_info': {
        const p = getChannelInfo.params.parse(params);
        const denied = await guardPrivateChannel(token, p.channel, ctx);
        if (denied) return denied;

        const res = await slackGet('conversations.info', token, { channel: p.channel, include_num_members: true });
        if (!res.ok) return slackError(res);
        const data = (await res.json()) as { ok: boolean; error?: string; channel?: Record<string, unknown> };
        if (!data.ok) return slackError(res, data);
        const ch = data.channel;
        if (!ch) return { success: false, error: 'Channel not found' };

        // DMs and group DMs don't have topic/purpose/creator
        if (ch.is_im || ch.is_mpim) {
          return {
            success: true,
            data: {
              id: ch.id,
              is_im: ch.is_im || false,
              is_mpim: ch.is_mpim || false,
              num_members: ch.num_members,
              created: ch.created,
            },
          };
        }

        const topic = (ch.topic || {}) as Record<string, unknown>;
        const purpose = (ch.purpose || {}) as Record<string, unknown>;

        // Resolve creator through user cache
        let creatorDisplay: string | undefined;
        if (typeof ch.creator === 'string') {
          if (!userCache.has(ch.creator as string)) {
            try {
              const userRes = await slackGet('users.info', token, { user: ch.creator });
              if (userRes.ok) {
                const userData = (await userRes.json()) as { ok: boolean; user?: Record<string, unknown> };
                if (userData.ok && userData.user) {
                  userCache.set(ch.creator as string, formatUserDisplay(ch.creator as string, userData.user));
                }
              }
            } catch { /* leave unresolved */ }
          }
          creatorDisplay = userCache.get(ch.creator as string) || (ch.creator as string);
        }

        return {
          success: true,
          data: {
            id: ch.id,
            name: ch.name,
            is_private: ch.is_private || false,
            is_archived: ch.is_archived || false,
            topic: topic.value || undefined,
            purpose: purpose.value || undefined,
            num_members: ch.num_members,
            created: ch.created,
            creator: creatorDisplay,
          },
        };
      }

      case 'slack.get_reactions': {
        const p = getReactions.params.parse(params);
        const denied = await guardPrivateChannel(token, p.channel, ctx);
        if (denied) return denied;

        const res = await slackGet('reactions.get', token, {
          channel: p.channel,
          timestamp: p.timestamp,
          full: true,
        });
        if (!res.ok) return slackError(res);
        const data = (await res.json()) as { ok: boolean; error?: string; message?: Record<string, unknown> };
        if (!data.ok) return slackError(res, data);
        const msg = data.message;
        if (!msg) return { success: false, error: 'Message not found' };

        const rawReactions = Array.isArray(msg.reactions) ? (msg.reactions as Record<string, unknown>[]) : [];
        if (rawReactions.length === 0) {
          return { success: true, data: { reactions: [] } };
        }

        // Collect all user IDs across all reactions for batch resolution
        const allUserIds = new Set<string>();
        for (const r of rawReactions) {
          if (Array.isArray(r.users)) {
            for (const uid of r.users as string[]) allUserIds.add(uid);
          }
        }

        // Resolve uncached users
        const uncached = [...allUserIds].filter((uid) => !userCache.has(uid));
        if (uncached.length > 0) {
          await Promise.all(
            uncached.map(async (uid) => {
              try {
                const userRes = await slackGet('users.info', token, { user: uid });
                if (!userRes.ok) return;
                const userData = (await userRes.json()) as { ok: boolean; user?: Record<string, unknown> };
                if (userData.ok && userData.user) userCache.set(uid, formatUserDisplay(uid, userData.user));
              } catch { /* leave unresolved */ }
            }),
          );
        }

        const reactions = rawReactions.map((r) => ({
          name: r.name,
          count: r.count,
          users: (Array.isArray(r.users) ? (r.users as string[]) : []).map(
            (uid) => userCache.get(uid) || uid,
          ),
        }));

        return { success: true, data: { reactions } };
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
