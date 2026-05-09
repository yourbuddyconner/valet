import type { D1Database } from '@cloudflare/workers-types';
import { createThread } from './threads.js';

/**
 * Look up an existing channel→thread mapping.
 * Returns the orchestrator thread ID if found, null otherwise.
 */
export async function getChannelThreadMapping(
  db: D1Database,
  channelType: string,
  channelId: string,
  externalThreadId: string,
  userId: string,
): Promise<{ threadId: string; sessionId: string; lastSeenTs: string | null } | null> {
  const row = await db
    .prepare(
      'SELECT thread_id, session_id, last_seen_ts FROM channel_thread_mappings WHERE channel_type = ? AND channel_id = ? AND external_thread_id = ? AND user_id = ?'
    )
    .bind(channelType, channelId, externalThreadId, userId)
    .first();

  if (!row) return null;
  return {
    threadId: row.thread_id as string,
    sessionId: row.session_id as string,
    lastSeenTs: row.last_seen_ts as string | null,
  };
}

/**
 * Resolve an external channel thread to an orchestrator thread.
 * Creates the orchestrator thread + mapping if none exists.
 *
 * Race-safe: uses INSERT OR IGNORE on the unique index so concurrent callers
 * don't fail. The loser's optimistically-created session_thread is cleaned up.
 *
 * This is channel-agnostic: Slack passes thread_ts, Discord passes thread snowflake,
 * Telegram passes '_root', etc.
 */
export async function getOrCreateChannelThread(
  db: D1Database,
  params: {
    channelType: string;
    channelId: string;
    externalThreadId: string;
    sessionId: string;
    userId: string;
  },
): Promise<string> {
  // Fast path: existing mapping
  const existing = await getChannelThreadMapping(
    db,
    params.channelType,
    params.channelId,
    params.externalThreadId,
    params.userId,
  );
  if (existing) {
    if (existing.sessionId === params.sessionId) {
      // Mapping matches current session — reuse it
      // Auto-reactivate if the thread was archived (no-op for active threads)
      await db
        .prepare(
          "UPDATE session_threads SET status = 'active', last_active_at = datetime('now') WHERE id = ? AND status = 'archived'"
        )
        .bind(existing.threadId)
        .run();
      return existing.threadId;
    }
    // Stale mapping from a previous session (e.g., orchestrator was reset).
    // Delete it so we can create a fresh mapping for the current session.
    await db
      .prepare(
        'DELETE FROM channel_thread_mappings WHERE channel_type = ? AND channel_id = ? AND external_thread_id = ? AND user_id = ?'
      )
      .bind(params.channelType, params.channelId, params.externalThreadId, params.userId)
      .run();
  }

  // Create orchestrator thread optimistically
  const threadId = crypto.randomUUID();
  await createThread(db, { id: threadId, sessionId: params.sessionId });

  // Insert mapping with INSERT OR IGNORE to handle concurrent racers.
  // The unique index on (channel_type, channel_id, external_thread_id, user_id)
  // ensures only the first writer wins per user; the second silently no-ops.
  const mappingId = crypto.randomUUID();
  await db
    .prepare(
      'INSERT OR IGNORE INTO channel_thread_mappings (id, session_id, thread_id, channel_type, channel_id, external_thread_id, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .bind(
      mappingId,
      params.sessionId,
      threadId,
      params.channelType,
      params.channelId,
      params.externalThreadId,
      params.userId,
    )
    .run();

  // Read back the winner — may be ours or a concurrent racer's
  const winner = await getChannelThreadMapping(
    db,
    params.channelType,
    params.channelId,
    params.externalThreadId,
    params.userId,
  );

  // If we lost the race, clean up our orphaned thread
  if (winner && winner.threadId !== threadId) {
    await db.prepare('DELETE FROM session_threads WHERE id = ?').bind(threadId).run();
  }

  // Defensive: if winner is null (concurrent delete between INSERT and SELECT),
  // clean up the orphaned thread and return our threadId as a best-effort fallback.
  if (!winner) {
    console.error('[getOrCreateChannelThread] Winner lookup returned null after INSERT — cleaning up orphan and returning optimistic threadId');
    await db.prepare('DELETE FROM session_threads WHERE id = ?').bind(threadId).run();
    return threadId;
  }

  return winner.threadId;
}

/**
 * Update the last-seen cursor for a user's thread mapping.
 */
export async function updateThreadCursor(
  db: D1Database,
  channelType: string,
  channelId: string,
  externalThreadId: string,
  userId: string,
  lastSeenTs: string,
): Promise<void> {
  await db
    .prepare(
      'UPDATE channel_thread_mappings SET last_seen_ts = ? WHERE channel_type = ? AND channel_id = ? AND external_thread_id = ? AND user_id = ?'
    )
    .bind(lastSeenTs, channelType, channelId, externalThreadId, userId)
    .run();
}

/**
 * Reverse lookup: given an internal threadId, return the origin channel
 * (the channel that first created this thread). Returns the earliest mapping.
 *
 * The returned `channelId` is in the composite format expected by SessionAgentDO
 * (e.g., `C123:thread_ts` for Slack) so it can be used directly as
 * `pendingChannelReply.channelId` and parsed by `parseSlackChannelId`.
 */
export async function getThreadOriginChannel(
  db: D1Database,
  threadId: string,
): Promise<{ channelType: string; channelId: string } | null> {
  const row = await db
    .prepare(
      'SELECT channel_type, channel_id, external_thread_id FROM channel_thread_mappings WHERE thread_id = ? ORDER BY created_at ASC LIMIT 1'
    )
    .bind(threadId)
    .first();

  if (!row) return null;
  const channelId = row.channel_id as string;
  const externalThreadId = row.external_thread_id as string | null;
  return {
    channelType: row.channel_type as string,
    // Reconstruct composite channelId (e.g., C123:thread_ts) for Slack threading.
    // Only Slack uses this composite format — other channels (Telegram, etc.) store
    // externalThreadId but don't use it as part of the channelId.
    channelId: (row.channel_type === 'slack' && externalThreadId)
      ? `${channelId}:${externalThreadId}`
      : channelId,
  };
}
