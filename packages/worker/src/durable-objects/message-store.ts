/**
 * MessageStore — encapsulates all DO-local message persistence and streaming turn state.
 *
 * Owns:
 * - The `messages` and `replication_state` tables in DO SQLite
 * - A monotonic sequence counter (`seq`) that bumps on every SQLite mutation
 * - In-memory `activeTurns` map for streaming turn assembly
 * - D1 flush via seq-based watermark
 *
 * Uses Cloudflare's SqlStorage type directly (globally available via @cloudflare/workers-types).
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AuthorInfo {
  id?: string;
  email?: string;
  name?: string;
  avatarUrl?: string;
}

export interface TurnMetadata {
  channelType?: string;
  channelId?: string;
  opencodeSessionId?: string;
  threadId?: string;
}

/** Discriminated union for message parts. */
export interface TextPart {
  type: 'text';
  text: string;
  streaming?: boolean;
}

export interface ToolCallPart {
  type: 'tool-call';
  callId: string;
  toolName: string;
  status: string;
  args?: unknown;
  result?: unknown;
  error?: unknown;
}

export interface ErrorPart {
  type: 'error';
  message: string;
}

export interface FinishPart {
  type: 'finish';
  reason: string;
}

export type MessagePart = TextPart | ToolCallPart | ErrorPart | FinishPart;

export interface TurnSnapshot {
  turnId: string;
  content: string;
  parts: MessagePart[];
  metadata: TurnMetadata;
}

export interface MessageRow {
  id: string;
  seq: number;
  role: string;
  content: string;
  parts: string | null;
  authorId: string | null;
  authorEmail: string | null;
  authorName: string | null;
  authorAvatarUrl: string | null;
  channelType: string | null;
  channelId: string | null;
  opencodeSessionId: string | null;
  messageFormat: string;
  threadId: string | null;
  createdAt: number;
}

/** Shape of a full row from the messages table (SQL column names). */
interface MessageSqlRow extends Record<string, SqlStorageValue> {
  id: string;
  seq: number;
  role: string;
  content: string;
  parts: string | null;
  author_id: string | null;
  author_email: string | null;
  author_name: string | null;
  author_avatar_url: string | null;
  channel_type: string | null;
  channel_id: string | null;
  opencode_session_id: string | null;
  message_format: string;
  thread_id: string | null;
  created_at: number;
}

/** Shape of a single active turn held in memory during streaming. */
interface ActiveTurn {
  text: string;
  parts: MessagePart[];
  metadata: TurnMetadata;
}

// ─── Schema SQL ──────────────────────────────────────────────────────────────

const MESSAGES_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  parts TEXT,
  author_id TEXT,
  author_email TEXT,
  author_name TEXT,
  author_avatar_url TEXT,
  channel_type TEXT,
  channel_id TEXT,
  opencode_session_id TEXT,
  message_format TEXT NOT NULL DEFAULT 'v2',
  thread_id TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
`;

const MESSAGES_INDEX_SQL = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_seq ON messages(seq);
`;

const REPLICATION_STATE_SQL = `
CREATE TABLE IF NOT EXISTS replication_state (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
`;

const MIGRATION_COLUMNS: Array<{ sql: string }> = [
  { sql: 'ALTER TABLE messages ADD COLUMN seq INTEGER NOT NULL DEFAULT 0' },
  { sql: "ALTER TABLE messages ADD COLUMN message_format TEXT NOT NULL DEFAULT 'v2'" },
  { sql: 'ALTER TABLE messages ADD COLUMN thread_id TEXT' },
  { sql: 'ALTER TABLE messages ADD COLUMN opencode_session_id TEXT' },
];

/** All columns for a full message SELECT. */
const MESSAGE_COLUMNS = 'id, seq, role, content, parts, author_id, author_email, author_name, author_avatar_url, channel_type, channel_id, opencode_session_id, message_format, thread_id, created_at';

// ─── MessageStore Class ──────────────────────────────────────────────────────

export class MessageStore {
  private sql: SqlStorage;
  private nextSeq: number;
  private lastReplicatedSeq: number;
  private activeTurns = new Map<string, ActiveTurn>();

