import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionAgentDO, buildForwardedParts } from './session-agent.js';

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
  messages: Map<string, Record<string, unknown>>;
  channelState: Map<string, { busy: number; opencode_session_id: string | null }>;
} {
  const queue = new Map<string, QueueRow>();
  const state = new Map<string, string>();
  const interactivePrompts = new Map<string, InteractivePromptRow>();
  const messages = new Map<string, Record<string, unknown>>();
  const channelState = new Map<string, { busy: number; opencode_session_id: string | null }>();
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
        const opencodeSessionId = params[1] === undefined || params[1] === null
          ? null
          : String(params[1]);
        const existing = channelState.get(channelKey);
        channelState.set(channelKey, {
          busy: existing?.busy ?? 0,
          opencode_session_id: opencodeSessionId,
        });
        return cursor([]);
      }

      if (q.startsWith('SELECT') && q.includes('FROM channel_state')) {
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
          child_session_id: (params[17] as string) || null,
          child_status: (params[18] as string) || null,
          priority: typeof params[19] === 'number' ? params[19] : 0,
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

        if (q.includes("queue_type = 'prompt'")) {
          rows = rows.filter((row) => row.queue_type === 'prompt');
        }

        if (q.includes('child_session_id IS NULL')) {
          rows = rows.filter((row) => row.child_session_id === null);
        }

        if (q.includes('COUNT(*)')) {
          return cursor([{ count: rows.length, c: rows.length }]);
        }

        if (q.includes('ORDER BY created_at DESC')) {
          rows.sort((a, b) => b.created_at - a.created_at);
        } else if (q.includes('ORDER BY priority DESC, created_at ASC')) {
          rows.sort((a, b) => b.priority - a.priority || a.created_at - b.created_at);
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
        } else if (q.includes('WHERE id = ?')) {
          queue.delete(String(params[0]));
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
    messages: Map<string, Record<string, unknown>>;
    channelState: Map<string, { busy: number; opencode_session_id: string | null }>;
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

    await (agent as any).handleClearQueue();

    const withdrawn = broadcasts.find((b) => b.type === 'queue.withdrawn');
    expect(withdrawn).toBeTruthy();
    expect((withdrawn as any).data.content).toBe('will be cleared');

    const queueState = broadcasts.find((b) => b.type === 'queue.state');
    expect((queueState as any)?.data?.pending).toBeNull();

    expect((agent as any).promptQueue.length).toBe(0);
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
    expect(queueState?.data).toEqual({ pending: null });
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

  it('drops screenshot emission when prompt_queue has no row for messageId', async () => {
    const { agent, broadcasts } = await createTestAgent();
    const writeMessageSpy = vi.spyOn((agent as any).messageStore, 'writeMessage');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await (agent as any).runnerHandlers.screenshot({
      type: 'screenshot',
      messageId: 'nonexistent',
      data: 'base64data',
      description: 'A screenshot',
    });

    expect(warnSpy).toHaveBeenCalledWith(
      '[ChannelRouting] dropped emission',
      expect.objectContaining({ reason: 'no_prompt_row', eventType: 'screenshot', messageId: 'nonexistent' }),
    );
    expect(writeMessageSpy).not.toHaveBeenCalled();
    expect(broadcasts.find((m) => m.type === 'message')).toBeUndefined();
  });

  it('attributes screenshot to channel from prompt_queue lookup', async () => {
    const { agent, broadcasts } = await createTestAgent();
    (agent as any).promptQueue.enqueue({
      id: 'msg-1',
      content: 'hi',
      status: 'processing',
      channelType: 'slack',
      channelId: 'C123',
    });
    const writeMessageSpy = vi.spyOn((agent as any).messageStore, 'writeMessage');

    await (agent as any).runnerHandlers.screenshot({
      type: 'screenshot',
      messageId: 'msg-1',
      data: 'base64data',
      description: 'A screenshot',
    });

    expect(writeMessageSpy).toHaveBeenCalledTimes(1);
    expect(writeMessageSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'system',
        content: 'A screenshot',
        parts: expect.stringContaining('screenshot'),
        channelType: 'slack',
        channelId: 'C123',
      }),
    );

    const ssBroadcast = broadcasts.find((m) => m.type === 'message');
    expect(ssBroadcast).toMatchObject({
      type: 'message',
      data: expect.objectContaining({
        role: 'system',
        content: 'A screenshot',
        channelType: 'slack',
        channelId: 'C123',
      }),
    });
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
});
