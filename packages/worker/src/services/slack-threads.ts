import { getSlackUserInfo } from './slack.js';

const SLACK_API = 'https://slack.com/api';
const MAX_THREAD_MESSAGES = 200;
const MAX_DM_MESSAGES = 20;
const MAX_RETRIES = 2;

export interface ThreadContextMessage {
  ts: string;
  userId: string | null;
  username: string | null; // bot persona name (from chat.postMessage username override)
  text: string;
  files: Array<{ name: string }>;
  isBotMessage: boolean;
}

/**
 * Fetch thread replies from Slack via conversations.replies.
 * Returns up to MAX_THREAD_MESSAGES most recent messages.
 */
export async function fetchThreadReplies(
  botToken: string,
  channel: string,
  threadTs: string,
): Promise<ThreadContextMessage[]> {
  const allMessages: ThreadContextMessage[] = [];
  let cursor: string | undefined;
  let retryCount = 0;

  // Paginate through thread replies
  do {
    const params = new URLSearchParams({
      channel,
      ts: threadTs,
      limit: '200',
    });
    if (cursor) {
      params.set('cursor', cursor);
    }

    let resp: Response;
    try {
      resp = await fetch(`${SLACK_API}/conversations.replies?${params}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${botToken}` },
      });
    } catch (err) {
      console.error(`[SlackThreads] conversations.replies fetch error:`, err);
      break;
    }

    // Retry on 429 rate limit with Retry-After backoff (max 2 retries)
    if (resp.status === 429) {
      if (++retryCount > MAX_RETRIES) {
        console.error(`[SlackThreads] Rate limit retries exhausted`);
        break;
      }
      const retryAfter = Math.min(parseInt(resp.headers.get('Retry-After') || '1', 10), 5);
      console.log(`[SlackThreads] Rate limited, retrying after ${retryAfter}s (attempt ${retryCount}/${MAX_RETRIES})`);
      await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
      continue;
    }

    if (!resp.ok) {
      console.error(`[SlackThreads] conversations.replies HTTP error: status=${resp.status}`);
      break;
    }

    const result = (await resp.json()) as {
      ok: boolean;
      messages?: Array<{
        ts: string;
        user?: string;
        username?: string;
        text?: string;
        subtype?: string;
        bot_id?: string;
        files?: Array<{ name: string }>;
      }>;
      has_more?: boolean;
      response_metadata?: { next_cursor?: string };
    };

    if (!result.ok || !result.messages) break;

    for (const msg of result.messages) {
      allMessages.push({
        ts: msg.ts,
        userId: msg.user || null,
        username: msg.username || null,
        text: msg.text || '',
        files: msg.files?.map((f) => ({ name: f.name })) || [],
        isBotMessage: !!msg.bot_id || msg.subtype === 'bot_message',
      });
    }

    cursor = result.has_more ? result.response_metadata?.next_cursor : undefined;
  } while (cursor);

  // Return only the most recent MAX_THREAD_MESSAGES
  if (allMessages.length > MAX_THREAD_MESSAGES) {
    return allMessages.slice(-MAX_THREAD_MESSAGES);
  }
  return allMessages;
}

/**
 * Fetch recent channel history from a DM channel via conversations.history.
 * Returns up to MAX_DM_MESSAGES most recent messages newer than `oldest`.
 * Used for DM rehydration where we want recent messages (not thread-specific replies).
 */
export async function fetchChannelHistory(
  botToken: string,
  channel: string,
  oldest: string | null,
): Promise<ThreadContextMessage[]> {
  const allMessages: ThreadContextMessage[] = [];
  let cursor: string | undefined;
  let retryCount = 0;

  do {
    const params = new URLSearchParams({
      channel,
      limit: String(MAX_DM_MESSAGES),
    });
    if (oldest) {
      params.set('oldest', oldest);
      params.set('inclusive', 'false');
    }
    if (cursor) {
      params.set('cursor', cursor);
    }

    let resp: Response;
    try {
      resp = await fetch(`${SLACK_API}/conversations.history?${params}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${botToken}` },
      });
    } catch (err) {
      console.error(`[SlackThreads] conversations.history fetch error:`, err);
      break;
    }

    // Retry on 429 rate limit with Retry-After backoff (max 2 retries)
    if (resp.status === 429) {
      if (++retryCount > MAX_RETRIES) {
        console.error(`[SlackThreads] Rate limit retries exhausted`);
        break;
      }
      const retryAfter = Math.min(parseInt(resp.headers.get('Retry-After') || '1', 10), 5);
      console.log(`[SlackThreads] Rate limited, retrying after ${retryAfter}s (attempt ${retryCount}/${MAX_RETRIES})`);
      await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
      continue;
    }

    if (!resp.ok) {
      console.error(`[SlackThreads] conversations.history HTTP error: status=${resp.status}`);
      break;
    }

    const result = (await resp.json()) as {
      ok: boolean;
      messages?: Array<{
        ts: string;
        user?: string;
        username?: string;
        text?: string;
        subtype?: string;
        bot_id?: string;
        files?: Array<{ name: string }>;
      }>;
      has_more?: boolean;
      response_metadata?: { next_cursor?: string };
    };

    if (!result.ok || !result.messages) break;

    for (const msg of result.messages) {
      allMessages.push({
        ts: msg.ts,
        userId: msg.user || null,
        username: msg.username || null,
        text: msg.text || '',
        files: msg.files?.map((f) => ({ name: f.name })) || [],
        isBotMessage: !!msg.bot_id || msg.subtype === 'bot_message',
      });
    }

    // conversations.history returns newest-first; stop after first page
    // if we already have enough messages or there are no more
    cursor = result.has_more && allMessages.length < MAX_DM_MESSAGES
      ? result.response_metadata?.next_cursor
      : undefined;
  } while (cursor);

  // conversations.history returns newest-first, reverse to chronological order
  allMessages.reverse();

  // Cap at MAX_DM_MESSAGES (take most recent)
  if (allMessages.length > MAX_DM_MESSAGES) {
    return allMessages.slice(-MAX_DM_MESSAGES);
  }
  return allMessages;
}

