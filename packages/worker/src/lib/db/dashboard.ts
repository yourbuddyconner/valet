import type { D1Database } from '@cloudflare/workers-types';

// ─── Types ──────────────────────────────────────────────────────────────────

export type SessionAggregateRow = {
  total_sessions: number;
  active_sessions: number;
  unique_repos: number;
  total_messages: number;
  total_tool_calls: number;
  total_duration: number;
};

export type PrevPeriodAggregateRow = {
  count: number;
  messages: number;
};

export type ActivityRow = {
  date: string;
  sessions: number;
  messages: number;
};

export type TopRepoRow = {
  workspace: string;
  sessionCount: number;
  messageCount: number;
};

export type RecentSessionRow = {
  id: string;
  workspace: string;
  status: string;
  messageCount: number;
  toolCallCount: number;
  durationSeconds: number;
  createdAt: string;
  lastActiveAt: string;
  errorMessage?: string;
};

export type ActiveSessionRow = {
  id: string;
  workspace: string;
  status: string;
  createdAt: string;
  lastActiveAt: string;
};

// ─── Queries ────────────────────────────────────────────────────────────────

export async function getOrgSessionAggregate(
  db: D1Database,
  periodStart: string
): Promise<SessionAggregateRow> {
  const row = await db
    .prepare(`
      SELECT
        (SELECT COUNT(*) FROM sessions WHERE created_at >= ? AND is_orchestrator = 0 AND COALESCE(purpose, 'interactive') != 'workflow')
          + (SELECT COUNT(DISTINCT user_id) FROM sessions WHERE created_at >= ? AND is_orchestrator = 1)
          as total_sessions,
        SUM(CASE WHEN status IN ('running', 'idle', 'initializing') THEN 1 ELSE 0 END) as active_sessions,
        COUNT(DISTINCT CASE WHEN is_orchestrator = 0 THEN workspace END) as unique_repos,
        (SELECT COUNT(*) FROM messages m
          INNER JOIN sessions s ON s.id = m.session_id
          WHERE m.created_at >= ? AND m.role IN ('user', 'assistant')
            AND COALESCE(s.purpose, 'interactive') != 'workflow'
        ) as total_messages,
        COALESCE(SUM(tool_call_count), 0) as total_tool_calls,
        COALESCE(SUM(active_seconds), 0) as total_duration
      FROM sessions
      WHERE created_at >= ?
        AND COALESCE(purpose, 'interactive') != 'workflow'
    `)
    .bind(periodStart, periodStart, periodStart, periodStart)
    .first<SessionAggregateRow>();

  return row!;
}

export async function getUserSessionAggregate(
  db: D1Database,
  userId: string,
  periodStart: string
): Promise<SessionAggregateRow> {
  const row = await db
    .prepare(`
      SELECT
        (SELECT COUNT(*) FROM sessions WHERE user_id = ? AND created_at >= ? AND is_orchestrator = 0 AND COALESCE(purpose, 'interactive') != 'workflow')
          + (SELECT MIN(1, COUNT(*)) FROM sessions WHERE user_id = ? AND created_at >= ? AND is_orchestrator = 1)
          as total_sessions,
        SUM(CASE WHEN status IN ('running', 'idle', 'initializing') THEN 1 ELSE 0 END) as active_sessions,
        COUNT(DISTINCT CASE WHEN is_orchestrator = 0 THEN workspace END) as unique_repos,
        (SELECT COUNT(*) FROM messages m
          INNER JOIN sessions s ON s.id = m.session_id
          WHERE m.created_at >= ? AND m.role IN ('user', 'assistant')
            AND s.user_id = ? AND COALESCE(s.purpose, 'interactive') != 'workflow'
        ) as total_messages,
        COALESCE(SUM(tool_call_count), 0) as total_tool_calls,
        COALESCE(SUM(active_seconds), 0) as total_duration
      FROM sessions
      WHERE user_id = ?
        AND created_at >= ?
        AND COALESCE(purpose, 'interactive') != 'workflow'
    `)
    .bind(userId, periodStart, userId, periodStart, periodStart, userId, userId, periodStart)
    .first<SessionAggregateRow>();

  return row!;
}

export async function getPrevPeriodAggregate(
  db: D1Database,
  prevStart: string,
  periodStart: string
): Promise<PrevPeriodAggregateRow> {
  const row = await db
    .prepare(`
      SELECT
        (SELECT COUNT(*) FROM sessions WHERE created_at >= ? AND created_at < ? AND is_orchestrator = 0 AND COALESCE(purpose, 'interactive') != 'workflow')
          + (SELECT COUNT(DISTINCT user_id) FROM sessions WHERE created_at >= ? AND created_at < ? AND is_orchestrator = 1)
          as count,
        (SELECT COUNT(*) FROM messages m
          INNER JOIN sessions s ON s.id = m.session_id
          WHERE m.created_at >= ? AND m.created_at < ? AND m.role IN ('user', 'assistant')
            AND COALESCE(s.purpose, 'interactive') != 'workflow'
        ) as messages
    `)
    .bind(prevStart, periodStart, prevStart, periodStart, prevStart, periodStart)
    .first<PrevPeriodAggregateRow>();

  return row ?? { count: 0, messages: 0 };
}