  constructor(sql: SqlStorage) {
    this.sql = sql;

    // Create tables (idempotent)
    this.sql.exec(MESSAGES_TABLE_SQL);
    this.sql.exec(REPLICATION_STATE_SQL);

    // Run column migrations for existing DOs (must run BEFORE index creation)
    for (const migration of MIGRATION_COLUMNS) {
      try { this.sql.exec(migration.sql); } catch { /* column already exists */ }
    }

    // Backfill seq from rowid for existing rows that have the default seq=0.
    // This must run BEFORE the unique index is created, since multiple seq=0
    // values would violate the uniqueness constraint.
    this.sql.exec('UPDATE messages SET seq = rowid WHERE seq = 0');

    // Now safe to create the unique index (all seq values are unique)
    this.sql.exec(MESSAGES_INDEX_SQL);

    // Initialize seq counter from MAX(seq) in messages table
    const maxSeqRow = this.sql.exec<{ max_seq: number | null }>('SELECT MAX(seq) as max_seq FROM messages').one();
    this.nextSeq = typeof maxSeqRow.max_seq === 'number' && maxSeqRow.max_seq > 0 ? maxSeqRow.max_seq + 1 : 1;

    // Initialize replication watermark
    const repRows = this.sql.exec<{ value: number }>("SELECT value FROM replication_state WHERE key = 'last_replicated_seq'").toArray();
    this.lastReplicatedSeq = repRows.length > 0 ? repRows[0].value : 0;
  }

  // ─── Seq Counter ─────────────────────────────────────────────────────

  /** Consume and return the next sequence number. */
  private bumpSeq(): number {
    return this.nextSeq++;
  }

  /** Current next-seq value (for testing/diagnostics). */
  get currentSeq(): number {
    return this.nextSeq;
  }

  // ─── Task 1: writeMessage ────────────────────────────────────────────

