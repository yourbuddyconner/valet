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

  it('re-arms the alarm when idle hibernation is the only pending deadline', async () => {
    const { agent } = await createTestAgent();

    (agent as any).sessionState.idleTimeoutMs = 60_000;
    (agent as any).sessionState.lastUserActivityAt = Date.now() - 1_000;

    const scheduleAlarm = vi.spyOn((agent as any).lifecycle, 'scheduleAlarm');

    await agent.alarm();

    expect(scheduleAlarm).toHaveBeenCalledTimes(1);
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

  it('tags assistant messages with the thread from the processing prompt queue entry', async () => {
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

    // Thread ID comes from the processing queue entry, not sessionState
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

    // Thread ID resolved from the processing queue entry
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
    // Simulate a processing entry with a thread_id so message.create can resolve it
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
});