export async function getSessionActivityByDay(
  db: D1Database,
  periodStart: string,
  periodDays: number
): Promise<ActivityRow[]> {
  const result = await db
    .prepare(`
      WITH RECURSIVE dates(date) AS (
        SELECT date(?, '-' || ? || ' days')
        UNION ALL
        SELECT date(date, '+1 day') FROM dates WHERE date < date('now')
      ),
      session_counts AS (
        SELECT
          date(created_at) as day,
          COUNT(CASE WHEN is_orchestrator = 0 THEN 1 END)
            + COUNT(DISTINCT CASE WHEN is_orchestrator = 1 THEN user_id END) as cnt
        FROM sessions
        WHERE created_at >= ?
          AND COALESCE(purpose, 'interactive') != 'workflow'
        GROUP BY day
      ),
      message_counts AS (
        SELECT
          date(m.created_at) as day,
          COUNT(*) as msgs
        FROM messages m
        INNER JOIN sessions s ON s.id = m.session_id
        WHERE m.created_at >= ?
          AND COALESCE(s.purpose, 'interactive') != 'workflow'
          AND m.role IN ('user', 'assistant')
        GROUP BY day
      )
      SELECT
        d.date,
        COALESCE(sc.cnt, 0) as sessions,
        COALESCE(mc.msgs, 0) as messages
      FROM dates d
      LEFT JOIN session_counts sc ON sc.day = d.date
      LEFT JOIN message_counts mc ON mc.day = d.date
      ORDER BY d.date
    `)
    .bind(periodStart, periodDays, periodStart, periodStart)
    .all();

  return (result.results ?? []).map((r: Record<string, unknown>) => ({
    date: String(r.date),
    sessions: Number(r.sessions),
    messages: Number(r.messages),
  }));
}

export async function getTopReposBySessionCount(
  db: D1Database,
  periodStart: string,
  limit: number = 8
): Promise<TopRepoRow[]> {
  const result = await db
    .prepare(`
      SELECT
        workspace,
        COUNT(*) as session_count,
        COALESCE(SUM(message_count), 0) as message_count
      FROM sessions
      WHERE created_at >= ?
        AND COALESCE(purpose, 'interactive') != 'workflow'
        AND is_orchestrator = 0
      GROUP BY workspace
      ORDER BY session_count DESC
      LIMIT ?
    `)
    .bind(periodStart, limit)
    .all();

  return (result.results ?? []).map((r: Record<string, unknown>) => ({
    workspace: String(r.workspace),
    sessionCount: Number(r.session_count),
    messageCount: Number(r.message_count),
  }));
}

export async function getRecentUserSessions(
  db: D1Database,
  userId: string,
  limit: number = 10
): Promise<RecentSessionRow[]> {
  const result = await db
    .prepare(`
      SELECT DISTINCT
        s.id, s.workspace, s.status, s.message_count, s.tool_call_count,
        s.active_seconds as duration_seconds,
        s.created_at, s.last_active_at, s.error_message
      FROM sessions s
      LEFT JOIN session_participants sp ON sp.session_id = s.id AND sp.user_id = ?
      WHERE (s.user_id = ? OR sp.user_id IS NOT NULL)
        AND COALESCE(s.purpose, 'interactive') != 'workflow'
        AND s.is_orchestrator = 0
      ORDER BY s.created_at DESC
      LIMIT ?
    `)
    .bind(userId, userId, limit)
    .all();

  return (result.results ?? []).map((r: Record<string, unknown>) => ({
    id: String(r.id),
    workspace: String(r.workspace),
    status: String(r.status),
    messageCount: Number(r.message_count),
    toolCallCount: Number(r.tool_call_count),
    durationSeconds: Number(r.duration_seconds),
    createdAt: String(r.created_at),
    lastActiveAt: String(r.last_active_at),
    errorMessage: r.error_message ? String(r.error_message) : undefined,
  }));
}

export async function getActiveUserSessions(
  db: D1Database,
  userId: string
): Promise<ActiveSessionRow[]> {
  const result = await db
    .prepare(`
      SELECT DISTINCT s.id, s.workspace, s.status, s.created_at, s.last_active_at
      FROM sessions s
      LEFT JOIN session_participants sp ON sp.session_id = s.id AND sp.user_id = ?
      WHERE (s.user_id = ? OR sp.user_id IS NOT NULL)
        AND s.status IN ('running', 'idle', 'initializing', 'restoring')
        AND COALESCE(s.purpose, 'interactive') != 'workflow'
      ORDER BY s.last_active_at DESC
    `)
    .bind(userId, userId)
    .all();

  return (result.results ?? []).map((r: Record<string, unknown>) => ({
    id: String(r.id),
    workspace: String(r.workspace),
    status: String(r.status),
    createdAt: String(r.created_at),
    lastActiveAt: String(r.last_active_at),
  }));
}

export async function getUnflushedSessionIds(
  db: D1Database,
  userId: string,
  limit: number = 20
): Promise<string[]> {
  const result = await db
    .prepare(
      `SELECT id FROM sessions
       WHERE user_id = ?
         AND message_count = 0
         AND status != 'initializing'
         AND COALESCE(purpose, 'interactive') != 'workflow'
       LIMIT ?`
    )
    .bind(userId, limit)
    .all();

  return (result.results ?? []).map((r: Record<string, unknown>) => String(r.id));
}
