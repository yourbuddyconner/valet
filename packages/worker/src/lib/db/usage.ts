import type { D1Database } from '@cloudflare/workers-types';

// ─── Types ──────────────────────────────────────────────────────────────────

export type UsageEventRow = {
  id: string;
  session_id: string;
  turn_id: string;
  oc_message_id: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  created_at: string;
};

// ─── Batch Insert (DO flush → D1) ──────────────────────────────────────────

export async function batchInsertUsageEvents(
  db: D1Database,
  sessionId: string,
  entries: Array<{
    localId: number;
    turnId: string;
    ocMessageId: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    createdAt: number;
  }>,
): Promise<void> {
  if (entries.length === 0) return;

  const stmts = entries.map((entry) =>
    db.prepare(
      'INSERT OR IGNORE INTO usage_events (id, session_id, turn_id, oc_message_id, model, input_tokens, output_tokens, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, datetime(?, \'unixepoch\'))'
    ).bind(
      `${sessionId}:${entry.localId}`,
      sessionId,
      entry.turnId,
      entry.ocMessageId,
      entry.model,
      entry.inputTokens,
      entry.outputTokens,
      entry.createdAt,
    )
  );

  await db.batch(stmts);
}

// ─── Aggregate Queries ────────────────────────────────────────────────────

export interface UsageHeroStats {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalSessions: number;
  totalUsers: number;
}

export async function getUsageHeroStats(
  db: D1Database,
  periodStart: string,
): Promise<UsageHeroStats> {
  const row = await db
    .prepare(`
      SELECT
        COALESCE(SUM(ue.input_tokens), 0) as total_input_tokens,
        COALESCE(SUM(ue.output_tokens), 0) as total_output_tokens,
        COUNT(DISTINCT ue.session_id) as total_sessions,
        COUNT(DISTINCT s.user_id) as total_users
      FROM usage_events ue
      LEFT JOIN sessions s ON s.id = ue.session_id
      WHERE ue.created_at >= ?
    `)
    .bind(periodStart)
    .first<{
      total_input_tokens: number;
      total_output_tokens: number;
      total_sessions: number;
      total_users: number;
    }>();

  return {
    totalInputTokens: row?.total_input_tokens ?? 0,
    totalOutputTokens: row?.total_output_tokens ?? 0,
    totalSessions: row?.total_sessions ?? 0,
    totalUsers: row?.total_users ?? 0,
  };
}

export interface UsageByDayRow {
  date: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export async function getUsageByDay(
  db: D1Database,
  periodStart: string,
): Promise<UsageByDayRow[]> {
  const result = await db
    .prepare(`
      SELECT
        date(ue.created_at) as date,
        ue.model,
        SUM(ue.input_tokens) as input_tokens,
        SUM(ue.output_tokens) as output_tokens
      FROM usage_events ue
      WHERE ue.created_at >= ?
      GROUP BY date(ue.created_at), ue.model
      ORDER BY date ASC
    `)
    .bind(periodStart)
    .all();

  return (result.results ?? []).map((r: Record<string, unknown>) => ({
    date: String(r.date),
    model: String(r.model),
    inputTokens: Number(r.input_tokens),
    outputTokens: Number(r.output_tokens),
  }));
}

export interface UsageByUserRow {
  userId: string;
  email: string;
  name: string | null;
  inputTokens: number;
  outputTokens: number;
  sessionCount: number;
}

export async function getUsageByUser(
  db: D1Database,
  periodStart: string,
): Promise<UsageByUserRow[]> {
  const result = await db
    .prepare(`
      SELECT
        s.user_id,
        u.email,
        u.name,
        SUM(ue.input_tokens) as input_tokens,
        SUM(ue.output_tokens) as output_tokens,
        COUNT(DISTINCT ue.session_id) as session_count
      FROM usage_events ue
      LEFT JOIN sessions s ON s.id = ue.session_id
      LEFT JOIN users u ON u.id = s.user_id
      WHERE ue.created_at >= ?
        AND s.user_id IS NOT NULL
      GROUP BY s.user_id
      ORDER BY (SUM(ue.input_tokens) + SUM(ue.output_tokens)) DESC
    `)
    .bind(periodStart)
    .all();

  return (result.results ?? []).map((r: Record<string, unknown>) => ({
    userId: String(r.user_id),
    email: r.email ? String(r.email) : 'Unknown',
    name: r.name ? String(r.name) : null,
    inputTokens: Number(r.input_tokens),
    outputTokens: Number(r.output_tokens),
    sessionCount: Number(r.session_count),
  }));
}

export interface UsageByUserModelRow {
  userId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export async function getUsageByUserModel(
  db: D1Database,
  periodStart: string,
): Promise<UsageByUserModelRow[]> {
  const result = await db
    .prepare(`
      SELECT
        s.user_id,
        ue.model,
        SUM(ue.input_tokens) as input_tokens,
        SUM(ue.output_tokens) as output_tokens
      FROM usage_events ue
      LEFT JOIN sessions s ON s.id = ue.session_id
      WHERE ue.created_at >= ?
        AND s.user_id IS NOT NULL
      GROUP BY s.user_id, ue.model
    `)
    .bind(periodStart)
    .all();

  return (result.results ?? []).map((r: Record<string, unknown>) => ({
    userId: String(r.user_id),
    model: String(r.model),
    inputTokens: Number(r.input_tokens),
    outputTokens: Number(r.output_tokens),
  }));
}

export interface UsageByModelRow {
  model: string;
  inputTokens: number;
  outputTokens: number;
  callCount: number;
}

export async function getUsageByModel(
  db: D1Database,
  periodStart: string,
): Promise<UsageByModelRow[]> {
  const result = await db
    .prepare(`
      SELECT
        model,
        SUM(input_tokens) as input_tokens,
        SUM(output_tokens) as output_tokens,
        COUNT(*) as call_count
      FROM usage_events
      WHERE created_at >= ?
      GROUP BY model
      ORDER BY (SUM(input_tokens) + SUM(output_tokens)) DESC
    `)
    .bind(periodStart)
    .all();

  return (result.results ?? []).map((r: Record<string, unknown>) => ({
    model: String(r.model),
    inputTokens: Number(r.input_tokens),
    outputTokens: Number(r.output_tokens),
    callCount: Number(r.call_count),
  }));
}
