import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ACTION_APPROVAL_EXPIRY_MS, SessionAgentDO, buildActionApprovalPromptActions, buildForwardedParts, resolveSlackChannelId } from './session-agent.js';
import { createTestDb } from '../test-utils/db.js';
import { sessions } from '../lib/schema/sessions.js';
import { users } from '../lib/schema/users.js';
import { userIdentityLinks } from '../lib/schema/channels.js';
import { workflows, workflowExecutions } from '../lib/schema/workflows.js';
import { createInvocation, getInvocation, getUserActionPolicyOverride, upsertActionPolicy } from '../lib/db/actions.js';
import type { InteractivePrompt } from '@valet/sdk';
import * as sessionTools from '../services/session-tools.js';
import * as channelsDb from '../lib/db/channels.js';
import * as channelThreadsDb from '../lib/db/channel-threads.js';
import * as slackDb from '../lib/db/slack.js';

interface QueueRow {
  id: string;
  content: string;
  attachments: string | null;
  model: string | null;
  queue_type: string;
  workflow_execution_id: string | null;
  workflow_payload: string | null;
  status: string;
  author_id: string | null;
  author_email: string | null;
  author_name: string | null;
  author_avatar_url: string | null;
  channel_type: string | null;
  channel_id: string | null;
  channel_key: string | null;
  thread_id: string | null;
  continuation_context: string | null;
  context_prefix: string | null;
  reply_channel_type: string | null;
  reply_channel_id: string | null;
  child_session_id: string | null;
  child_status: string | null;
  priority: number;
  replaceable: number;
  received_at: number | null;
  dispatched_at: number | null;
  created_at: number;
}

interface InteractivePromptRow {
  id: string;
  type: string;
  request_id: string | null;
  title: string;
  body?: string | null;
  actions: string;
  context: string;
  status: string;
  expires_at: number | null;
  channel_refs?: string | null;
}

function cursor<T>(rows: T[]): { toArray(): T[]; one(): T } {
  return {
    toArray: () => rows,
    one: () => {
      if (rows.length === 0) throw new Error('Expected exactly one row');
      return rows[0];
    },
  };
}

let insertCounter = 0;

function createMockSql(): SqlStorage & {
  queue: Map<string, QueueRow>;
  state: Map<string, string>;
  interactivePrompts: Map<string, InteractivePromptRow>;
  messages: Map<string, Record<string, unknown>>;
  channelState: Map<string, { busy: number; opencode_session_id: string | null; idle_queued_since: number | null; error_safety_net_at: number | null }>;
} {
  const queue = new Map<string, QueueRow>();
  const state = new Map<string, string>();
  const interactivePrompts = new Map<string, InteractivePromptRow>();
  const messages = new Map<string, Record<string, unknown>>();
  const channelState = new Map<string, { busy: number; opencode_session_id: string | null; idle_queued_since: number | null; error_safety_net_at: number | null }>();
  insertCounter = 0;

  return {
    queue,
    state,
    interactivePrompts,
    messages,
    channelState,
    exec(query: string, ...params: unknown[]) {
      const q = query.trim();

      if (q.startsWith('CREATE') || q.startsWith('ALTER TABLE')) {
        return cursor([]);
      }

      if (q.startsWith('INSERT INTO channel_state')) {
        const channelKey = String(params[0]);
        const existing = channelState.get(channelKey) ?? {
          busy: 0,
          opencode_session_id: null,
          idle_queued_since: null,
          error_safety_net_at: null,
        };
        // Distinguish between the four INSERT patterns by checking the column list.
        if (q.includes('opencode_session_id')) {
          const opencodeSessionId = params[1] === undefined || params[1] === null
            ? null
            : String(params[1]);
          channelState.set(channelKey, { ...existing, opencode_session_id: opencodeSessionId });
        } else if (q.includes('idle_queued_since')) {
          const ms = params[1] === undefined || params[1] === null ? null : Number(params[1]);
          channelState.set(channelKey, { ...existing, idle_queued_since: ms });
        } else if (q.includes('error_safety_net_at')) {
          const ms = params[1] === undefined || params[1] === null ? null : Number(params[1]);
          channelState.set(channelKey, { ...existing, error_safety_net_at: ms });
        } else {
          // Default: (channel_key, busy) — setChannelBusy
          const busy = Number(params[1]) || 0;
          channelState.set(channelKey, { ...existing, busy });
        }
        return cursor([]);
      }

      if (q.startsWith('UPDATE channel_state SET busy')) {
        // clearAllChannelBusy — reset all channels to idle
        for (const [key, val] of channelState) {
          channelState.set(key, { ...val, busy: 0 });
        }
        return cursor([]);
      }

      if (q.startsWith('UPDATE channel_state SET idle_queued_since')) {
        for (const [key, val] of channelState) {
          channelState.set(key, { ...val, idle_queued_since: null });
        }
        return cursor([]);
      }

      if (q.startsWith('UPDATE channel_state SET error_safety_net_at')) {
        for (const [key, val] of channelState) {
          channelState.set(key, { ...val, error_safety_net_at: null });
        }
        return cursor([]);
      }

      if (q.startsWith('SELECT') && q.includes('FROM channel_state')) {
        if (q.includes('WHERE busy = 1')) {
          const busy = Array.from(channelState.entries()).find(([, row]) => row.busy === 1);
          return busy === undefined ? cursor([]) : cursor([{ channel_key: busy[0] }]);
        }
        if (q.includes('error_safety_net_at IS NOT NULL')) {
          const rows = Array.from(channelState.entries())
            .filter(([, r]) => r.error_safety_net_at !== null)
            .map(([k, r]) => ({ channel_key: k, error_safety_net_at: r.error_safety_net_at }));
          rows.sort((a, b) => (a.error_safety_net_at ?? 0) - (b.error_safety_net_at ?? 0));
          return cursor(rows.slice(0, 1));
        }
        if (q.includes('idle_queued_since IS NOT NULL')) {
          const rows = Array.from(channelState.entries())
            .filter(([, r]) => r.idle_queued_since !== null)
            .map(([k, r]) => ({ channel_key: k, idle_queued_since: r.idle_queued_since }));
          rows.sort((a, b) => (a.idle_queued_since ?? 0) - (b.idle_queued_since ?? 0));
          return cursor(rows.slice(0, 1));
        }
        // Reverse lookup by opencode_session_id — used by getChannelKeyByOcSessionId
        // to route call-tool approvals back to the originating thread.
        if (q.includes('opencode_session_id = ?')) {
          const ocSessionId = String(params[0]);
          const found = Array.from(channelState.entries())
            .find(([, r]) => r.opencode_session_id === ocSessionId);
          return found
            ? cursor([{ channel_key: found[0] }])
            : cursor([]);
        }
        const channelKey = String(params[0]);
        const row = channelState.get(channelKey);
        return row === undefined ? cursor([]) : cursor([row]);
      }
      if (q.startsWith("UPDATE prompt_queue SET queue_type = 'prompt'")) {
        return cursor([]);
      }
      if (q.startsWith('CREATE INDEX')) {
        return cursor([]);
      }

      if (q.startsWith('INSERT OR REPLACE INTO state')) {
        state.set(String(params[0]), String(params[1]));
        return cursor([]);
      }

      if (q.includes('SELECT MAX(seq) as max_seq FROM messages')) {
        return cursor([{ max_seq: null }]);
      }

      if (q.includes('SELECT 1 FROM messages WHERE id = ?')) {
        return cursor(messages.has(String(params[0])) ? [{ 1: 1 }] : []);
      }

      if (q.startsWith('INSERT OR IGNORE INTO messages')) {
        const id = String(params[0]);
        if (!messages.has(id)) {
          messages.set(id, { id, seq: params[1], role: params[2], content: params[3] });
        }
        return cursor([]);
      }

      if (q.includes("SELECT value FROM replication_state WHERE key = 'last_replicated_seq'")) {
        return cursor([]);
      }

      if (q.startsWith('SELECT') && q.includes('FROM state')) {
        const value = state.get(String(params[0]));
        return value === undefined ? cursor([]) : cursor([{ value }]);
      }

      if (q.startsWith('INSERT INTO prompt_queue')) {
        insertCounter += 1;
        let row: QueueRow;
        if (q.includes("'workflow_execute'")) {
          // Workflow-execute insert: (id, content, queue_type, workflow_execution_id, workflow_payload, status)
          // params: [id, workflowExecutionId, workflowPayload, status]
          row = {
            id: String(params[0] ?? ''),
            content: '',
            attachments: null,
            model: null,
            queue_type: 'workflow_execute',
            workflow_execution_id: (params[1] as string) || null,
            workflow_payload: (params[2] as string) || null,
            status: String(params[3] ?? 'queued'),
            author_id: null,
            author_email: null,
            author_name: null,
            author_avatar_url: null,
            channel_type: null,
            channel_id: null,
            channel_key: null,
            thread_id: null,
            continuation_context: null,
            context_prefix: null,
            reply_channel_type: null,
            reply_channel_id: null,
            child_session_id: null,
            child_status: null,
            priority: 0,
            replaceable: 1,
            received_at: typeof params[4] === 'number' ? params[4] : Date.now(),
            dispatched_at: null,
            created_at: insertCounter,
          };
        } else {
          row = {
            id: String(params[0] ?? ''),
            content: String(params[1] ?? ''),
            attachments: (params[2] as string) || null,
            model: (params[3] as string) || null,
            queue_type: 'prompt',
            workflow_execution_id: null,
            workflow_payload: null,
            status: String(params[4] ?? 'queued'),
            author_id: (params[5] as string) || null,
            author_email: (params[6] as string) || null,
            author_name: (params[7] as string) || null,
            author_avatar_url: (params[8] as string) || null,
            channel_type: (params[9] as string) || null,
            channel_id: (params[10] as string) || null,
            channel_key: (params[11] as string) || null,
            thread_id: (params[12] as string) || null,
            continuation_context: (params[13] as string) || null,
            context_prefix: (params[14] as string) || null,
            reply_channel_type: (params[15] as string) || null,
            reply_channel_id: (params[16] as string) || null,
            child_session_id: (params[17] as string) || null,
            child_status: (params[18] as string) || null,
            priority: typeof params[19] === 'number' ? params[19] : 0,
            replaceable: typeof params[20] === 'number' ? params[20] : 1,
            received_at: typeof params[21] === 'number' ? params[21] : Date.now(),
            dispatched_at: null,
            created_at: insertCounter,
          };
        }
        queue.set(row.id, row);
        return cursor([]);
      }

      if (q.startsWith('SELECT') && q.includes('FROM prompt_queue')) {
        let rows = Array.from(queue.values());
        // Honor `WHERE id = ?` for single-row lookups (getChannelKeyById,
        // getReceivedAtById, getModelById, etc.). The bind param is the
        // first one in these queries. Without this filter the mock returned
        // the FIRST inserted row for every getXxxById call, silently masking
        // bugs in any code that resolves state by messageId.
        if (q.includes('WHERE id = ?') || q.includes(' AND id = ?')) {
          const targetId = String(params[0]);
          rows = rows.filter((row) => row.id === targetId);
        }
        if (q.includes("status = 'queued'")) {
          rows = rows.filter((row) => row.status === 'queued');
        } else if (q.includes("status = 'processing'")) {
          rows = rows.filter((row) => row.status === 'processing');
        } else if (q.includes("status = 'completed'")) {
          rows = rows.filter((row) => row.status === 'completed');
        }

        if (q.includes("queue_type = 'prompt'")) {
          rows = rows.filter((row) => row.queue_type === 'prompt');
        }

        if (q.includes('child_session_id IS NULL')) {
          rows = rows.filter((row) => row.child_session_id === null);
        }

        if (q.includes('replaceable = 1')) {
          rows = rows.filter((row) => row.replaceable === 1);
        }

        // Honor `channel_key = ?` in SELECTs (used by /clear-queue thread scoping
        // and other channel-scoped lookups). The bind param appears at the end.
        if (q.includes('channel_key = ?') && !q.includes('FROM channel_state')) {
          const ck = String(params[params.length - 1]);
          rows = rows.filter((row) => row.channel_key === ck);
        }

        // Honor `id NOT IN (?, ?, ...)` used by dequeueNext's exclude path.
        const notInMatch = q.match(/id NOT IN \(([?,\s]+)\)/);
        if (notInMatch) {
          const placeholderCount = (notInMatch[1].match(/\?/g) ?? []).length;
          const excluded = new Set(
            params.slice(0, placeholderCount).map((p) => String(p)),
          );
          rows = rows.filter((row) => !excluded.has(String(row.id)));
        }

        if (q.includes('COUNT(*)')) {
          return cursor([{ count: rows.length, c: rows.length }]);
        }

        // Aggregates over dispatched_at — used by lastPromptDispatchedAt
        // (MAX) and getOldestProcessingDispatchedAt (MIN).
        if (q.includes('MAX(dispatched_at)')) {
          const ts = rows
            .filter((r) => r.dispatched_at !== null)
            .reduce<number | null>((max, r) => Math.max(max ?? 0, r.dispatched_at as number), null);
          return cursor([{ ts }]);
        }
        if (q.includes('MIN(dispatched_at)')) {
          const filtered = rows.filter((r) => r.dispatched_at !== null);
          const ts = filtered.length === 0
            ? null
            : filtered.reduce<number>((min, r) => Math.min(min, r.dispatched_at as number), Infinity);
          return cursor([{ ts: ts === Infinity ? null : ts }]);
        }

        // SELECT id ... ORDER BY dispatched_at ASC — getStuckProcessingMessageId.
        if (q.includes('ORDER BY dispatched_at ASC')) {
          let filtered = rows.filter((r) => r.dispatched_at !== null);
          if (q.includes('dispatched_at <= ?')) {
            const cutoff = Number(params[params.length - 1]);
            filtered = filtered.filter((r) => (r.dispatched_at as number) <= cutoff);
          }
          filtered.sort((a, b) => (a.dispatched_at as number) - (b.dispatched_at as number));
          return cursor(filtered.slice(0, 1));
        }

        // SELECT DISTINCT channel_key — armIdleQueuedSinceForAllQueuedChannels.
        if (q.includes('SELECT DISTINCT channel_key')) {
          const seen = new Set<string>();
          const out: Array<{ channel_key: string }> = [];
          for (const r of rows) {
            if (r.channel_key && !seen.has(r.channel_key)) {
              seen.add(r.channel_key);
              out.push({ channel_key: r.channel_key });
            }
          }
          return cursor(out);
        }

        // SELECT DISTINCT thread_id — handleAbort's per-thread fan-out.
        if (q.includes('SELECT DISTINCT thread_id')) {
          const seen = new Set<string | null>();
          const out: Array<{ thread_id: string | null }> = [];
          for (const r of rows) {
            const key = r.thread_id ?? null;
            if (!seen.has(key)) {
              seen.add(key);
              out.push({ thread_id: r.thread_id ?? null });
            }
          }
          return cursor(out);
        }

        if (q.includes('ORDER BY created_at DESC')) {
          rows.sort((a, b) => b.created_at - a.created_at);
        } else if (q.includes('ORDER BY priority DESC, created_at ASC')) {
          rows.sort((a, b) => b.priority - a.priority || a.created_at - b.created_at);
        } else if (q.includes('ORDER BY created_at ASC')) {
          rows.sort((a, b) => a.created_at - b.created_at);
        }

        if (q.includes('LIMIT 2') && rows.length > 2) {
          rows = rows.slice(0, 2);
        } else if (q.includes('LIMIT 1') && rows.length > 1) {
          rows = [rows[0]];
        }

        return cursor(rows);
      }

      if (q.startsWith('UPDATE prompt_queue')) {
        if (q.includes('SET dispatched_at = ?')) {
          const ts = Number(params[0]);
          const row = queue.get(String(params[1]));
          if (row) row.dispatched_at = ts;
        } else if (q.includes("SET status = 'completed' WHERE status = 'processing'")) {
          for (const row of queue.values()) {
            if (row.status === 'processing') row.status = 'completed';
          }
        } else if (q.includes("SET status = 'queued'") && q.includes("WHERE status = 'processing'")) {
          for (const row of queue.values()) {
            if (row.status === 'processing') {
              row.status = 'queued';
              if (q.includes('dispatched_at = NULL')) row.dispatched_at = null;
            }
          }
        } else if (q.includes("SET status = 'queued'") && q.includes('WHERE id = ?')) {
          const row = queue.get(String(params[0]));
          if (row) {
            row.status = 'queued';
            if (q.includes('dispatched_at = NULL')) row.dispatched_at = null;
          }
        } else if (q.includes("SET status = 'processing' WHERE id = ?")) {
          const row = queue.get(String(params[0]));
          if (row) row.status = 'processing';
        } else if (q.includes("SET status = 'completed' WHERE id = ?")) {
          const row = queue.get(String(params[0]));
          if (row) row.status = 'completed';
        }
        return cursor([]);
      }

      if (q.startsWith('DELETE FROM prompt_queue')) {
        if (q.includes("status = 'completed'")) {
          for (const [id, row] of queue.entries()) {
            if (row.status === 'completed') queue.delete(id);
          }
        } else if (q.includes("status = 'queued' AND channel_key = ?")) {
          const channelKey = String(params[0]);
          for (const [id, row] of queue.entries()) {
            if (row.status === 'queued' && row.channel_key === channelKey) queue.delete(id);
          }
        } else if (q.includes("status = 'queued'")) {
          for (const [id, row] of queue.entries()) {
            if (row.status === 'queued') queue.delete(id);
          }
        } else if (q.includes('WHERE id = ?')) {
          queue.delete(String(params[0]));
        } else {
          queue.clear();
        }
        return cursor([]);
      }

      if (q.startsWith('INSERT INTO interactive_prompts') || q.startsWith('INSERT OR REPLACE INTO interactive_prompts')) {
        const hasBodyColumn = q.includes('body, actions');
        interactivePrompts.set(String(params[0]), {
          id: String(params[0]),
          type: String(q.includes("'approval'") ? 'approval' : 'question'),
          request_id: (params[1] as string) || null,
          title: String(params[2] ?? ''),
          body: hasBodyColumn ? String(params[3] ?? '') : null,
          actions: String(params[hasBodyColumn ? 4 : 3] ?? ''),
          context: String(params[hasBodyColumn ? 5 : 4] ?? ''),
          status: 'pending',
          expires_at: typeof params[hasBodyColumn ? 6 : 5] === 'number' ? params[hasBodyColumn ? 6 : 5] as number : null,
          channel_refs: null,
        });
        return cursor([]);
      }

      if (q.startsWith('SELECT') && q.includes('FROM interactive_prompts')) {
        if (q.includes('WHERE id = ?')) {
          const row = interactivePrompts.get(String(params[0]));
          if (!row) return cursor([]);
          if (q.includes("status = 'pending'") && row.status !== 'pending') return cursor([]);
          return cursor([row]);
        }
        let rows = Array.from(interactivePrompts.values());
        if (q.includes("status = 'pending'")) {
          rows = rows.filter((row) => row.status === 'pending');
        }
        if (q.includes('expires_at IS NOT NULL') && typeof params[0] === 'number') {
          rows = rows.filter((row) => row.expires_at !== null && row.expires_at <= Number(params[0]));
        }
        return cursor(rows);
      }

      if (q.startsWith("UPDATE interactive_prompts SET status = 'resolving'")) {
        const row = interactivePrompts.get(String(params[0]));
        if (row?.status === 'pending') {
          row.status = 'resolving';
          return cursor(q.includes('RETURNING') ? [{ id: row.id }] : []);
        }
        return cursor([]);
      }

      if (q.startsWith("UPDATE interactive_prompts SET status = 'pending'")) {
        const row = interactivePrompts.get(String(params[0]));
        if (row?.status === 'resolving') row.status = 'pending';
        return cursor([]);
      }

      if (q.startsWith('UPDATE interactive_prompts SET channel_refs = ? WHERE id = ?')) {
        const row = interactivePrompts.get(String(params[1]));
        if (row) row.channel_refs = (params[0] as string) || null;
        return cursor([]);
      }

      if (q.startsWith('DELETE FROM interactive_prompts')) {
        interactivePrompts.delete(String(params[0]));
        return cursor([]);
      }

      return cursor([]);
    },
  } as unknown as SqlStorage & {
    queue: Map<string, QueueRow>;
    state: Map<string, string>;
    interactivePrompts: Map<string, InteractivePromptRow>;
    messages: Map<string, Record<string, unknown>>;
    channelState: Map<string, { busy: number; opencode_session_id: string | null; idle_queued_since: number | null; error_safety_net_at: number | null }>;
  };
}