  /**
   * Write a complete message to SQLite. Used for user messages, system messages,
   * and other write-once messages. Returns the assigned seq number.
   */
  writeMessage(params: {
    id: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    parts?: string | null;
    author?: AuthorInfo;
    channelType?: string | null;
    channelId?: string | null;
    opencodeSessionId?: string | null;
    messageFormat?: string;
    threadId?: string | null;
  }): number {
    const seq = this.bumpSeq();
    this.sql.exec(
      `INSERT OR IGNORE INTO messages (id, seq, role, content, parts, author_id, author_email, author_name, author_avatar_url, channel_type, channel_id, opencode_session_id, message_format, thread_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params.id,
      seq,
      params.role,
      params.content,
      params.parts ?? null,
      params.author?.id ?? null,
      params.author?.email ?? null,
      params.author?.name ?? null,
      params.author?.avatarUrl ?? null,
      params.channelType ?? null,
      params.channelId ?? null,
      params.opencodeSessionId ?? null,
      params.messageFormat ?? 'v2',
      params.threadId ?? null,
    );
    return seq;
  }

  // ─── Task 2: Streaming Turn Lifecycle ────────────────────────────────

  /**
   * Begin a new streaming assistant turn. Inserts a placeholder row in SQLite
   * and tracks the turn in the in-memory activeTurns map.
   */
  // FUTURE: dispatch channel transport lifecycle hook here (onTurnStarted)
  createTurn(turnId: string, metadata: TurnMetadata): number {
    const seq = this.bumpSeq();
    this.sql.exec(
      `INSERT OR IGNORE INTO messages (id, seq, role, content, parts, message_format, channel_type, channel_id, opencode_session_id, thread_id)
       VALUES (?, ?, 'assistant', '', '[]', 'v2', ?, ?, ?, ?)`,
      turnId,
      seq,
      metadata.channelType ?? null,
      metadata.channelId ?? null,
      metadata.opencodeSessionId ?? null,
      metadata.threadId ?? null,
    );
    this.activeTurns.set(turnId, {
      text: '',
      parts: [],
      metadata: { ...metadata },
    });
    return seq;
  }

  /**
   * Append a text delta to an active streaming turn. In-memory only — no SQLite write,
   * no seq bump. Creates a new text part after tool calls (text -> tool-call -> text pattern).
   */
  // FUTURE: dispatch channel transport lifecycle hook here (onTextDelta)
  appendTextDelta(turnId: string, delta: string): boolean {
    const turn = this.activeTurns.get(turnId);
    if (!turn) return false;

    turn.text += delta;

    // Update or create the current streaming text part
    const lastPart = turn.parts[turn.parts.length - 1];
    if (lastPart && lastPart.type === 'text' && lastPart.streaming) {
      lastPart.text += delta;
    } else {
      // New text part — starts after a non-text part (e.g., tool-call) or is the first part
      turn.parts.push({ type: 'text', text: delta, streaming: true });
    }

    return true;
  }

  /**
   * Update a tool call within an active turn. Persists to SQLite (survives hibernation)
   * and bumps seq.
   */
  updateToolCall(
    turnId: string,
    callId: string,
    toolName: string,
    status: string,
    args?: unknown,
    result?: unknown,
    error?: unknown,
  ): number | null {
    const turn = this.activeTurns.get(turnId);
    if (!turn) return null;

    // Find existing tool part or create new one
    let toolPart = turn.parts.find(
      (p): p is ToolCallPart => p.type === 'tool-call' && p.callId === callId,
    );

    if (toolPart) {
      toolPart.status = status;
      if (args !== undefined) toolPart.args = args;
      if (result !== undefined) toolPart.result = result;
      if (error !== undefined) toolPart.error = error;
    } else {
      // Mark any trailing streaming text part as not streaming before adding tool
      const lastPart = turn.parts[turn.parts.length - 1];
      if (lastPart && lastPart.type === 'text' && lastPart.streaming) {
        lastPart.streaming = false;
      }
      toolPart = {
        type: 'tool-call',
        callId,
        toolName,
        status,
        ...(args !== undefined ? { args } : {}),
        ...(result !== undefined ? { result } : {}),
        ...(error !== undefined ? { error } : {}),
      };
      turn.parts.push(toolPart);
    }

    // Persist to SQLite — UPDATE existing row (preserves created_at)
    const seq = this.bumpSeq();
    this.sql.exec(
      'UPDATE messages SET parts = ?, content = ?, seq = ? WHERE id = ?',
      JSON.stringify(turn.parts),
      turn.text,
      seq,
      turnId,
    );

    return seq;
  }

  /**
   * Finalize a streaming turn. MUST use UPDATE (not INSERT OR REPLACE) to preserve created_at.
   * Marks text parts as not streaming, applies finalText if single text part, adds finish part.
   * Returns a TurnSnapshot and removes the turn from activeTurns.
   */
  // FUTURE: dispatch channel transport lifecycle hook here (onTurnFinalized)
  finalizeTurn(
    turnId: string,
    finalText?: string,
    reason?: string,
    errorMsg?: string,
  ): TurnSnapshot | null {
    const turn = this.activeTurns.get(turnId);
    if (!turn) return null;

    // Use finalText if provided (may be more complete than streamed chunks)
    const finalContent = finalText ?? turn.text;

    // If turn was recovered from hibernation with empty parts, populate from finalContent
    if (turn.parts.length === 0 && finalContent) {
      turn.parts.push({ type: 'text', text: finalContent });
    }

    // Mark all text parts as not streaming.
    // If there's only one text part and finalText was provided, use it (more complete).
    const textParts = turn.parts.filter((p): p is TextPart => p.type === 'text');
    if (textParts.length === 1 && finalText) {
      textParts[0].text = finalContent;
    }
    for (const part of textParts) {
      part.streaming = false;
    }

    // If there was an error, add error part before finish
    if (reason === 'error' && errorMsg) {
      turn.parts.push({ type: 'error', message: errorMsg });
    }

    // Add finish part (always last)
    turn.parts.push({ type: 'finish', reason: reason || 'end_turn' });

    // UPDATE existing row in SQLite — preserves created_at
    const seq = this.bumpSeq();
    this.sql.exec(
      'UPDATE messages SET content = ?, parts = ?, seq = ? WHERE id = ?',
      finalContent,
      JSON.stringify(turn.parts),
      seq,
      turnId,
    );

    const snapshot: TurnSnapshot = {
      turnId,
      content: finalContent,
      parts: [...turn.parts],
      metadata: { ...turn.metadata },
    };

    // Clean up active turn
    this.activeTurns.delete(turnId);

    return snapshot;
  }

  /** Get the in-memory snapshot of an active turn (returns null if not active). */
  getTurnSnapshot(turnId: string): TurnSnapshot | null {
    const turn = this.activeTurns.get(turnId);
    if (!turn) return null;
    return {
      turnId,
      content: turn.text,
      parts: [...turn.parts],
      metadata: { ...turn.metadata },
    };
  }

  /** Set of currently active (streaming) turn IDs. */
  get activeTurnIds(): Set<string> {
    return new Set(this.activeTurns.keys());
  }

  /**
   * Recover a turn from SQLite after DO hibernation wipes in-memory state.
   * Re-adds to activeTurns. Returns the snapshot if found.
   */
  recoverTurn(turnId: string): TurnSnapshot | null {
    const rows = this.sql.exec<MessageSqlRow>(
      `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE id = ? AND role = 'assistant' AND message_format = 'v2'`,
      turnId,
    ).toArray();
    if (rows.length === 0) return null;

    const row = rows[0];
    let recoveredParts: MessagePart[] = [];
    try {
      if (row.parts) {
        recoveredParts = JSON.parse(row.parts) as MessagePart[];
      }
    } catch { /* corrupted parts — start fresh */ }

    const metadata: TurnMetadata = {
      channelType: row.channel_type || undefined,
      channelId: row.channel_id || undefined,
      opencodeSessionId: row.opencode_session_id || undefined,
      threadId: row.thread_id || undefined,
    };

    const turn: ActiveTurn = {
      text: row.content || '',
      parts: recoveredParts,
      metadata,
    };
    this.activeTurns.set(turnId, turn);

    return {
      turnId,
      content: turn.text,
      parts: [...turn.parts],
      metadata: { ...turn.metadata },
    };
  }

  /** Check if a message with the given ID exists. */
  hasMessage(id: string): boolean {
    const rows = this.sql.exec("SELECT 1 FROM messages WHERE id = ? LIMIT 1", id).toArray();
    return rows.length > 0;
  }

  /** Read a single message by ID. */
  getMessage(id: string): MessageRow | null {
    const rows = this.sql.exec<MessageSqlRow>(
      `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE id = ?`,
      id,
    ).toArray();
    if (rows.length === 0) return null;
    return this.rowToMessageRow(rows[0]);
  }

  /** Read messages, ordered by created_at ASC, seq ASC. Supports optional limit and cursor. */
  getMessages(opts?: { limit?: number; afterId?: string; afterCreatedAt?: number; threadId?: string }): MessageRow[] {
    let query = `SELECT ${MESSAGE_COLUMNS} FROM messages`;
    const params: (string | number)[] = [];
    const conditions: string[] = [];

    if (opts?.afterId) {
      conditions.push('(created_at, seq) > (SELECT created_at, seq FROM messages WHERE id = ?)');
      params.push(opts.afterId);
    } else if (opts?.afterCreatedAt !== undefined) {
      conditions.push('created_at > ?');
      params.push(opts.afterCreatedAt);
    }

    if (opts?.threadId) {
      conditions.push('thread_id = ?');
      params.push(opts.threadId);
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ' ORDER BY created_at ASC, seq ASC';

    if (opts?.limit) {
      query += ' LIMIT ?';
      params.push(opts.limit);
    }

    const rows = this.sql.exec<MessageSqlRow>(query, ...params).toArray();
    return rows.map((r) => this.rowToMessageRow(r));
  }

  /**
   * Update the parts JSON of an existing message. Used by audio-transcript handler.
   * Bumps seq so the change is flushed to D1.
   */
  updateMessageParts(messageId: string, parts: string): number {
    const seq = this.bumpSeq();
    this.sql.exec(
      'UPDATE messages SET parts = ?, seq = ? WHERE id = ?',
      parts,
      seq,
      messageId,
    );
    return seq;
  }

  // ─── Task 4: D1 Flush ───────────────────────────────────────────────

  /**
   * Flush messages with seq > lastReplicatedSeq to D1 via the provided callback.
   * Advances the watermark in replication_state on success.
   */
  async flushToD1<TDb>(
    db: TDb,
    sessionId: string,
    batchUpsert: (db: TDb, sessionId: string, msgs: Array<{
      id: string;
      role: string;
      content: string;
      parts: string | null;
      authorId: string | null;
      authorEmail: string | null;
      authorName: string | null;
      authorAvatarUrl: string | null;
      channelType: string | null;
      channelId: string | null;
      opencodeSessionId: string | null;
      messageFormat: string;
      threadId: string | null;
      createdAt?: number;
    }>) => Promise<void>,
  ): Promise<number> {
    const rows = this.sql.exec<MessageSqlRow>(
      `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE seq > ? ORDER BY seq ASC LIMIT 200`,
      this.lastReplicatedSeq,
    ).toArray();

    if (rows.length === 0) return 0;

    const msgs = rows.map((row) => ({
      id: row.id,
      role: row.role,
      content: row.content,
      parts: row.parts,
      authorId: row.author_id,
      authorEmail: row.author_email,
      authorName: row.author_name,
      authorAvatarUrl: row.author_avatar_url,
      channelType: row.channel_type,
      channelId: row.channel_id,
      opencodeSessionId: row.opencode_session_id,
      messageFormat: row.message_format || 'v2',
      threadId: row.thread_id,
      createdAt: row.created_at,
    }));

    await batchUpsert(db, sessionId, msgs);

    // Advance watermark — but don't advance past active turns so they get re-flushed
    const activeTurnIdSet = this.activeTurnIds;
    const activeSeqs = rows
      .filter((row) => activeTurnIdSet.has(row.id))
      .map((row) => row.seq);
    const minActiveSeq = activeSeqs.length > 0 ? Math.min(...activeSeqs) : null;
    const maxFlushedSeq = rows[rows.length - 1].seq;
    const safeWatermark = Math.max(
      0,
      minActiveSeq !== null ? Math.min(maxFlushedSeq, minActiveSeq - 1) : maxFlushedSeq,
    );

    this.lastReplicatedSeq = safeWatermark;
    this.sql.exec(
      "INSERT OR REPLACE INTO replication_state (key, value) VALUES ('last_replicated_seq', ?)",
      safeWatermark,
    );

    return rows.length;
  }

  /** Current replication watermark (for testing/diagnostics). */
  get replicatedSeq(): number {
    return this.lastReplicatedSeq;
  }

  // ─── Delete Operations ──────────────────────────────────────────────

  /**
   * Delete a message and all messages created at or after it (revert).
   * Bumps seq so the deletion is visible to the replication watermark.
   * Returns the list of deleted message IDs.
   */
  deleteMessagesFrom(messageId: string): string[] {
    const targetRows = this.sql.exec<{ created_at: number }>(
      'SELECT created_at FROM messages WHERE id = ?', messageId,
    ).toArray();

    if (targetRows.length === 0) return [];

    const createdAt = targetRows[0].created_at;
    const affected = this.sql.exec<{ id: string }>(
      'SELECT id FROM messages WHERE created_at >= ? ORDER BY created_at ASC', createdAt,
    ).toArray();

    const removedIds = affected.map((m) => m.id);
    if (removedIds.length === 0) return [];

    const placeholders = removedIds.map(() => '?').join(',');
    this.sql.exec(`DELETE FROM messages WHERE id IN (${placeholders})`, ...removedIds);

    // Clean up any active turns that were deleted
    for (const id of removedIds) {
      this.activeTurns.delete(id);
    }

    // Bump seq so watermark logic knows state changed
    this.bumpSeq();

    return removedIds;
  }

  /**
   * Delete all messages (session reset/reuse). Resets seq counter and
   * replication watermark so the session starts fresh.
   */
  reset(): void {
    this.sql.exec('DELETE FROM messages');
    this.activeTurns.clear();
    this.nextSeq = 1;
    this.lastReplicatedSeq = 0;
    this.sql.exec(
      "INSERT OR REPLACE INTO replication_state (key, value) VALUES ('last_replicated_seq', 0)",
    );
  }

  // ─── Helpers ─────────────────────────────────────────────────────────

  private rowToMessageRow(row: MessageSqlRow): MessageRow {
    return {
      id: row.id,
      seq: row.seq,
      role: row.role,
      content: row.content,
      parts: row.parts,
      authorId: row.author_id,
      authorEmail: row.author_email,
      authorName: row.author_name,
      authorAvatarUrl: row.author_avatar_url,
      channelType: row.channel_type,
      channelId: row.channel_id,
      opencodeSessionId: row.opencode_session_id,
      messageFormat: row.message_format || 'v2',
      threadId: row.thread_id,
      createdAt: row.created_at,
    };
  }
}
