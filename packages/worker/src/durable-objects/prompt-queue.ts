/**
 * PromptQueue — prompt queue state machine, collect mode, and dispatch state.
 *
 * Owns:
 * - The `prompt_queue` table in DO SQLite (all CRUD)
 * - Queue-related keys in the `state` table (runnerBusy, promptReceivedAt,
 *   lastPromptDispatchedAt, currentPromptAuthorId, queueMode, collectDebounceMs,
 *   collectBuffer:*, collectFlushAt:*)
 * - Collect mode buffer management
 *
 * Uses Cloudflare's SqlStorage type directly (globally available via @cloudflare/workers-types).
 *
 * Does NOT own: runner communication, channel routing, model resolution,
 * broadcasting, message persistence, or alarm scheduling. The DO orchestrates
 * those concerns using PromptQueue as a data layer.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface EnqueueParams {
  id: string;
  content: string;
  attachments?: string | null;
  model?: string | null;
  status?: 'queued' | 'processing';
  queueType?: 'prompt' | 'workflow_execute';
  workflowExecutionId?: string | null;
  workflowPayload?: string | null;
  authorId?: string | null;
  authorEmail?: string | null;
  authorName?: string | null;
  authorAvatarUrl?: string | null;
  channelType?: string | null;
  channelId?: string | null;
  channelKey?: string | null;
  threadId?: string | null;
  continuationContext?: string | null;
  contextPrefix?: string | null;
  replyChannelType?: string | null;
  replyChannelId?: string | null;
}

export interface QueueEntry {
  id: string;
  content: string;
  attachments: string | null;
  model: string | null;
  queueType: string;
  workflowExecutionId: string | null;
  workflowPayload: string | null;
  authorId: string | null;
  authorEmail: string | null;
  authorName: string | null;
  channelType: string | null;
  channelId: string | null;
  channelKey: string | null;
  threadId: string | null;
  continuationContext: string | null;
  contextPrefix: string | null;
  replyChannelType: string | null;
  replyChannelId: string | null;
}

export interface CollectBufferEntry {
  content: string;
  model?: string;
  author?: {
    id: string;
    email: string;
    name?: string;
    avatarUrl?: string;
    gitName?: string;
    gitEmail?: string;
  };
  attachments?: unknown[];
  channelType?: string;
  channelId?: string;
  threadId?: string;
  contextPrefix?: string;
}

export interface CollectFlush {
  channelKey: string;
  buffer: CollectBufferEntry[];
}

// ─── PromptQueue ─────────────────────────────────────────────────────────────

export interface PromptQueueDeps {
  getState: (key: string) => string | undefined;
  setState: (key: string, value: string) => void;
}

export class PromptQueue {
  private sql: SqlStorage;
  private deps: PromptQueueDeps;

  constructor(sql: SqlStorage, deps?: PromptQueueDeps) {
    this.sql = sql;
    this.deps = deps ?? {
      getState: (key) => {
        const rows = sql.exec('SELECT value FROM state WHERE key = ?', key).toArray();
        return rows.length > 0 ? (rows[0].value as string) : undefined;
      },
      setState: (key, value) => {
        sql.exec('INSERT OR REPLACE INTO state (key, value) VALUES (?, ?)', key, value);
      },
    };
  }

  /**
   * Run prompt_queue schema migrations.
   * Called from the DO constructor's blockConcurrencyWhile.
   * The initial CREATE TABLE is in SCHEMA_SQL; these handle column additions
   * for DOs created before the columns existed.
   */
  runMigrations(): void {
    try { this.sql.exec('ALTER TABLE prompt_queue ADD COLUMN author_avatar_url TEXT'); } catch { /* already exists */ }
    try { this.sql.exec('ALTER TABLE prompt_queue ADD COLUMN attachments TEXT'); } catch { /* already exists */ }
    try { this.sql.exec('ALTER TABLE prompt_queue ADD COLUMN channel_type TEXT'); } catch { /* already exists */ }
    try { this.sql.exec('ALTER TABLE prompt_queue ADD COLUMN channel_id TEXT'); } catch { /* already exists */ }
    try { this.sql.exec('ALTER TABLE prompt_queue ADD COLUMN channel_key TEXT'); } catch { /* already exists */ }
    try { this.sql.exec('ALTER TABLE prompt_queue ADD COLUMN model TEXT'); } catch { /* already exists */ }
    try { this.sql.exec("ALTER TABLE prompt_queue ADD COLUMN queue_type TEXT NOT NULL DEFAULT 'prompt'"); } catch { /* already exists */ }
    try { this.sql.exec('ALTER TABLE prompt_queue ADD COLUMN workflow_execution_id TEXT'); } catch { /* already exists */ }
    try { this.sql.exec('ALTER TABLE prompt_queue ADD COLUMN workflow_payload TEXT'); } catch { /* already exists */ }
    this.sql.exec("UPDATE prompt_queue SET queue_type = 'prompt' WHERE queue_type IS NULL OR queue_type = ''");
    try { this.sql.exec('ALTER TABLE prompt_queue ADD COLUMN thread_id TEXT'); } catch { /* already exists */ }
    try { this.sql.exec('ALTER TABLE prompt_queue ADD COLUMN continuation_context TEXT'); } catch { /* already exists */ }
    try { this.sql.exec('ALTER TABLE prompt_queue ADD COLUMN context_prefix TEXT'); } catch { /* already exists */ }
    try { this.sql.exec('ALTER TABLE prompt_queue ADD COLUMN reply_channel_type TEXT'); } catch { /* already exists */ }
    try { this.sql.exec('ALTER TABLE prompt_queue ADD COLUMN reply_channel_id TEXT'); } catch { /* already exists */ }
  }

  // ─── Core Queue Operations ───────────────────────────────────────────────

  /** Insert an entry into the prompt queue. */
  enqueue(params: EnqueueParams): void {
    const status = params.status || 'queued';
    const queueType = params.queueType || 'prompt';

    if (queueType === 'workflow_execute') {
      this.sql.exec(
        "INSERT INTO prompt_queue (id, content, queue_type, workflow_execution_id, workflow_payload, status) VALUES (?, '', 'workflow_execute', ?, ?, ?)",
        params.id,
        params.workflowExecutionId || null,
        params.workflowPayload || null,
        status,
      );
      return;
    }

    this.sql.exec(
      "INSERT INTO prompt_queue (id, content, attachments, model, status, author_id, author_email, author_name, author_avatar_url, channel_type, channel_id, channel_key, thread_id, continuation_context, context_prefix, reply_channel_type, reply_channel_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      params.id,
      params.content,
      params.attachments || null,
      params.model || null,
      status,
      params.authorId || null,
      params.authorEmail || null,
      params.authorName || null,
      params.authorAvatarUrl || null,
      params.channelType || null,
      params.channelId || null,
      params.channelKey || null,
      params.threadId || null,
      params.continuationContext || null,
      params.contextPrefix || null,
      params.replyChannelType || null,
      params.replyChannelId || null,
    );
  }

  /**
   * Dequeue the oldest queued entry (FIFO). Atomically marks it as 'processing'.
   * Returns null if the queue is empty.
   */
  dequeueNext(): QueueEntry | null {
    const rows = this.sql
      .exec(
        "SELECT id, content, attachments, model, author_id, author_email, author_name, channel_type, channel_id, channel_key, queue_type, workflow_execution_id, workflow_payload, thread_id, continuation_context, context_prefix, reply_channel_type, reply_channel_id FROM prompt_queue WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1",
      )
      .toArray();

    if (rows.length === 0) return null;

    const row = rows[0];
    this.sql.exec(
      "UPDATE prompt_queue SET status = 'processing' WHERE id = ?",
      row.id as string,
    );

    return this.rowToEntry(row);
  }

  /**
   * Mark all processing entries as completed, then prune completed entries.
   * Returns the number of entries that were processing.
   */
  markCompleted(): number {
    const countRow = this.sql
      .exec("SELECT COUNT(*) AS count FROM prompt_queue WHERE status = 'processing'")
      .toArray();
    const processingCount = (countRow[0]?.count as number) ?? 0;

    this.sql.exec("UPDATE prompt_queue SET status = 'completed' WHERE status = 'processing'");
    this.sql.exec("DELETE FROM prompt_queue WHERE status = 'completed'");

    return processingCount;
  }

  /** Revert processing entries back to queued. Optionally scope to a single entry by id. */
  revertProcessingToQueued(id?: string): void {
    if (id) {
      this.sql.exec("UPDATE prompt_queue SET status = 'queued' WHERE id = ?", id);
    } else {
      this.sql.exec("UPDATE prompt_queue SET status = 'queued' WHERE status = 'processing'");
    }
  }

  /** Mark a single entry as completed (e.g. malformed workflow). */
  dropEntry(id: string): void {
    this.sql.exec("UPDATE prompt_queue SET status = 'completed' WHERE id = ?", id);
  }

  /** Delete queued entries. If channelKey provided, scoped to that channel. Returns count deleted. */
  clearQueued(channelKey?: string): number {
    const before = this.length;
    if (channelKey) {
      this.sql.exec(
        "DELETE FROM prompt_queue WHERE status = 'queued' AND channel_key = ?",
        channelKey,
      );
    } else {
      this.sql.exec("DELETE FROM prompt_queue WHERE status = 'queued'");
    }
    return before - this.length;
  }

  /** Delete all entries (fresh start / session stop). */
  clearAll(): void {
    this.sql.exec('DELETE FROM prompt_queue');
  }

  // ─── Queries ───────────────────────────────────────────────────────────────

  /** Number of queued (not processing/completed) entries. */
  get length(): number {
    const result = this.sql
      .exec("SELECT COUNT(*) as count FROM prompt_queue WHERE status = 'queued'")
      .toArray();
    return (result[0]?.count as number) ?? 0;
  }

  /** Number of entries currently being processed. */
  get processingCount(): number {
    return Number(
      this.sql
        .exec("SELECT COUNT(*) AS c FROM prompt_queue WHERE status = 'processing'")
        .one().c,
    );
  }

  /** Get the thread_id from the most recent processing entry. */
  getProcessingThreadId(): string | null {
    const rows = this.sql
      .exec("SELECT thread_id FROM prompt_queue WHERE status = 'processing' ORDER BY created_at DESC LIMIT 1")
      .toArray();
    if (rows.length === 0) return null;
    return (rows[0].thread_id as string) || null;
  }

  /** Get the model from the processing entry (for turn_complete metrics). */
  getProcessingModel(): string | null {
    const rows = this.sql
      .exec("SELECT model FROM prompt_queue WHERE status = 'processing' LIMIT 1")
      .toArray();
    if (rows.length === 0) return null;
    return rows[0].model ? String(rows[0].model) : null;
  }

  /**
   * Get channel context from the processing entry.
   * Used for hibernation recovery of channel reply state.
   * Prefers reply_channel_type/reply_channel_id over channel_type/channel_id.
   */
  getProcessingChannelContext(): { channelType: string; channelId: string } | null {
    const rows = this.sql
      .exec("SELECT channel_type, channel_id, reply_channel_type, reply_channel_id FROM prompt_queue WHERE status = 'processing' LIMIT 1")
      .toArray();
    if (rows.length === 0) return null;

    const channelType = (rows[0].reply_channel_type as string) || (rows[0].channel_type as string) || null;
    const channelId = (rows[0].reply_channel_id as string) || (rows[0].channel_id as string) || null;
    if (!channelType || !channelId) return null;

    return { channelType, channelId };
  }

  // ─── Queue Dispatch State ──────────────────────────────────────────────────
  //
  // These state keys track the runner's busy/idle status and prompt timing.
  // They live in the `state` KV table alongside other session state.

  get runnerBusy(): boolean {
    return this.getState('runnerBusy') === 'true';
  }

  set runnerBusy(busy: boolean) {
    this.setState('runnerBusy', busy ? 'true' : 'false');
  }

  /** Record that a prompt was just dispatched to the runner. Sets runnerBusy + timestamp. */
  stampDispatched(): void {
    this.setState('runnerBusy', 'true');
    this.setState('lastPromptDispatchedAt', String(Date.now()));
  }

  /** Clear dispatch tracking state (on completion). */
  clearDispatchTimers(): void {
    this.setState('lastPromptDispatchedAt', '');
    this.setState('errorSafetyNetAt', '');
  }

  get lastPromptDispatchedAt(): number {
    return parseInt(this.getState('lastPromptDispatchedAt') || '0', 10);
  }

  get promptReceivedAt(): number {
    return parseInt(this.getState('promptReceivedAt') || '0', 10);
  }

  stampPromptReceived(): void {
    this.setState('promptReceivedAt', String(Date.now()));
  }

  clearPromptReceived(): void {
    this.setState('promptReceivedAt', '');
  }

  get currentPromptAuthorId(): string | undefined {
    return this.getState('currentPromptAuthorId') || undefined;
  }

  set currentPromptAuthorId(id: string | undefined) {
    this.setState('currentPromptAuthorId', id || '');
  }

  get queueMode(): string {
    return this.getState('queueMode') || 'followup';
  }

  set queueMode(mode: string) {
    this.setState('queueMode', mode);
  }

  get collectDebounceMs(): number {
    return parseInt(this.getState('collectDebounceMs') || '3000', 10);
  }

  set collectDebounceMs(ms: number) {
    this.setState('collectDebounceMs', String(ms));
  }

  /** Check if a processing prompt has been stuck longer than timeoutMs. */
  isStuckProcessing(timeoutMs: number): boolean {
    const dispatched = this.lastPromptDispatchedAt;
    if (!dispatched) return false;
    return (Date.now() - dispatched) >= timeoutMs;
  }

  /** Get the error safety-net timestamp (ms epoch, 0 if unset). */
  get errorSafetyNetAt(): number {
    return parseInt(this.getState('errorSafetyNetAt') || '0', 10);
  }

  set errorSafetyNetAt(ms: number) {
    this.setState('errorSafetyNetAt', ms ? String(ms) : '');
  }

  // ─── Collect Mode ──────────────────────────────────────────────────────────

  /** Append an entry to the per-channel collect buffer. Returns new buffer length. */
  appendToCollectBuffer(channelKey: string, entry: CollectBufferEntry): number {
    const bufferStateKey = `collectBuffer:${channelKey}`;
    const raw = this.getState(bufferStateKey);
    const buffer: CollectBufferEntry[] = raw ? JSON.parse(raw) : [];
    buffer.push(entry);
    this.setState(bufferStateKey, JSON.stringify(buffer));

    // Set per-channel flush deadline
    const flushAt = Date.now() + this.collectDebounceMs;
    this.setState(`collectFlushAt:${channelKey}`, String(flushAt));

    return buffer.length;
  }

  /** Check if any per-channel collect buffer has a flush due. */
  hasCollectFlushDue(): boolean {
    const rows = this.sql
      .exec("SELECT value FROM state WHERE key LIKE 'collectFlushAt:%' AND value != '' LIMIT 1")
      .toArray();
    if (rows.length === 0) return false;
    return parseInt(rows[0].value as string) <= Date.now();
  }

  /**
   * Get all collect flushes that are ready (flushAt <= now).
   * Returns the buffer contents and clears the state for each ready channel.
   * Also checks legacy (non-keyed) buffer.
   */
  getReadyCollectFlushes(): CollectFlush[] {
    const now = Date.now();
    const flushRows = this.sql
      .exec("SELECT key, value FROM state WHERE key LIKE 'collectFlushAt:%'")
      .toArray();

    const result: CollectFlush[] = [];

    for (const row of flushRows) {
      const key = row.key as string;
      const flushAt = parseInt(row.value as string);
      if (!flushAt || now < flushAt) continue;

      const channelKey = key.replace('collectFlushAt:', '');
      const bufferStateKey = `collectBuffer:${channelKey}`;
      const bufferRaw = this.getState(bufferStateKey);
      if (!bufferRaw) {
        this.setState(key, '');
        continue;
      }

      const buffer: CollectBufferEntry[] = JSON.parse(bufferRaw);
      if (buffer.length === 0) {
        this.setState(bufferStateKey, '');
        this.setState(key, '');
        continue;
      }

      // Clear buffer and flush state
      this.setState(bufferStateKey, '');
      this.setState(key, '');
      result.push({ channelKey, buffer });
    }

    // Legacy non-keyed buffer
    const legacyRaw = this.getState('collectBuffer');
    if (legacyRaw) {
      const legacyFlushAt = this.getState('collectFlushAt');
      if (legacyFlushAt && now >= parseInt(legacyFlushAt)) {
        const buffer: CollectBufferEntry[] = JSON.parse(legacyRaw);
        if (buffer.length > 0) {
          this.setState('collectBuffer', '');
          this.setState('collectFlushAt', '');
          result.push({ channelKey: '__legacy__', buffer });
        }
      }
    }

    return result;
  }

  /** Check if legacy collect flush is due. */
  hasLegacyCollectFlushDue(): boolean {
    const legacyFlushAt = this.getState('collectFlushAt');
    return !!legacyFlushAt && Date.now() >= parseInt(legacyFlushAt);
  }

  // ─── Internal Helpers ──────────────────────────────────────────────────────

  private getState(key: string): string | undefined {
    return this.deps.getState(key);
  }

  private setState(key: string, value: string): void {
    this.deps.setState(key, value);
  }

  private rowToEntry(row: Record<string, unknown>): QueueEntry {
    return {
      id: row.id as string,
      content: row.content as string,
      attachments: (row.attachments as string) || null,
      model: (row.model as string) || null,
      queueType: ((row.queue_type as string) || 'prompt').trim() || 'prompt',
      workflowExecutionId: (row.workflow_execution_id as string) || null,
      workflowPayload: (row.workflow_payload as string) || null,
      authorId: (row.author_id as string) || null,
      authorEmail: (row.author_email as string) || null,
      authorName: (row.author_name as string) || null,
      channelType: (row.channel_type as string) || null,
      channelId: (row.channel_id as string) || null,
      channelKey: (row.channel_key as string) || null,
      threadId: (row.thread_id as string) || null,
      continuationContext: (row.continuation_context as string) || null,
      contextPrefix: (row.context_prefix as string) || null,
      replyChannelType: (row.reply_channel_type as string) || null,
      replyChannelId: (row.reply_channel_id as string) || null,
    };
  }
}