function createMockCtx() {
  const sql = createMockSql();
  let initPromise: Promise<void> = Promise.resolve();
  const waitUntil = vi.fn((promise: Promise<unknown>) => promise);
  const acceptedSockets: Array<{ socket: unknown; tags: string[] }> = [];

  const ctx = {
    storage: {
      sql,
      setAlarm: vi.fn(),
      getAlarm: vi.fn(),
    },
    blockConcurrencyWhile(fn: () => Promise<void>) {
      initPromise = Promise.resolve(fn());
      return initPromise;
    },
    acceptWebSocket(socket: unknown, tags: string[]) {
      acceptedSockets.push({ socket, tags });
    },
    getWebSockets: vi.fn(() => []),
    getTags(socket: unknown) {
      return acceptedSockets.find((entry) => entry.socket === socket)?.tags ?? [];
    },
    waitUntil,
  } as unknown as DurableObjectState;

  return { ctx, sql, waitUntil, initPromise: () => initPromise, acceptedSockets };
}

function createMockDb(options?: {
  threadRow?: { session_id?: string | null; opencode_session_id?: string | null } | null;
  threadMessages?: Array<{ role?: string; content?: string }>;
}) {
  return {
    prepare: vi.fn((query: string) => ({
      bind: vi.fn(() => ({
        first: vi.fn().mockResolvedValue(
          query.includes('FROM session_threads')
            ? (options?.threadRow ?? null)
            : null
        ),
        run: vi.fn().mockResolvedValue({ success: true }),
        all: vi.fn().mockResolvedValue({
          results: query.includes('FROM messages')
            ? (options?.threadMessages ?? [])
            : [],
        }),
      })),
    })),
  };
}

async function createTestAgent(opts?: {
  sockets?: Array<{ send: ReturnType<typeof vi.fn> }>;
  dbOptions?: {
    threadRow?: { session_id?: string | null; opencode_session_id?: string | null } | null;
    threadMessages?: Array<{ role?: string; content?: string }>;
  };
}) {
  const { ctx, sql, waitUntil, initPromise } = createMockCtx();
  const sockets = opts?.sockets ?? [];
  (ctx.getWebSockets as unknown as ReturnType<typeof vi.fn>).mockReturnValue(sockets);

  const agent = new SessionAgentDO(ctx, { DB: createMockDb(opts?.dbOptions) } as any);
  await initPromise();

  (agent as any).sessionState.set('sessionId', 'orchestrator:user-1');
  (agent as any).sessionState.set('userId', 'user-1');
  (agent as any).sessionState.set('status', 'running');

  const broadcasts: Array<Record<string, unknown>> = [];
  (agent as any).broadcastToClients = vi.fn((message: Record<string, unknown>) => {
    broadcasts.push(message);
  });
  (agent as any).sendChannelInteractivePrompts = vi.fn().mockResolvedValue(undefined);
  (agent as any).notifyEventBus = vi.fn();
  (agent as any).emitEvent = vi.fn();
  (agent as any).emitAuditEvent = vi.fn();
  (agent as any).flushMessagesToD1 = vi.fn().mockResolvedValue(undefined);
  (agent as any).isUserConnected = vi.fn().mockReturnValue(true);
  (agent as any).sendToastToUser = vi.fn();
  (agent as any).enqueueOwnerNotification = vi.fn().mockResolvedValue(undefined);
  (agent as any).getUserDetails = vi.fn().mockResolvedValue(undefined);
  (agent as any).resolveModelPreferences = vi.fn().mockResolvedValue([]);
  (agent as any).rescheduleIdleAlarm = vi.fn();
  (agent as any).lifecycle.touchActivity = vi.fn();

  return { agent, sql, waitUntil, broadcasts, ctx, sockets };
}

