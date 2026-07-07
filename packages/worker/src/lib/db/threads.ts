import type { D1Database } from '@cloudflare/workers-types';
import type { SessionThread, ThreadStatus } from '@valet/shared';

export interface ThreadOriginInput {
  originType?: string;
  originChannelType?: string;
  originChannelId?: string;
  originTriggerId?: string;
  originTriggerType?: string;
}

export interface CreateThreadInput extends ThreadOriginInput {
  id: string;
  sessionId: string;
  opencodeSessionId?: string;
}

interface ThreadRow {
  id: string;
  session_id: string;
  opencode_session_id?: string | null;
  origin_type?: string | null;
  origin_channel_type?: string | null;
  origin_channel_id?: string | null;
  origin_trigger_id?: string | null;
  origin_trigger_type?: string | null;
  title?: string | null;
  summary_additions?: number | null;
  summary_deletions?: number | null;
  summary_files?: number | null;
  status?: string | null;
  message_count?: number | null;
  first_message_preview?: string | null;
  channel_type?: string | null;
  channel_id?: string | null;
  created_at: string;
  last_active_at: string;
}

function normalizeThreadStatus(status?: string | null): ThreadStatus {
  return status === 'archived' ? 'archived' : 'active';
}

function isMissingOriginColumnError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  const message = error.message.toLowerCase();
  const originColumns = [
    'origin_type',
    'origin_channel_type',
    'origin_channel_id',
    'origin_trigger_id',
    'origin_trigger_type',
  ];

  return (
    originColumns.some((column) => message.includes(column)) &&
    (message.includes('no column') || message.includes('no such column'))
  );
}

// ─── Row-to-Domain Converter ────────────────────────────────────────────────

function rowToThread(row: ThreadRow): SessionThread {
  return {
    id: row.id,
    sessionId: row.session_id,
    opencodeSessionId: row.opencode_session_id || undefined,
    originType: row.origin_type || undefined,
    originChannelType: row.origin_channel_type || undefined,
    originChannelId: row.origin_channel_id || undefined,
    originTriggerId: row.origin_trigger_id || undefined,
    originTriggerType: row.origin_trigger_type || undefined,
    title: row.title ?? undefined,
    summaryAdditions: row.summary_additions ?? 0,
    summaryDeletions: row.summary_deletions ?? 0,
    summaryFiles: row.summary_files ?? 0,
    status: normalizeThreadStatus(row.status),
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
  data: CreateThreadInput
): Promise<SessionThread> {
  const originType = data.originType ?? 'web';

  try {
    await db
      .prepare(
        `INSERT INTO session_threads (
          id, session_id, opencode_session_id,
          origin_type, origin_channel_type, origin_channel_id,
          origin_trigger_id, origin_trigger_type
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        data.id,
        data.sessionId,
        data.opencodeSessionId ?? null,
        originType,
        data.originChannelType ?? null,
        data.originChannelId ?? null,
        data.originTriggerId ?? null,
        data.originTriggerType ?? null
      )
      .run();
  } catch (error) {
    if (!isMissingOriginColumnError(error)) throw error;

    await db
      .prepare('INSERT INTO session_threads (id, session_id, opencode_session_id) VALUES (?, ?, ?)')
      .bind(data.id, data.sessionId, data.opencodeSessionId ?? null)
      .run();
  }

  return {
    id: data.id,
    sessionId: data.sessionId,
    opencodeSessionId: data.opencodeSessionId,
    originType,
    originChannelType: data.originChannelType,
    originChannelId: data.originChannelId,
    originTriggerId: data.originTriggerId,
    originTriggerType: data.originTriggerType,
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
    .first<ThreadRow>();

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
    .first<ThreadRow>();

  return row ? rowToThread(row) : null;
}

export async function listThreads(
  db: D1Database,
  sessionId: string,
  options: { cursor?: string; limit?: number; status?: string; userId?: string; page?: number; pageSize?: number } = {}
): Promise<{ threads: SessionThread[]; cursor?: string; hasMore: boolean; page?: number; pageSize?: number; totalCount?: number; totalPages?: number }> {
  const limit = options.limit || 20;
  const page = options.page;
  const pageSize = options.pageSize || limit;

  // When userId is provided, list threads across ALL orchestrator sessions for
  // this user so that thread history survives orchestrator session rotation.
  const crossSession = !!options.userId;

  const previewJoin = `
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
    LEFT JOIN channel_thread_mappings ctm
      ON ctm.id = (
        SELECT id
        FROM channel_thread_mappings
        WHERE thread_id = t.id
        ORDER BY created_at ASC, id ASC
        LIMIT 1
      )`;

  let whereClause = '';
  const params: (string | number)[] = [];

  if (crossSession) {
    const userId = options.userId;
    whereClause += `
    WHERE t.session_id IN (
      SELECT id FROM sessions
      WHERE user_id = ? AND purpose = 'orchestrator'
    )`;
    if (userId) params.push(userId);
  } else {
    whereClause += `
    WHERE t.session_id = ?`;
    params.push(sessionId);
  }

  if (options.status) {
    whereClause += ' AND t.status = ?';
    params.push(options.status);
  }

  if (page && page > 0) {
    const countResult = await db
      .prepare(`SELECT COUNT(*) as count FROM session_threads t ${whereClause}`)
      .bind(...params)
      .first<{ count?: number }>();
    const totalCount = Number(countResult?.count ?? 0);
    const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
    const safePage = Math.min(page, totalPages);
    const offset = (safePage - 1) * pageSize;

    const pageRowsResult = await db
      .prepare(`${previewJoin} ${whereClause} ORDER BY t.last_active_at DESC LIMIT ? OFFSET ?`)
      .bind(...params, pageSize, offset)
      .all<ThreadRow>();
    const pageRows = pageRowsResult.results || [];
    const threads = pageRows.map(rowToThread);

    return {
      threads,
      hasMore: safePage < totalPages,
      page: safePage,
      pageSize,
      totalCount,
      totalPages,
    };
  }

  let query = `${previewJoin} ${whereClause}`;

  if (options.cursor) {
    query += ' AND t.last_active_at < ?';
    params.push(options.cursor);
  }

  query += ' ORDER BY t.last_active_at DESC LIMIT ?';
  params.push(limit + 1);

  const result = await db.prepare(query).bind(...params).all<ThreadRow>();
  const rows = result.results || [];

  const hasMore = rows.length > limit;
  const pageRows = rows.slice(0, limit);

  const threads = pageRows.map(rowToThread);
  const cursorRow = pageRows[pageRows.length - 1];

  return {
    threads,
    cursor: hasMore && cursorRow ? String(cursorRow.last_active_at) : undefined,
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
    .first<{ message_count?: number }>();
  return row?.message_count ?? 0;
}