/**
 * Resolve display names for a set of Slack user IDs.
 * Returns a Map of userId -> displayName.
 * Uses an in-memory cache scoped to this call to avoid redundant API requests.
 */
export async function resolveDisplayNames(
  botToken: string,
  userIds: string[],
): Promise<Map<string, string>> {
  const nameMap = new Map<string, string>();
  const uniqueIds = [...new Set(userIds)];

  // Resolve in parallel (batch of unique IDs)
  const results = await Promise.all(
    uniqueIds.map(async (uid) => {
      const profile = await getSlackUserInfo(botToken, uid);
      return { uid, name: profile?.displayName || profile?.realName || uid };
    }),
  );

  for (const { uid, name } of results) {
    nameMap.set(uid, name);
  }

  return nameMap;
}

/**
 * Convert a Slack ts (epoch.sequence) to human-readable format.
 */
function formatSlackTs(ts: string): string {
  const epochSeconds = parseFloat(ts);
  const date = new Date(epochSeconds * 1000);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

/**
 * Build a formatted thread context string from Slack thread messages.
 *
 * Fetches thread history, resolves display names, filters to messages
 * newer than the cursor, and returns a formatted context block ready
 * to prepend to the user's message.
 *
 * Returns null if there are no new context messages.
 */
export async function buildThreadContext(
  botToken: string,
  channel: string,
  threadTs: string,
  lastSeenTs: string | null,
  currentMessageTs: string,
): Promise<string | null> {
  const messages = await fetchThreadReplies(botToken, channel, threadTs);

  // Filter to messages newer than cursor (if cursor exists)
  // Exclude the current invoking message (it will be sent separately)
  const newMessages = messages.filter((msg) => {
    if (msg.ts === currentMessageTs) return false;
    if (!lastSeenTs) return true;
    return msg.ts > lastSeenTs;
  });

  if (newMessages.length === 0) return null;

  // Collect user IDs that need name resolution (skip bot messages — they use username)
  const userIdsToResolve = newMessages
    .filter((msg) => !msg.isBotMessage && msg.userId)
    .map((msg) => msg.userId!);

  const nameMap = await resolveDisplayNames(botToken, userIdsToResolve);

  // Format each message
  const lines = newMessages.map((msg) => {
    const timestamp = formatSlackTs(msg.ts);
    const displayName = msg.isBotMessage
      ? (msg.username || 'Bot')
      : (msg.userId ? nameMap.get(msg.userId) || msg.userId : 'Unknown');

    let content = msg.text;

    // FUTURE: Download images via url_private with bot token for multipart attachment
    // For now, note files as placeholders
    for (const file of msg.files) {
      content += ` [file: ${file.name}]`;
    }

    return `[${timestamp}] ${displayName}: ${content}`;
  });

  return `--- Thread context (messages you haven't seen) ---\n${lines.join('\n')}\n--- End thread context ---`;
}

/**
 * Build a formatted DM context string from recent DM channel history.
 *
 * Fetches recent messages from the DM channel, resolves display names,
 * filters to messages newer than the cursor, and returns a formatted
 * context block ready to prepend to the user's message.
 *
 * Returns null if there are no new context messages.
 */
export async function buildDmContext(
  botToken: string,
  channel: string,
  lastSeenTs: string | null,
  currentMessageTs: string,
): Promise<string | null> {
  const messages = await fetchChannelHistory(botToken, channel, lastSeenTs);

  // Exclude the current invoking message (it will be sent separately)
  const newMessages = messages.filter((msg) => msg.ts !== currentMessageTs);

  if (newMessages.length === 0) return null;

  // Collect user IDs that need name resolution (skip bot messages — they use username)
  const userIdsToResolve = newMessages
    .filter((msg) => !msg.isBotMessage && msg.userId)
    .map((msg) => msg.userId!);

  const nameMap = await resolveDisplayNames(botToken, userIdsToResolve);

  // Format each message
  const lines = newMessages.map((msg) => {
    const timestamp = formatSlackTs(msg.ts);
    const displayName = msg.isBotMessage
      ? (msg.username || 'Bot')
      : (msg.userId ? nameMap.get(msg.userId) || msg.userId : 'Unknown');

    let content = msg.text;

    for (const file of msg.files) {
      content += ` [file: ${file.name}]`;
    }

    return `[${timestamp}] ${displayName}: ${content}`;
  });

  return `--- DM context (recent messages) ---\n${lines.join('\n')}\n--- End DM context ---`;
}
