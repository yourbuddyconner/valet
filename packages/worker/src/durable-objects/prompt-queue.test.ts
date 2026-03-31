import { describe, it, expect, beforeEach } from 'vitest';
import { PromptQueue, type EnqueueParams, type CollectBufferEntry } from './prompt-queue.js';

// ─── SqlStorage Mock ─────────────────────────────────────────────────────────
//
// Real in-memory tables for prompt_queue and state, using Maps to simulate
// SQLite behavior. This gives accurate results without needing an actual DB.

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

function createMockSql(): SqlStorage & { queue: Map<string, QueueRow>; state: Map<string, string> } {
  const queue = new Map<string, QueueRow>();
  const state = new Map<string, string>();
  insertCounter = 0;

  return {
    queue,
    state,
    exec(query: string, ...params: unknown[]) {
      const q = query.trim();

      // ─── prompt_queue operations ─────────────────────────────────

      if (q.startsWith('INSERT INTO prompt_queue')) {
        insertCounter++;
        const row: QueueRow = {
          id: (params[0] as string) || '',
          content: (params[1] as string) || '',
          attachments: null,
          model: null,
          queue_type: 'prompt',
          workflow_execution_id: null,
          workflow_payload: null,
          status: 'queued',
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
          created_at: insertCounter, // monotonic for ordering
        };

        // Parse workflow_execute INSERTs
        if (q.includes("'workflow_execute'")) {
          row.content = '';
          row.queue_type = 'workflow_execute';
          row.workflow_execution_id = (params[1] as string) || null;
          row.workflow_payload = (params[2] as string) || null;
          row.status = (params[3] as string) || 'queued';
        } else if (params.length >= 17) {
          // Full prompt INSERT
          row.attachments = (params[2] as string) || null;
          row.model = (params[3] as string) || null;
          row.status = (params[4] as string) || 'queued';
          row.author_id = (params[5] as string) || null;
          row.author_email = (params[6] as string) || null;
          row.author_name = (params[7] as string) || null;
          row.author_avatar_url = (params[8] as string) || null;
          row.channel_type = (params[9] as string) || null;
          row.channel_id = (params[10] as string) || null;
          row.channel_key = (params[11] as string) || null;
          row.thread_id = (params[12] as string) || null;
          row.continuation_context = (params[13] as string) || null;
          row.context_prefix = (params[14] as string) || null;
          row.reply_channel_type = (params[15] as string) || null;
          row.reply_channel_id = (params[16] as string) || null;
        } else if (params.length >= 3) {
          // Minimal INSERT (id, content, status, thread_id)
          row.status = q.includes("'processing'") ? 'processing' : 'queued';
          row.thread_id = (params[2] as string) || null;
        }

        queue.set(row.id, row);
        return cursor([]);
      }

      if (q.startsWith('SELECT') && q.includes('FROM prompt_queue')) {
        let rows = Array.from(queue.values());

        if (q.includes("status = 'queued'")) {
          rows = rows.filter((r) => r.status === 'queued');
        } else if (q.includes("status = 'processing'")) {
          rows = rows.filter((r) => r.status === 'processing');
        } else if (q.includes("status = 'completed'")) {
          rows = rows.filter((r) => r.status === 'completed');
        }

        if (q.includes('COUNT(*)')) {
          return cursor([{ count: rows.length, c: rows.length }]);
        }

        if (q.includes('ORDER BY created_at ASC')) {
          rows.sort((a, b) => a.created_at - b.created_at);
        }
        if (q.includes('ORDER BY created_at DESC')) {
          rows.sort((a, b) => b.created_at - a.created_at);
        }

        if (q.includes('LIMIT 1') && rows.length > 1) {
          rows = [rows[0]];
        }

        return cursor(rows);
      }

      if (q.startsWith('UPDATE prompt_queue')) {
        if (q.includes("SET status = 'processing' WHERE id = ?")) {
          const row = queue.get(params[0] as string);
          if (row) row.status = 'processing';
        } else if (q.includes("SET status = 'completed' WHERE status = 'processing'")) {
          for (const row of queue.values()) {
            if (row.status === 'processing') row.status = 'completed';
          }
        } else if (q.includes("SET status = 'completed' WHERE id = ?")) {
          const row = queue.get(params[0] as string);
          if (row) row.status = 'completed';
        } else if (q.includes("SET status = 'queued' WHERE status = 'processing'")) {
          for (const row of queue.values()) {
            if (row.status === 'processing') row.status = 'queued';
          }
        } else if (q.includes("SET status = 'queued' WHERE id = ?")) {
          const row = queue.get(params[0] as string);
          if (row) row.status = 'queued';
        }
        return cursor([]);
      }

      if (q.startsWith('DELETE FROM prompt_queue')) {
        if (q.includes("status = 'queued' AND channel_key = ?")) {
          const channelKey = params[0] as string;
          for (const [id, row] of queue) {
            if (row.status === 'queued' && row.channel_key === channelKey) queue.delete(id);
          }
        } else if (q.includes("status = 'queued'")) {
          for (const [id, row] of queue) {
            if (row.status === 'queued') queue.delete(id);
          }
        } else if (q.includes("status = 'completed'")) {
          for (const [id, row] of queue) {
            if (row.status === 'completed') queue.delete(id);
          }
        } else {
          queue.clear();
        }
        return cursor([]);
      }

      // ─── state table operations ──────────────────────────────────

      if (q.startsWith('INSERT OR REPLACE INTO state')) {
        state.set(params[0] as string, params[1] as string);
        return cursor([]);
      }

      if (q.startsWith('SELECT') && q.includes('FROM state')) {
        if (q.includes('WHERE key = ?')) {
          const val = state.get(params[0] as string);
          return val !== undefined ? cursor([{ value: val }]) : cursor([]);
        }
        if (q.includes("LIKE 'collectFlushAt:%'")) {
          const rows: { key: string; value: string }[] = [];
          for (const [k, v] of state) {
            if (k.startsWith('collectFlushAt:') && (!q.includes("AND value != ''") || v !== '')) {
              rows.push({ key: k, value: v });
            }
          }
          if (q.includes('LIMIT 1') && rows.length > 1) return cursor([rows[0]]);
          return cursor(rows);
        }
        return cursor([]);
      }

      // ─── Migration / no-op ───────────────────────────────────────

      return cursor([]);
    },
  } as unknown as SqlStorage & { queue: Map<string, QueueRow>; state: Map<string, string> };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('PromptQueue', () => {
  let sql: ReturnType<typeof createMockSql>;
  let pq: PromptQueue;

  beforeEach(() => {
    sql = createMockSql();
    pq = new PromptQueue(sql);
  });

  // ─── Core Queue Operations ─────────────────────────────────────────

  describe('enqueue / dequeue lifecycle', () => {
    it('enqueues a prompt and dequeues it FIFO', () => {
      pq.enqueue({ id: 'p1', content: 'hello' });
      pq.enqueue({ id: 'p2', content: 'world' });

      expect(pq.length).toBe(2);

      const entry = pq.dequeueNext();
      expect(entry).not.toBeNull();
      expect(entry!.id).toBe('p1');
      expect(entry!.content).toBe('hello');
      expect(pq.length).toBe(1);

      // The dequeued entry is now 'processing'
      expect(pq.processingCount).toBe(1);
    });

    it('dequeueNext returns null when empty', () => {
      expect(pq.dequeueNext()).toBeNull();
    });

    it('enqueues with processing status for direct dispatch', () => {
      pq.enqueue({ id: 'p1', content: 'direct', status: 'processing' });
      expect(pq.length).toBe(0); // not queued
      expect(pq.processingCount).toBe(1);
    });

    it('preserves full prompt metadata through enqueue/dequeue', () => {
      pq.enqueue({
        id: 'p1', content: 'test', model: 'gpt-4',
        authorId: 'u1', authorEmail: 'u@x.com', authorName: 'User',
        channelType: 'slack', channelId: 'C123', channelKey: 'slack:C123',
        threadId: 'th1', continuationContext: 'ctx', contextPrefix: 'prefix',
        replyChannelType: 'slack', replyChannelId: 'C123:ts',
        attachments: '[{"type":"file"}]',
      });

      const entry = pq.dequeueNext()!;
      expect(entry.model).toBe('gpt-4');
      expect(entry.authorId).toBe('u1');
      expect(entry.authorEmail).toBe('u@x.com');
      expect(entry.channelType).toBe('slack');
      expect(entry.threadId).toBe('th1');
      expect(entry.contextPrefix).toBe('prefix');
      expect(entry.replyChannelType).toBe('slack');
      expect(entry.replyChannelId).toBe('C123:ts');
      expect(entry.attachments).toBe('[{"type":"file"}]');
    });
  });

  describe('markCompleted', () => {
    it('marks processing entries completed and prunes', () => {
      pq.enqueue({ id: 'p1', content: 'a', status: 'processing' });
      pq.enqueue({ id: 'p2', content: 'b' });

      const count = pq.markCompleted();
      expect(count).toBe(1);
      // p1 was processing → completed → deleted, p2 still queued
      expect(pq.length).toBe(1);
      expect(pq.processingCount).toBe(0);
    });

    it('returns 0 when nothing is processing', () => {
      pq.enqueue({ id: 'p1', content: 'a' });
      expect(pq.markCompleted()).toBe(0);
    });
  });

  describe('revertProcessingToQueued', () => {
    it('reverts all processing entries', () => {
      pq.enqueue({ id: 'p1', content: 'a', status: 'processing' });
      pq.enqueue({ id: 'p2', content: 'b', status: 'processing' });

      pq.revertProcessingToQueued();
      expect(pq.length).toBe(2);
      expect(pq.processingCount).toBe(0);
    });

    it('reverts a single entry by id', () => {
      pq.enqueue({ id: 'p1', content: 'a', status: 'processing' });
      pq.enqueue({ id: 'p2', content: 'b', status: 'processing' });

      pq.revertProcessingToQueued('p1');
      expect(pq.length).toBe(1);
      expect(pq.processingCount).toBe(1);
    });
  });

  describe('dropEntry', () => {
    it('marks a single entry as completed', () => {
      pq.enqueue({ id: 'p1', content: 'bad', status: 'processing' });
      pq.dropEntry('p1');
      expect(pq.processingCount).toBe(0);
      // It's now 'completed', not deleted yet (markCompleted does the prune)
    });
  });

  describe('clearQueued', () => {
    it('clears all queued entries', () => {
      pq.enqueue({ id: 'p1', content: 'a' });
      pq.enqueue({ id: 'p2', content: 'b' });
      pq.enqueue({ id: 'p3', content: 'c', status: 'processing' });

      const cleared = pq.clearQueued();
      expect(cleared).toBe(2);
      expect(pq.length).toBe(0);
      expect(pq.processingCount).toBe(1); // processing untouched
    });

    it('clears only for a specific channel', () => {
      pq.enqueue({ id: 'p1', content: 'a', channelKey: 'slack:C1' });
      pq.enqueue({ id: 'p2', content: 'b', channelKey: 'slack:C2' });

      const cleared = pq.clearQueued('slack:C1');
      expect(cleared).toBe(1);
      expect(pq.length).toBe(1);
    });
  });

  describe('clearAll', () => {
    it('removes everything', () => {
      pq.enqueue({ id: 'p1', content: 'a' });
      pq.enqueue({ id: 'p2', content: 'b', status: 'processing' });
      pq.clearAll();
      expect(pq.length).toBe(0);
      expect(pq.processingCount).toBe(0);
    });
  });

  // ─── Queries ──────────────────────────────────────────────────────────

  describe('getProcessingThreadId', () => {
    it('returns thread_id from processing entry', () => {
      pq.enqueue({ id: 'p1', content: 'a', threadId: 'th42', status: 'processing' });
      expect(pq.getProcessingThreadId()).toBe('th42');
    });

    it('returns null when no processing entry', () => {
      expect(pq.getProcessingThreadId()).toBeNull();
    });
  });

  describe('getProcessingModel', () => {
    it('returns model from processing entry', () => {
      pq.enqueue({ id: 'p1', content: 'a', model: 'claude-3', status: 'processing' });
      expect(pq.getProcessingModel()).toBe('claude-3');
    });
  });

  describe('getProcessingChannelContext', () => {
    it('prefers reply channel over channel', () => {
      pq.enqueue({
        id: 'p1', content: 'a', status: 'processing',
        channelType: 'thread', channelId: 'th1',
        replyChannelType: 'slack', replyChannelId: 'C123:ts',
      });
      const ctx = pq.getProcessingChannelContext();
      expect(ctx).toEqual({ channelType: 'slack', channelId: 'C123:ts' });
    });

    it('falls back to channel when no reply channel', () => {
      pq.enqueue({
        id: 'p1', content: 'a', status: 'processing',
        channelType: 'telegram', channelId: '12345',
      });
      const ctx = pq.getProcessingChannelContext();
      expect(ctx).toEqual({ channelType: 'telegram', channelId: '12345' });
    });

    it('returns null when no processing entry', () => {
      expect(pq.getProcessingChannelContext()).toBeNull();
    });
  });

  // ─── Queue Dispatch State ─────────────────────────────────────────────

  describe('runnerBusy', () => {
    it('defaults to false', () => {
      expect(pq.runnerBusy).toBe(false);
    });

    it('can be set to true and back', () => {
      pq.runnerBusy = true;
      expect(pq.runnerBusy).toBe(true);
      pq.runnerBusy = false;
      expect(pq.runnerBusy).toBe(false);
    });
  });

  describe('stampDispatched', () => {
    it('sets runnerBusy and lastPromptDispatchedAt', () => {
      pq.stampDispatched();
      expect(pq.runnerBusy).toBe(true);
      expect(pq.lastPromptDispatchedAt).toBeGreaterThan(0);
    });
  });

  describe('clearDispatchTimers', () => {
    it('clears lastPromptDispatchedAt and errorSafetyNetAt', () => {
      pq.stampDispatched();
      pq.errorSafetyNetAt = Date.now() + 60000;
      pq.clearDispatchTimers();
      expect(pq.lastPromptDispatchedAt).toBe(0);
      expect(pq.errorSafetyNetAt).toBe(0);
    });
  });

  describe('promptReceivedAt', () => {
    it('stamps and clears', () => {
      pq.stampPromptReceived();
      expect(pq.promptReceivedAt).toBeGreaterThan(0);
      pq.clearPromptReceived();
      expect(pq.promptReceivedAt).toBe(0);
    });
  });

  describe('currentPromptAuthorId', () => {
    it('gets and sets', () => {
      expect(pq.currentPromptAuthorId).toBeUndefined();
      pq.currentPromptAuthorId = 'user123';
      expect(pq.currentPromptAuthorId).toBe('user123');
      pq.currentPromptAuthorId = undefined;
      expect(pq.currentPromptAuthorId).toBeUndefined();
    });
  });

  describe('queueMode', () => {
    it('defaults to followup', () => {
      expect(pq.queueMode).toBe('followup');
    });

    it('can be changed', () => {
      pq.queueMode = 'collect';
      expect(pq.queueMode).toBe('collect');
    });
  });

  describe('isStuckProcessing', () => {
    it('returns false with no dispatch', () => {
      expect(pq.isStuckProcessing(5000)).toBe(false);
    });

    it('returns true when dispatch is older than timeout', () => {
      // Set lastPromptDispatchedAt to 10 seconds ago
      sql.state.set('lastPromptDispatchedAt', String(Date.now() - 10000));
      expect(pq.isStuckProcessing(5000)).toBe(true);
    });

    it('returns false when dispatch is newer than timeout', () => {
      sql.state.set('lastPromptDispatchedAt', String(Date.now() - 1000));
      expect(pq.isStuckProcessing(5000)).toBe(false);
    });
  });

  // ─── Workflow Queue Entries ───────────────────────────────────────────

  describe('workflow entries', () => {
    it('enqueues workflow_execute type', () => {
      pq.enqueue({
        id: 'wf1', content: '',
        queueType: 'workflow_execute',
        workflowExecutionId: 'exec-1',
        workflowPayload: '{"kind":"run","executionId":"exec-1","payload":{}}',
      });

      const entry = pq.dequeueNext()!;
      expect(entry.queueType).toBe('workflow_execute');
      expect(entry.workflowExecutionId).toBe('exec-1');
      expect(entry.workflowPayload).toContain('exec-1');
    });
  });

  // ─── Collect Mode ─────────────────────────────────────────────────────

  describe('collect mode', () => {
    it('appends to buffer and returns length', () => {
      const entry: CollectBufferEntry = { content: 'msg1' };
      const len = pq.appendToCollectBuffer('slack:C1', entry);
      expect(len).toBe(1);

      const len2 = pq.appendToCollectBuffer('slack:C1', { content: 'msg2' });
      expect(len2).toBe(2);
    });

    it('sets flush deadline per channel', () => {
      pq.appendToCollectBuffer('slack:C1', { content: 'msg' });
      const flushAt = sql.state.get('collectFlushAt:slack:C1');
      expect(flushAt).toBeDefined();
      expect(parseInt(flushAt!)).toBeGreaterThan(Date.now() - 1000);
    });

    it('hasCollectFlushDue returns false when no buffers', () => {
      expect(pq.hasCollectFlushDue()).toBe(false);
    });

    it('hasCollectFlushDue returns true when flush is past due', () => {
      sql.state.set('collectFlushAt:slack:C1', String(Date.now() - 1000));
      expect(pq.hasCollectFlushDue()).toBe(true);
    });

    it('getReadyCollectFlushes returns ready buffers and clears state', () => {
      // Set up a buffer that's ready to flush
      const buffer: CollectBufferEntry[] = [
        { content: 'msg1', channelType: 'slack', channelId: 'C1' },
        { content: 'msg2', channelType: 'slack', channelId: 'C1' },
      ];
      sql.state.set('collectBuffer:slack:C1', JSON.stringify(buffer));
      sql.state.set('collectFlushAt:slack:C1', String(Date.now() - 1000));

      // Not ready yet
      sql.state.set('collectBuffer:slack:C2', JSON.stringify([{ content: 'future' }]));
      sql.state.set('collectFlushAt:slack:C2', String(Date.now() + 60000));

      const flushes = pq.getReadyCollectFlushes();
      expect(flushes).toHaveLength(1);
      expect(flushes[0].channelKey).toBe('slack:C1');
      expect(flushes[0].buffer).toHaveLength(2);

      // State should be cleared for C1
      expect(sql.state.get('collectBuffer:slack:C1')).toBe('');
      expect(sql.state.get('collectFlushAt:slack:C1')).toBe('');

      // C2 should be untouched
      expect(sql.state.get('collectBuffer:slack:C2')).toBeDefined();
    });

    it('handles legacy non-keyed buffer', () => {
      const buffer: CollectBufferEntry[] = [{ content: 'legacy-msg' }];
      sql.state.set('collectBuffer', JSON.stringify(buffer));
      sql.state.set('collectFlushAt', String(Date.now() - 1000));

      const flushes = pq.getReadyCollectFlushes();
      expect(flushes).toHaveLength(1);
      expect(flushes[0].channelKey).toBe('__legacy__');
      expect(flushes[0].buffer).toHaveLength(1);

      // Legacy state should be cleared
      expect(sql.state.get('collectBuffer')).toBe('');
      expect(sql.state.get('collectFlushAt')).toBe('');
    });

    it('collectDebounceMs defaults to 3000', () => {
      expect(pq.collectDebounceMs).toBe(3000);
    });

    it('collectDebounceMs can be changed', () => {
      pq.collectDebounceMs = 5000;
      expect(pq.collectDebounceMs).toBe(5000);
    });
  });

  describe('idleQueuedSince', () => {
    it('is 0 by default', () => {
      expect(pq.idleQueuedSince).toBe(0);
    });

    it('stores and retrieves a timestamp', () => {
      pq.idleQueuedSince = 1711921234000;
      expect(pq.idleQueuedSince).toBe(1711921234000);
    });

    it('clears when set to 0', () => {
      pq.idleQueuedSince = 1711921234000;
      pq.idleQueuedSince = 0;
      expect(pq.idleQueuedSince).toBe(0);
    });
  });

  // ─── Migrations ───────────────────────────────────────────────────────

  describe('runMigrations', () => {
    it('runs without error', () => {
      // runMigrations does ALTER TABLE which our mock ignores
      expect(() => pq.runMigrations()).not.toThrow();
    });
  });

  // ─── Edge Cases ───────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('enqueue with null optional fields', () => {
      pq.enqueue({ id: 'p1', content: 'bare minimum' });
      const entry = pq.dequeueNext()!;
      expect(entry.model).toBeNull();
      expect(entry.authorId).toBeNull();
      expect(entry.channelType).toBeNull();
      expect(entry.threadId).toBeNull();
    });

    it('multiple dequeue/complete cycles', () => {
      pq.enqueue({ id: 'p1', content: 'first' });
      pq.enqueue({ id: 'p2', content: 'second' });
      pq.enqueue({ id: 'p3', content: 'third' });

      // Dequeue and complete first
      const e1 = pq.dequeueNext()!;
      expect(e1.id).toBe('p1');
      pq.markCompleted();

      // Dequeue and complete second
      const e2 = pq.dequeueNext()!;
      expect(e2.id).toBe('p2');
      pq.markCompleted();

      // Dequeue third
      const e3 = pq.dequeueNext()!;
      expect(e3.id).toBe('p3');
      pq.markCompleted();

      // Queue is empty
      expect(pq.dequeueNext()).toBeNull();
      expect(pq.length).toBe(0);
    });

    it('clearQueued returns 0 when nothing to clear', () => {
      expect(pq.clearQueued()).toBe(0);
    });
  });
});
