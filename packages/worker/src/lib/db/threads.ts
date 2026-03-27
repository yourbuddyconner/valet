import type { D1Database } from '@cloudflare/workers-types';
import type { SessionThread, ThreadStatus } from '@valet/shared';

// ─── Row-to-Domain Converter ────────────────────────────────────────────────

function rowToThread(row: any): SessionThread {
  return {
    id: row.id,
    sessionId: row.session_id,
    opencodeSessionId: row.opencode_session_id || undefined,
    title: row.title || undefined,
    summaryAdditions: row.summary_additions ?? 0,
    summaryDeletions: row.summary_deletions ?? 0,
    summaryFiles: row.summary_files ?? 0,
    status: (row.status as ThreadStatus) || 'active',
    messageCount: row.message_count ?? 0,
    firstMessagePreview: row.first_message_preview || undefined,
    channelType: row.channel_type || undefined,
    channelId: row.channel_id || undefined,
    createdAt: new Date(row.created_at),
    lastActiveAt: new Date(row.last_active_at),
  };
}

// ─── Thread CRUD ────────────────────────────────────────────────────────────

export async function createThread(
  db: D1Database,
  data: { id: string; sessionId: string; opencodeSessionId?: string }
): Promise<SessionThread> {
  await db
    .prepare(
      'INSERT INTO session_threads (id, session_id, opencode_session_id) VALUES (?, ?, ?)'
    )
    .bind(data.id, data.sessionId, data.opencodeSessionId || null)
    .run();

  return {
    id: data.id,
    sessionId: data.sessionId,
    opencodeSessionId: data.opencodeSessionId,
    summaryAdditions: 0,
    summaryDeletions: 0,
    summaryFiles: 0,
    status: 'active',
    messageCount: 0,
    createdAt: new Date(),
    lastActiveAt: new Date(),
  };
}

export async function getThread(
  db: D1Database,
  threadId: string
): Promise<SessionThread | null> {
  const row = await db
    .prepare('SELECT * FROM session_threads WHERE id = ?')
    .bind(threadId)
    .first();

  return row ? rowToThread(row) : null;
}

export async function getActiveThread(
  db: D1Database,
  sessionId: string
): Promise<SessionThread | null> {
  const row = await db
    .prepare(
      "SELECT * FROM session_threads WHERE session_id = ? AND status = 'active' ORDER BY last_active_at DESC LIMIT 1"
    )
    .bind(sessionId)
    .first();

  return row ? rowToThread(row) : null;
}

export async function listThreads(
  db: D1Database,
  sessionId: string,
  options: { cursor?: string; limit?: number; status?: string; userId?: string } = {}
): Promise<{ threads: SessionThread[]; cursor?: string; hasMore: boolean }> {
  const limit = options.limit || 20;

  // When userId is provided, list threads across ALL orchestrator sessions for
  // this user so that thread history survives orchestrator session rotation.
  const crossSession = !!options.userId;

  let query = `
    SELECT t.*,
      (SELECT SUBSTR(m.content, 1, 120)
       FROM messages m
       WHERE m.thread_id = t.id AND m.role = 'user'
       ORDER BY m.created_at ASC
       LIMIT 1
      ) as first_message_preview,
      ctm.channel_type,
      ctm.channel_id
    FROM session_threads t
    LEFT JOIN (
      SELECT DISTINCT thread_id, channel_type, channel_id
      FROM channel_thread_mappings
    ) ctm ON ctm.thread_id = t.id`;

  const params: (string | number)[] = [];

  if (crossSession) {
    query += `
    WHERE t.session_id IN (
      SELECT id FROM sessions
      WHERE user_id = ? AND purpose = 'orchestrator'
    )`;
    params.push(options.userId!);
  } else {
    query += `
    WHERE t.session_id = ?`;
    params.push(sessionId);
  }

  if (options.status) {
    query += ' AND t.status = ?';
    params.push(options.status);
  }

  if (options.cursor) {
    query += ' AND t.last_active_at < ?';
    params.push(options.cursor);
  }

  query += ' ORDER BY t.last_active_at DESC LIMIT ?';
  params.push(limit + 1);

  const result = await db.prepare(query).bind(...params).all();
  const rows = result.results || [];

  const hasMore = rows.length > limit;
  const pageRows = rows.slice(0, limit);

  const threads = pageRows.map((row: any) => rowToThread(row));

  return {
    threads,
    cursor: hasMore
      ? String((pageRows[pageRows.length - 1] as any).last_active_at)
      : undefined,
    hasMore,
  };
}

export async function updateThread(
  db: D1Database,
  threadId: string,
  updates: Partial<{
    title: string;
    opencodeSessionId: string;
    summaryAdditions: number;
    summaryDeletions: number;
    summaryFiles: number;
    status: ThreadStatus;
    messageCount: number;
  }>
): Promise<void> {
  const setClauses: string[] = [];
  const params: (string | number)[] = [];

  if (updates.title !== undefined) {
    setClauses.push('title = ?');
    params.push(updates.title);
  }
  if (updates.opencodeSessionId !== undefined) {
    setClauses.push('opencode_session_id = ?');
    params.push(updates.opencodeSessionId);
  }
  if (updates.summaryAdditions !== undefined) {
    setClauses.push('summary_additions = ?');
    params.push(updates.summaryAdditions);
  }
  if (updates.summaryDeletions !== undefined) {
    setClauses.push('summary_deletions = ?');
    params.push(updates.summaryDeletions);
  }
  if (updates.summaryFiles !== undefined) {
    setClauses.push('summary_files = ?');
    params.push(updates.summaryFiles);
  }
  if (updates.status !== undefined) {
    setClauses.push('status = ?');
    params.push(updates.status);
  }
  if (updates.messageCount !== undefined) {
    setClauses.push('message_count = ?');
    params.push(updates.messageCount);
  }

  if (setClauses.length === 0) return;

  // Always update last_active_at
  setClauses.push("last_active_at = datetime('now')");

  params.push(threadId);

  await db
    .prepare(
      `UPDATE session_threads SET ${setClauses.join(', ')} WHERE id = ?`
    )
    .bind(...params)
    .run();
}

export async function updateThreadStatus(
  db: D1Database,
  threadId: string,
  status: ThreadStatus
): Promise<void> {
  await db
    .prepare('UPDATE session_threads SET status = ? WHERE id = ?')
    .bind(status, threadId)
    .run();
}

/**
 * Increment the message count for a thread and return the new count.
 */
export async function incrementThreadMessageCount(
  db: D1Database,
  threadId: string
): Promise<number> {
  await db
    .prepare(
      "UPDATE session_threads SET message_count = message_count + 1, last_active_at = datetime('now') WHERE id = ?"
    )
    .bind(threadId)
    .run();
  // D1 doesn't support RETURNING — read back the new count
  const row = await db
    .prepare('SELECT message_count FROM session_threads WHERE id = ?')
    .bind(threadId)
    .first();
  return (row?.message_count as number) ?? 0;
}
