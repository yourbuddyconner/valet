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
  child_session_id: string | null;
  child_status: string | null;
  priority: number;
  replaceable: number;
  received_at: number | null;
  dispatched_at: number | null;
  created_at: number;
}

interface ChannelStateRow {
  busy: number;
  opencode_session_id: string | null;
  idle_queued_since: number | null;
  error_safety_net_at: number | null;
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

function createMockSql(): SqlStorage & { queue: Map<string, QueueRow>; state: Map<string, string>; channelState: Map<string, ChannelStateRow> } {
  const queue = new Map<string, QueueRow>();
  const state = new Map<string, string>();
  const channelState = new Map<string, ChannelStateRow>();
  insertCounter = 0;

  return {
    queue,
    state,
    channelState,
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
          child_session_id: null,
          child_status: null,
          priority: 0,
          replaceable: 1,
          received_at: null,
          dispatched_at: null,
          created_at: insertCounter, // monotonic for ordering
        };

        // Parse workflow_execute INSERTs (id, exec_id, payload, status, received_at)
        if (q.includes("'workflow_execute'")) {
          row.content = '';
          row.queue_type = 'workflow_execute';
          row.workflow_execution_id = (params[1] as string) || null;
          row.workflow_payload = (params[2] as string) || null;
          row.status = (params[3] as string) || 'queued';
          row.received_at = typeof params[4] === 'number' ? params[4] : Date.now();
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
          row.child_session_id = (params[17] as string) || null;
          row.child_status = (params[18] as string) || null;
          row.priority = typeof params[19] === 'number' ? params[19] : 0;
          row.replaceable = typeof params[20] === 'number' ? params[20] : 1;
          row.received_at = typeof params[21] === 'number' ? params[21] : Date.now();
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

        if (q.includes('WHERE id = ?')) {
          rows = rows.filter((r) => r.id === (params[0] as string));
          if (q.includes("AND status = 'processing'")) {
            rows = rows.filter((r) => r.status === 'processing');
          } else if (q.includes("AND status = 'queued'")) {
            rows = rows.filter((r) => r.status === 'queued');
          }
        } else if (q.includes('WHERE channel_key = ?')) {
          const channelKey = String(params[0]);
          rows = rows.filter((r) => r.channel_key === channelKey);
          if (q.includes("AND status = 'processing'")) {
            rows = rows.filter((r) => r.status === 'processing');
          } else if (q.includes("AND status = 'queued'")) {
            rows = rows.filter((r) => r.status === 'queued');
          }
        } else if (q.includes("status = 'queued'")) {
          rows = rows.filter((r) => r.status === 'queued');
        } else if (q.includes("status = 'processing'")) {
          rows = rows.filter((r) => r.status === 'processing');
        } else if (q.includes("status = 'completed'")) {
          rows = rows.filter((r) => r.status === 'completed');
        }

        if (q.includes('child_session_id IS NULL')) {
          rows = rows.filter((r) => r.child_session_id === null);
        }

        if (q.includes('child_session_id IS NOT NULL')) {
          rows = rows.filter((r) => r.child_session_id !== null);
        }

        if (q.includes('replaceable = 1')) {
          rows = rows.filter((r) => r.replaceable === 1);
        }

        if (q.includes('COUNT(*)')) {
          return cursor([{ count: rows.length, c: rows.length }]);
        }

        // Aggregates
        if (q.includes('MAX(dispatched_at)')) {
          const ts = rows
            .filter((r) => r.dispatched_at !== null)
            .reduce<number | null>((max, r) => Math.max(max ?? 0, r.dispatched_at as number) , null);
          return cursor([{ ts }]);
        }
        if (q.includes('MIN(dispatched_at)')) {
          const filtered = rows.filter((r) => r.dispatched_at !== null);
          const ts = filtered.length === 0 ? null : filtered.reduce<number>((min, r) => Math.min(min, r.dispatched_at as number), Infinity);
          return cursor([{ ts: ts === Infinity ? null : ts }]);
        }
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

        if (q.includes('ORDER BY priority DESC, created_at ASC')) {
          rows.sort((a, b) => b.priority - a.priority || a.created_at - b.created_at);
        } else if (q.includes('ORDER BY created_at ASC')) {
          rows.sort((a, b) => a.created_at - b.created_at);
        } else if (q.includes('ORDER BY dispatched_at ASC')) {
          rows = rows.filter((r) => r.dispatched_at !== null);
          rows.sort((a, b) => (a.dispatched_at as number) - (b.dispatched_at as number));
        }
        if (q.includes('ORDER BY created_at DESC')) {
          rows.sort((a, b) => b.created_at - a.created_at);
        }

        // Optional `AND id NOT IN (?, ?, ...)` for drain exclude list
        const notInMatch = q.match(/id NOT IN \(([?,\s]+)\)/);
        if (notInMatch) {
          const placeholderCount = (notInMatch[1].match(/\?/g) ?? []).length;
          const excluded = new Set(params.slice(0, placeholderCount).map((p) => String(p)));
          rows = rows.filter((r) => !excluded.has(r.id));
        }

        // Optional `dispatched_at <= ?` for stuck-processing lookup
        if (q.includes('dispatched_at <= ?')) {
          const cutoff = Number(params[params.length - 1]);
          rows = rows.filter((r) => r.dispatched_at !== null && (r.dispatched_at as number) <= cutoff);
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
          const id = params[1] as string;
          const row = queue.get(id);
          if (row) row.dispatched_at = ts;
        } else if (q.includes("SET status = 'processing' WHERE id = ?")) {
          const row = queue.get(params[0] as string);
          if (row) row.status = 'processing';
        } else if (q.includes("SET status = 'completed' WHERE status = 'processing'")) {
          for (const row of queue.values()) {
            if (row.status === 'processing') row.status = 'completed';
          }
        } else if (q.includes("SET status = 'completed' WHERE id = ?")) {
          const row = queue.get(params[0] as string);
          if (row) row.status = 'completed';
        } else if (q.includes("SET status = 'queued'") && q.includes("WHERE status = 'processing'")) {
          // The new revertProcessingToQueued NULLs dispatched_at alongside.
          for (const row of queue.values()) {
            if (row.status === 'processing') {
              row.status = 'queued';
              if (q.includes('dispatched_at = NULL')) row.dispatched_at = null;
            }
          }
        } else if (q.includes("SET status = 'queued'") && q.includes('WHERE id = ?')) {
          const row = queue.get(params[0] as string);
          if (row) {
            row.status = 'queued';
            if (q.includes('dispatched_at = NULL')) row.dispatched_at = null;
          }
        }
        return cursor([]);
      }

      // ─── channel_state operations ─────────────────────────────────

      if (q.startsWith('INSERT INTO channel_state')) {
        const channelKey = String(params[0]);
        const existing = channelState.get(channelKey) ?? {
          busy: 0,
          opencode_session_id: null,
          idle_queued_since: null,
          error_safety_net_at: null,
        };
        if (q.includes('opencode_session_id')) {
          const v = params[1] === undefined || params[1] === null ? null : String(params[1]);
          channelState.set(channelKey, { ...existing, opencode_session_id: v });
        } else if (q.includes('idle_queued_since')) {
          const v = params[1] === undefined || params[1] === null ? null : Number(params[1]);
          channelState.set(channelKey, { ...existing, idle_queued_since: v });
        } else if (q.includes('error_safety_net_at')) {
          const v = params[1] === undefined || params[1] === null ? null : Number(params[1]);
          channelState.set(channelKey, { ...existing, error_safety_net_at: v });
        } else {
          const busy = Number(params[1]) || 0;
          channelState.set(channelKey, { ...existing, busy });
        }
        return cursor([]);
      }

      if (q.startsWith('UPDATE channel_state SET busy')) {
        for (const [k, v] of channelState) channelState.set(k, { ...v, busy: 0 });
        return cursor([]);
      }
      if (q.startsWith('UPDATE channel_state SET idle_queued_since')) {
        for (const [k, v] of channelState) channelState.set(k, { ...v, idle_queued_since: null });
        return cursor([]);
      }
      if (q.startsWith('UPDATE channel_state SET error_safety_net_at')) {
        for (const [k, v] of channelState) channelState.set(k, { ...v, error_safety_net_at: null });
        return cursor([]);
      }

      if (q.startsWith('SELECT') && q.includes('FROM channel_state')) {
        if (q.includes('WHERE busy = 1')) {
          const found = Array.from(channelState.entries()).find(([, r]) => r.busy === 1);
          return found ? cursor([{ channel_key: found[0] }]) : cursor([]);
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
        const channelKey = String(params[0]);
        const row = channelState.get(channelKey);
        return row === undefined ? cursor([]) : cursor([row]);
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
        } else if (q.includes('WHERE id = ?') && q.includes("status = 'completed'")) {
          const targetId = params[0] as string;
          const row = queue.get(targetId);
          if (row && row.status === 'completed') queue.delete(targetId);
        } else if (q.includes('WHERE id = ?')) {
          queue.delete(params[0] as string);
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
  } as unknown as SqlStorage & { queue: Map<string, QueueRow>; state: Map<string, string>; channelState: Map<string, ChannelStateRow> };
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

    it('retrieves stored attachments by prompt id', () => {
      const attachments = [{ type: 'file', mime: 'application/pdf', url: 'data:application/pdf;base64,abc' }];
      pq.enqueue({
        id: 'p1',
        content: '',
        attachments: JSON.stringify(attachments),
        status: 'processing',
      });

      expect(pq.getAttachmentsById('p1')).toEqual(attachments);
      expect(pq.getAttachmentsById('missing')).toBeNull();
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

  describe('peekQueued / withdrawQueued', () => {
    it('withdrawQueued can skip protected prompts for implicit replacement', () => {
      pq.enqueue({ id: 'scheduled', content: 'scheduled prompt', replaceable: false });
      pq.enqueue({ id: 'public', content: 'public prompt' });

      const withdrawn = pq.withdrawQueued({ replaceableOnly: true });

      expect(withdrawn?.id).toBe('public');
      expect(pq.dequeueNext()?.id).toBe('scheduled');
    });

    it('explicit withdrawQueued still removes the oldest protected prompt', () => {
      pq.enqueue({ id: 'scheduled', content: 'scheduled prompt', replaceable: false });
      pq.enqueue({ id: 'public', content: 'public prompt' });

      const withdrawn = pq.withdrawQueued();

      expect(withdrawn?.id).toBe('scheduled');
      expect(pq.dequeueNext()?.id).toBe('public');
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

  describe('getChannelTargetById', () => {
    it('prefers reply_channel_* over channel_*', () => {
      pq.enqueue({
        id: 'p1', content: 'a',
        channelType: 'thread', channelId: 'th1',
        replyChannelType: 'slack', replyChannelId: 'C123:ts',
      });
      const target = pq.getChannelTargetById('p1');
      expect(target).toEqual({ channelType: 'slack', channelId: 'C123:ts', threadId: null });
    });

    it('falls back to channel_* when reply_channel_* is missing', () => {
      pq.enqueue({
        id: 'p1', content: 'a',
        channelType: 'telegram', channelId: '12345',
      });
      const target = pq.getChannelTargetById('p1');
      expect(target).toEqual({ channelType: 'telegram', channelId: '12345', threadId: null });
    });

    it('returns web/thread as valid targets (no special-casing)', () => {
      pq.enqueue({
        id: 'p-web', content: 'a',
        channelType: 'web', channelId: 'session-1',
      });
      pq.enqueue({
        id: 'p-thread', content: 'b',
        channelType: 'thread', channelId: 'th42',
      });
      expect(pq.getChannelTargetById('p-web')).toEqual({ channelType: 'web', channelId: 'session-1', threadId: null });
      expect(pq.getChannelTargetById('p-thread')).toEqual({ channelType: 'thread', channelId: 'th42', threadId: null });
    });

    it('returns undefined when the row is missing', () => {
      expect(pq.getChannelTargetById('does-not-exist')).toBeUndefined();
    });
  });

  describe('getProcessingChannelTarget', () => {
    it('returns channel target for the processing row', () => {
      pq.enqueue({
        id: 'p1', content: 'a', status: 'processing',
        channelType: 'telegram', channelId: '12345',
      });
      expect(pq.getProcessingChannelTarget()).toEqual({
        channelType: 'telegram', channelId: '12345',
      });
    });

    it('prefers reply_channel_* over channel_* on processing row', () => {
      pq.enqueue({
        id: 'p1', content: 'a', status: 'processing',
        channelType: 'thread', channelId: 'th1',
        replyChannelType: 'slack', replyChannelId: 'C123:ts',
      });
      expect(pq.getProcessingChannelTarget()).toEqual({
        channelType: 'slack', channelId: 'C123:ts',
      });
    });

    it('returns null when no row is processing (empty queue)', () => {
      expect(pq.getProcessingChannelTarget()).toBeNull();
    });

    it('returns null when only queued rows exist', () => {
      pq.enqueue({
        id: 'p1', content: 'a', status: 'queued',
        channelType: 'telegram', channelId: '12345',
      });
      expect(pq.getProcessingChannelTarget()).toBeNull();
    });

    it('does not special-case web/thread (valid emit targets)', () => {
      pq.enqueue({
        id: 'p-web', content: 'a', status: 'processing',
        channelType: 'web', channelId: 'session-1',
      });
      expect(pq.getProcessingChannelTarget()).toEqual({
        channelType: 'web', channelId: 'session-1',
      });
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
    it('sets runnerBusy; lastPromptDispatchedAt requires a processing row with messageId', () => {
      // No-arg stamp (workflow direct-dispatch) sets runnerBusy but doesn't
      // touch the row table, so the aggregate getter remains 0.
      pq.stampDispatched();
      expect(pq.runnerBusy).toBe(true);
      expect(pq.lastPromptDispatchedAt).toBe(0);

      // With messageId on a processing row, the aggregate getter reflects it.
      pq.enqueue({ id: 'mx', content: 'hi', channelKey: 'thread:x', channelType: 'thread', channelId: 'x', status: 'processing' });
      pq.stampDispatched('mx', 'thread:x');
      expect(pq.lastPromptDispatchedAt).toBeGreaterThan(0);
    });
  });

  describe('per-row dispatched_at + per-channel error safety net', () => {
    it('stampDispatched updates the prompt_queue row and runnerBusy; safety net is per-channel', () => {
      pq.enqueue({ id: 'm1', content: 'hi', channelKey: 'thread:a', channelType: 'thread', channelId: 'a', status: 'processing' });
      pq.stampDispatched('m1', 'thread:a');
      expect(pq.runnerBusy).toBe(true);
      expect(pq.lastPromptDispatchedAt).toBeGreaterThan(0);

      pq.setChannelErrorSafetyNetAt('thread:a', Date.now() + 60000);
      expect(pq.getChannelErrorSafetyNetAt('thread:a')).toBeGreaterThan(0);

      pq.clearAllChannelErrorSafetyNets();
      expect(pq.getChannelErrorSafetyNetAt('thread:a')).toBe(0);
    });

    it('received_at is stamped at enqueue time and readable per-row', () => {
      pq.enqueue({ id: 'm-rcv', content: 'x', channelKey: 'thread:b', channelType: 'thread', channelId: 'b', status: 'queued' });
      expect(pq.getReceivedAtById('m-rcv')).toBeGreaterThan(0);
      expect(pq.getReceivedAtById('does-not-exist')).toBe(0);
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
    it('returns false with no in-flight rows', () => {
      expect(pq.isStuckProcessing(5000)).toBe(false);
    });

    it('returns true when the OLDEST processing row was dispatched longer ago than the timeout', () => {
      pq.enqueue({ id: 'old', content: 'x', channelKey: 'thread:a', channelType: 'thread', channelId: 'a', status: 'processing' });
      // Reach into the mock to backdate dispatched_at for the row.
      const row = sql.queue.get('old')!;
      row.dispatched_at = Date.now() - 10000;
      expect(pq.isStuckProcessing(5000)).toBe(true);
    });

    it('returns false when every processing row dispatched within the timeout window', () => {
      pq.enqueue({ id: 'fresh', content: 'x', channelKey: 'thread:b', channelType: 'thread', channelId: 'b', status: 'processing' });
      const row = sql.queue.get('fresh')!;
      row.dispatched_at = Date.now() - 1000;
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

    it('arms and reads back via per-channel API; aggregate getter returns earliest', () => {
      pq.setChannelIdleQueuedSince('thread:a', 1711921234000);
      expect(pq.getChannelIdleQueuedSince('thread:a')).toBe(1711921234000);
      expect(pq.idleQueuedSince).toBe(1711921234000);

      pq.setChannelIdleQueuedSince('thread:b', 1711921200000); // older
      expect(pq.idleQueuedSince).toBe(1711921200000);
    });

    it('clearAllChannelIdleQueuedSince zeroes every channel', () => {
      pq.setChannelIdleQueuedSince('thread:a', 1711921234000);
      pq.setChannelIdleQueuedSince('thread:b', 1711921000000);
      pq.clearAllChannelIdleQueuedSince();
      expect(pq.getChannelIdleQueuedSince('thread:a')).toBe(0);
      expect(pq.getChannelIdleQueuedSince('thread:b')).toBe(0);
      expect(pq.idleQueuedSince).toBe(0);
    });
  });

  describe('markCompletedById', () => {
    it('completes only the specified entry', () => {
      pq.enqueue({ id: 'a', content: 'first', status: 'processing' });
      pq.enqueue({ id: 'b', content: 'second', status: 'processing' });

      const count = pq.markCompletedById('a');

      expect(count).toBe(1);
      // 'b' should still be processing
      expect(pq.processingCount).toBe(1);
    });

    it('returns 0 when id is not processing', () => {
      pq.enqueue({ id: 'a', content: 'first' }); // status: queued (default)
      const count = pq.markCompletedById('a');
      expect(count).toBe(0);
    });

    it('returns 0 and DOES NOT escalate when id is undefined', () => {
      // The previous fallback to unscoped markCompleted() wiped every
      // processing row across the DO. Under concurrent dispatch that
      // orphaned every other channel's runner state. Watchdog handles
      // truly stuck rows via its 5-min revert; this path is now a no-op.
      pq.enqueue({ id: 'a', content: 'first', status: 'processing' });
      pq.enqueue({ id: 'b', content: 'second', status: 'processing' });

      const count = pq.markCompletedById(undefined);

      expect(count).toBe(0);
      expect(pq.processingCount).toBe(2); // both rows untouched
    });
  });

  describe('markCompletedMostRecentByChannel', () => {
    it('completes the most recent processing row on the given channel', () => {
      pq.enqueue({ id: 'a', content: 'first', status: 'processing', channelKey: 'thread:t1' });
      pq.enqueue({ id: 'b', content: 'second', status: 'processing', channelKey: 'thread:t1' });
      pq.enqueue({ id: 'c', content: 'third', status: 'processing', channelKey: 'thread:t2' });

      const completedId = pq.markCompletedMostRecentByChannel('thread:t1');

      expect(completedId).toBe('b');
      expect(pq.processingCount).toBe(2); // 'a' and 'c' remain
    });

    it('returns null when no processing row exists on the channel', () => {
      pq.enqueue({ id: 'a', content: 'first', status: 'processing', channelKey: 'thread:t1' });
      const completedId = pq.markCompletedMostRecentByChannel('thread:t2');
      expect(completedId).toBeNull();
      expect(pq.processingCount).toBe(1);
    });
  });

  // ─── Migrations ───────────────────────────────────────────────────────

  describe('runMigrations', () => {
    it('runs without error', () => {
      // runMigrations does ALTER TABLE which our mock ignores
      expect(() => pq.runMigrations()).not.toThrow();
    });
  });

  describe('getProcessingWorkflowContext', () => {
    it('returns null when nothing is processing', () => {
      expect(pq.getProcessingWorkflowContext()).toBeNull();
    });

    it('returns queueType and workflowExecutionId for a workflow_execute row', () => {
      pq.enqueue({
        id: 'wf1',
        content: '',
        queueType: 'workflow_execute',
        workflowExecutionId: 'exec-abc-123',
        status: 'processing',
      });
      expect(pq.getProcessingWorkflowContext()).toEqual({
        queueType: 'workflow_execute',
        workflowExecutionId: 'exec-abc-123',
      });
    });

    it('returns queueType=prompt and workflowExecutionId=null for a regular prompt row', () => {
      pq.enqueue({ id: 'p1', content: 'hello', status: 'processing' });
      expect(pq.getProcessingWorkflowContext()).toEqual({
        queueType: 'prompt',
        workflowExecutionId: null,
      });
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
