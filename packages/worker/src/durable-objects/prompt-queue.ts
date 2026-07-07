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
  childSessionId?: string | null;
  childStatus?: string | null;
  priority?: number;
  replaceable?: boolean;
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
  authorAvatarUrl: string | null;
  channelType: string | null;
  channelId: string | null;
  channelKey: string | null;
  threadId: string | null;
  continuationContext: string | null;
  contextPrefix: string | null;
  replyChannelType: string | null;
  replyChannelId: string | null;
  childSessionId: string | null;
  childStatus: string | null;
  priority: number;
  replaceable: boolean;
}

export interface ThreadPromptStatus {
  threadId: string;
  status: 'idle' | 'working';
  queuedPrompts: number;
  processingPrompts: number;
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
    try { this.sql.exec('ALTER TABLE prompt_queue ADD COLUMN child_session_id TEXT'); } catch { /* already exists */ }
    try { this.sql.exec('ALTER TABLE prompt_queue ADD COLUMN child_status TEXT'); } catch { /* already exists */ }
    try { this.sql.exec('ALTER TABLE prompt_queue ADD COLUMN priority INTEGER NOT NULL DEFAULT 0'); } catch { /* already exists */ }
    try { this.sql.exec('ALTER TABLE prompt_queue ADD COLUMN replaceable INTEGER NOT NULL DEFAULT 1'); } catch { /* already exists */ }
    // Per-row timing replaces the global `promptReceivedAt` / `lastPromptDispatchedAt`
    // session-state keys. With cross-thread concurrent dispatch each row needs its
    // own timestamp so queue_wait/turn_complete metrics and the stuck-processing
    // watchdog don't get clobbered by sibling thread activity.
    try { this.sql.exec('ALTER TABLE prompt_queue ADD COLUMN received_at INTEGER'); } catch { /* already exists */ }
    try { this.sql.exec('ALTER TABLE prompt_queue ADD COLUMN dispatched_at INTEGER'); } catch { /* already exists */ }
    // Per-channel idle/safety-net timers replace the global `idleQueuedSince` and
    // `errorSafetyNetAt` session-state keys for the same reason.
    try { this.sql.exec('ALTER TABLE channel_state ADD COLUMN idle_queued_since INTEGER'); } catch { /* already exists */ }
    try { this.sql.exec('ALTER TABLE channel_state ADD COLUMN error_safety_net_at INTEGER'); } catch { /* already exists */ }
  }

  // ─── Core Queue Operations ───────────────────────────────────────────────

  /** Insert an entry into the prompt queue. */
  enqueue(params: EnqueueParams): void {
    const status = params.status || 'queued';
    const queueType = params.queueType || 'prompt';
    const nowMs = Date.now();

    if (queueType === 'workflow_execute') {
      this.sql.exec(
        "INSERT INTO prompt_queue (id, content, queue_type, workflow_execution_id, workflow_payload, status, received_at) VALUES (?, '', 'workflow_execute', ?, ?, ?, ?)",
        params.id,
        params.workflowExecutionId || null,
        params.workflowPayload || null,
        status,
        nowMs,
      );
      return;
    }

    this.sql.exec(
      "INSERT INTO prompt_queue (id, content, attachments, model, status, author_id, author_email, author_name, author_avatar_url, channel_type, channel_id, channel_key, thread_id, continuation_context, context_prefix, reply_channel_type, reply_channel_id, child_session_id, child_status, priority, replaceable, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
      params.childSessionId || null,
      params.childStatus || null,
      params.priority ?? 0,
      params.replaceable === false ? 0 : 1,
      nowMs,
    );
  }

  /**
   * Dequeue the oldest queued entry (FIFO). Atomically marks it as 'processing'.
   * Returns null if the queue is empty.
   *
   * `excludeIds`, when provided, skips rows with those ids. Used by the
   * drain loop to advance past rows whose channels are still busy without
   * spinning on the same row each call.
   */
  dequeueNext(excludeIds?: ReadonlySet<string>): QueueEntry | null {
    const baseSql =
      "SELECT id, content, attachments, model, author_id, author_email, author_name, author_avatar_url, channel_type, channel_id, channel_key, queue_type, workflow_execution_id, workflow_payload, thread_id, continuation_context, context_prefix, reply_channel_type, reply_channel_id, child_session_id, child_status, priority, replaceable FROM prompt_queue WHERE status = 'queued'";
    const orderSql = " ORDER BY priority DESC, created_at ASC LIMIT 1";

    let rows: Record<string, unknown>[];
    if (excludeIds && excludeIds.size > 0) {
      const placeholders = Array.from({ length: excludeIds.size }, () => '?').join(', ');
      rows = this.sql
        .exec(
          `${baseSql} AND id NOT IN (${placeholders})${orderSql}`,
          ...Array.from(excludeIds),
        )
        .toArray();
    } else {
      rows = this.sql.exec(baseSql + orderSql).toArray();
    }

    if (rows.length === 0) return null;

    const row = rows[0];
    this.sql.exec(
      "UPDATE prompt_queue SET status = 'processing' WHERE id = ?",
      row.id as string,
    );

    return this.rowToEntry(row);
  }

  /**
   * Dequeue the oldest queued child-event entry (has child_session_id).
   * Used when a wait subscription is active so child events are dispatched
   * before user messages, preventing the wait from being pre-empted.
   */
  dequeueNextChild(): QueueEntry | null {
    const rows = this.sql
      .exec(
        "SELECT id, content, attachments, model, author_id, author_email, author_name, author_avatar_url, channel_type, channel_id, channel_key, queue_type, workflow_execution_id, workflow_payload, thread_id, continuation_context, context_prefix, reply_channel_type, reply_channel_id, child_session_id, child_status, priority, replaceable FROM prompt_queue WHERE status = 'queued' AND child_session_id IS NOT NULL ORDER BY priority DESC, created_at ASC LIMIT 1",
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

  markCompletedById(id: string | undefined): number {
    // CRITICAL: do NOT escalate to unscoped markCompleted() when id is
    // missing. Under concurrent dispatch, an `aborted` frame from the
    // runner can arrive with messageId=undefined (e.g. the runner's
    // empty-target ack path, or a duplicate abort for a channel whose
    // activeMessageId was already cleared by a sibling frame). The old
    // behavior was to `DELETE FROM prompt_queue WHERE status='completed'`
    // after wiping every processing row to 'completed' — which orphans
    // every other concurrent thread's runner state. The watchdog's
    // 5-min stuck-processing timer is the correct cleanup path; the
    // queue drain still runs even when nothing was completed here.
    if (!id) return 0;

    const countRow = this.sql
      .exec("SELECT COUNT(*) AS count FROM prompt_queue WHERE id = ? AND status = 'processing'", id)
      .toArray();
    const count = (countRow[0]?.count as number) ?? 0;

    if (count > 0) {
      this.sql.exec("UPDATE prompt_queue SET status = 'completed' WHERE id = ? AND status = 'processing'", id);
      this.sql.exec("DELETE FROM prompt_queue WHERE id = ? AND status = 'completed'", id);
    }

    return count;
  }

  /** Complete the most recent processing row on a specific channel, if any.
   *  Used when an `aborted` frame arrives without a messageId but the DO
   *  has channel context (e.g. resolved via getProcessingChannelKey).
   *  Returns the id that was completed, or null if no processing row
   *  exists on that channel. */
  markCompletedMostRecentByChannel(channelKey: string): string | null {
    const rows = this.sql
      .exec(
        "SELECT id FROM prompt_queue WHERE channel_key = ? AND status = 'processing' ORDER BY created_at DESC LIMIT 1",
        channelKey,
      )
      .toArray();
    const id = rows[0]?.id as string | undefined;
    if (!id) return null;
    // Defensive `AND status = 'processing'` matches markCompletedById — keeps
    // the method a no-op if the row's status changed between SELECT and
    // UPDATE (e.g. concurrent path completed it first).
    this.sql.exec("UPDATE prompt_queue SET status = 'completed' WHERE id = ? AND status = 'processing'", id);
    this.sql.exec("DELETE FROM prompt_queue WHERE id = ? AND status = 'completed'", id);
    return id;
  }

  /** Revert processing entries back to queued. Optionally scope to a single entry by id.
   *  NULLs `dispatched_at` so it remains a faithful "row was sent to the
   *  runner" signal — reverted rows haven't been sent (yet) for this attempt. */
  revertProcessingToQueued(id?: string): void {
    if (id) {
      this.sql.exec("UPDATE prompt_queue SET status = 'queued', dispatched_at = NULL WHERE id = ?", id);
    } else {
      this.sql.exec("UPDATE prompt_queue SET status = 'queued', dispatched_at = NULL WHERE status = 'processing'");
    }
  }

  /** Drop a single entry — marks completed and DELETEs in one step so the
   *  row doesn't linger as an orphaned 'completed' row until the next
   *  unscoped markCompleted() sweep. */
  dropEntry(id: string): void {
    this.sql.exec("UPDATE prompt_queue SET status = 'completed' WHERE id = ?", id);
    this.sql.exec('DELETE FROM prompt_queue WHERE id = ?', id);
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

  private static readonly USER_PROMPT_COLUMNS =
    'id, content, attachments, model, author_id, author_email, author_name, author_avatar_url, channel_type, channel_id, channel_key, queue_type, workflow_execution_id, workflow_payload, thread_id, continuation_context, context_prefix, reply_channel_type, reply_channel_id, child_session_id, child_status, priority, replaceable';

  private static userPromptQuery(replaceableOnly = false): string {
    const replaceableClause = replaceableOnly ? ' AND replaceable = 1' : '';
    return `SELECT ${PromptQueue.USER_PROMPT_COLUMNS} FROM prompt_queue WHERE status = 'queued' AND queue_type = 'prompt' AND child_session_id IS NULL${replaceableClause} ORDER BY priority DESC, created_at ASC LIMIT 1`;
  }

  /** Read the single queued user-prompt entry without removing it. Returns null if none. */
  peekQueued(): QueueEntry | null {
    const rows = this.sql.exec(PromptQueue.userPromptQuery()).toArray();
    if (rows.length === 0) return null;
    return this.rowToEntry(rows[0]);
  }

  /** Remove and return the single queued user-prompt entry (not child events, not workflows). Returns null if none. */
  withdrawQueued(options?: { replaceableOnly?: boolean }): QueueEntry | null {
    const rows = this.sql.exec(PromptQueue.userPromptQuery(options?.replaceableOnly)).toArray();
    if (rows.length === 0) return null;
    const row = rows[0];
    this.sql.exec('DELETE FROM prompt_queue WHERE id = ?', row.id as string);
    return this.rowToEntry(row);
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

  getThreadPromptStatus(threadId: string): ThreadPromptStatus {
    const rows = this.sql
      .exec(
        "SELECT status, COUNT(*) AS count FROM prompt_queue WHERE thread_id = ? AND queue_type = 'prompt' GROUP BY status",
        threadId,
      )
      .toArray();

    let queuedPrompts = 0;
    let processingPrompts = 0;
    for (const row of rows) {
      const count = Number(row.count ?? 0);
      if (row.status === 'queued') queuedPrompts = count;
      if (row.status === 'processing') processingPrompts = count;
    }

    return {
      threadId,
      status: queuedPrompts > 0 || processingPrompts > 0 ? 'working' : 'idle',
      queuedPrompts,
      processingPrompts,
    };
  }

  /** Get the thread_id from the most recent processing entry. */
  getProcessingThreadId(): string | null {
    const rows = this.sql
      .exec("SELECT thread_id FROM prompt_queue WHERE status = 'processing' ORDER BY created_at DESC LIMIT 1")
      .toArray();
    if (rows.length === 0) return null;
    return (rows[0].thread_id as string) || null;
  }

  /** Get the model from the processing entry (for turn_complete metrics).
   *
   *  @deprecated Under cross-thread concurrent dispatch there can be multiple
   *  processing rows. Callers that know which prompt completed should use
   *  {@link getModelById} keyed by the completed messageId. This is kept for
   *  paths that have no messageId yet, but returns null when ambiguous so
   *  metrics don't silently attribute to the wrong model.
   */
  getProcessingModel(): string | null {
    const rows = this.sql
      .exec("SELECT model FROM prompt_queue WHERE status = 'processing' LIMIT 2")
      .toArray();
    if (rows.length === 0) return null;
    if (rows.length > 1) return null; // ambiguous: don't lie
    return rows[0].model ? String(rows[0].model) : null;
  }

  /** Lookup the model for a specific prompt by messageId. */
  getModelById(messageId: string): string | null {
    const rows = this.sql
      .exec('SELECT model FROM prompt_queue WHERE id = ? LIMIT 1', messageId)
      .toArray();
    if (rows.length === 0) return null;
    return rows[0].model ? String(rows[0].model) : null;
  }

  /** Channel target for the currently-processing prompt.
   *  Returns null when nothing is processing OR when MORE than one row is
   *  processing (ambiguous under cross-thread concurrent dispatch). Callers
   *  must instead resolve by messageId via {@link getChannelTargetById}. */
  getProcessingChannelTarget(): { channelType: string | null; channelId: string | null } | null {
    const rows = this.sql
      .exec("SELECT channel_type, channel_id, reply_channel_type, reply_channel_id FROM prompt_queue WHERE status = 'processing' ORDER BY created_at DESC LIMIT 2")
      .toArray();
    if (rows.length === 0) return null;
    if (rows.length > 1) return null;
    const channelType = (rows[0].reply_channel_type as string) || (rows[0].channel_type as string) || null;
    const channelId = (rows[0].reply_channel_id as string) || (rows[0].channel_id as string) || null;
    return { channelType, channelId };
  }

  /** queue_type and workflow_execution_id for the currently-processing row.
   *  Returns null when nothing is processing OR when multiple rows are. */
  getProcessingWorkflowContext(): { queueType: string; workflowExecutionId: string | null } | null {
    const rows = this.sql
      .exec(
        "SELECT queue_type, workflow_execution_id FROM prompt_queue WHERE status = 'processing' ORDER BY created_at DESC LIMIT 2",
      )
      .toArray();
    if (rows.length === 0) return null;
    if (rows.length > 1) return null;
    return {
      queueType: (rows[0].queue_type as string) || 'prompt',
      workflowExecutionId: (rows[0].workflow_execution_id as string | null) ?? null,
    };
  }

  /** queue_type / workflow_execution_id keyed by messageId — deterministic
   *  under concurrent dispatch. */
  getWorkflowContextById(messageId: string): { queueType: string; workflowExecutionId: string | null } | null {
    const rows = this.sql
      .exec(
        'SELECT queue_type, workflow_execution_id FROM prompt_queue WHERE id = ? LIMIT 1',
        messageId,
      )
      .toArray();
    if (rows.length === 0) return null;
    return {
      queueType: (rows[0].queue_type as string) || 'prompt',
      workflowExecutionId: (rows[0].workflow_execution_id as string | null) ?? null,
    };
  }

  /** Author email of the currently-processing entry. Null when ambiguous. */
  getProcessingAuthorEmail(): string | null {
    const rows = this.sql
      .exec("SELECT author_email FROM prompt_queue WHERE status = 'processing' ORDER BY created_at DESC LIMIT 2")
      .toArray();
    if (rows.length !== 1) return null;
    return (rows[0].author_email as string | null) ?? null;
  }

  /** Author email keyed by messageId. */
  getAuthorEmailById(messageId: string): string | null {
    const rows = this.sql
      .exec('SELECT author_email FROM prompt_queue WHERE id = ? LIMIT 1', messageId)
      .toArray();
    if (rows.length === 0) return null;
    return (rows[0].author_email as string | null) ?? null;
  }

  /** Get channel target for a specific prompt by messageId.
   *  Prefers reply_channel_* over channel_* (matches legacy getProcessingChannelContext
   *  precedence) so external-channel replies route correctly.
   *  Unlike getProcessingChannelContext, does NOT special-case 'web'/'thread' — those
   *  are valid emit targets in the explicit-routing contract.
   */
  /** Get the stored channel_key for a prompt queue entry by message ID. */
  getChannelKeyById(messageId: string): string | null {
    const rows = this.sql
      .exec('SELECT channel_key FROM prompt_queue WHERE id = ? LIMIT 1', messageId)
      .toArray();
    return rows.length > 0 ? (rows[0].channel_key as string | null) : null;
  }

  /** Channel key of the currently processing prompt queue entry — DEPRECATED
   *  under cross-thread concurrent dispatch where multiple processing rows
   *  can co-exist. Returns null when ambiguous so callers don't unmark the
   *  wrong channel as busy. Prefer {@link getChannelKeyById} keyed by the
   *  specific messageId that completed. */
  getProcessingChannelKey(): string | null {
    const rows = this.sql
      .exec("SELECT channel_key FROM prompt_queue WHERE status = 'processing' LIMIT 2")
      .toArray();
    if (rows.length === 0) return null;
    if (rows.length > 1) return null;
    return (rows[0].channel_key as string | null) ?? null;
  }

  getChannelTargetById(messageId: string): { channelType: string | null; channelId: string | null; threadId: string | null } | undefined {
    const rows = this.sql
      .exec("SELECT channel_type, channel_id, reply_channel_type, reply_channel_id, thread_id FROM prompt_queue WHERE id = ? LIMIT 1", messageId)
      .toArray();
    if (rows.length === 0) return undefined;
    const channelType = (rows[0].reply_channel_type as string) || (rows[0].channel_type as string) || null;
    const channelId = (rows[0].reply_channel_id as string) || (rows[0].channel_id as string) || null;
    const threadId = (rows[0].thread_id as string) || null;
    return { channelType, channelId, threadId };
  }

  getAttachmentsById(messageId: string): unknown[] | null {
    const rows = this.sql
      .exec("SELECT attachments FROM prompt_queue WHERE id = ? LIMIT 1", messageId)
      .toArray();
    if (rows.length === 0 || typeof rows[0].attachments !== 'string' || !rows[0].attachments) {
      return null;
    }
    try {
      const parsed = JSON.parse(rows[0].attachments);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  /**
   * Get external channel context from the processing entry.
   * Used for hibernation recovery of active external-channel state.
   * Prefers reply_channel_type/reply_channel_id over channel_type/channel_id.
   */
  getProcessingChannelContext(): { channelType: string; channelId: string; threadId?: string } | null {
    const rows = this.sql
      .exec("SELECT channel_type, channel_id, reply_channel_type, reply_channel_id, thread_id FROM prompt_queue WHERE status = 'processing' ORDER BY created_at DESC LIMIT 1")
      .toArray();
    if (rows.length === 0) return null;

    const channelType = (rows[0].reply_channel_type as string) || (rows[0].channel_type as string) || null;
    const channelId = (rows[0].reply_channel_id as string) || (rows[0].channel_id as string) || null;
    const threadId = (rows[0].thread_id as string) || undefined;
    if (!channelType || !channelId) return null;
    if (channelType === 'web' || channelType === 'thread') return null;

    return threadId ? { channelType, channelId, threadId } : { channelType, channelId };
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

  /** Record that a prompt was just dispatched to the runner. Sets runnerBusy,
   *  stamps the per-row `dispatched_at`, and marks the channel busy. With
   *  cross-thread concurrent dispatch each row owns its own dispatched_at so
   *  the stuck-processing watchdog can identify the *oldest* in-flight row
   *  instead of being clobbered by a more recent sibling.
   *
   *  When `messageId` is omitted (e.g. workflow direct-dispatch which holds
   *  the runner without a prompt_queue row), only runnerBusy + optional
   *  channel busy state are updated. */
  stampDispatched(messageId?: string, channelKey?: string): void {
    this.setState('runnerBusy', 'true');
    if (messageId) {
      this.sql.exec(
        'UPDATE prompt_queue SET dispatched_at = ? WHERE id = ?',
        Date.now(),
        messageId,
      );
    }
    if (channelKey) {
      this.setChannelBusy(channelKey, true);
    }
  }

  /** No-op kept for callers that still want a hook on completion. Per-row
   *  dispatched_at is cleaned up by the row's transition to 'completed' →
   *  pruning. Error safety nets are now per-channel; clear them via
   *  {@link setChannelErrorSafetyNetAt}. */
  clearDispatchTimers(): void {
    // intentionally empty — see method docstring
  }

  /** Most recent dispatched_at across all processing rows. Kept for the
   *  watchdog's "anything in flight?" guard; per-row deadlines should use
   *  {@link getOldestProcessingDispatchedAt}. */
  get lastPromptDispatchedAt(): number {
    const rows = this.sql
      .exec(
        "SELECT MAX(dispatched_at) AS ts FROM prompt_queue WHERE status = 'processing' AND dispatched_at IS NOT NULL",
      )
      .toArray();
    return (rows[0]?.ts as number | null) ?? 0;
  }

  /** Oldest dispatched_at across all processing rows. Used by the
   *  stuck-processing watchdog so a wedged thread can be detected even when
   *  sibling threads keep dispatching fresh rows. */
  getOldestProcessingDispatchedAt(): number {
    const rows = this.sql
      .exec(
        "SELECT MIN(dispatched_at) AS ts FROM prompt_queue WHERE status = 'processing' AND dispatched_at IS NOT NULL",
      )
      .toArray();
    return (rows[0]?.ts as number | null) ?? 0;
  }

  /** Per-row received_at lookup. */
  getReceivedAtById(messageId: string): number {
    const rows = this.sql
      .exec('SELECT received_at FROM prompt_queue WHERE id = ? LIMIT 1', messageId)
      .toArray();
    return (rows[0]?.received_at as number | null) ?? 0;
  }

  /** Aggregate view: any channel whose idle_queued_since is set will surface
   *  here. Returns the EARLIEST armed timestamp across all channels. Useful
   *  for status broadcasts that want a single number. */
  get idleQueuedSince(): number {
    const earliest = this.getEarliestChannelIdleQueuedSince();
    return earliest?.armedAt ?? 0;
  }

  /** Aggregate view: earliest armed channel error-safety-net timestamp. */
  get errorSafetyNetAt(): number {
    const earliest = this.getEarliestChannelErrorSafetyNetAt();
    return earliest?.armedAt ?? 0;
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

  /** True if ANY in-flight prompt has been processing for at least timeoutMs.
   *  Uses the OLDEST dispatched_at so a wedged thread is still detectable when
   *  sibling threads keep firing fresh dispatches. */
  isStuckProcessing(timeoutMs: number): boolean {
    const oldest = this.getOldestProcessingDispatchedAt();
    if (!oldest) return false;
    return (Date.now() - oldest) >= timeoutMs;
  }

  /** Return the messageId of the oldest in-flight prompt that has been
   *  processing for at least timeoutMs. Null if nothing is stuck. */
  getStuckProcessingMessageId(timeoutMs: number): string | null {
    const cutoff = Date.now() - timeoutMs;
    const rows = this.sql
      .exec(
        "SELECT id FROM prompt_queue WHERE status = 'processing' AND dispatched_at IS NOT NULL AND dispatched_at <= ? ORDER BY dispatched_at ASC LIMIT 1",
        cutoff,
      )
      .toArray();
    return rows.length > 0 ? (rows[0].id as string) : null;
  }

  /** Per-channel error safety-net. Set when this channel's turn errored;
   *  cleared when its prompt completes. Replaces the global errorSafetyNetAt
   *  that any sibling thread's completion could clobber. */
  getChannelErrorSafetyNetAt(channelKey: string): number {
    const rows = this.sql
      .exec('SELECT error_safety_net_at FROM channel_state WHERE channel_key = ?', channelKey)
      .toArray();
    return (rows[0]?.error_safety_net_at as number | null) ?? 0;
  }

  setChannelErrorSafetyNetAt(channelKey: string, ms: number): void {
    this.sql.exec(
      'INSERT INTO channel_state (channel_key, error_safety_net_at) VALUES (?, ?) ON CONFLICT(channel_key) DO UPDATE SET error_safety_net_at = excluded.error_safety_net_at',
      channelKey,
      ms || null,
    );
  }

  /** Return the smallest non-null error_safety_net_at across all channels.
   *  Used by the watchdog to schedule the next safety-net firing. */
  getEarliestChannelErrorSafetyNetAt(): { channelKey: string; armedAt: number } | null {
    const rows = this.sql
      .exec(
        'SELECT channel_key, error_safety_net_at FROM channel_state WHERE error_safety_net_at IS NOT NULL ORDER BY error_safety_net_at ASC LIMIT 1',
      )
      .toArray();
    if (rows.length === 0) return null;
    return {
      channelKey: rows[0].channel_key as string,
      armedAt: rows[0].error_safety_net_at as number,
    };
  }

  /** Per-channel idle-queued-since. Replaces the global idleQueuedSince. */
  getChannelIdleQueuedSince(channelKey: string): number {
    const rows = this.sql
      .exec('SELECT idle_queued_since FROM channel_state WHERE channel_key = ?', channelKey)
      .toArray();
    return (rows[0]?.idle_queued_since as number | null) ?? 0;
  }

  setChannelIdleQueuedSince(channelKey: string, ms: number): void {
    this.sql.exec(
      'INSERT INTO channel_state (channel_key, idle_queued_since) VALUES (?, ?) ON CONFLICT(channel_key) DO UPDATE SET idle_queued_since = excluded.idle_queued_since',
      channelKey,
      ms || null,
    );
  }

  /** Set idle_queued_since for a channel only if currently unarmed. */
  armChannelIdleQueuedSince(channelKey: string, ms: number): void {
    if (this.getChannelIdleQueuedSince(channelKey) === 0) {
      this.setChannelIdleQueuedSince(channelKey, ms);
    }
  }

  /** For every channel that currently has queued rows, arm its
   *  idle_queued_since to `ms` if not already armed. Used after recovery
   *  paths (disconnect revert, etc.) where many channels may have just
   *  flipped from processing→queued. */
  armIdleQueuedSinceForAllQueuedChannels(ms: number): void {
    const rows = this.sql
      .exec(
        "SELECT DISTINCT channel_key FROM prompt_queue WHERE status = 'queued' AND channel_key IS NOT NULL",
      )
      .toArray();
    for (const row of rows) {
      const key = row.channel_key as string | null;
      if (!key) continue;
      this.armChannelIdleQueuedSince(key, ms);
    }
  }

  /** Clear idle_queued_since on every channel. Used on a clean session start /
   *  recovery when no queued work remains. */
  clearAllChannelIdleQueuedSince(): void {
    this.sql.exec('UPDATE channel_state SET idle_queued_since = NULL WHERE idle_queued_since IS NOT NULL');
  }

  /** Clear error_safety_net_at on every channel. */
  clearAllChannelErrorSafetyNets(): void {
    this.sql.exec('UPDATE channel_state SET error_safety_net_at = NULL WHERE error_safety_net_at IS NOT NULL');
  }

  /** Smallest non-null idle_queued_since across all channels — drives the
   *  stuck-queue watchdog alarm. */
  getEarliestChannelIdleQueuedSince(): { channelKey: string; armedAt: number } | null {
    const rows = this.sql
      .exec(
        'SELECT channel_key, idle_queued_since FROM channel_state WHERE idle_queued_since IS NOT NULL ORDER BY idle_queued_since ASC LIMIT 1',
      )
      .toArray();
    if (rows.length === 0) return null;
    return {
      channelKey: rows[0].channel_key as string,
      armedAt: rows[0].idle_queued_since as number,
    };
  }

  // ─── Per-Channel Busy State ─────────────────────────────────────────────────
  // Uses the `busy` column on the existing `channel_state` table (DO SQLite).
  // With a sequential runner only one channel is busy at a time, but tracking
  // per-channel lets us target aborts and broadcast per-thread status.

  /** Check whether a specific channel is currently busy. */
  isChannelBusy(channelKey: string): boolean {
    const rows = this.sql
      .exec('SELECT busy FROM channel_state WHERE channel_key = ?', channelKey)
      .toArray();
    return rows.length > 0 && (rows[0].busy as number) !== 0;
  }

  /** Mark a channel busy or idle. Upserts into channel_state. */
  setChannelBusy(channelKey: string, busy: boolean): void {
    this.sql.exec(
      'INSERT INTO channel_state (channel_key, busy) VALUES (?, ?) ON CONFLICT(channel_key) DO UPDATE SET busy = excluded.busy',
      channelKey,
      busy ? 1 : 0,
    );
  }

  /** Return the channel_key that is currently marked busy, or null if none. */
  getBusyChannelKey(): string | null {
    const rows = this.sql
      .exec('SELECT channel_key FROM channel_state WHERE busy = 1 LIMIT 1')
      .toArray();
    return rows.length > 0 ? (rows[0].channel_key as string) : null;
  }

  /** Reset all channels to idle. Called on startup/recovery. */
  clearAllChannelBusy(): void {
    this.sql.exec('UPDATE channel_state SET busy = 0');
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
      authorAvatarUrl: (row.author_avatar_url as string) || null,
      channelType: (row.channel_type as string) || null,
      channelId: (row.channel_id as string) || null,
      channelKey: (row.channel_key as string) || null,
      threadId: (row.thread_id as string) || null,
      continuationContext: (row.continuation_context as string) || null,
      contextPrefix: (row.context_prefix as string) || null,
      replyChannelType: (row.reply_channel_type as string) || null,
      replyChannelId: (row.reply_channel_id as string) || null,
      childSessionId: (row.child_session_id as string) || null,
      childStatus: (row.child_status as string) || null,
      priority: typeof row.priority === 'number' ? row.priority : 0,
      replaceable: row.replaceable === undefined ? true : Number(row.replaceable) !== 0,
    };
  }
}
