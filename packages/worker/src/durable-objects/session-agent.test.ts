import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionAgentDO } from './session-agent.js';

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
  created_at: number;
}

interface InteractivePromptRow {
  id: string;
  type: string;
  request_id: string | null;
  title: string;
  actions: string;
  context: string;
  status: string;
  expires_at: number | null;
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
} {
  const queue = new Map<string, QueueRow>();
  const state = new Map<string, string>();
  const interactivePrompts = new Map<string, InteractivePromptRow>();
  insertCounter = 0;

  return {
    queue,
    state,
    interactivePrompts,
    exec(query: string, ...params: unknown[]) {
      const q = query.trim();

      if (q.startsWith('CREATE') || q.startsWith('ALTER TABLE')) {
        return cursor([]);
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

      if (q.includes("SELECT value FROM replication_state WHERE key = 'last_replicated_seq'")) {
        return cursor([]);
      }

      if (q.startsWith('SELECT') && q.includes('FROM state')) {
        const value = state.get(String(params[0]));
        return value === undefined ? cursor([]) : cursor([{ value }]);
      }

      if (q.startsWith('INSERT INTO prompt_queue')) {
        insertCounter += 1;
        const row: QueueRow = {
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
          created_at: insertCounter,
        };
        queue.set(row.id, row);
        return cursor([]);
      }

      if (q.startsWith('SELECT') && q.includes('FROM prompt_queue')) {
        let rows = Array.from(queue.values());
        if (q.includes("status = 'queued'")) {
          rows = rows.filter((row) => row.status === 'queued');
        } else if (q.includes("status = 'processing'")) {
          rows = rows.filter((row) => row.status === 'processing');
        } else if (q.includes("status = 'completed'")) {
          rows = rows.filter((row) => row.status === 'completed');
        }

        if (q.includes('COUNT(*)')) {
          return cursor([{ count: rows.length, c: rows.length }]);
        }

        if (q.includes('ORDER BY created_at DESC')) {
          rows.sort((a, b) => b.created_at - a.created_at);
        } else if (q.includes('ORDER BY created_at ASC')) {
          rows.sort((a, b) => a.created_at - b.created_at);
        }

        if (q.includes('LIMIT 1') && rows.length > 1) {
          rows = [rows[0]];
        }

        return cursor(rows);
      }

      if (q.startsWith('UPDATE prompt_queue')) {
        if (q.includes("SET status = 'completed' WHERE status = 'processing'")) {
          for (const row of queue.values()) {
            if (row.status === 'processing') row.status = 'completed';
          }
        } else if (q.includes("SET status = 'queued' WHERE status = 'processing'")) {
          for (const row of queue.values()) {
            if (row.status === 'processing') row.status = 'queued';
          }
        } else if (q.includes("SET status = 'queued' WHERE id = ?")) {
          const row = queue.get(String(params[0]));
          if (row) row.status = 'queued';
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
        } else {
          queue.clear();
        }
        return cursor([]);
      }

      if (q.startsWith('INSERT INTO interactive_prompts') || q.startsWith('INSERT OR REPLACE INTO interactive_prompts')) {
        interactivePrompts.set(String(params[0]), {
          id: String(params[0]),
          type: String(q.includes("'approval'") ? 'approval' : 'question'),
          request_id: (params[1] as string) || null,
          title: String(params[2] ?? ''),
          actions: String(params[3] ?? ''),
          context: String(params[4] ?? ''),
          status: 'pending',
          expires_at: typeof params[5] === 'number' ? params[5] : null,
        });
        return cursor([]);
      }

      if (q.startsWith('UPDATE interactive_prompts SET channel_refs = ? WHERE id = ?')) {
        return cursor([]);
      }

      return cursor([]);
    },
  } as unknown as SqlStorage & {
    queue: Map<string, QueueRow>;
    state: Map<string, string>;
    interactivePrompts: Map<string, InteractivePromptRow>;
  };
}

function createMockCtx() {
  const sql = createMockSql();
  let initPromise: Promise<void> = Promise.resolve();
  const waitUntil = vi.fn((promise: Promise<unknown>) => promise);

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
    getWebSockets: vi.fn(() => []),
    waitUntil,
  } as unknown as DurableObjectState;

  return { ctx, sql, waitUntil, initPromise: () => initPromise };
}