describe('SessionAgentDO', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('does not reuse stale Slack channel context for a later web-only question', async () => {
    const { agent, sql, waitUntil, broadcasts } = await createTestAgent();
    const sendChannelInteractivePrompts = (agent as any).sendChannelInteractivePrompts as ReturnType<typeof vi.fn>;

    (agent as any).promptQueue.enqueue({
      id: 'slack-turn',
      content: 'from slack',
      status: 'processing',
      channelType: 'slack',
      channelId: 'thread-123',
      channelKey: 'thread:thread-123',
      replyChannelType: 'slack',
      replyChannelId: 'C123',
    });
    // received_at is stamped automatically by enqueue.

    await (agent as any).handlePromptComplete();

    (agent as any).promptQueue.enqueue({
      id: 'web-turn',
      content: 'from web',
      status: 'processing',
      channelType: 'web',
      channelId: 'default',
      channelKey: 'web:default',
    });

    await (agent as any).runnerHandlers.question({
      type: 'question',
      messageId: 'web-turn',
      questionId: 'q-web',
      text: 'Need a decision',
      options: ['Yes', 'No'],
    });

    const promptMessage = broadcasts.find((message) => message.type === 'interactive_prompt');
    expect(promptMessage).toBeTruthy();
    // Channel is attributed from the prompt_queue row for the current prompt.
    expect(promptMessage).toMatchObject({ channelType: 'web', channelId: 'default' });
    expect(promptMessage?.prompt).toMatchObject({
      id: 'q-web',
      type: 'question',
      context: { options: ['Yes', 'No'], channelType: 'web', channelId: 'default' },
    });

    expect(sendChannelInteractivePrompts).toHaveBeenCalledOnce();
    expect(sendChannelInteractivePrompts).toHaveBeenCalledWith(
      'q-web',
      expect.objectContaining({
        context: expect.objectContaining({
          options: ['Yes', 'No'],
          channelType: 'web',
          channelId: 'default',
        }),
      }),
    );
    expect(waitUntil).toHaveBeenCalledOnce();

    const storedPrompt = sql.interactivePrompts.get('q-web');
    expect(storedPrompt).toBeTruthy();
    expect(JSON.parse(storedPrompt!.context)).toEqual({
      options: ['Yes', 'No'],
      channelType: 'web',
      channelId: 'default',
    });
  });

  it('re-arms the alarm when idle hibernation is the only pending deadline', async () => {
    const { agent } = await createTestAgent();

    (agent as any).sessionState.idleTimeoutMs = 60_000;
    (agent as any).sessionState.lastUserActivityAt = Date.now() - 1_000;

    const scheduleAlarm = vi.spyOn((agent as any).lifecycle, 'scheduleAlarm');

    await agent.alarm();

    expect(scheduleAlarm).toHaveBeenCalledTimes(1);
  });

  it('logs loudly when sandbox_lost happens near the Modal 24h hard timeout', async () => {
    const { agent } = await createTestAgent();
    const now = 1_779_300_000_000;
    const twentyFourHoursMs = 24 * 60 * 60 * 1000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    (agent as any).sessionState.sandboxStartedAt = now - twentyFourHoursMs - 30_000;
    (agent as any).sessionState.sandboxId = 'sb-24h';
    (agent as any).sessionState.backendUrl = 'https://backend/create-session';
    (agent as any).sessionState.spawnRequest = { sessionId: 'orchestrator:user-1' };
    (agent as any).spawnSandbox = vi.fn().mockResolvedValue(undefined);

    await (agent as any).performRecovery('sandbox_lost');

    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('Modal sandbox hard timeout edge'));
    expect((agent as any).emitEvent).toHaveBeenCalledWith('session.recovery', {
      summary: 'modal_sandbox_hard_timeout_edge',
      properties: expect.objectContaining({
        reason: 'sandbox_lost',
        sandboxId: 'sb-24h',
        sandboxAgeMs: twentyFourHoursMs + 30_000,
        modalTimeoutMs: twentyFourHoursMs,
      }),
    });
  });

  it('sends a minimal init payload during client websocket upgrade', async () => {
    const send = vi.fn();
    const serverSocket = { send };
    const clientSocket = {};
    class MockWebSocketPair {
      0 = clientSocket;
      1 = serverSocket;
    }
    vi.stubGlobal('WebSocketPair', MockWebSocketPair as unknown as typeof WebSocketPair);

    const { agent, ctx } = await createTestAgent();
    (agent as any).sessionState.set('workspace', '/workspace/project');
    (agent as any).sessionState.set('title', 'Latency test');
    (agent as any).sessionState.set('sandboxId', 'sandbox-123');
    (agent as any).promptQueue.runnerBusy = true;
    (agent as any).promptQueue.enqueue({
      id: 'queued-turn',
      content: 'hello',
      status: 'queued',
    });

    await (agent as any).upgradeClient(
      new Request('https://example.com/api/sessions/test/ws?role=client&userId=user-1', {
        headers: { Upgrade: 'websocket' },
      }),
      new URL('https://example.com/api/sessions/test/ws?role=client&userId=user-1'),
    ).catch((err: unknown) => {
      // Node's Response implementation rejects status 101, but the init frame
      // has already been sent by this point, which is what this test verifies.
      expect(err).toBeInstanceOf(RangeError);
    });

    expect((ctx as any).acceptWebSocket).toBeDefined();
    expect(send).toHaveBeenCalled();

    const initMessage = JSON.parse(send.mock.calls[0][0] as string);
    expect(initMessage.type).toBe('init');
    expect(initMessage.session).toEqual({
      id: 'orchestrator:user-1',
      status: 'running',
      workspace: '/workspace/project',
      title: 'Latency test',
    });
    expect(initMessage.data).toMatchObject({
      sandboxRunning: true,
      runnerConnected: false,
      runnerBusy: true,
      promptsQueued: 1,
      connectedClients: 1,
    });
    expect(initMessage.session).not.toHaveProperty('messages');
    expect(initMessage.data).not.toHaveProperty('availableModels');
    expect(initMessage.data).not.toHaveProperty('auditLog');
  });

  it('tags assistant messages with the thread from the Runner-provided message.create envelope', async () => {
    const runnerSocket = { send: vi.fn() };
    const { agent, broadcasts } = await createTestAgent({ sockets: [runnerSocket] });

    await (agent as any).handlePrompt(
      'continue this thread',
      undefined,
      undefined,
      undefined,
      'web',
      'default',
      'thread-direct',
    );

    // Runner derives threadId from extractChannelContext and sends it explicitly
    await (agent as any).runnerHandlers['message.create']({
      type: 'message.create',
      turnId: 'turn-direct',
      threadId: 'thread-direct',
    });

    const created = broadcasts.find((message) => {
      const data = message.data as Record<string, unknown> | undefined;
      return message.type === 'message' && data?.id === 'turn-direct';
    });
    expect((created?.data as Record<string, unknown> | undefined)).toMatchObject({
      id: 'turn-direct',
      threadId: 'thread-direct',
    });
  });

  it('hydrates a persisted OpenCode session id for a cold resumed thread before dispatch', async () => {
    const runnerSocket = { send: vi.fn() };
    const { agent } = await createTestAgent({
      sockets: [runnerSocket],
      dbOptions: {
        threadRow: {
          session_id: 'orchestrator:user-1:old',
          opencode_session_id: 'persisted-thread-session',
        },
      },
    });

    await (agent as any).handlePrompt(
      'resume persisted thread',
      undefined,
      undefined,
      undefined,
      'web',
      'default',
      'thread-persisted',
    );

    const sent = JSON.parse(runnerSocket.send.mock.calls.at(-1)?.[0] as string);
    expect(sent).toMatchObject({
      type: 'prompt',
      threadId: 'thread-persisted',
      channelType: 'thread',
      channelId: 'thread-persisted',
      opencodeSessionId: 'persisted-thread-session',
    });
  });

  it('hydrates both persisted session id and fallback continuation context for a cold resumed thread', async () => {
    const runnerSocket = { send: vi.fn() };
    const { agent } = await createTestAgent({
      sockets: [runnerSocket],
      dbOptions: {
        threadRow: {
          session_id: 'orchestrator:user-1:old',
          opencode_session_id: 'persisted-thread-session',
        },
        threadMessages: [
          { role: 'assistant', content: 'Earlier answer' },
          { role: 'user', content: 'Earlier question' },
        ],
      },
    });

    await (agent as any).handlePrompt(
      'resume persisted thread with fallback',
      undefined,
      undefined,
      undefined,
      'web',
      'default',
      'thread-persisted-fallback',
    );

    const sent = JSON.parse(runnerSocket.send.mock.calls.at(-1)?.[0] as string);
    expect(sent).toMatchObject({
      type: 'prompt',
      threadId: 'thread-persisted-fallback',
      channelType: 'thread',
      channelId: 'thread-persisted-fallback',
      opencodeSessionId: 'persisted-thread-session',
      continuationContext: '[user]: Earlier question\n[assistant]: Earlier answer',
    });
  });

  it('hydrates continuation context for a cold legacy thread before dispatch', async () => {
    const runnerSocket = { send: vi.fn() };
    const { agent } = await createTestAgent({
      sockets: [runnerSocket],
      dbOptions: {
        threadRow: {
          session_id: 'orchestrator:user-1:old',
          opencode_session_id: null,
        },
        threadMessages: [
          { role: 'assistant', content: 'Earlier answer' },
          { role: 'user', content: 'Earlier question' },
        ],
      },
    });

    await (agent as any).handlePrompt(
      'resume legacy thread',
      undefined,
      undefined,
      undefined,
      'web',
      'default',
      'thread-legacy',
    );

    const sent = JSON.parse(runnerSocket.send.mock.calls.at(-1)?.[0] as string);
    expect(sent).toMatchObject({
      type: 'prompt',
      threadId: 'thread-legacy',
      channelType: 'thread',
      channelId: 'thread-legacy',
      continuationContext: '[user]: Earlier question\n[assistant]: Earlier answer',
    });
    expect(sent.opencodeSessionId).toBeUndefined();
  });

  it('tags assistant messages with the thread from a dispatched queued prompt', async () => {
    const runnerSocket = { send: vi.fn() };
    const { agent, broadcasts } = await createTestAgent({ sockets: [runnerSocket] });

    (agent as any).promptQueue.enqueue({
      id: 'queued-threaded',
      content: 'queued work',
      status: 'queued',
      channelType: 'thread',
      channelId: 'thread-queued',
      channelKey: 'thread:thread-queued',
      threadId: 'thread-queued',
    });

    const dispatched = await (agent as any).sendNextQueuedPrompt();
    expect(dispatched).toBe(true);

    // Runner echoes threadId back on message.create envelope
    await (agent as any).runnerHandlers['message.create']({
      type: 'message.create',
      turnId: 'turn-queued',
      threadId: 'thread-queued',
    });

    const created = broadcasts.find((message) => {
      const data = message.data as Record<string, unknown> | undefined;
      return message.type === 'message' && data?.id === 'turn-queued';
    });
    expect((created?.data as Record<string, unknown> | undefined)).toMatchObject({
      id: 'turn-queued',
      threadId: 'thread-queued',
    });
  });

  it('preserves threadId through tool updates and finalize once the turn is created', async () => {
    const { agent, broadcasts } = await createTestAgent();
    // Runner provides threadId explicitly on message.create; no queue fallback.
    (agent as any).promptQueue.enqueue({
      id: 'prompt-parts',
      content: 'threaded work',
      status: 'processing',
      channelType: 'thread',
      channelId: 'thread-parts',
      channelKey: 'thread:thread-parts',
      threadId: 'thread-parts',
    });

    await (agent as any).runnerHandlers['message.create']({
      type: 'message.create',
      turnId: 'turn-parts',
      threadId: 'thread-parts',
    });
    await (agent as any).runnerHandlers['message.part.tool-update']({
      type: 'message.part.tool-update',
      turnId: 'turn-parts',
      callId: 'tool-1',
      toolName: 'channel_reply',
      status: 'completed',
      result: { ok: true },
    });
    await (agent as any).runnerHandlers['message.finalize']({
      type: 'message.finalize',
      turnId: 'turn-parts',
      reason: 'end_turn',
      finalText: 'done',
    });

    const updates = broadcasts.filter((message) => message.type === 'message.updated');
    expect(updates).not.toHaveLength(0);
    for (const update of updates) {
      const data = update.data as Record<string, unknown> | undefined;
      expect(data?.threadId).toBe('thread-parts');
    }
  });

  it('does not mirror text channel replies into the web UI', async () => {
    const { agent, broadcasts } = await createTestAgent();
    const runnerSend = vi.fn();
    (agent as any).runnerLink.send = runnerSend;
    (agent as any).channelRouter = {
      sendReply: vi.fn().mockResolvedValue({ success: true }),
    };
    (agent as any).promptQueue.enqueue({
      id: 'prompt-channel-reply',
      content: 'threaded Telegram prompt',
      status: 'processing',
      channelType: 'thread',
      channelId: 'thread-telegram',
      channelKey: 'thread:thread-telegram',
      threadId: 'thread-telegram',
      replyChannelType: 'telegram',
      replyChannelId: 'chat-123',
    });

    await (agent as any).handleChannelReply(
      'reply-request-1',
      'telegram',
      'chat-123',
      'No voice note came through on my end.',
      undefined,
      undefined,
      true,
    );

    expect((agent as any).channelRouter.sendReply).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        channelType: 'telegram',
        channelId: 'chat-123',
        message: 'No voice note came through on my end.',
      }),
    );
    expect(runnerSend).toHaveBeenCalledWith({ type: 'channel-reply-result', requestId: 'reply-request-1', success: true });
    const mirrored = broadcasts.find((message) => {
      const data = message.data as Record<string, unknown> | undefined;
      return message.type === 'message' && data?.content === 'No voice note came through on my end.';
    });
    expect(mirrored).toBeUndefined();
  });

  it('does not leak thread ID from a Telegram turn into a subsequent web-UI turn', async () => {
    const runnerSocket = { send: vi.fn() };
    const { agent, broadcasts } = await createTestAgent({ sockets: [runnerSocket] });

    // Turn 1: Telegram prompt with a threadId
    await (agent as any).handlePrompt(
      'telegram message',
      undefined,
      undefined,
      undefined,
      'telegram',
      'chat-123',
      'thread-telegram',
      undefined, // continuationContext
      undefined, // contextPrefix
      { channelType: 'telegram', channelId: 'chat-123' }, // replyTo
    );

    // Complete turn 1
    await (agent as any).handlePromptComplete();

    // Turn 2: web-UI prompt with NO threadId
    await (agent as any).handlePrompt(
      'web message',
      undefined,
      undefined,
      undefined,
      'web',
      'default',
      undefined, // no threadId
    );

    // Runner sends message.create for turn 2
    await (agent as any).runnerHandlers['message.create']({
      type: 'message.create',
      turnId: 'turn-web',
    });

    const created = broadcasts.find((message) => {
      const data = message.data as Record<string, unknown> | undefined;
      return message.type === 'message' && data?.id === 'turn-web';
    });
    // The web turn must NOT have the Telegram threadId
    expect((created?.data as Record<string, unknown> | undefined)?.threadId).toBeUndefined();
  });

  it('preserves original array parts when building forwarded message parts', () => {
    expect(buildForwardedParts(
      [{ type: 'text', text: 'full forwarded text' }],
      {
        forwarded: true,
        sourceSessionId: 'child-1',
        sourceSessionTitle: 'child-1',
        originalRole: 'assistant',
        originalCreatedAt: '2026-04-06T12:00:00.000Z',
        originalMessageId: 'child-msg-1',
        originalSessionId: 'child-1',
      },
    )).toEqual([
      { type: 'text', text: 'full forwarded text' },
      {
        forwarded: true,
        sourceSessionId: 'child-1',
        sourceSessionTitle: 'child-1',
        originalRole: 'assistant',
        originalCreatedAt: '2026-04-06T12:00:00.000Z',
        originalMessageId: 'child-msg-1',
        originalSessionId: 'child-1',
      },
    ]);
  });

  it('accepts ISO timestamps for the /messages after cursor', async () => {
    const { agent } = await createTestAgent();
    const getMessages = vi.spyOn((agent as any).messageStore, 'getMessages').mockReturnValue([]);
    const after = '2026-04-06T12:00:00.000Z';

    await agent.fetch(new Request(`http://do/messages?after=${encodeURIComponent(after)}`));

    expect(getMessages).toHaveBeenCalledWith(expect.objectContaining({
      afterCreatedAt: 1775476800,
    }))
  });

  it('withdrawQueued removes and returns the single queued user prompt', async () => {
    const { agent } = await createTestAgent();

    (agent as any).promptQueue.enqueue({
      id: 'withdraw-test',
      content: 'pending message',
      status: 'queued',
      channelType: 'web',
      channelId: 'default',
      channelKey: 'web:default',
      threadId: 'thread-1',
      authorId: 'user-1',
      authorEmail: 'user@test.com',
      authorName: 'Test User',
      authorAvatarUrl: 'https://example.com/avatar.png',
    });

    expect((agent as any).promptQueue.length).toBe(1);

    const withdrawn = (agent as any).promptQueue.withdrawQueued();
    expect(withdrawn).toBeTruthy();
    expect(withdrawn.id).toBe('withdraw-test');
    expect(withdrawn.content).toBe('pending message');
    expect(withdrawn.threadId).toBe('thread-1');
    expect(withdrawn.authorAvatarUrl).toBe('https://example.com/avatar.png');
    expect((agent as any).promptQueue.length).toBe(0);
  });

  it('withdrawQueued returns null when no queued user prompt exists', async () => {
    const { agent } = await createTestAgent();
    const withdrawn = (agent as any).promptQueue.withdrawQueued();
    expect(withdrawn).toBeNull();
  });

  it('withdrawQueued does not remove child session events', async () => {
    const { agent } = await createTestAgent();

    (agent as any).promptQueue.enqueue({
      id: 'child-event',
      content: 'child status update',
      status: 'queued',
      childSessionId: 'child-1',
      childStatus: 'terminated',
    });

    const withdrawn = (agent as any).promptQueue.withdrawQueued();
    expect(withdrawn).toBeNull();
    expect((agent as any).promptQueue.length).toBe(1);
  });

  it('peekQueued reads without removing', async () => {
    const { agent } = await createTestAgent();

    (agent as any).promptQueue.enqueue({
      id: 'peek-test',
      content: 'peek content',
      status: 'queued',
      channelType: 'web',
      channelId: 'default',
      channelKey: 'web:default',
    });

    const peeked = (agent as any).promptQueue.peekQueued();
    expect(peeked).toBeTruthy();
    expect(peeked.id).toBe('peek-test');
    expect((agent as any).promptQueue.length).toBe(1); // still there
  });

  it('does not write user message to message store when prompt is queued (runner busy)', async () => {
    const runnerSocket = { send: vi.fn() };
    const { agent, broadcasts } = await createTestAgent({ sockets: [runnerSocket] });

    // Make runner busy
    (agent as any).promptQueue.runnerBusy = true;

    const writeMessageSpy = vi.spyOn((agent as any).messageStore, 'writeMessage');

    await (agent as any).handlePrompt(
      'queued message',
      undefined,
      { id: 'user-1', email: 'u@test.com', name: 'User' },
      undefined,
      'web',
      'default',
      undefined,
    );

    // The message should NOT have been written to the message store
    expect(writeMessageSpy).not.toHaveBeenCalled();

    // The message broadcast should NOT have been sent
    const userMsgBroadcast = broadcasts.find(
      (b) => b.type === 'message' && (b.data as any)?.role === 'user' && (b.data as any)?.content === 'queued message'
    );
    expect(userMsgBroadcast).toBeUndefined();

    // But the queue entry SHOULD exist
    expect((agent as any).promptQueue.length).toBe(1);
  });

  it('writes user message to message store when prompt dispatches directly (runner idle)', async () => {
    const runnerSocket = { send: vi.fn() };
    const { agent } = await createTestAgent({ sockets: [runnerSocket] });

    const writeMessageSpy = vi.spyOn((agent as any).messageStore, 'writeMessage');

    await (agent as any).handlePrompt(
      'direct message',
      undefined,
      { id: 'user-1', email: 'u@test.com', name: 'User' },
      undefined,
      'web',
      'default',
      undefined,
    );

    // The message SHOULD have been written to the message store
    expect(writeMessageSpy).toHaveBeenCalledOnce();
    expect(writeMessageSpy).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'user', content: 'direct message' }),
    );
  });

  it('single-slot enforcement: new followup replaces existing pending', async () => {
    const runnerSocket = { send: vi.fn() };
    const { agent, broadcasts } = await createTestAgent({ sockets: [runnerSocket] });

    (agent as any).promptQueue.runnerBusy = true;

    // Queue first followup
    await (agent as any).handlePrompt(
      'first followup',
      undefined, undefined, undefined,
      'web', 'default', undefined,
    );

    expect((agent as any).promptQueue.length).toBe(1);

    // Queue second followup — should replace the first
    await (agent as any).handlePrompt(
      'second followup',
      undefined, undefined, undefined,
      'web', 'default', undefined,
    );

    expect((agent as any).promptQueue.length).toBe(1);

    // First should have been withdrawn
    const withdrawn = broadcasts.find((b) => b.type === 'queue.withdrawn');
    expect(withdrawn).toBeTruthy();
    expect((withdrawn as any).data.content).toBe('first followup');

    // Queue should contain only the second
    const pending = (agent as any).promptQueue.peekQueued();
    expect(pending.content).toBe('second followup');
  });

  it('preserves separate internal fresh-thread scheduled prompts while runner is not ready', async () => {
    const { agent, broadcasts, sql } = await createTestAgent();

    const existing = await agent.fetch(new Request('http://do/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: 'existing followup',
        threadId: 'thread-existing',
        authorId: 'user-1',
      }),
    }));
    const first = await agent.fetch(new Request('http://do/prompt', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Valet-Prompt-Queue-Policy': 'append',
      },
      body: JSON.stringify({
        content: 'first scheduled prompt',
        threadId: 'thread-scheduled-1',
        authorName: 'Scheduled Task',
        authorEmail: 'scheduled-task@valet.local',
        authorId: 'user-1',
      }),
    }));
    const second = await agent.fetch(new Request('http://do/prompt', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Valet-Prompt-Queue-Policy': 'append',
      },
      body: JSON.stringify({
        content: 'second scheduled prompt',
        threadId: 'thread-scheduled-2',
        authorName: 'Scheduled Task',
        authorEmail: 'scheduled-task@valet.local',
        authorId: 'user-1',
      }),
    }));

    expect(existing.status).toBe(200);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(broadcasts.find((b) => b.type === 'queue.withdrawn')).toBeUndefined();

    const queued = sql
      .exec("SELECT * FROM prompt_queue WHERE status = 'queued' ORDER BY created_at ASC")
      .toArray();
    expect(queued).toHaveLength(3);
    expect(queued.map((row) => row.content)).toEqual(['existing followup', 'first scheduled prompt', 'second scheduled prompt']);
    expect(queued.map((row) => row.thread_id)).toEqual(['thread-existing', 'thread-scheduled-1', 'thread-scheduled-2']);
    expect(queued.map((row) => row.priority)).toEqual([0, 0, 0]);

    expect((agent as any).promptQueue.dequeueNext()?.content).toBe('existing followup');
    expect((agent as any).promptQueue.dequeueNext()?.content).toBe('first scheduled prompt');
    expect((agent as any).promptQueue.dequeueNext()?.content).toBe('second scheduled prompt');
  });

  it('ignores body-only queue preservation from public prompt payloads', async () => {
    const { agent, broadcasts, sql } = await createTestAgent();

    const first = await agent.fetch(new Request('http://do/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: 'first public prompt',
        threadId: 'thread-public-1',
        authorId: 'user-1',
      }),
    }));
    const second = await agent.fetch(new Request('http://do/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: 'second public prompt',
        threadId: 'thread-public-2',
        authorId: 'user-1',
        preserveQueuedPrompts: true,
      }),
    }));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const withdrawn = broadcasts.find((b) => b.type === 'queue.withdrawn');
    expect(withdrawn).toBeTruthy();
    expect((withdrawn as any).data.content).toBe('first public prompt');

    const queued = sql
      .exec("SELECT * FROM prompt_queue WHERE status = 'queued' ORDER BY created_at ASC")
      .toArray();
    expect(queued).toHaveLength(1);
    expect(queued[0].content).toBe('second public prompt');
  });

  it('does not replace internal appended scheduled prompts with a later public prompt', async () => {
    const { agent, broadcasts, sql } = await createTestAgent();

    const scheduled = await agent.fetch(new Request('http://do/prompt', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Valet-Prompt-Queue-Policy': 'append',
      },
      body: JSON.stringify({
        content: 'scheduled prompt',
        threadId: 'thread-scheduled',
        authorName: 'Scheduled Task',
        authorEmail: 'scheduled-task@valet.local',
        authorId: 'user-1',
      }),
    }));
    const user = await agent.fetch(new Request('http://do/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: 'public prompt',
        threadId: 'thread-public',
        authorId: 'user-1',
      }),
    }));

    expect(scheduled.status).toBe(200);
    expect(user.status).toBe(200);
    expect(broadcasts.find((b) => b.type === 'queue.withdrawn')).toBeUndefined();

    const queued = sql
      .exec("SELECT * FROM prompt_queue WHERE status = 'queued' ORDER BY created_at ASC")
      .toArray();
    expect(queued.map((row) => row.content)).toEqual(['scheduled prompt', 'public prompt']);
    expect((agent as any).promptQueue.dequeueNext()?.content).toBe('scheduled prompt');
    expect((agent as any).promptQueue.dequeueNext()?.content).toBe('public prompt');
  });

  it('broadcasts queue.state with pending item after enqueue', async () => {
    const runnerSocket = { send: vi.fn() };
    const { agent, broadcasts } = await createTestAgent({ sockets: [runnerSocket] });

    (agent as any).promptQueue.runnerBusy = true;

    await (agent as any).handlePrompt(
      'queue state test',
      undefined, undefined, undefined,
      'web', 'default', 'thread-qs',
    );

    const queueState = broadcasts.find((b) => b.type === 'queue.state');
    expect(queueState).toBeTruthy();
    expect((queueState as any).data.pending).toBeTruthy();
    expect((queueState as any).data.pending.content).toBe('queue state test');
    expect((queueState as any).data.pending.threadId).toBe('thread-qs');
  });

  it('handleAbort does not clear queued prompts', async () => {
    const runnerSocket = { send: vi.fn() };
    const { agent } = await createTestAgent({ sockets: [runnerSocket] });

    (agent as any).promptQueue.enqueue({
      id: 'pending-1',
      content: 'pending work',
      status: 'queued',
      channelType: 'web',
      channelId: 'default',
      channelKey: 'web:default',
    });

    (agent as any).promptQueue.runnerBusy = true;

    await (agent as any).handleAbort('web', 'default');

    expect((agent as any).promptQueue.length).toBe(1);
    expect(runnerSocket.send).toHaveBeenCalledWith(
      expect.stringContaining('"type":"abort"')
    );
  });

  it('WebSocket abort forwards channelType/channelId so a Stop on one thread is scoped, not global', async () => {
    // Regression: with concurrent cross-thread dispatch enabled, the Stop
    // button must send a channel-scoped abort so the runner aborts only the
    // requested thread's OpenCode session, not every active channel.
    const runnerSocket = { send: vi.fn() };
    const { agent } = await createTestAgent({ sockets: [runnerSocket] });

    (agent as any).promptQueue.runnerBusy = true;

    await (agent as any).handleClientMessage({ send: vi.fn() }, {
      type: 'abort',
      channelType: 'thread',
      channelId: 'thread-stop-me',
    });

    const aborts = runnerSocket.send.mock.calls
      .map((call: unknown[]) => JSON.parse(call[0] as string))
      .filter((msg) => msg.type === 'abort');
    expect(aborts).toHaveLength(1);
    expect(aborts[0]).toMatchObject({
      type: 'abort',
      channelType: 'thread',
      channelId: 'thread-stop-me',
    });
  });

  it('HTTP /prompt interrupt with threadId scopes the abort to that thread', async () => {
    // Stop button can also arrive via HTTP POST /prompt with body.interrupt.
    // It must scope the runner abort using body.threadId / body.channelType.
    const runnerSocket = { send: vi.fn() };
    const { agent } = await createTestAgent({ sockets: [runnerSocket] });

    (agent as any).promptQueue.runnerBusy = true;

    const response = await agent.fetch(new Request('http://do/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ interrupt: true, threadId: 'thread-stop-me' }),
    }));
    expect(response.status).toBe(200);

    const aborts = runnerSocket.send.mock.calls
      .map((call: unknown[]) => JSON.parse(call[0] as string))
      .filter((msg) => msg.type === 'abort');
    expect(aborts).toHaveLength(1);
    expect(aborts[0]).toMatchObject({
      type: 'abort',
      channelType: 'thread',
      channelId: 'thread-stop-me',
    });
  });

  it('aborted frame with channelType/channelId completes the right row under concurrent dispatch (2+ processing rows)', async () => {
    // Regression for R6-F2. Under concurrent cross-thread dispatch, the DO
    // can have 2+ processing rows. If the runner sends `aborted` with no
    // messageId, the old fallback (getProcessingChannelKey) returns null
    // when there are 2+ processing rows — the row stays stuck forever
    // because the stuck-processing watchdog only fires when the runner is
    // disconnected. The runner now forwards channelType/channelId on the
    // aborted frame so the DO can resolve the channel even without a
    // messageId. This test verifies that:
    //   1. Only the row on the acked channel is completed.
    //   2. The sibling channel's row stays processing.
    const { agent } = await createTestAgent();

    (agent as any).promptQueue.enqueue({
      id: 'row-a',
      content: 'A',
      status: 'processing',
      channelType: 'thread',
      channelId: 'thread-a',
      channelKey: 'thread:thread-a',
      threadId: 'thread-a',
    });
    (agent as any).promptQueue.enqueue({
      id: 'row-b',
      content: 'B',
      status: 'processing',
      channelType: 'thread',
      channelId: 'thread-b',
      channelKey: 'thread:thread-b',
      threadId: 'thread-b',
    });
    expect((agent as any).promptQueue.processingCount).toBe(2);

    // Runner sends `aborted` for thread-a — no messageId (e.g. duplicate
    // abort whose activeMessageId was cleared by a sibling frame).
    await (agent as any).runnerHandlers.aborted({
      type: 'aborted',
      channelType: 'thread',
      channelId: 'thread-a',
    });

    // Exactly one row should be completed — the one on the acked channel.
    expect((agent as any).promptQueue.processingCount).toBe(1);
    const sqlRows = (agent as any).ctx.storage.sql
      .exec("SELECT id, status FROM prompt_queue ORDER BY id")
      .toArray();
    expect(sqlRows).toHaveLength(1);
    expect(sqlRows[0]).toMatchObject({ id: 'row-b', status: 'processing' });
  });

  it('aborted frame without messageId or channel falls back without wiping siblings', async () => {
    // Regression for R5-F1+F2 and R6-F4. If the runner sends `aborted`
    // with neither a messageId nor a channel context, the DO must NOT
    // wipe every processing row (old behavior) and must NOT drain the
    // queue for an unrelated channel (R6-F4 — that would surprise the
    // user with a dispatch they never asked for).
    const runnerSocket = { send: vi.fn() };
    const { agent } = await createTestAgent({ sockets: [runnerSocket] });

    (agent as any).promptQueue.enqueue({
      id: 'row-a',
      content: 'A',
      status: 'processing',
      channelType: 'thread',
      channelId: 'thread-a',
      channelKey: 'thread:thread-a',
    });
    (agent as any).promptQueue.enqueue({
      id: 'row-b',
      content: 'B',
      status: 'processing',
      channelType: 'thread',
      channelId: 'thread-b',
      channelKey: 'thread:thread-b',
    });
    // A queued prompt on yet another channel — the drain-skip guard
    // ensures this does NOT get dispatched by the confused-abort frame.
    (agent as any).promptQueue.enqueue({
      id: 'row-c-queued',
      content: 'C',
      status: 'queued',
      channelType: 'thread',
      channelId: 'thread-c',
      channelKey: 'thread:thread-c',
    });

    await (agent as any).runnerHandlers.aborted({ type: 'aborted' });

    // No rows wiped, no queued prompt dispatched.
    const sqlRows = (agent as any).ctx.storage.sql
      .exec("SELECT id, status FROM prompt_queue ORDER BY id")
      .toArray();
    expect(sqlRows).toHaveLength(3);
    expect(sqlRows[0]).toMatchObject({ id: 'row-a', status: 'processing' });
    expect(sqlRows[1]).toMatchObject({ id: 'row-b', status: 'processing' });
    expect(sqlRows[2]).toMatchObject({ id: 'row-c-queued', status: 'queued' });
    // Specifically, the runner did NOT receive a new prompt frame.
    const prompts = runnerSocket.send.mock.calls
      .map((call: unknown[]) => JSON.parse(call[0] as string))
      .filter((msg) => msg.type === 'prompt');
    expect(prompts).toHaveLength(0);
  });

  it('sendNextQueuedPrompt writes user message to message store at dispatch time', async () => {
    const runnerSocket = { send: vi.fn() };
    const { agent, broadcasts } = await createTestAgent({ sockets: [runnerSocket] });

    const writeMessageSpy = vi.spyOn((agent as any).messageStore, 'writeMessage');

    // Enqueue a prompt (simulating deferred write — no message in store yet)
    (agent as any).promptQueue.enqueue({
      id: 'deferred-msg',
      content: 'deferred content',
      status: 'queued',
      channelType: 'thread',
      channelId: 'thread-abc',
      channelKey: 'thread:thread-abc',
      threadId: 'thread-abc',
      authorId: 'user-1',
      authorEmail: 'u@test.com',
      authorName: 'Test User',
      authorAvatarUrl: 'https://example.com/avatar.png',
    });

    // Before dispatch: message should NOT have been written
    expect(writeMessageSpy).not.toHaveBeenCalled();

    // Dispatch
    const dispatched = await (agent as any).sendNextQueuedPrompt();
    expect(dispatched).toBe(true);

    // After dispatch: message SHOULD have been written
    expect(writeMessageSpy).toHaveBeenCalledOnce();
    expect(writeMessageSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'deferred-msg',
        role: 'user',
        content: 'deferred content',
        author: expect.objectContaining({
          id: 'user-1',
          email: 'u@test.com',
          name: 'Test User',
          avatarUrl: 'https://example.com/avatar.png',
        }),
      }),
    );

    // User message should have been broadcast to clients
    const userMsgBroadcast = broadcasts.find(
      (b) => b.type === 'message' && (b.data as any)?.id === 'deferred-msg' && (b.data as any)?.role === 'user'
    );
    expect(userMsgBroadcast).toBeTruthy();
    expect((userMsgBroadcast?.data as any).authorAvatarUrl).toBe('https://example.com/avatar.png');

    // queue.state should have been broadcast with pending: null
    const queueState = broadcasts.find((b) => b.type === 'queue.state');
    expect(queueState?.data).toMatchObject({ pending: null });
  });

  it('stuck-processing watchdog targets the OLDEST in-flight row, not the most recent', async () => {
    // Regression for the per-row dispatched_at design: with cross-thread
    // concurrent dispatch, MAX(dispatched_at) would let a fresh sibling
    // dispatch push the deadline forward forever. We require MIN semantics
    // so a wedged row from T=0 is still detectable when sibling dispatches
    // continue at T=4min.
    const { agent } = await createTestAgent();
    const now = Date.now();

    // Old row dispatched 6 minutes ago (past the 5-minute stuck threshold).
    (agent as any).promptQueue.enqueue({
      id: 'msg-old',
      content: 'wedged',
      status: 'processing',
      channelType: 'thread', channelId: 'thread-old', channelKey: 'thread:thread-old', threadId: 'thread-old',
    });
    (agent as any).ctx.storage.sql.exec(
      'UPDATE prompt_queue SET dispatched_at = ? WHERE id = ?',
      now - 6 * 60 * 1000,
      'msg-old',
    );

    // Fresh row dispatched 10 seconds ago — pre-fix MAX would mask the wedge.
    (agent as any).promptQueue.enqueue({
      id: 'msg-fresh',
      content: 'healthy',
      status: 'processing',
      channelType: 'thread', channelId: 'thread-fresh', channelKey: 'thread:thread-fresh', threadId: 'thread-fresh',
    });
    (agent as any).ctx.storage.sql.exec(
      'UPDATE prompt_queue SET dispatched_at = ? WHERE id = ?',
      now - 10 * 1000,
      'msg-fresh',
    );

    const snapshot = (agent as any).buildHealthSnapshot();
    // OLDEST dispatched_at is the wedged row's stamp, not the fresh one.
    expect(snapshot.oldestProcessingDispatchedAt).toBe(now - 6 * 60 * 1000);
    expect(snapshot.stuckProcessingMessageId).toBe('msg-old');
  });

  it('sendNextQueuedPrompt drains every cross-channel queued prompt in one pass', async () => {
    // Regression for the scheduled-trigger burst: three manual triggers fire
    // before the runner is ready, all three get queued (PR #42's preservation
    // path), and the wake-time drain has to dispatch all three — not just one
    // at a time waiting for each to finish.
    const runnerSocket = { send: vi.fn() };
    const { agent } = await createTestAgent({ sockets: [runnerSocket] });

    for (const threadId of ['thread-a', 'thread-b', 'thread-c']) {
      (agent as any).promptQueue.enqueue({
        id: `msg-${threadId}`,
        content: `prompt for ${threadId}`,
        status: 'queued',
        channelType: 'thread',
        channelId: threadId,
        channelKey: `thread:${threadId}`,
        threadId,
      });
    }

    const dispatched = await (agent as any).sendNextQueuedPrompt();
    expect(dispatched).toBe(true);

    // All three prompt frames should have been sent to the runner.
    const sentPrompts = runnerSocket.send.mock.calls
      .map((call: unknown[]) => JSON.parse(call[0] as string))
      .filter((msg) => msg.type === 'prompt');
    const sentIds = sentPrompts.map((msg: { messageId: string }) => msg.messageId).sort();
    expect(sentIds).toEqual(['msg-thread-a', 'msg-thread-b', 'msg-thread-c']);

    // Queue should be empty and each channel marked busy.
    expect((agent as any).promptQueue.length).toBe(0);
    expect((agent as any).promptQueue.isChannelBusy('thread:thread-a')).toBe(true);
    expect((agent as any).promptQueue.isChannelBusy('thread:thread-b')).toBe(true);
    expect((agent as any).promptQueue.isChannelBusy('thread:thread-c')).toBe(true);
  });

  it('sendNextQueuedPrompt filters subsequent child events against the wait subscription that was set at drain entry', async () => {
    // dispatchQueuedPromptEntry clears sessionState.waitSubscription on every
    // successful dispatch. The picker must use a snapshot taken at drain entry
    // so iter 2+ still filters out non-matching child events.
    const runnerSocket = { send: vi.fn() };
    const { agent } = await createTestAgent({ sockets: [runnerSocket] });

    (agent as any).sessionState.waitSubscription = {
      sessionIds: ['child-X'],
      notifyOn: 'status_change',
    };

    // Item 1: a user prompt with no childSessionId — picks up first (FIFO),
    // dispatcher clears waitSubscription as a side effect.
    (agent as any).promptQueue.enqueue({
      id: 'msg-user',
      content: 'user prompt',
      status: 'queued',
      channelType: 'thread',
      channelId: 'thread-user',
      channelKey: 'thread:thread-user',
      threadId: 'thread-user',
    });
    // Item 2: a queued child event from a session OUTSIDE the wait subscription.
    // Under the snapshot, the picker must drop it.
    (agent as any).promptQueue.enqueue({
      id: 'evt-child-Y',
      content: 'child event from non-subscribed session',
      status: 'queued',
      childSessionId: 'child-Y',
      childStatus: 'running',
    });

    const dispatched = await (agent as any).sendNextQueuedPrompt();
    expect(dispatched).toBe(true);

    const sentIds = runnerSocket.send.mock.calls
      .map((call: unknown[]) => JSON.parse(call[0] as string))
      .filter((m) => m.type === 'prompt')
      .map((m: { messageId: string }) => m.messageId);
    expect(sentIds).toEqual(['msg-user']);

    // The non-matching child event must have been dropped (via dropEntry),
    // not dispatched and not left queued.
    expect((agent as any).promptQueue.length).toBe(0);
  });

  it('sendNextQueuedPrompt isolates per-item dispatch exceptions instead of reverting earlier in-flight dispatches', async () => {
    // If dispatchQueuedPromptEntry throws mid-drain, only the failing row
    // should revert; earlier successful dispatches must stay 'processing' so
    // the runner's eventual complete attributes to them correctly.
    const runnerSocket = { send: vi.fn() };
    const { agent } = await createTestAgent({ sockets: [runnerSocket] });

    (agent as any).promptQueue.enqueue({
      id: 'msg-ok',
      content: 'will dispatch',
      status: 'queued',
      channelType: 'thread',
      channelId: 'thread-ok',
      channelKey: 'thread:thread-ok',
      threadId: 'thread-ok',
    });
    (agent as any).promptQueue.enqueue({
      id: 'msg-throws',
      content: 'will throw',
      status: 'queued',
      channelType: 'thread',
      channelId: 'thread-throws',
      channelKey: 'thread:thread-throws',
      threadId: 'thread-throws',
    });

    // Make the second item's dispatch fail with a synchronous throw inside
    // the dispatch body. resolveModelPreferences is awaited per-item; override
    // it to return [] for the first call and throw on the second.
    let resolveCallCount = 0;
    (agent as any).resolveModelPreferences = vi.fn().mockImplementation(async () => {
      resolveCallCount += 1;
      if (resolveCallCount === 2) throw new Error('synthetic D1 failure');
      return [];
    });

    const dispatched = await (agent as any).sendNextQueuedPrompt();
    expect(dispatched).toBe(true); // msg-ok succeeded

    // msg-ok was sent, msg-throws was not.
    const sentIds = runnerSocket.send.mock.calls
      .map((call: unknown[]) => JSON.parse(call[0] as string))
      .filter((m) => m.type === 'prompt')
      .map((m: { messageId: string }) => m.messageId);
    expect(sentIds).toEqual(['msg-ok']);

    // Critically: msg-ok stays 'processing' (so the eventual runner complete
    // attributes), msg-throws is back to 'queued' for retry.
    const rows = (agent as any).ctx.storage.sql
      .exec("SELECT id, status FROM prompt_queue ORDER BY id ASC")
      .toArray();
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'msg-ok', status: 'processing' }),
      expect.objectContaining({ id: 'msg-throws', status: 'queued' }),
    ]));
  });

  it('sendNextQueuedPrompt leaves entries queued whose channel is already busy', async () => {
    // Cross-channel drain must not steal a slot on a channel that's still
    // processing — that row stays queued until the channel completes.
    const runnerSocket = { send: vi.fn() };
    const { agent } = await createTestAgent({ sockets: [runnerSocket] });

    (agent as any).promptQueue.setChannelBusy('thread:thread-busy', true);

    (agent as any).promptQueue.enqueue({
      id: 'msg-busy',
      content: 'cannot dispatch yet',
      status: 'queued',
      channelType: 'thread',
      channelId: 'thread-busy',
      channelKey: 'thread:thread-busy',
      threadId: 'thread-busy',
    });
    (agent as any).promptQueue.enqueue({
      id: 'msg-free',
      content: 'free to dispatch',
      status: 'queued',
      channelType: 'thread',
      channelId: 'thread-free',
      channelKey: 'thread:thread-free',
      threadId: 'thread-free',
    });

    const dispatched = await (agent as any).sendNextQueuedPrompt();
    expect(dispatched).toBe(true);

    const sentIds = runnerSocket.send.mock.calls
      .map((call: unknown[]) => JSON.parse(call[0] as string))
      .filter((msg) => msg.type === 'prompt')
      .map((msg: { messageId: string }) => msg.messageId);
    expect(sentIds).toEqual(['msg-free']);

    // The busy-channel row stays queued for the next drain cycle.
    expect((agent as any).promptQueue.length).toBe(1);
    const remaining = (agent as any).ctx.storage.sql
      .exec("SELECT id, status FROM prompt_queue WHERE status = 'queued'")
      .toArray();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({ id: 'msg-busy', status: 'queued' });
  });

  it('queue.withdraw removes pending and broadcasts content', async () => {
    const { agent, broadcasts } = await createTestAgent();
    const mockWs = { send: vi.fn() };

    (agent as any).promptQueue.enqueue({
      id: 'pending-withdraw',
      content: 'withdraw me',
      status: 'queued',
      channelType: 'web',
      channelId: 'default',
      channelKey: 'web:default',
      threadId: 'thread-1',
    });

    await (agent as any).handleClientMessage(mockWs, {
      type: 'queue.withdraw',
    });

    expect((agent as any).promptQueue.length).toBe(0);

    const withdrawn = broadcasts.find((b) => b.type === 'queue.withdrawn');
    expect(withdrawn).toBeTruthy();
    expect((withdrawn as any).data.messageId).toBe('pending-withdraw');
    expect((withdrawn as any).data.content).toBe('withdraw me');
    expect((withdrawn as any).data.threadId).toBe('thread-1');

    // Should also broadcast queue.state with pending: null
    const queueState = broadcasts.find((b) => b.type === 'queue.state');
    expect(queueState?.data).toMatchObject({ pending: null });
  });

  it('queue.withdraw is silent no-op when nothing is queued', async () => {
    const { agent, broadcasts } = await createTestAgent();
    const mockWs = { send: vi.fn() };

    await (agent as any).handleClientMessage(mockWs, {
      type: 'queue.withdraw',
    });

    const withdrawn = broadcasts.find((b) => b.type === 'queue.withdrawn');
    expect(withdrawn).toBeUndefined();
  });

  it('queue.promote dispatches directly when runner is idle', async () => {
    const runnerSocket = { send: vi.fn() };
    const { agent } = await createTestAgent({ sockets: [runnerSocket] });

    (agent as any).promptQueue.enqueue({
      id: 'pending-promote',
      content: 'promote me',
      status: 'queued',
      channelType: 'web',
      channelId: 'default',
      channelKey: 'web:default',
    });

    await (agent as any).handleClientMessage({ send: vi.fn() }, {
      type: 'queue.promote',
    });

    // Should have dispatched directly (no abort needed)
    const promptSent = runnerSocket.send.mock.calls.some(
      (call: unknown[]) => JSON.parse(call[0] as string).type === 'prompt'
    );
    expect(promptSent).toBe(true);
  });

  it('queue.replace withdraws old, aborts, and dispatches new content', async () => {
    const runnerSocket = { send: vi.fn() };
    const { agent, broadcasts } = await createTestAgent({ sockets: [runnerSocket] });

    (agent as any).promptQueue.runnerBusy = true;

    (agent as any).promptQueue.enqueue({
      id: 'old-pending',
      content: 'old content',
      status: 'queued',
      channelType: 'web',
      channelId: 'default',
      channelKey: 'web:default',
    });

    await (agent as any).handleClientMessage({ send: vi.fn() }, {
      type: 'queue.replace',
      content: 'new replacement content',
    });

    // Old entry should have been withdrawn
    const withdrawn = broadcasts.find((b) => b.type === 'queue.withdrawn');
    expect(withdrawn).toBeTruthy();
    expect((withdrawn as any).data.content).toBe('old content');

    // Abort should have been sent
    const abortSent = runnerSocket.send.mock.calls.some(
      (call: unknown[]) => JSON.parse(call[0] as string).type === 'abort'
    );
    expect(abortSent).toBe(true);
  });

  it('init payload includes pendingPrompt when a followup is queued', async () => {
    const { agent } = await createTestAgent();

    (agent as any).promptQueue.enqueue({
      id: 'init-pending',
      content: 'queued before connect',
      status: 'queued',
      channelType: 'web',
      channelId: 'default',
      channelKey: 'web:default',
      threadId: 'thread-init',
    });

    const pending = (agent as any).promptQueue.peekQueued();
    expect(pending).toBeTruthy();
    expect(pending.id).toBe('init-pending');
    expect(pending.content).toBe('queued before connect');
    expect(pending.threadId).toBe('thread-init');
    // Queue entry should still exist (peek, not withdraw)
    expect((agent as any).promptQueue.length).toBe(1);
  });

  it('handleClearQueue broadcasts queue.withdrawn for pending user prompt', async () => {
    const { agent, broadcasts } = await createTestAgent();

    (agent as any).promptQueue.enqueue({
      id: 'clear-pending',
      content: 'will be cleared',
      status: 'queued',
      channelType: 'web',
      channelId: 'default',
      channelKey: 'web:default',
    });

    await (agent as any).handleClearQueue(new URL('http://do/clear-queue'));

    const withdrawn = broadcasts.find((b) => b.type === 'queue.withdrawn');
    expect(withdrawn).toBeTruthy();
    expect((withdrawn as any).data.content).toBe('will be cleared');

    const queueState = broadcasts.find((b) => b.type === 'queue.state');
    expect((queueState as any)?.data?.pending).toBeNull();

    expect((agent as any).promptQueue.length).toBe(0);
  });

  it('handleClearQueue scoped to a threadId only withdraws that thread', async () => {
    const { agent, broadcasts } = await createTestAgent();

    (agent as any).promptQueue.enqueue({
      id: 'pending-a',
      content: 'keep me',
      status: 'queued',
      channelType: 'thread',
      channelId: 'thread-a',
      channelKey: 'thread:thread-a',
      threadId: 'thread-a',
    });
    (agent as any).promptQueue.enqueue({
      id: 'pending-b',
      content: 'clear me',
      status: 'queued',
      channelType: 'thread',
      channelId: 'thread-b',
      channelKey: 'thread:thread-b',
      threadId: 'thread-b',
    });

    await (agent as any).handleClearQueue(new URL('http://do/clear-queue?threadId=thread-b'));

    // Only thread-b's withdrawn event should fire
    const withdrawn = broadcasts.filter((b) => b.type === 'queue.withdrawn');
    expect(withdrawn).toHaveLength(1);
    expect((withdrawn[0] as any).data.messageId).toBe('pending-b');

    // thread-a is still queued
    const remaining = (agent as any).ctx.storage.sql
      .exec("SELECT id FROM prompt_queue WHERE status = 'queued'")
      .toArray();
    expect(remaining.map((r: any) => r.id)).toEqual(['pending-a']);
  });

  it('full steer lifecycle: followup → promote → dispatch', async () => {
    const runnerSocket = { send: vi.fn() };
    const { agent, broadcasts } = await createTestAgent({ sockets: [runnerSocket] });

    // Dispatch initial prompt (makes runner busy)
    await (agent as any).handlePrompt(
      'initial work',
      undefined,
      { id: 'user-1', email: 'u@test.com' },
      undefined,
      'web', 'default', 'thread-1',
    );

    // Runner is now busy
    expect((agent as any).promptQueue.runnerBusy).toBe(true);

    const writeMessageSpy = vi.spyOn((agent as any).messageStore, 'writeMessage');

    // Queue a followup (should not write to message store)
    await (agent as any).handlePrompt(
      'followup work',
      undefined,
      { id: 'user-1', email: 'u@test.com' },
      undefined,
      'web', 'default', 'thread-1',
    );

    // Followup should be in queue but NOT in message store
    expect((agent as any).promptQueue.length).toBe(1);
    expect(writeMessageSpy).not.toHaveBeenCalled();

    // queue.state should have been broadcast with the pending item
    const queueStateBroadcast = broadcasts.find(
      (b) => b.type === 'queue.state' && (b.data as any)?.pending?.content === 'followup work'
    );
    expect(queueStateBroadcast).toBeTruthy();

    // Promote the followup
    await (agent as any).handleClientMessage({ send: vi.fn() }, { type: 'queue.promote' });

    // Should have sent abort
    const abortSent = runnerSocket.send.mock.calls.some(
      (call: unknown[]) => JSON.parse(call[0] as string).type === 'abort'
    );
    expect(abortSent).toBe(true);
  });

  it('channel steer preserves the existing pending web followup', async () => {
    const runnerSocket = { send: vi.fn() };
    const { agent, broadcasts } = await createTestAgent({ sockets: [runnerSocket] });

    // Make runner busy
    (agent as any).promptQueue.runnerBusy = true;

    // Queue a web followup
    (agent as any).promptQueue.enqueue({
      id: 'web-followup',
      content: 'web user work',
      status: 'queued',
      channelType: 'web',
      channelId: 'default',
      channelKey: 'web:default',
    });

    // Channel steer arrives
    await (agent as any).handleInterruptPrompt(
      'telegram urgent',
      undefined,
      { id: 'user-1', email: 'u@test.com' },
      undefined,
      'telegram',
      'chat-123',
      'thread-telegram',
    );

    // Abort should have been sent
    const abortSent = runnerSocket.send.mock.calls.some(
      (call: unknown[]) => JSON.parse(call[0] as string).type === 'abort'
    );
    expect(abortSent).toBe(true);

    // The web followup should NOT have been withdrawn — it should still be in the queue
    const withdrawnBroadcast = broadcasts.find((b) => b.type === 'queue.withdrawn');
    expect(withdrawnBroadcast).toBeUndefined();

    // Queue should have 2 items: the steer prompt + the original web followup
    // (steer was enqueued because runnerBusy is still true during abort)
    const allQueued = (agent as any).ctx.storage.sql
      .exec("SELECT * FROM prompt_queue WHERE status = 'queued' ORDER BY created_at ASC")
      .toArray();
    expect(allQueued.length).toBe(2);
    expect(allQueued[0].content).toBe('web user work');
    expect(allQueued[1].content).toBe('telegram urgent');
  });

  it('does not steer-abort an unrelated orchestrator thread when channel prompt requests steer', async () => {
    const runnerSocket = { send: vi.fn() };
    const { agent } = await createTestAgent({ sockets: [runnerSocket] });

    (agent as any).promptQueue.runnerBusy = true;
    (agent as any).promptQueue.setChannelBusy('thread:web-thread', true);
    (agent as any).promptQueue.setChannelBusy('thread:slack-thread', true);

    const response = await agent.fetch(new Request('http://do/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: 'telegram test prompt',
        queueMode: 'steer',
        channelType: 'telegram',
        channelId: 'chat-123',
        threadId: 'telegram-thread',
        authorName: 'Telegram User',
      }),
    }));

    expect(response.status).toBe(200);
    const sent = runnerSocket.send.mock.calls.map((call: unknown[]) => JSON.parse(call[0] as string));
    expect(sent).not.toContainEqual(expect.objectContaining({ type: 'abort' }));
    expect(sent).toContainEqual(expect.objectContaining({
      type: 'prompt',
      content: 'telegram test prompt',
      channelType: 'thread',
      channelId: 'telegram-thread',
      threadId: 'telegram-thread',
      replyChannelType: 'telegram',
      replyChannelId: 'chat-123',
    }));
  });

  it('withdraw → re-send flow preserves content', async () => {
    const runnerSocket = { send: vi.fn() };
    const { agent, broadcasts } = await createTestAgent({ sockets: [runnerSocket] });

    (agent as any).promptQueue.runnerBusy = true;

    // Queue a followup
    await (agent as any).handlePrompt(
      'original content',
      undefined,
      { id: 'user-1', email: 'u@test.com' },
      undefined,
      'web', 'default', undefined,
    );

    // Withdraw it
    await (agent as any).handleClientMessage({ send: vi.fn() }, { type: 'queue.withdraw' });

    // Should have broadcast the content
    const withdrawn = broadcasts.find((b) => b.type === 'queue.withdrawn');
    expect(withdrawn).toBeTruthy();
    expect((withdrawn as any).data.content).toBe('original content');

    // Queue should be empty
    expect((agent as any).promptQueue.length).toBe(0);
  });

  it('steer prompt dispatches before existing pending followup (priority ordering)', async () => {
    const runnerSocket = { send: vi.fn() };
    const { agent } = await createTestAgent({ sockets: [runnerSocket] });

    (agent as any).promptQueue.runnerBusy = true;

    // Enqueue a followup first (lower priority)
    (agent as any).promptQueue.enqueue({
      id: 'followup-first',
      content: 'followup content',
      status: 'queued',
      channelType: 'web',
      channelId: 'default',
      channelKey: 'web:default',
    });

    // Enqueue a steer second (higher priority)
    (agent as any).promptQueue.enqueue({
      id: 'steer-second',
      content: 'steer content',
      status: 'queued',
      channelType: 'telegram',
      channelId: 'chat-123',
      channelKey: 'telegram:chat-123',
      priority: 1,
    });

    // dequeueNext should return the steer (priority 1) before the followup (priority 0)
    const first = (agent as any).promptQueue.dequeueNext();
    expect(first.id).toBe('steer-second');
    expect(first.content).toBe('steer content');

    const second = (agent as any).promptQueue.dequeueNext();
    expect(second.id).toBe('followup-first');
    expect(second.content).toBe('followup content');
  });

  it('does not duplicate broadcast when re-dispatching a reverted prompt', async () => {
    const runnerSocket = { send: vi.fn() };
    const { agent, broadcasts } = await createTestAgent({ sockets: [runnerSocket] });

    // Simulate a directly-dispatched prompt that was already written to message store
    (agent as any).messageStore.writeMessage({
      id: 'already-written',
      role: 'user',
      content: 'already in store',
    });

    // Now simulate revert-to-queued: the prompt is back in the queue
    (agent as any).promptQueue.enqueue({
      id: 'already-written',
      content: 'already in store',
      status: 'queued',
      channelType: 'web',
      channelId: 'default',
      channelKey: 'web:default',
    });

    // Clear broadcasts from setup
    broadcasts.length = 0;

    // Dispatch via sendNextQueuedPrompt
    await (agent as any).sendNextQueuedPrompt();

    // Should NOT have broadcast a user message (already written)
    const userMsgBroadcast = broadcasts.find(
      (b) => b.type === 'message' && (b.data as any)?.id === 'already-written' && (b.data as any)?.role === 'user'
    );
    expect(userMsgBroadcast).toBeUndefined();

    // Should still broadcast queue.state to clear pending card
    const queueState = broadcasts.find((b) => b.type === 'queue.state');
    expect(queueState?.data).toMatchObject({ pending: null });
  });

  it('reverts stuck processing entries when runner becomes ready after hibernation', async () => {
    const runnerSocket = { send: vi.fn() };
    const { agent } = await createTestAgent({ sockets: [runnerSocket] });

    // Simulate state after DO eviction: processing entry stuck, runnerBusy=true
    (agent as any).promptQueue.enqueue({
      id: 'stuck-processing',
      content: 'was processing when DO evicted',
      status: 'processing',
      channelType: 'web',
      channelId: 'default',
      channelKey: 'web:default',
    });
    (agent as any).promptQueue.runnerBusy = true;

    // Also queue a new user message (arrived while sandbox was waking)
    (agent as any).promptQueue.enqueue({
      id: 'new-queued',
      content: 'new message while waking',
      status: 'queued',
      channelType: 'web',
      channelId: 'default',
      channelKey: 'web:default',
    });

    // Simulate runner becoming ready (wasInitializing path)
    // Set runnerReady to false first so wasInitializing is true
    (agent as any).runnerLink.ready = false;

    // Trigger the agentStatus idle handler
    await (agent as any).runnerHandlers['agentStatus']({
      type: 'agentStatus',
      status: 'idle',
    });

    // The stuck processing entry should have been reverted and dispatched
    // runnerBusy should now reflect the dispatched state
    // At minimum, sendNextQueuedPrompt should have been called
    const promptSent = runnerSocket.send.mock.calls.some(
      (call: unknown[]) => JSON.parse(call[0] as string).type === 'prompt'
    );
    expect(promptSent).toBe(true);
  });

  it('drops error emission when prompt_queue has no row for messageId', async () => {
    const { agent, broadcasts } = await createTestAgent();
    const writeMessageSpy = vi.spyOn((agent as any).messageStore, 'writeMessage');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await (agent as any).runnerHandlers.error({
      type: 'error',
      messageId: 'nonexistent',
      error: 'boom',
    });

    expect(warnSpy).toHaveBeenCalledWith(
      '[ChannelRouting] dropped emission',
      expect.objectContaining({ reason: 'no_prompt_row', messageId: 'nonexistent', error: 'boom' }),
    );
    expect(writeMessageSpy).not.toHaveBeenCalled();
    expect(broadcasts.find((m) => m.type === 'error')).toBeUndefined();
    expect((agent as any).notifyEventBus).not.toHaveBeenCalled();
    expect((agent as any).enqueueOwnerNotification).not.toHaveBeenCalled();
    expect((agent as any).emitEvent).not.toHaveBeenCalled();
  });

  it('attributes error to channel from prompt_queue lookup', async () => {
    const { agent, broadcasts } = await createTestAgent();
    (agent as any).promptQueue.enqueue({
      id: 'msg-1',
      content: 'hi',
      status: 'processing',
      channelType: 'thread',
      channelId: 'thread-abc',
    });
    const writeMessageSpy = vi.spyOn((agent as any).messageStore, 'writeMessage');

    await (agent as any).runnerHandlers.error({
      type: 'error',
      messageId: 'msg-1',
      error: 'oops',
    });

    expect(writeMessageSpy).toHaveBeenCalledTimes(1);
    expect(writeMessageSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'system',
        content: expect.stringContaining('oops'),
        channelType: 'thread',
        channelId: 'thread-abc',
      }),
    );
    const errBroadcast = broadcasts.find((m) => m.type === 'error');
    expect(errBroadcast).toMatchObject({
      type: 'error',
      error: 'oops',
      channelType: 'thread',
      channelId: 'thread-abc',
    });
  });

  it('drops question emission when prompt_queue has no row for messageId', async () => {
    const { agent, sql, broadcasts } = await createTestAgent();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await (agent as any).runnerHandlers.question({
      type: 'question',
      messageId: 'nonexistent',
      questionId: 'q-1',
      text: 'pick?',
    });

    expect(warnSpy).toHaveBeenCalledWith(
      '[ChannelRouting] dropped emission',
      expect.objectContaining({ reason: 'no_prompt_row', messageId: 'nonexistent', questionId: 'q-1' }),
    );
    expect(sql.interactivePrompts.size).toBe(0);
    expect(broadcasts.find((m) => m.type === 'interactive_prompt')).toBeUndefined();
    expect((agent as any).notifyEventBus).not.toHaveBeenCalled();
    expect((agent as any).sendChannelInteractivePrompts).not.toHaveBeenCalled();
  });

  it('attributes question to channel from prompt_queue lookup', async () => {
    const { agent, sql, broadcasts } = await createTestAgent();
    (agent as any).promptQueue.enqueue({
      id: 'msg-1',
      content: 'hi',
      status: 'processing',
      channelType: 'slack',
      channelId: 'C123',
    });

    await (agent as any).runnerHandlers.question({
      type: 'question',
      messageId: 'msg-1',
      questionId: 'q-1',
      text: 'pick?',
      options: ['a', 'b'],
    });

    expect(sql.interactivePrompts.size).toBe(1);
    const storedPrompt = sql.interactivePrompts.get('q-1');
    expect(storedPrompt).toBeTruthy();
    const storedContext = JSON.parse(storedPrompt!.context);
    expect(storedContext).toMatchObject({ channelType: 'slack', channelId: 'C123' });

    const promptBroadcast = broadcasts.find((m) => m.type === 'interactive_prompt');
    expect(promptBroadcast).toMatchObject({
      type: 'interactive_prompt',
      channelType: 'slack',
      channelId: 'C123',
    });
  });

  it('broadcasts question prompt thread metadata from the originating queue row', async () => {
    const { agent, broadcasts } = await createTestAgent();
    (agent as any).promptQueue.enqueue({
      id: 'msg-telegram',
      content: 'hi',
      status: 'processing',
      channelType: 'thread',
      channelId: 'thread-telegram',
      threadId: 'thread-telegram',
      replyChannelType: 'telegram',
      replyChannelId: 'chat-123',
    });

    await (agent as any).runnerHandlers.question({
      type: 'question',
      messageId: 'msg-telegram',
      questionId: 'q-telegram',
      text: 'pick?',
      options: ['a', 'b'],
    });

    const promptBroadcast = broadcasts.find((m) => m.type === 'interactive_prompt');
    expect(promptBroadcast).toMatchObject({
      type: 'interactive_prompt',
      channelType: 'telegram',
      channelId: 'chat-123',
      threadId: 'thread-telegram',
    });
  });

  it('resolves same-channel web messages as pending question answers', async () => {
    const { agent, sql, broadcasts } = await createTestAgent();
    (agent as any).runnerLink.send = vi.fn().mockReturnValue(true);

    sql.interactivePrompts.set('q-web', {
      id: 'q-web',
      type: 'question',
      request_id: null,
      title: 'Need a decision',
      actions: JSON.stringify([{ id: 'option_0', label: 'Regenerate options' }]),
      context: JSON.stringify({
        options: ['Regenerate options'],
        channelType: 'web',
        channelId: 'default',
      }),
      status: 'pending',
      expires_at: Math.floor(Date.now() / 1000) + 300,
      channel_refs: null,
    });

    const resolved = await (agent as any).tryResolveChannelQuestion(
      'Regenerate options',
      { id: 'user-1', email: 'user-1@example.com' },
      'web',
      'default',
    );

    expect(resolved).toBe(true);
    expect((agent as any).runnerLink.send).toHaveBeenCalledWith({
      type: 'answer',
      questionId: 'q-web',
      answer: 'Regenerate options',
    });
    expect(broadcasts).toContainEqual(expect.objectContaining({
      type: 'interactive_prompt_resolved',
      promptId: 'q-web',
    }));
    expect(sql.interactivePrompts.has('q-web')).toBe(false);
  });

  it('resolves web thread messages as pending question answers before queueing', async () => {
    const { agent, sql, broadcasts } = await createTestAgent();
    (agent as any).runnerLink.send = vi.fn().mockReturnValue(true);

    sql.interactivePrompts.set('q-thread', {
      id: 'q-thread',
      type: 'question',
      request_id: null,
      title: 'Need a decision',
      actions: JSON.stringify([{ id: 'option_0', label: 'Regenerate options' }]),
      context: JSON.stringify({
        options: ['Regenerate options'],
        channelType: 'thread',
        channelId: 'thread-123',
      }),
      status: 'pending',
      expires_at: Math.floor(Date.now() / 1000) + 300,
      channel_refs: null,
    });

    await (agent as any).handlePrompt(
      'Regenerate options',
      undefined,
      { id: 'user-1', email: 'user-1@example.com' },
      undefined,
      undefined,
      undefined,
      'thread-123',
    );

    expect((agent as any).runnerLink.send).toHaveBeenCalledWith({
      type: 'answer',
      questionId: 'q-thread',
      answer: 'Regenerate options',
    });
    expect(sql.queue.size).toBe(0);
    expect(broadcasts).toContainEqual(expect.objectContaining({
      type: 'interactive_prompt_resolved',
      promptId: 'q-thread',
    }));
    expect(sql.interactivePrompts.has('q-thread')).toBe(false);
  });

  it('resolves Telegram thread messages against the original Telegram question channel before interrupting', async () => {
    const { agent, sql, broadcasts } = await createTestAgent();
    (agent as any).runnerLink.send = vi.fn().mockReturnValue(true);
    (agent as any).promptQueue.runnerBusy = true;

    sql.interactivePrompts.set('q-telegram', {
      id: 'q-telegram',
      type: 'question',
      request_id: null,
      title: 'Need a decision',
      actions: JSON.stringify([{ id: 'option_0', label: 'Telegram' }]),
      context: JSON.stringify({
        options: ['Telegram'],
        channelType: 'telegram',
        channelId: 'chat-123',
        threadId: 'thread-telegram',
      }),
      status: 'pending',
      expires_at: Math.floor(Date.now() / 1000) + 300,
      channel_refs: null,
    });

    await (agent as any).handleInterruptPrompt(
      'Telegram',
      undefined,
      { id: 'user-1', email: 'user-1@example.com' },
      undefined,
      'telegram',
      'chat-123',
      'thread-telegram',
    );

    expect((agent as any).runnerLink.send).toHaveBeenCalledWith({
      type: 'answer',
      questionId: 'q-telegram',
      answer: 'Telegram',
    });
    expect((agent as any).runnerLink.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'abort' }));
    expect(sql.queue.size).toBe(0);
    expect(broadcasts).toContainEqual(expect.objectContaining({
      type: 'interactive_prompt_resolved',
      promptId: 'q-telegram',
    }));
    expect(sql.interactivePrompts.has('q-telegram')).toBe(false);
  });

  describe('action approval prompts', () => {
    async function setupApprovalPrompt(
      actionId = 'allow_session',
      opts?: {
        expiresAt?: number;
        failInvocationApprove?: boolean;
        failOverrideWrite?: boolean;
        executionRejects?: boolean;
        invocationStatus?: string;
        legacyContext?: boolean;
        noSummary?: boolean;
        orgDenyBeforeResolve?: boolean;
        resolvedBy?: string;
        skipResolve?: boolean;
      },
    ) {
      const { agent, sql, broadcasts, ctx } = await createTestAgent();
      const testDb = createTestDb();
      const appDb = testDb.db;
      appDb.insert(users).values({ id: 'user-1', email: 'user-1@example.com' }).run();
      appDb.insert(sessions).values({
        id: 'orchestrator:user-1',
        userId: 'user-1',
        workspace: '/tmp/session-agent-approval',
        status: 'running',
      }).run();

      await createInvocation(appDb as any, {
        id: 'inv-approval',
        sessionId: 'orchestrator:user-1',
        userId: 'user-1',
        service: 'gmail',
        actionId: 'draft.create',
        riskLevel: 'medium',
        resolvedMode: 'require_approval',
        status: opts?.invocationStatus ?? 'pending',
      });

      Object.defineProperty(agent, 'appDb', { value: appDb });
      (agent as any).runnerLink.send = vi.fn().mockReturnValue(true);
      (agent as any).executeActionAndSend = opts?.executionRejects
        ? vi.fn().mockRejectedValue(new Error('execution exploded'))
        : vi.fn().mockResolvedValue({ success: true });
      const promptContext = {
        toolId: 'gmail:draft.create',
        service: 'gmail',
        actionId: 'draft.create',
        params: { to: 'customer@example.com' },
        riskLevel: 'medium',
        invocationId: 'inv-approval',
        ...(opts?.noSummary ? {} : { summary: 'Create a Gmail draft' }),
        ...(opts?.legacyContext ? { credentialSources: [] } : {}),
      };
      sql.interactivePrompts.set('inv-approval', {
        id: 'inv-approval',
        type: 'approval',
        request_id: 'request-approval',
        title: 'Action requires approval',
        body: 'Create a Gmail draft',
        actions: JSON.stringify(buildActionApprovalPromptActions()),
        context: JSON.stringify(promptContext),
        status: 'pending',
        expires_at: opts?.expiresAt ?? Math.floor(Date.now() / 1000) + 600,
        channel_refs: null,
      });

      if (opts?.failOverrideWrite) {
        testDb.sqlite.exec(`
          CREATE TRIGGER fail_uapo_insert BEFORE INSERT ON user_action_policy_overrides
          BEGIN
            SELECT RAISE(ABORT, 'override write failed');
          END;
          CREATE TRIGGER fail_uapo_update BEFORE UPDATE ON user_action_policy_overrides
          BEGIN
            SELECT RAISE(ABORT, 'override write failed');
          END;
        `);
      }

      if (opts?.failInvocationApprove) {
        testDb.sqlite.exec(`
          CREATE TRIGGER fail_action_invocation_approve BEFORE UPDATE OF status ON action_invocations
          WHEN NEW.status = 'approved'
          BEGIN
            SELECT RAISE(ABORT, 'approve write failed');
          END;
        `);
      }

      if (opts?.orgDenyBeforeResolve) {
        await upsertActionPolicy(appDb as any, {
          id: 'org-deny-before-resolve',
          service: 'gmail',
          actionId: 'draft.create',
          mode: 'deny',
          createdBy: 'user-1',
        });
      }

      if (!opts?.skipResolve) {
        await (agent as any).handlePromptResolved('inv-approval', {
          actionId,
          resolvedBy: opts?.resolvedBy ?? 'user-1',
        });
      }

      return { agent, sql, broadcasts, appDb, ctx };
    }

    it('builds Codex-style approval choices', () => {
      expect(buildActionApprovalPromptActions()).toEqual([
        { id: 'allow_once', label: 'Allow', description: 'Run the tool once and continue.', style: 'primary' },
        { id: 'allow_session', label: 'Allow for Session', description: 'Run the tool and remember this choice for this session.' },
        { id: 'allow_always', label: 'Always Allow', description: 'Run the tool and remember this choice for future tool calls.' },
        { id: 'cancel', label: 'Cancel', description: 'Cancel this tool call.', style: 'danger' },
      ]);
    });

    it('keeps approval expiry below the sandbox gateway idle ceiling', () => {
      expect(ACTION_APPROVAL_EXPIRY_MS).toBeLessThan(255_000);
    });

    it('broadcasts MCP tool discovery warning messages to clients', async () => {
      const { agent, broadcasts } = await createTestAgent();
      const listToolsSpy = vi.spyOn(sessionTools, 'listTools').mockResolvedValue({
        tools: [],
        warnings: [{
          service: 'salesforce-read-only',
          displayName: 'Salesforce (Read Only)',
          reason: 'request_failed',
          message: 'MCP salesforce-read-only initialize failed: HTTP 404 - Not Found',
          integrationId: 'integration-1',
        }],
        mcpCacheEntries: [],
        discoveredRiskLevels: new Map(),
        disabledPluginServices: new Set(),
      });
      (agent as any).runnerLink.send = vi.fn().mockReturnValue(true);

      await (agent as any).handleListTools('list-tools-request', 'salesforce');

      expect(listToolsSpy).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything(), 'user-1', expect.objectContaining({
        service: 'salesforce',
      }));
      expect((agent as any).runnerLink.send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'list-tools-result',
        warnings: [expect.objectContaining({
          service: 'salesforce-read-only',
          reason: 'request_failed',
          message: 'MCP salesforce-read-only initialize failed: HTTP 404 - Not Found',
        })],
      }));
      expect(broadcasts).toContainEqual(expect.objectContaining({
        type: 'integration-auth-required',
        services: [expect.objectContaining({
          service: 'salesforce-read-only',
          reason: 'request_failed',
          message: 'MCP salesforce-read-only initialize failed: HTTP 404 - Not Found',
        })],
      }));
    });

    it('allow_session creates a session-scoped exact override and executes', async () => {
      const { agent, sql, appDb } = await setupApprovalPrompt('allow_session');

      const override = await getUserActionPolicyOverride(appDb as any, 'inv-approval:session');
      const invocation = await getInvocation(appDb as any, 'inv-approval');

      expect(override).toMatchObject({
        userId: 'user-1',
        service: 'gmail',
        actionId: 'draft.create',
        mode: 'allow',
        lifetime: 'session',
        sessionId: 'orchestrator:user-1',
        source: 'approval_prompt',
        sourceInvocationId: 'inv-approval',
      });
      expect(invocation).toMatchObject({ status: 'approved', resolvedBy: 'user-1' });
      expect((agent as any).executeActionAndSend).toHaveBeenCalledOnce();
      expect(sql.interactivePrompts.has('inv-approval')).toBe(false);
    });

    it('allow_always creates a persistent exact override and executes', async () => {
      const { agent, appDb } = await setupApprovalPrompt('allow_always');

      const override = await getUserActionPolicyOverride(appDb as any, 'inv-approval:persistent');

      expect(override).toMatchObject({
        userId: 'user-1',
        service: 'gmail',
        actionId: 'draft.create',
        mode: 'allow',
        lifetime: 'persistent',
        sessionId: null,
        source: 'approval_prompt',
        sourceInvocationId: 'inv-approval',
      });
      expect((agent as any).executeActionAndSend).toHaveBeenCalledOnce();
    });

    it('cancel denies the invocation without executing', async () => {
      const { agent, appDb } = await setupApprovalPrompt('cancel');

      const invocation = await getInvocation(appDb as any, 'inv-approval');

      expect(invocation).toMatchObject({ status: 'denied', resolvedBy: 'user-1' });
      expect((agent as any).executeActionAndSend).not.toHaveBeenCalled();
    });

    it('keeps legacy approve mapped to allow_once', async () => {
      const { agent, appDb } = await setupApprovalPrompt('approve');

      const invocation = await getInvocation(appDb as any, 'inv-approval');

      expect(invocation).toMatchObject({ status: 'approved', resolvedBy: 'user-1' });
      expect(await getUserActionPolicyOverride(appDb as any, 'inv-approval:session')).toBeUndefined();
      expect((agent as any).executeActionAndSend).toHaveBeenCalledOnce();
    });

    it('expires stale approval prompts instead of executing them', async () => {
      const { agent, sql, appDb, broadcasts } = await setupApprovalPrompt('allow_once', {
        expiresAt: Math.floor(Date.now() / 1000) - 1,
      });

      const invocation = await getInvocation(appDb as any, 'inv-approval');

      expect(invocation).toMatchObject({ status: 'expired' });
      expect((agent as any).executeActionAndSend).not.toHaveBeenCalled();
      expect(sql.interactivePrompts.has('inv-approval')).toBe(false);
      expect(broadcasts).toContainEqual(expect.objectContaining({
        type: 'interactive_prompt_expired',
        promptId: 'inv-approval',
      }));
    });

    it('does not execute when the invocation is no longer pending', async () => {
      const { agent, sql, appDb } = await setupApprovalPrompt('allow_once', {
        invocationStatus: 'denied',
      });

      const invocation = await getInvocation(appDb as any, 'inv-approval');

      expect(invocation).toMatchObject({ status: 'denied' });
      expect((agent as any).executeActionAndSend).not.toHaveBeenCalled();
      expect(sql.interactivePrompts.has('inv-approval')).toBe(false);
    });

    it('does not persist an allow override when the invocation is no longer pending', async () => {
      const { agent, appDb } = await setupApprovalPrompt('allow_session', {
        invocationStatus: 'denied',
      });

      const invocation = await getInvocation(appDb as any, 'inv-approval');

      expect(invocation).toMatchObject({ status: 'denied' });
      expect(await getUserActionPolicyOverride(appDb as any, 'inv-approval:session')).toBeUndefined();
      expect((agent as any).executeActionAndSend).not.toHaveBeenCalled();
    });

    it('terminalizes allow_once when organization policy now denies the action', async () => {
      const { agent, sql, appDb, broadcasts } = await setupApprovalPrompt('allow_once', {
        orgDenyBeforeResolve: true,
      });

      const invocation = await getInvocation(appDb as any, 'inv-approval');

      expect(invocation).toMatchObject({
        status: 'failed',
        error: expect.stringContaining('denied by organization policy'),
      });
      expect(sql.interactivePrompts.has('inv-approval')).toBe(false);
      expect(broadcasts).toContainEqual(expect.objectContaining({
        type: 'interactive_prompt_resolved',
        promptId: 'inv-approval',
      }));
      expect((agent as any).executeActionAndSend).not.toHaveBeenCalled();
    });

    it('keeps the prompt pending without releasing the runner for unknown approval actions', async () => {
      const { agent, sql, appDb } = await setupApprovalPrompt('__bogus__');

      const invocation = await getInvocation(appDb as any, 'inv-approval');

      expect(invocation).toMatchObject({ status: 'pending', resolvedBy: null });
      expect(sql.interactivePrompts.get('inv-approval')).toMatchObject({ status: 'pending' });
      expect((agent as any).runnerLink.send).not.toHaveBeenCalledWith(expect.objectContaining({
        type: 'call-tool-result',
        requestId: 'request-approval',
      }));
    });

    it('cleans up and fails the invocation when execution throws after approval', async () => {
      const { agent, sql, appDb, broadcasts } = await setupApprovalPrompt('allow_once', {
        executionRejects: true,
      });

      const invocation = await getInvocation(appDb as any, 'inv-approval');

      expect(invocation).toMatchObject({
        status: 'failed',
        resolvedBy: 'user-1',
        error: 'execution exploded',
      });
      expect(sql.interactivePrompts.has('inv-approval')).toBe(false);
      expect(broadcasts).toContainEqual(expect.objectContaining({
        type: 'interactive_prompt_resolved',
        promptId: 'inv-approval',
      }));
    });

    it('fails stale legacy approvals and broadcasts terminal prompt state', async () => {
      const { agent, sql, appDb, broadcasts } = await setupApprovalPrompt('allow_once', {
        legacyContext: true,
      });

      const invocation = await getInvocation(appDb as any, 'inv-approval');

      expect(invocation).toMatchObject({
        status: 'failed',
        error: expect.stringContaining('expired during a system update'),
      });
      expect((agent as any).executeActionAndSend).not.toHaveBeenCalled();
      expect(sql.interactivePrompts.has('inv-approval')).toBe(false);
      expect(broadcasts).toContainEqual(expect.objectContaining({
        type: 'interactive_prompt_expired',
        promptId: 'inv-approval',
        promptType: 'approval',
      }));
    });

    it('broadcasts terminal prompt state when override persistence fails after approval', async () => {
      const { agent, sql, appDb, broadcasts } = await setupApprovalPrompt('allow_session', {
        failOverrideWrite: true,
      });

      const invocation = await getInvocation(appDb as any, 'inv-approval');

      expect(invocation).toMatchObject({
        status: 'failed',
        resolvedBy: 'user-1',
      });
      expect((agent as any).executeActionAndSend).not.toHaveBeenCalled();
      expect(sql.interactivePrompts.has('inv-approval')).toBe(false);
      expect(broadcasts).toContainEqual(expect.objectContaining({
        type: 'interactive_prompt_expired',
        promptId: 'inv-approval',
        promptType: 'approval',
      }));
    });

    it('rejects approval resolution from a non-owner websocket user', async () => {
      const { agent, sql, appDb, ctx } = await setupApprovalPrompt('allow_once', {
        skipResolve: true,
      });
      const socket = { send: vi.fn() };
      (ctx as any).acceptWebSocket(socket, ['client:user-2']);

      await (agent as any).handleClientMessage(socket, {
        type: 'approve-action',
        invocationId: 'inv-approval',
        actionId: 'allow_once',
      });

      const invocation = await getInvocation(appDb as any, 'inv-approval');

      expect(invocation).toMatchObject({ status: 'pending' });
      expect(sql.interactivePrompts.get('inv-approval')).toMatchObject({ status: 'pending' });
      expect((agent as any).executeActionAndSend).not.toHaveBeenCalled();
      expect(socket.send).toHaveBeenCalledWith(expect.stringContaining('Only the session owner can resolve this prompt'));
    });

    it('restores the prompt when approving throws before the runner is released', async () => {
      const { agent, sql, appDb } = await setupApprovalPrompt('allow_once', {
        failInvocationApprove: true,
        skipResolve: true,
      });

      const result = await (agent as any).handlePromptResolved('inv-approval', {
        actionId: 'allow_once',
        resolvedBy: 'user-1',
      });
      const invocation = await getInvocation(appDb as any, 'inv-approval');

      expect(result).toMatchObject({ ok: false, status: 500 });
      expect(invocation).toMatchObject({ status: 'pending', resolvedBy: null });
      expect(sql.interactivePrompts.get('inv-approval')).toMatchObject({ status: 'pending' });
      expect((agent as any).runnerLink.send).not.toHaveBeenCalledWith(expect.objectContaining({
        type: 'call-tool-result',
        requestId: 'request-approval',
      }));
    });

    it('stops resolution when the pending prompt claim does not update a row', async () => {
      const { agent, sql, appDb } = await setupApprovalPrompt('allow_once', {
        skipResolve: true,
      });
      const originalExec = sql.exec.bind(sql);
      vi.spyOn(sql, 'exec').mockImplementation((query: string, ...params: unknown[]) => {
        if (query.trim().startsWith("UPDATE interactive_prompts SET status = 'resolving'")) {
          return originalExec("SELECT * FROM interactive_prompts WHERE id = ?", "__missing__");
        }
        return originalExec(query, ...params);
      });

      const result = await (agent as any).handlePromptResolved('inv-approval', {
        actionId: 'allow_once',
        resolvedBy: 'user-1',
      });
      const invocation = await getInvocation(appDb as any, 'inv-approval');

      expect(result).toMatchObject({ ok: false, status: 409 });
      expect(invocation).toMatchObject({ status: 'pending', resolvedBy: null });
      expect(sql.interactivePrompts.get('inv-approval')).toMatchObject({ status: 'pending' });
      expect((agent as any).executeActionAndSend).not.toHaveBeenCalled();
      expect((agent as any).runnerLink.send).not.toHaveBeenCalledWith(expect.objectContaining({
        type: 'call-tool-result',
        requestId: 'request-approval',
      }));
    });

    it('rejects approve actions sent through the deny websocket transport', async () => {
      const { agent, sql, appDb, ctx } = await setupApprovalPrompt('allow_once', {
        skipResolve: true,
      });
      const socket = { send: vi.fn() };
      (ctx as any).acceptWebSocket(socket, ['client:user-1']);

      await (agent as any).handleClientMessage(socket, {
        type: 'deny-action',
        invocationId: 'inv-approval',
        actionId: 'allow_session',
      });

      const invocation = await getInvocation(appDb as any, 'inv-approval');

      expect(invocation).toMatchObject({ status: 'pending', resolvedBy: null });
      expect(sql.interactivePrompts.get('inv-approval')).toMatchObject({ status: 'pending' });
      expect((agent as any).executeActionAndSend).not.toHaveBeenCalled();
      expect(socket.send).toHaveBeenCalledWith(expect.stringContaining('does not accept approval action'));
    });

    it('cleans up prompt and invocation when approval setup fails after notifying the runner', async () => {
      const { agent, sql } = await createTestAgent();
      const testDb = createTestDb();
      const appDb = testDb.db;
      appDb.insert(users).values({ id: 'user-1', email: 'user-1@example.com' }).run();
      appDb.insert(sessions).values({
        id: 'orchestrator:user-1',
        userId: 'user-1',
        workspace: '/tmp/session-agent-approval-setup',
        status: 'running',
      }).run();
      await createInvocation(appDb as any, {
        id: 'inv-setup-failure',
        sessionId: 'orchestrator:user-1',
        userId: 'user-1',
        service: 'gmail',
        actionId: 'draft.create',
        riskLevel: 'medium',
        resolvedMode: 'require_approval',
        status: 'pending',
      });
      Object.defineProperty(agent, 'appDb', { value: appDb });
      (agent as any).runnerLink.send = vi.fn().mockReturnValue(true);
      (agent as any).ensureActionExpiryAlarm = vi.fn().mockRejectedValue(new Error('alarm failed'));
      vi.spyOn(sessionTools, 'resolveActionPolicy').mockResolvedValue({
        outcome: 'pending_approval',
        invocationId: 'inv-setup-failure',
        riskLevel: 'medium',
        service: 'gmail',
        actionId: 'draft.create',
        actionSource: {} as any,
        disabledPluginServicesCache: null,
      });

      await (agent as any).handleCallTool('request-setup-failure', 'gmail:draft.create', {}, 'Create a draft');
      const invocation = await getInvocation(appDb as any, 'inv-setup-failure');

      expect((agent as any).runnerLink.send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'call-tool-pending',
        requestId: 'request-setup-failure',
      }));
      expect((agent as any).runnerLink.send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'call-tool-result',
        requestId: 'request-setup-failure',
        error: 'alarm failed',
      }));
      expect(invocation).toMatchObject({ status: 'failed', error: 'alarm failed' });
      expect(sql.interactivePrompts.has('inv-setup-failure')).toBe(false);
    });

    it('does not expire prompts that are already being resolved', async () => {
      const { agent, sql } = await createTestAgent();
      sql.interactivePrompts.set('resolving-approval', {
        id: 'resolving-approval',
        type: 'approval',
        request_id: 'request-resolving',
        title: 'Action requires approval',
        body: 'Create a Gmail draft',
        actions: JSON.stringify(buildActionApprovalPromptActions()),
        context: JSON.stringify({
          toolId: 'gmail:draft.create',
          service: 'gmail',
          actionId: 'draft.create',
          params: { to: 'customer@example.com' },
          riskLevel: 'medium',
          invocationId: 'resolving-approval',
          summary: 'Create a Gmail draft',
        }),
        status: 'resolving',
        expires_at: Math.floor(Date.now() / 1000) - 1,
        channel_refs: null,
      });

      await agent.alarm();

      expect(sql.interactivePrompts.has('resolving-approval')).toBe(true);
    });
  });

  it('drops image emission when prompt_queue has no row for messageId', async () => {
    const { agent, broadcasts } = await createTestAgent();
    const writeMessageSpy = vi.spyOn((agent as any).messageStore, 'writeMessage');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await (agent as any).runnerHandlers.image({
      type: 'image',
      messageId: 'nonexistent',
      data: 'base64data',
      mimeType: 'image/png',
      description: 'An image',
    });

    expect(warnSpy).toHaveBeenCalledWith(
      '[ChannelRouting] dropped emission',
      expect.objectContaining({ reason: 'no_prompt_row', eventType: 'image', messageId: 'nonexistent' }),
    );
    expect(writeMessageSpy).not.toHaveBeenCalled();
    expect(broadcasts.find((m) => m.type === 'message')).toBeUndefined();
  });

  it('attributes image to channel from prompt_queue lookup', async () => {
    const { agent, broadcasts } = await createTestAgent();
    (agent as any).promptQueue.enqueue({
      id: 'msg-1',
      content: 'hi',
      status: 'processing',
      channelType: 'slack',
      channelId: 'C123',
    });
    const writeMessageSpy = vi.spyOn((agent as any).messageStore, 'writeMessage');

    await (agent as any).runnerHandlers.image({
      type: 'image',
      messageId: 'msg-1',
      data: 'base64data',
      mimeType: 'image/png',
      description: 'An image',
    });

    expect(writeMessageSpy).toHaveBeenCalledTimes(1);
    expect(writeMessageSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'system',
        content: 'An image',
        parts: expect.stringContaining('image'),
        channelType: 'slack',
        channelId: 'C123',
      }),
    );

    const imgBroadcast = broadcasts.find((m) => m.type === 'message');
    expect(imgBroadcast).toMatchObject({
      type: 'message',
      data: expect.objectContaining({
        role: 'system',
        content: 'An image',
        channelType: 'slack',
        channelId: 'C123',
      }),
    });
  });

  it('screenshot handler delegates to image handler for backward compat', async () => {
    const { agent, broadcasts } = await createTestAgent();
    (agent as any).promptQueue.enqueue({
      id: 'msg-2',
      content: 'hi',
      status: 'processing',
      channelType: 'slack',
      channelId: 'C456',
    });
    const writeMessageSpy = vi.spyOn((agent as any).messageStore, 'writeMessage');

    await (agent as any).runnerHandlers.screenshot({
      type: 'screenshot',
      messageId: 'msg-2',
      data: 'base64data',
      description: 'A screenshot',
    });

    expect(writeMessageSpy).toHaveBeenCalledTimes(1);
    expect(writeMessageSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'system',
        content: 'A screenshot',
        parts: expect.stringContaining('image'),
        channelType: 'slack',
        channelId: 'C456',
      }),
    );
  });

  it('broadcasts agentStatus without channel attribution when messageId is absent', async () => {
    const { agent, broadcasts } = await createTestAgent();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await (agent as any).runnerHandlers.agentStatus({
      type: 'agentStatus',
      status: 'idle',
    });

    const statusBroadcasts = broadcasts.filter((m) => m.type === 'agentStatus');
    expect(statusBroadcasts).toHaveLength(1);
    expect(statusBroadcasts[0]).toMatchObject({ type: 'agentStatus', status: 'idle' });
    expect(statusBroadcasts[0]).not.toHaveProperty('channelType');
    expect(statusBroadcasts[0]).not.toHaveProperty('channelId');
    expect(warnSpy).not.toHaveBeenCalledWith(
      '[ChannelRouting] dropped emission',
      expect.anything(),
    );
  });

  it('attributes agentStatus to channel when messageId resolves', async () => {
    const { agent, broadcasts } = await createTestAgent();
    (agent as any).promptQueue.enqueue({
      id: 'msg-1',
      content: 'hi',
      status: 'processing',
      channelType: 'slack',
      channelId: 'C1',
    });

    await (agent as any).runnerHandlers.agentStatus({
      type: 'agentStatus',
      messageId: 'msg-1',
      status: 'thinking',
    });

    const statusBroadcast = broadcasts.find((m) => m.type === 'agentStatus');
    expect(statusBroadcast).toMatchObject({
      type: 'agentStatus',
      status: 'thinking',
      channelType: 'slack',
      channelId: 'C1',
    });
  });

  // ─── resolveSlackChannelId ───────────────────────────────────────────────────

  describe('resolveSlackChannelId', () => {
    it('restores composite channelId when agent sends bare Slack channelId', () => {
      expect(resolveSlackChannelId('slack', 'D123', 'D123:1234567890.123456'))
        .toBe('D123:1234567890.123456');
    });

    it('passes through bare Slack channelId when no stored context exists', () => {
      expect(resolveSlackChannelId('slack', 'D123', undefined)).toBe('D123');
    });

    it('passes through bare Slack channelId when stored context has no thread_ts', () => {
      expect(resolveSlackChannelId('slack', 'D123', 'D123')).toBe('D123');
    });

    it('does not override when stored context is for a different channel', () => {
      expect(resolveSlackChannelId('slack', 'D123', 'C999:9999999999.999999'))
        .toBe('D123');
    });

    it('passes through composite channelId that already includes thread_ts', () => {
      expect(resolveSlackChannelId('slack', 'D123:1234567890.123456', 'D123:1234567890.123456'))
        .toBe('D123:1234567890.123456');
    });

    it('does not apply to non-Slack channel types', () => {
      expect(resolveSlackChannelId('telegram', '12345', '12345:9999'))
        .toBe('12345');
    });
  });

  it('drops agentStatus when messageId is provided but prompt_queue has no row', async () => {
    const { agent, broadcasts } = await createTestAgent();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await (agent as any).runnerHandlers.agentStatus({
      type: 'agentStatus',
      messageId: 'nonexistent',
      status: 'thinking',
    });

    expect(warnSpy).toHaveBeenCalledWith(
      '[ChannelRouting] dropped emission',
      expect.objectContaining({ reason: 'no_prompt_row', eventType: 'agentStatus', messageId: 'nonexistent' }),
    );
    expect(broadcasts.filter((m) => m.type === 'agentStatus')).toHaveLength(0);
  });

  // ─── sendChannelInteractivePrompts — thread filter and DM fallback ────────────

  describe('sendChannelInteractivePrompts — thread filter and DM fallback', () => {
    it('does not add thread-type channel as a delivery target', async () => {
      const { agent, sql } = await createTestAgent();
      (agent as any).sessionState.set('userId', 'user-1');

      const sendInteractiveMock = vi.fn().mockResolvedValue([]);
      (agent as any).channelRouter.sendInteractivePrompt = sendInteractiveMock;
      (agent as any).channelRouter.resolveUserDmTarget = vi.fn().mockResolvedValue(null);

      // Set appDb to a real test DB (no slack identity link → no DM fallback)
      const testDb = createTestDb();
      const appDb = testDb.db;
      appDb.insert(users).values({ id: 'user-1', email: 'user-1@example.com' }).run();
      Object.defineProperty(agent, 'appDb', { value: appDb });

      // Insert a processing row with channel_type='thread' via PromptQueue.enqueue
      (agent as any).promptQueue.enqueue({
        id: 'pq-t',
        content: '',
        status: 'processing',
        channelType: 'thread',
        channelId: 'thread-uuid',
        channelKey: 'thread:thread-uuid',
      });

      const prompt: InteractivePrompt = {
        id: 'inv-t',
        sessionId: 'orchestrator:user-1',
        type: 'approval',
        title: 'Approval',
        body: 'Test',
        actions: [],
        context: { channelType: 'thread', channelId: 'thread-uuid' },
      };

      // Restore the real sendChannelInteractivePrompts (it is mocked in createTestAgent)
      delete (agent as any).sendChannelInteractivePrompts;

      await (agent as any).sendChannelInteractivePrompts('inv-t', prompt);

      if (sendInteractiveMock.mock.calls.length > 0) {
        const targets = sendInteractiveMock.mock.calls[0][0].targets as Array<{ channelType: string }>;
        expect(targets.every((t: { channelType: string }) => t.channelType !== 'thread')).toBe(true);
      }
      // The key assertion: no thread target was added, so sendInteractivePrompt
      // is either not called (no DM fallback) or called without thread targets.
      expect(sendInteractiveMock).not.toHaveBeenCalledWith(
        expect.objectContaining({
          targets: expect.arrayContaining([
            expect.objectContaining({ channelType: 'thread' }),
          ]),
        }),
      );
    });

    it('sends a DM with provenance label when user has Slack identity and no real channel targets', async () => {
      const { agent } = await createTestAgent();
      (agent as any).sessionState.set('sessionId', 'orchestrator:user-1');
      (agent as any).sessionState.set('userId', 'user-1');

      // Set up a real appDb with a Slack identity link for user-1
      const testDb = createTestDb();
      const appDb = testDb.db;
      appDb.insert(users).values({ id: 'user-1', email: 'user-1@example.com' }).run();
      appDb.insert(sessions).values({
        id: 'orchestrator:user-1',
        userId: 'user-1',
        workspace: '/tmp/test',
        status: 'running',
      }).run();
      appDb.insert(userIdentityLinks).values({
        id: 'link-1',
        userId: 'user-1',
        provider: 'slack',
        externalId: 'U0SLACK99',
      }).run();
      Object.defineProperty(agent, 'appDb', { value: appDb });

      // Enqueue a processing row with scheduled-task author email so isUnattended fires
      (agent as any).promptQueue.enqueue({
        id: 'pq-sched',
        content: '',
        authorEmail: 'scheduled-task@valet.local',
        status: 'processing',
      });

      const resolveUserDmTargetMock = vi.fn().mockResolvedValue({ channelType: 'slack', channelId: 'D0DM1234' });
      (agent as any).channelRouter.resolveUserDmTarget = resolveUserDmTargetMock;

      const sendInteractiveMock = vi.fn().mockResolvedValue([{ channelType: 'slack', ref: { messageId: 't1', channelId: 'D0DM1234' } }]);
      (agent as any).channelRouter.sendInteractivePrompt = sendInteractiveMock;

      const prompt: InteractivePrompt = {
        id: 'inv-dm',
        sessionId: 'orchestrator:user-1',
        type: 'approval',
        title: 'Approval',
        body: 'Post weekly report',
        actions: [{ id: 'approve_once', label: 'Approve', style: 'primary' }],
        context: { toolId: 'slack:send_message', riskLevel: 'medium', summary: 'Post weekly report' },
      };

      // Restore the real sendChannelInteractivePrompts (it is mocked in createTestAgent)
      delete (agent as any).sendChannelInteractivePrompts;

      await (agent as any).sendChannelInteractivePrompts('inv-dm', prompt);

      expect(resolveUserDmTargetMock).toHaveBeenCalledWith('slack', 'user-1', 'U0SLACK99');
      expect(sendInteractiveMock).toHaveBeenCalledOnce();
      const callOpts = sendInteractiveMock.mock.calls[0][0] as { targets: Array<{ channelType: string; channelId: string }>; prompt: InteractivePrompt };
      expect(callOpts.targets).toContainEqual({ channelType: 'slack', channelId: 'D0DM1234' });
      expect(callOpts.prompt.context?.provenanceLabel as string).toContain('scheduled task');
    });

    it('creates 2-part and 3-part Slack DM bindings and pre-registers thread mapping after DM fallback delivery', async () => {
      const { agent } = await createTestAgent();
      (agent as any).sessionState.set('sessionId', 'orchestrator:user-1');
      (agent as any).sessionState.set('userId', 'user-1');

      const testDb = createTestDb();
      const appDb = testDb.db;
      appDb.insert(users).values({ id: 'user-1', email: 'user-1@example.com' }).run();
      appDb.insert(sessions).values({
        id: 'orchestrator:user-1', userId: 'user-1', workspace: '/tmp', status: 'running',
      }).run();
      appDb.insert(userIdentityLinks).values({
        id: 'link-slack', userId: 'user-1', provider: 'slack', externalId: 'U0SLACK99',
      }).run();
      Object.defineProperty(agent, 'appDb', { value: appDb, configurable: true });

      // Queue a scheduled-task processing row with a thread ID so getProcessingThreadId
      // returns the existing web conversation thread.
      (agent as any).promptQueue.enqueue({
        id: 'pq-bind-test',
        content: '',
        authorEmail: 'scheduled-task@valet.local',
        status: 'processing',
        threadId: 'existing-web-thread-uuid',
      });

      // Mock Slack install lookup, binding creation, and thread registration.
      vi.spyOn(slackDb, 'getOrgSlackInstallAny').mockResolvedValue({
        teamId: 'T0TEST123', botToken: 'xoxb-test', botUserId: 'BTEST',
        teamName: 'Test', appId: null,
      } as any);
      const ensureBindingSpy = vi.spyOn(channelsDb, 'ensureChannelBinding').mockResolvedValue(undefined);
      const registerThreadSpy = vi.spyOn(channelThreadsDb, 'registerChannelThread').mockResolvedValue(undefined);

      (agent as any).channelRouter.resolveUserDmTarget = vi.fn().mockResolvedValue({ channelType: 'slack', channelId: 'D0DM1234' });
      (agent as any).channelRouter.sendInteractivePrompt = vi.fn().mockResolvedValue([
        { channelType: 'slack', ref: { channelId: 'D0DM1234', messageId: '1700000000.000001' } },
      ]);

      delete (agent as any).sendChannelInteractivePrompts;

      const prompt: InteractivePrompt = {
        id: 'inv-bind-test',
        sessionId: 'orchestrator:user-1',
        type: 'approval',
        title: 'Approval',
        actions: [{ id: 'approve_once', label: 'Approve', style: 'primary' }],
      };

      await (agent as any).sendChannelInteractivePrompts('inv-bind-test', prompt);
      // Flush the fire-and-forget promise chain before asserting.
      await new Promise((r) => setTimeout(r, 0));

      // 2-part binding: catches regular DM replies (no thread_ts).
      expect(ensureBindingSpy).toHaveBeenCalledWith(
        appDb,
        expect.objectContaining({
          channelId: 'T0TEST123:D0DM1234',
          channelType: 'slack',
          userId: 'user-1',
          sessionId: 'orchestrator:user-1',
        }),
      );
      // 3-part binding: catches explicit "Reply in thread" on the approval message.
      expect(ensureBindingSpy).toHaveBeenCalledWith(
        appDb,
        expect.objectContaining({
          channelId: 'T0TEST123:D0DM1234:1700000000.000001',
          channelType: 'slack',
          slackThreadTs: '1700000000.000001',
        }),
      );
      // Thread mapping: routes replies to the originating web conversation thread.
      expect(registerThreadSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          channelType: 'slack',
          channelId: 'D0DM1234',
          externalThreadId: '1700000000.000001',
          userId: 'user-1',
          threadId: 'existing-web-thread-uuid',
        }),
      );
    });
  });

  // ─── expireInteractivePromptRow — error message ───────────────────────────────

  describe('expireInteractivePromptRow — error message', () => {
    it('sends actionable unattended error when session is orchestrator with scheduled-task author email', async () => {
      const { agent } = await createTestAgent();
      (agent as any).sessionState.set('sessionId', 'orchestrator:user-1');

      const runnerSendMock = vi.fn().mockReturnValue(true);
      (agent as any).runnerLink.send = runnerSendMock;

      const row = {
        id: 'inv-expire',
        type: 'approval',
        request_id: 'req-expire',
        context: JSON.stringify({ toolId: 'slack:send_message', invocationId: 'inv-expire' }),
        channel_refs: null,
      };

      // Set up appDb so updateInvocationStatus doesn't throw
      const testDb = createTestDb();
      const appDb = testDb.db;
      appDb.insert(users).values({ id: 'user-1', email: 'user-1@example.com' }).run();
      Object.defineProperty(agent, 'appDb', { value: appDb });

      // Enqueue a processing row with scheduled-task author email so isUnattended fires
      (agent as any).promptQueue.enqueue({
        id: 'pq-expire-sched',
        content: '',
        authorEmail: 'scheduled-task@valet.local',
        status: 'processing',
      });

      await (agent as any).expireInteractivePromptRow(row);

      const call = runnerSendMock.mock.calls.find(
        (c: Array<{ type: string; error?: string }>) => c[0].type === 'call-tool-result',
      );
      expect(call).toBeDefined();
      const error: string = call![0].error;
      expect(error).toContain('expired without a response');
      expect(error).toContain('Do not retry');
    });

    it('sends a plain expired message for attended (non-orchestrator) sessions', async () => {
      const { agent } = await createTestAgent();
      (agent as any).sessionState.set('sessionId', 'session-regular-123'); // non-orchestrator

      const runnerSendMock = vi.fn().mockReturnValue(true);
      (agent as any).runnerLink.send = runnerSendMock;

      const row = {
        id: 'inv-expire-att',
        type: 'approval',
        request_id: 'req-expire-att',
        context: JSON.stringify({ toolId: 'slack:send_message', invocationId: 'inv-expire-att' }),
        channel_refs: null,
      };

      await (agent as any).expireInteractivePromptRow(row);

      const call = runnerSendMock.mock.calls.find(
        (c: Array<{ type: string; error?: string }>) => c[0].type === 'call-tool-result',
      );
      expect(call).toBeDefined();
      const error: string = call![0].error;
      expect(error).toContain('expired without a response');
      expect(error).not.toContain('Do not retry');
      expect(error).not.toContain('running unattended');
    });
  });
});
