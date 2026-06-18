import {
  SQL_JOIN_DIAGNOSTIC,
  SQL_SESSION_BY_ID,
  SQL_THREAD_MESSAGES,
  SQL_THREAD_MODEL_TOTALS,
  SQL_THREAD_TOOL_HISTOGRAM,
  sqlThreadsByIds,
  sqlUsersByIds,
} from './queries.js';
import type {
  JoinDiagnostic,
  MessageRow,
  ModelTokenBreakdown,
  SessionRow,
  ThreadRow,
  ThreadTotals,
  UsageDataSource,
} from './types.js';

export interface CloudflareD1Config {
  apiToken: string;
  accountId: string;
  databaseId: string;
  // Optional override for the CF API base. Defaults to the public API.
  apiBase?: string;
}

interface D1QueryResponse {
  success: boolean;
  errors?: Array<{ code: number; message: string }>;
  messages?: Array<{ code: number; message: string }>;
  result?: Array<{
    results?: unknown[];
    success?: boolean;
    meta?: Record<string, unknown>;
  }>;
}

const IN_CLAUSE_BATCH = 80; // SQLite has a default 999 parameter limit; well below.
const FETCH_TIMEOUT_MS = 60_000;

export class CloudflareD1DataSource implements UsageDataSource {
  private readonly endpoint: string;
  private readonly headers: HeadersInit;

  constructor(private readonly config: CloudflareD1Config) {
    const base = config.apiBase ?? 'https://api.cloudflare.com/client/v4';
    this.endpoint = `${base}/accounts/${config.accountId}/d1/database/${config.databaseId}/query`;
    this.headers = {
      Authorization: `Bearer ${config.apiToken}`,
      'Content-Type': 'application/json',
    };
  }

  async diagnostic(from: Date, to: Date): Promise<JoinDiagnostic> {
    const rows = await this.query<{
      llm_call_rows: number;
      joined_to_message: number;
      attributed_to_thread: number;
    }>(SQL_JOIN_DIAGNOSTIC, [iso(from), iso(to)]);
    const row = rows[0] ?? { llm_call_rows: 0, joined_to_message: 0, attributed_to_thread: 0 };
    const total = Number(row.llm_call_rows ?? 0);
    const joined = Number(row.joined_to_message ?? 0);
    const attributed = Number(row.attributed_to_thread ?? 0);
    return {
      llmCallRows: total,
      joinedToMessage: joined,
      attributedToThread: attributed,
      hitRate: total === 0 ? 0 : attributed / total,
    };
  }

  async fetchThreadTotals(from: Date, to: Date): Promise<Map<string, ThreadTotals>> {
    const [modelRows, toolRows] = await Promise.all([
      this.query<{
        thread_id: string;
        session_id: string;
        model: string;
        input_tokens: number;
        output_tokens: number;
        calls: number;
        first_call_at: string;
        last_call_at: string;
      }>(SQL_THREAD_MODEL_TOTALS, [iso(from), iso(to)]),
      this.query<{ thread_id: string; tool_name: string; calls: number }>(
        SQL_THREAD_TOOL_HISTOGRAM,
        [iso(from), iso(to)],
      ),
    ]);

    const byThread = new Map<string, ThreadTotals>();

    for (const r of modelRows) {
      const existing =
        byThread.get(r.thread_id) ??
        ({
          threadId: r.thread_id,
          sessionId: r.session_id,
          inputTokens: 0,
          outputTokens: 0,
          llmCalls: 0,
          toolCalls: 0,
          modelBreakdown: {},
          toolHistogram: [],
          firstCallAt: r.first_call_at,
          lastCallAt: r.last_call_at,
        } satisfies ThreadTotals);

      const inputTokens = Number(r.input_tokens) || 0;
      const outputTokens = Number(r.output_tokens) || 0;
      const calls = Number(r.calls) || 0;

      existing.inputTokens += inputTokens;
      existing.outputTokens += outputTokens;
      existing.llmCalls += calls;

      const bucket: ModelTokenBreakdown = existing.modelBreakdown[r.model] ?? {
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
      };
      bucket.calls += calls;
      bucket.inputTokens += inputTokens;
      bucket.outputTokens += outputTokens;
      existing.modelBreakdown[r.model] = bucket;

      if (r.first_call_at < existing.firstCallAt) existing.firstCallAt = r.first_call_at;
      if (r.last_call_at > existing.lastCallAt) existing.lastCallAt = r.last_call_at;

      byThread.set(r.thread_id, existing);
    }

    for (const r of toolRows) {
      const existing = byThread.get(r.thread_id);
      if (!existing) continue; // tool call on a thread with zero llm_call rows — drop
      const calls = Number(r.calls) || 0;
      existing.toolHistogram.push({ toolName: r.tool_name, calls });
      existing.toolCalls += calls;
    }

    return byThread;
  }