function createMockDb() {
  return {
    prepare: vi.fn(() => ({
      bind: vi.fn(() => ({
        first: vi.fn().mockResolvedValue(null),
        run: vi.fn().mockResolvedValue({ success: true }),
        all: vi.fn().mockResolvedValue({ results: [] }),
      })),
    })),
  };
}

async function createTestAgent(opts?: { sockets?: Array<{ send: ReturnType<typeof vi.fn> }> }) {
  const { ctx, sql, waitUntil, initPromise } = createMockCtx();
  const sockets = opts?.sockets ?? [];
  (ctx.getWebSockets as unknown as ReturnType<typeof vi.fn>).mockReturnValue(sockets);

  const agent = new SessionAgentDO(ctx, { DB: createMockDb() } as any);
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

    (agent as any).channelRouter.setActiveChannel({ channelType: 'slack', channelId: 'C123' });
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
    (agent as any).promptQueue.stampPromptReceived();

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
      questionId: 'q-web',
      text: 'Need a decision',
      options: ['Yes', 'No'],
    });

    const promptMessage = broadcasts.find((message) => message.type === 'interactive_prompt');
    expect(promptMessage).toBeTruthy();
    expect(promptMessage).not.toHaveProperty('channelType');
    expect(promptMessage).not.toHaveProperty('channelId');
    expect(promptMessage?.prompt).toMatchObject({
      id: 'q-web',
      type: 'question',
      context: { options: ['Yes', 'No'] },
    });

    expect(sendChannelInteractivePrompts).toHaveBeenCalledOnce();
    expect(sendChannelInteractivePrompts).toHaveBeenCalledWith(
      'q-web',
      expect.objectContaining({
        context: { options: ['Yes', 'No'] },
      }),
    );
    expect(waitUntil).toHaveBeenCalledOnce();

    const storedPrompt = sql.interactivePrompts.get('q-web');
    expect(storedPrompt).toBeTruthy();
    expect(JSON.parse(storedPrompt!.context)).toEqual({ options: ['Yes', 'No'] });
  });

  it('keeps assistant turns on the current orchestrator thread after the processing row is gone', async () => {
    const { agent, broadcasts } = await createTestAgent();
    (agent as any).sessionState.set('currentThreadId', 'thread-keep-visible');

    await (agent as any).runnerHandlers['message.create']({
      type: 'message.create',
      turnId: 'turn-1',
    });

    const created = broadcasts.find((message) => message.type === 'message');
    expect(created).toBeTruthy();
    expect(created?.data).toMatchObject({
      id: 'turn-1',
      role: 'assistant',
      threadId: 'thread-keep-visible',
    });
  });

  it('persists currentThreadId from a direct threaded prompt for later assistant turns', async () => {
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

    expect((agent as any).sessionState.currentThreadId).toBe('thread-direct');

    await (agent as any).handlePromptComplete();
    await (agent as any).runnerHandlers['message.create']({
      type: 'message.create',
      turnId: 'turn-direct',
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

  it('persists currentThreadId from a queued threaded prompt for later assistant turns', async () => {
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
    expect((agent as any).sessionState.currentThreadId).toBe('thread-queued');

    await (agent as any).handlePromptComplete();
    await (agent as any).runnerHandlers['message.create']({
      type: 'message.create',
      turnId: 'turn-queued',
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
    (agent as any).sessionState.set('currentThreadId', 'thread-parts');

    await (agent as any).runnerHandlers['message.create']({
      type: 'message.create',
      turnId: 'turn-parts',
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
});