  async fetchThreads(threadIds: string[]): Promise<ThreadRow[]> {
    if (threadIds.length === 0) return [];
    const real = threadIds.filter((id) => !id.startsWith('__unattributed__:'));
    if (real.length === 0) return [];

    const out: ThreadRow[] = [];
    for (let i = 0; i < real.length; i += IN_CLAUSE_BATCH) {
      const batch = real.slice(i, i + IN_CLAUSE_BATCH);
      const { sql, params } = sqlThreadsByIds(batch);
      const rows = await this.query<{
        thread_id: string;
        session_id: string;
        origin_type: string | null;
        origin_channel_type: string | null;
        origin_channel_id: string | null;
        origin_trigger_id: string | null;
        origin_trigger_type: string | null;
        thread_title: string | null;
        user_id: string;
        is_orchestrator: number;
        purpose: string;
        session_title: string | null;
        user_email: string | null;
        has_user_message: number;
        has_channel_mapping: number;
      }>(sql, params);
      for (const r of rows) {
        out.push({
          threadId: r.thread_id,
          sessionId: r.session_id,
          userId: r.user_id,
          userEmail: r.user_email,
          isOrchestrator: Boolean(r.is_orchestrator),
          purpose: r.purpose,
          originType: r.origin_type,
          originChannelType: r.origin_channel_type,
          originChannelId: r.origin_channel_id,
          originTriggerId: r.origin_trigger_id,
          originTriggerType: r.origin_trigger_type,
          threadTitle: r.thread_title,
          sessionTitle: r.session_title,
          hasUserMessage: Boolean(r.has_user_message),
          hasChannelMapping: Boolean(r.has_channel_mapping),
        });
      }
    }
    return out;
  }

  async fetchThreadMessages(threadId: string): Promise<MessageRow[]> {
    if (threadId.startsWith('__unattributed__:')) return [];
    const rows = await this.query<{
      id: string;
      thread_id: string | null;
      session_id: string;
      role: string;
      content: string;
      channel_type: string | null;
      created_at: string;
    }>(SQL_THREAD_MESSAGES, [threadId]);
    return rows.map((r) => ({
      id: r.id,
      threadId: r.thread_id,
      sessionId: r.session_id,
      role: r.role,
      content: r.content ?? '',
      channelType: r.channel_type,
      createdAt: r.created_at,
    }));
  }

  async fetchSession(sessionId: string): Promise<SessionRow | null> {
    const rows = await this.query<{
      id: string;
      title: string | null;
      parent_session_id: string | null;
      is_orchestrator: number;
    }>(SQL_SESSION_BY_ID, [sessionId]);
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      title: row.title,
      parentSessionId: row.parent_session_id,
      isOrchestrator: Boolean(row.is_orchestrator),
    };
  }

  async fetchUsers(userIds: string[]): Promise<Map<string, { id: string; email: string | null }>> {
    const out = new Map<string, { id: string; email: string | null }>();
    if (userIds.length === 0) return out;
    for (let i = 0; i < userIds.length; i += IN_CLAUSE_BATCH) {
      const batch = userIds.slice(i, i + IN_CLAUSE_BATCH);
      const { sql, params } = sqlUsersByIds(batch);
      const rows = await this.query<{ id: string; email: string | null }>(sql, params);
      for (const r of rows) out.set(r.id, { id: r.id, email: r.email });
    }
    return out;
  }

  private async query<T>(sql: string, params: unknown[]): Promise<T[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(this.endpoint, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({ sql, params }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`D1 HTTP ${res.status}: ${body.slice(0, 500)}`);
      }
      const json = (await res.json()) as D1QueryResponse;
      if (!json.success || !json.result || json.result.length === 0) {
        const err = json.errors?.[0]?.message ?? 'unknown error';
        throw new Error(`D1 query failed: ${err}`);
      }
      const first = json.result[0]!;
      if (first.success === false) {
        throw new Error(`D1 result error: ${JSON.stringify(json.errors ?? json.messages ?? [])}`);
      }
      return (first.results ?? []) as T[];
    } finally {
      clearTimeout(timeout);
    }
  }
}

function iso(d: Date): string {
  // datetime('now') in SQLite produces 'YYYY-MM-DD HH:MM:SS'. Match that
  // format so string comparisons work against the created_at column.
  return d.toISOString().replace('T', ' ').slice(0, 19);
}
