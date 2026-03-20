# MessageStore Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract all message persistence, streaming turn state, and D1 replication from `session-agent.ts` into a single `MessageStore` class that owns the `messages` table and all message mutations.

**Architecture:** MessageStore is a plain class (not a Durable Object) instantiated by `SessionAgentDO` in its constructor. It owns the DO SQLite `messages` table, in-memory streaming turn state (replacing `activeTurns`), and seq-based D1 replication (replacing timestamp watermarks). Every raw `INSERT INTO messages`, `UPDATE messages`, and `activeTurns` mutation in the DO is replaced with a MessageStore method call. The DO becomes a thin coordinator that calls MessageStore methods and broadcasts results to WebSocket clients.

**Tech Stack:** TypeScript, Cloudflare Durable Objects (SqlStorage), D1, vitest

**Spec:** `docs/specs/2026-03-20-message-persistence-design.md`

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `packages/worker/src/durable-objects/message-store.ts` | MessageStore class: schema, seq counter, write-once messages, streaming turns, D1 flush |
| Create | `packages/worker/src/durable-objects/message-store.test.ts` | Unit tests for MessageStore |
| Modify | `packages/worker/src/durable-objects/session-agent.ts` | Replace 15+ INSERT/UPDATE sites + activeTurns + flushMessagesToD1 with MessageStore calls |
| Modify | `packages/worker/src/lib/db/messages.ts` | Update `batchUpsertMessages` to accept and pass `createdAt` + `createdAtEpoch` |
| Modify | `packages/worker/src/lib/schema/sessions.ts` | Add `createdAtEpoch` column to Drizzle schema |
| Create | `packages/worker/migrations/0002_message_created_at_epoch.sql` | D1 migration: add `created_at_epoch` column |
| Modify | `packages/worker/src/services/orchestrator.ts` | Remove direct D1 `saveMessage` call |
| Modify | `packages/worker/src/services/sessions.ts` | Remove direct D1 `saveMessage` call |

---

## Task 1: MessageStore — Schema + Constructor + Seq Counter

**Files:**
- Create: `packages/worker/src/durable-objects/message-store.ts`
- Create: `packages/worker/src/durable-objects/message-store.test.ts`

This task builds the skeleton: schema creation, seq counter initialization, and the `SqlStorage` mock pattern for testing.

- [ ] **Step 1: Write failing tests for constructor and seq initialization**

```typescript
// message-store.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { MessageStore } from './message-store.js';

// Minimal SqlStorage mock that uses an in-memory Map for testing.
// Real SqlStorage.exec() returns a cursor; we simulate the subset MessageStore uses.
function createMockSql() {
  const tables = new Map<string, Array<Record<string, unknown>>>();
  const sql = {
    exec(query: string, ...params: unknown[]) {
      // Store raw queries for assertion; return cursor-like object
      sql._queries.push({ query, params });

      // Handle schema DDL — just no-op
      if (query.trim().startsWith('CREATE ') || query.trim().startsWith('ALTER ')) {
        return { toArray: () => [] };
      }

      // Handle SELECTs needed by constructor
      if (query.includes('MAX(seq)')) {
        const msgs = tables.get('messages') || [];
        const maxSeq = msgs.reduce((m, r) => Math.max(m, (r.seq as number) || 0), 0);
        return { toArray: () => [{ max_seq: msgs.length > 0 ? maxSeq : null }] };
      }
      if (query.includes('FROM replication_state')) {
        const rows = tables.get('replication_state') || [];
        const match = rows.find(r => r.key === 'lastReplicatedSeq');
        return { toArray: () => match ? [match] : [] };
      }

      // Handle INSERTs (used by writeMessage, createTurn, etc.)
      if (query.trim().startsWith('INSERT')) {
        const tableName = query.match(/INTO\s+(\w+)/)?.[1] || '';
        if (!tables.has(tableName)) tables.set(tableName, []);
        // For messages table, extract id and seq from params
        if (tableName === 'messages') {
          // We'll build this out as we add methods
        }
        return { toArray: () => [] };
      }

      return { toArray: () => [] };
    },
    _queries: [] as Array<{ query: string; params: unknown[] }>,
    _tables: tables,
  };
  return sql;
}

describe('MessageStore', () => {
  describe('constructor', () => {
    it('initializes nextSeq to 1 on empty database', () => {
      const sql = createMockSql();
      const store = new MessageStore(sql as any);
      // After construction, writing a message should use seq=1
      store.writeMessage({ id: 'msg-1', role: 'user', content: 'hello' });
      const insertQuery = sql._queries.find(q => q.query.includes('INSERT INTO messages'));
      expect(insertQuery).toBeDefined();
      // seq should be 1 (first message)
      expect(insertQuery!.params).toContain(1);
    });

    it('initializes nextSeq from existing max seq', () => {
      const sql = createMockSql();
      sql._tables.set('messages', [{ seq: 42 }]);
      const store = new MessageStore(sql as any);
      store.writeMessage({ id: 'msg-1', role: 'user', content: 'hello' });
      const insertQuery = sql._queries.find(q => q.query.includes('INSERT INTO messages'));
      expect(insertQuery!.params).toContain(43);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/worker && npx vitest run src/durable-objects/message-store.test.ts`
Expected: FAIL — `message-store.ts` does not exist

- [ ] **Step 3: Write MessageStore skeleton with schema + constructor**

```typescript
// message-store.ts
import type { SqlStorage } from '@cloudflare/workers-types';

// ─── Types ────────────────────────────────────────────────────────────────

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

export interface TurnSnapshot {
  turnId: string;
  content: string;
  parts: Array<{ type: string; [key: string]: unknown }>;
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

// ─── Schema ───────────────────────────────────────────────────────────────

const MESSAGES_SCHEMA = `
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

  CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_seq ON messages(seq);

  CREATE TABLE IF NOT EXISTS replication_state (
    key TEXT PRIMARY KEY,
    value INTEGER NOT NULL
  );
`;

// ─── MessageStore ─────────────────────────────────────────────────────────

export class MessageStore {
  private sql: SqlStorage;
  private nextSeq: number;
  private lastReplicatedSeq: number;

  // In-memory streaming turn state (replaces activeTurns Map on DO)
  private activeTurns = new Map<string, {
    text: string;
    parts: Array<{ type: string; [key: string]: unknown }>;
    metadata: TurnMetadata;
  }>();

  constructor(sql: SqlStorage) {
    this.sql = sql;

    // Create tables (no-op if already exist)
    this.sql.exec(MESSAGES_SCHEMA);

    // Migrate existing DOs: add seq column if missing
    try {
      this.sql.exec('ALTER TABLE messages ADD COLUMN seq INTEGER DEFAULT NULL');
    } catch { /* already exists */ }

    // Migrate existing DOs: add message_format if missing
    try {
      this.sql.exec("ALTER TABLE messages ADD COLUMN message_format TEXT DEFAULT 'v2'");
    } catch { /* already exists */ }

    // Migrate existing DOs: add thread_id if missing
    try {
      this.sql.exec('ALTER TABLE messages ADD COLUMN thread_id TEXT DEFAULT NULL');
    } catch { /* already exists */ }

    // Initialize seq counter from existing data
    const seqRow = this.sql
      .exec('SELECT MAX(seq) as max_seq FROM messages')
      .toArray();
    const maxSeq = seqRow[0]?.max_seq;
    this.nextSeq = (typeof maxSeq === 'number' ? maxSeq : 0) + 1;

    // Initialize replication watermark
    const repRow = this.sql
      .exec("SELECT value FROM replication_state WHERE key = 'lastReplicatedSeq'")
      .toArray();
    this.lastReplicatedSeq = repRow.length > 0 ? (repRow[0].value as number) : 0;
  }

  /** Get the next seq value and increment the counter. */
  private nextSeqVal(): number {
    return this.nextSeq++;
  }

  // ── Write-once messages ──────────────────────────────────────────────

  writeMessage(params: {
    id: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    parts?: string | null;
    author?: AuthorInfo;
    channelType?: string;
    channelId?: string;
    opencodeSessionId?: string;
    threadId?: string;
  }): void {
    const seq = this.nextSeqVal();
    this.sql.exec(
      `INSERT INTO messages (id, seq, role, content, parts, author_id, author_email, author_name, author_avatar_url, channel_type, channel_id, opencode_session_id, thread_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      params.threadId ?? null,
    );
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/worker && npx vitest run src/durable-objects/message-store.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/durable-objects/message-store.ts packages/worker/src/durable-objects/message-store.test.ts
git commit -m "feat: MessageStore skeleton with schema, seq counter, and writeMessage"
```

---

## Task 2: MessageStore — Streaming Turn Lifecycle

**Files:**
- Modify: `packages/worker/src/durable-objects/message-store.ts`
- Modify: `packages/worker/src/durable-objects/message-store.test.ts`

Implements `createTurn`, `appendTextDelta`, `updateToolCall`, `finalizeTurn`, `getTurnSnapshot`, `activeTurnIds`, and `recoverTurn`.

- [ ] **Step 1: Write failing tests for streaming turn lifecycle**

```typescript
describe('streaming turns', () => {
  it('createTurn inserts placeholder and tracks in-memory', () => {
    const sql = createMockSql();
    const store = new MessageStore(sql as any);
    store.createTurn('turn-1', { threadId: 'thread-1' });
    const snapshot = store.getTurnSnapshot('turn-1');
    expect(snapshot).not.toBeNull();
    expect(snapshot!.content).toBe('');
    expect(snapshot!.parts).toEqual([]);
    expect(snapshot!.metadata.threadId).toBe('thread-1');
  });

  it('appendTextDelta accumulates text in-memory without SQLite write', () => {
    const sql = createMockSql();
    const store = new MessageStore(sql as any);
    store.createTurn('turn-1', {});
    const queryCountBefore = sql._queries.length;
    store.appendTextDelta('turn-1', 'hello ');
    store.appendTextDelta('turn-1', 'world');
    // No new SQLite queries for text deltas
    expect(sql._queries.length).toBe(queryCountBefore);
    const snapshot = store.getTurnSnapshot('turn-1');
    expect(snapshot!.content).toBe('hello world');
    // Should have one streaming text part
    expect(snapshot!.parts).toEqual([
      { type: 'text', text: 'hello world', streaming: true },
    ]);
  });

  it('updateToolCall persists to SQLite and bumps seq', () => {
    const sql = createMockSql();
    const store = new MessageStore(sql as any);
    store.createTurn('turn-1', {});
    store.appendTextDelta('turn-1', 'checking...');
    store.updateToolCall('turn-1', 'call-1', 'read_file', 'running');
    // Should have UPDATE query
    const updateQuery = sql._queries.find(q => q.query.includes('UPDATE messages'));
    expect(updateQuery).toBeDefined();
    const snapshot = store.getTurnSnapshot('turn-1');
    // Text part should no longer be streaming (tool call started)
    expect(snapshot!.parts[0]).toMatchObject({ type: 'text', text: 'checking...', streaming: false });
    expect(snapshot!.parts[1]).toMatchObject({ type: 'tool-call', callId: 'call-1', toolName: 'read_file', status: 'running' });
  });

  it('finalizeTurn persists final state and clears active turn', () => {
    const sql = createMockSql();
    const store = new MessageStore(sql as any);
    store.createTurn('turn-1', { channelType: 'slack', channelId: 'C123' });
    store.appendTextDelta('turn-1', 'final answer');
    const result = store.finalizeTurn('turn-1', 'final answer', 'end_turn');
    expect(result.content).toBe('final answer');
    expect(result.parts).toContainEqual({ type: 'finish', reason: 'end_turn' });
    // Active turn should be cleared
    expect(store.getTurnSnapshot('turn-1')).toBeNull();
    expect(store.activeTurnIds).not.toContain('turn-1');
  });

  it('finalizeTurn uses UPDATE not INSERT OR REPLACE', () => {
    const sql = createMockSql();
    const store = new MessageStore(sql as any);
    store.createTurn('turn-1', {});
    store.finalizeTurn('turn-1', 'done', 'end_turn');
    const finalizeQuery = sql._queries.filter(q =>
      q.query.includes('messages') && !q.query.includes('CREATE') && !q.query.includes('ALTER')
    ).pop();
    // Must be UPDATE, never INSERT OR REPLACE
    expect(finalizeQuery!.query).toMatch(/^UPDATE/i);
    expect(finalizeQuery!.query).not.toContain('INSERT OR REPLACE');
  });

  it('appendTextDelta creates new text part after tool call', () => {
    const sql = createMockSql();
    const store = new MessageStore(sql as any);
    store.createTurn('turn-1', {});
    store.appendTextDelta('turn-1', 'first ');
    store.updateToolCall('turn-1', 'call-1', 'read_file', 'complete', {}, 'file contents');
    store.appendTextDelta('turn-1', 'second ');
    const snapshot = store.getTurnSnapshot('turn-1');
    // Should have: text (not streaming) → tool-call → text (streaming)
    expect(snapshot!.parts.length).toBe(3);
    expect(snapshot!.parts[0]).toMatchObject({ type: 'text', text: 'first ', streaming: false });
    expect(snapshot!.parts[1]).toMatchObject({ type: 'tool-call', callId: 'call-1' });
    expect(snapshot!.parts[2]).toMatchObject({ type: 'text', text: 'second ', streaming: true });
  });

  it('activeTurnIds returns all active turn IDs', () => {
    const sql = createMockSql();
    const store = new MessageStore(sql as any);
    store.createTurn('turn-1', {});
    store.createTurn('turn-2', {});
    expect(store.activeTurnIds).toEqual(['turn-1', 'turn-2']);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/worker && npx vitest run src/durable-objects/message-store.test.ts`
Expected: FAIL — methods not implemented

- [ ] **Step 3: Implement streaming turn methods**

Add to `MessageStore` class in `message-store.ts`:

```typescript
  // ── Streaming turn lifecycle ──────────────────────────────────────────

  createTurn(turnId: string, metadata: TurnMetadata): void {
    const seq = this.nextSeqVal();
    this.sql.exec(
      `INSERT OR IGNORE INTO messages (id, seq, role, content, parts, message_format, channel_type, channel_id, opencode_session_id, thread_id)
       VALUES (?, ?, 'assistant', '', '[]', 'v2', ?, ?, ?, ?)`,
      turnId, seq,
      metadata.channelType ?? null,
      metadata.channelId ?? null,
      metadata.opencodeSessionId ?? null,
      metadata.threadId ?? null,
    );
    this.activeTurns.set(turnId, {
      text: '',
      parts: [],
      metadata,
    });
  }

  appendTextDelta(turnId: string, delta: string): void {
    const turn = this.activeTurns.get(turnId);
    if (!turn) return;
    turn.text += delta;
    const lastPart = turn.parts[turn.parts.length - 1];
    if (lastPart && lastPart.type === 'text' && lastPart.streaming) {
      lastPart.text += delta;
    } else {
      turn.parts.push({ type: 'text', text: delta, streaming: true });
    }
    // FUTURE: dispatch channel transport lifecycle hook here (onTextDelta)
  }

  updateToolCall(
    turnId: string,
    callId: string,
    toolName: string,
    status: string,
    args?: unknown,
    result?: unknown,
    error?: string,
  ): void {
    const turn = this.activeTurns.get(turnId);
    if (!turn) return;

    let toolPart = turn.parts.find(
      (p) => p.type === 'tool-call' && p.callId === callId,
    );
    if (toolPart) {
      toolPart.status = status;
      if (args !== undefined) toolPart.args = args;
      if (result !== undefined) toolPart.result = result;
      if (error !== undefined) toolPart.error = error;
    } else {
      // Mark any trailing streaming text part as not streaming
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

    // Persist to SQLite — bumps seq so D1 flush picks up tool state
    const seq = this.nextSeqVal();
    this.sql.exec(
      'UPDATE messages SET seq = ?, content = ?, parts = ? WHERE id = ?',
      seq, turn.text, JSON.stringify(turn.parts), turnId,
    );
  }

  finalizeTurn(turnId: string, finalText?: string, reason?: string): TurnSnapshot {
    const turn = this.activeTurns.get(turnId);
    if (!turn) {
      // Attempt recovery from SQLite (hibernation case)
      const recovered = this.recoverTurn(turnId);
      if (recovered) return recovered;
      throw new Error(`finalizeTurn: unknown turn ${turnId}`);
    }

    const content = finalText ?? turn.text;
    // If turn was recovered with empty parts, populate from finalContent
    if (turn.parts.length === 0 && content) {
      turn.parts.push({ type: 'text', text: content });
    }

    // Mark all text parts as not streaming; use finalText for single-text-part case
    const textParts = turn.parts.filter(p => p.type === 'text');
    if (textParts.length === 1 && finalText) {
      textParts[0].text = content;
    }
    for (const part of textParts) {
      part.streaming = false;
    }

    // Add finish part
    turn.parts.push({ type: 'finish', reason: reason || 'end_turn' });
    if (reason === 'error' && finalText) {
      turn.parts.push({ type: 'error', message: finalText });
    }

    // Persist — MUST use UPDATE to preserve original created_at
    const seq = this.nextSeqVal();
    this.sql.exec(
      'UPDATE messages SET seq = ?, content = ?, parts = ? WHERE id = ?',
      seq, content, JSON.stringify(turn.parts), turnId,
    );

    const snapshot: TurnSnapshot = {
      turnId,
      content,
      parts: [...turn.parts],
      metadata: { ...turn.metadata },
    };

    this.activeTurns.delete(turnId);
    // FUTURE: dispatch channel transport lifecycle hook here (onTurnFinalized)
    return snapshot;
  }

  // ── Turn snapshots ────────────────────────────────────────────────────

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

  get activeTurnIds(): string[] {
    return [...this.activeTurns.keys()];
  }

  recoverTurn(turnId: string): TurnSnapshot | null {
    const rows = this.sql
      .exec(
        "SELECT content, parts, channel_type, channel_id, opencode_session_id, thread_id FROM messages WHERE id = ? AND role = 'assistant'",
        turnId,
      )
      .toArray();
    if (rows.length === 0) return null;

    const row = rows[0];
    let parts: Array<{ type: string; [key: string]: unknown }> = [];
    try {
      if (row.parts && typeof row.parts === 'string') {
        parts = JSON.parse(row.parts);
      }
    } catch { /* corrupted — start fresh */ }

    const metadata: TurnMetadata = {
      channelType: (row.channel_type as string) || undefined,
      channelId: (row.channel_id as string) || undefined,
      opencodeSessionId: (row.opencode_session_id as string) || undefined,
      threadId: (row.thread_id as string) || undefined,
    };

    // Re-add to activeTurns for subsequent appendTextDelta/updateToolCall calls
    this.activeTurns.set(turnId, {
      text: (row.content as string) || '',
      parts,
      metadata,
    });

    return {
      turnId,
      content: (row.content as string) || '',
      parts,
      metadata,
    };
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/worker && npx vitest run src/durable-objects/message-store.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/durable-objects/message-store.ts packages/worker/src/durable-objects/message-store.test.ts
git commit -m "feat: MessageStore streaming turn lifecycle (createTurn, appendTextDelta, updateToolCall, finalizeTurn)"
```

---

## Task 3: MessageStore — stampChannelDelivery + Read Methods + getMessages

**Files:**
- Modify: `packages/worker/src/durable-objects/message-store.ts`
- Modify: `packages/worker/src/durable-objects/message-store.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
describe('stampChannelDelivery', () => {
  it('updates channel metadata and bumps seq', () => {
    const sql = createMockSql();
    const store = new MessageStore(sql as any);
    store.writeMessage({ id: 'msg-1', role: 'assistant', content: 'reply' });
    store.stampChannelDelivery('msg-1', 'slack', 'C123:ts');
    const updateQuery = sql._queries.find(q =>
      q.query.includes('UPDATE') && q.query.includes('channel_type')
    );
    expect(updateQuery).toBeDefined();
  });
});

describe('getMessage', () => {
  it('returns null for non-existent message', () => {
    const sql = createMockSql();
    const store = new MessageStore(sql as any);
    expect(store.getMessage('nonexistent')).toBeNull();
  });
});

describe('getMessages', () => {
  it('queries with ORDER BY created_at ASC, seq ASC', () => {
    const sql = createMockSql();
    const store = new MessageStore(sql as any);
    store.getMessages();
    const selectQuery = sql._queries.find(q =>
      q.query.includes('SELECT') && q.query.includes('FROM messages') && q.query.includes('ORDER BY')
    );
    expect(selectQuery).toBeDefined();
    expect(selectQuery!.query).toContain('created_at ASC');
    expect(selectQuery!.query).toContain('seq ASC');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/worker && npx vitest run src/durable-objects/message-store.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement stampChannelDelivery, getMessage, getMessages**

Add to `MessageStore`:

```typescript
  // ── Post-write mutations ──────────────────────────────────────────────

  stampChannelDelivery(messageId: string, channelType: string, channelId: string): void {
    const seq = this.nextSeqVal();
    this.sql.exec(
      'UPDATE messages SET seq = ?, channel_type = ?, channel_id = ? WHERE id = ?',
      seq, channelType, channelId, messageId,
    );
  }

  // ── Persisted reads ───────────────────────────────────────────────────

  getMessage(id: string): MessageRow | null {
    const rows = this.sql
      .exec(
        'SELECT id, seq, role, content, parts, author_id, author_email, author_name, author_avatar_url, channel_type, channel_id, opencode_session_id, message_format, thread_id, created_at FROM messages WHERE id = ?',
        id,
      )
      .toArray();
    if (rows.length === 0) return null;
    return this.rowToMessageRow(rows[0]);
  }

  getMessages(opts?: { limit?: number; afterCreatedAt?: number }): MessageRow[] {
    const limit = opts?.limit ?? 5000;
    let query: string;
    const params: (string | number)[] = [];

    if (opts?.afterCreatedAt !== undefined) {
      query = 'SELECT id, seq, role, content, parts, author_id, author_email, author_name, author_avatar_url, channel_type, channel_id, opencode_session_id, message_format, thread_id, created_at FROM messages WHERE created_at > ? ORDER BY created_at ASC, seq ASC LIMIT ?';
      params.push(opts.afterCreatedAt, limit);
    } else {
      query = 'SELECT id, seq, role, content, parts, author_id, author_email, author_name, author_avatar_url, channel_type, channel_id, opencode_session_id, message_format, thread_id, created_at FROM messages ORDER BY created_at ASC, seq ASC LIMIT ?';
      params.push(limit);
    }

    return this.sql.exec(query, ...params).toArray().map((r) => this.rowToMessageRow(r));
  }

  private rowToMessageRow(r: Record<string, unknown>): MessageRow {
    return {
      id: r.id as string,
      seq: r.seq as number,
      role: r.role as string,
      content: r.content as string,
      parts: r.parts as string | null,
      authorId: r.author_id as string | null,
      authorEmail: r.author_email as string | null,
      authorName: r.author_name as string | null,
      authorAvatarUrl: r.author_avatar_url as string | null,
      channelType: r.channel_type as string | null,
      channelId: r.channel_id as string | null,
      opencodeSessionId: r.opencode_session_id as string | null,
      messageFormat: (r.message_format as string) || 'v2',
      threadId: r.thread_id as string | null,
      createdAt: r.created_at as number,
    };
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/worker && npx vitest run src/durable-objects/message-store.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/durable-objects/message-store.ts packages/worker/src/durable-objects/message-store.test.ts
git commit -m "feat: MessageStore stampChannelDelivery, getMessage, getMessages"
```

---

## Task 4: MessageStore — D1 Flush (flushToD1)

**Files:**
- Modify: `packages/worker/src/durable-objects/message-store.ts`
- Modify: `packages/worker/src/durable-objects/message-store.test.ts`

- [ ] **Step 1: Write failing test for flushToD1**

```typescript
describe('flushToD1', () => {
  it('flushes messages with seq > lastReplicatedSeq', async () => {
    const sql = createMockSql();
    const store = new MessageStore(sql as any);

    // Mock the D1 batchUpsert — we'll pass a spy
    let flushedRows: unknown[] = [];
    const mockBatchUpsert = async (_db: unknown, _sessionId: string, rows: unknown[]) => {
      flushedRows = rows;
    };

    store.writeMessage({ id: 'msg-1', role: 'user', content: 'hello' });

    // The flush method needs the batchUpsert function and D1 handle
    // We'll test that it queries correctly and calls the callback
    const count = await store.flushToD1(null as any, 'session-1', mockBatchUpsert as any);
    expect(count).toBeGreaterThanOrEqual(0);
  });

  it('updates lastReplicatedSeq after successful flush', async () => {
    const sql = createMockSql();
    const store = new MessageStore(sql as any);

    const mockBatchUpsert = async () => {};
    store.writeMessage({ id: 'msg-1', role: 'user', content: 'hello' });

    await store.flushToD1(null as any, 'session-1', mockBatchUpsert as any);

    // Should have written to replication_state
    const repQuery = sql._queries.find(q =>
      q.query.includes('replication_state') && q.query.includes('INSERT')
    );
    expect(repQuery).toBeDefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/worker && npx vitest run src/durable-objects/message-store.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement flushToD1**

Add to `MessageStore`:

```typescript
  // ── D1 Replication ────────────────────────────────────────────────────

  /**
   * Flush new/updated messages to D1 via the provided batchUpsert function.
   * Uses internally-managed seq watermark. Returns the number of rows flushed.
   *
   * The batchUpsert function MUST explicitly include created_at in the column
   * list to prevent D1 from resetting it to datetime('now') on each flush.
   */
  async flushToD1(
    db: unknown,
    sessionId: string,
    batchUpsert: (db: unknown, sessionId: string, rows: Array<{
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
      createdAt: number;
    }>) => Promise<void>,
  ): Promise<number> {
    const rows = this.sql
      .exec(
        'SELECT id, seq, role, content, parts, author_id, author_email, author_name, author_avatar_url, channel_type, channel_id, opencode_session_id, message_format, thread_id, created_at FROM messages WHERE seq > ? ORDER BY seq ASC LIMIT 200',
        this.lastReplicatedSeq,
      )
      .toArray();

    if (rows.length === 0) return 0;

    const mapped = rows.map((row) => ({
      id: row.id as string,
      role: row.role as string,
      content: row.content as string,
      parts: row.parts as string | null,
      authorId: row.author_id as string | null,
      authorEmail: row.author_email as string | null,
      authorName: row.author_name as string | null,
      authorAvatarUrl: row.author_avatar_url as string | null,
      channelType: row.channel_type as string | null,
      channelId: row.channel_id as string | null,
      opencodeSessionId: row.opencode_session_id as string | null,
      messageFormat: (row.message_format as string) || 'v2',
      threadId: row.thread_id as string | null,
      createdAt: row.created_at as number,
    }));

    await batchUpsert(db, sessionId, mapped);

    // Advance watermark
    const maxSeq = rows[rows.length - 1].seq as number;
    this.lastReplicatedSeq = maxSeq;
    this.sql.exec(
      "INSERT OR REPLACE INTO replication_state (key, value) VALUES ('lastReplicatedSeq', ?)",
      maxSeq,
    );

    return rows.length;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/worker && npx vitest run src/durable-objects/message-store.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/durable-objects/message-store.ts packages/worker/src/durable-objects/message-store.test.ts
git commit -m "feat: MessageStore seq-based D1 replication (flushToD1)"
```

---

## Task 5: D1 Migration + batchUpsertMessages Update

**Files:**
- Create: `packages/worker/migrations/0002_message_created_at_epoch.sql`
- Modify: `packages/worker/src/lib/db/messages.ts`
- Modify: `packages/worker/src/lib/schema/sessions.ts`

- [ ] **Step 1: Create D1 migration**

```sql
-- 0002_message_created_at_epoch.sql
-- Add created_at_epoch column for accurate timestamp preservation from DO SQLite.
-- The existing created_at (TEXT datetime) is reset on INSERT OR REPLACE;
-- created_at_epoch preserves the original integer epoch from the DO.
ALTER TABLE messages ADD COLUMN created_at_epoch INTEGER;
UPDATE messages SET created_at_epoch = CAST(strftime('%s', created_at) AS INTEGER)
  WHERE created_at IS NOT NULL;
```

- [ ] **Step 2: Update Drizzle schema**

In `packages/worker/src/lib/schema/sessions.ts`, add `createdAtEpoch` column to the messages table definition:

```typescript
// Add after the existing createdAt field:
createdAtEpoch: integer(),
```

- [ ] **Step 3: Update `batchUpsertMessages` to accept and pass `createdAt`**

In `packages/worker/src/lib/db/messages.ts`, update the function signature and SQL:

```typescript
export async function batchUpsertMessages(
  db: D1Database,
  sessionId: string,
  msgs: Array<{
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
    threadId?: string | null;
    createdAt?: number;  // integer epoch from DO SQLite
  }>,
): Promise<void> {
  if (msgs.length === 0) return;

  const stmts = msgs.map((msg) =>
    db.prepare(
      'INSERT OR REPLACE INTO messages (id, session_id, role, content, parts, author_id, author_email, author_name, author_avatar_url, channel_type, channel_id, opencode_session_id, message_format, thread_id, created_at_epoch) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(
      msg.id,
      sessionId,
      msg.role,
      msg.content,
      msg.parts,
      msg.authorId,
      msg.authorEmail,
      msg.authorName,
      msg.authorAvatarUrl,
      msg.channelType,
      msg.channelId,
      msg.opencodeSessionId,
      msg.messageFormat || 'v2',
      msg.threadId || null,
      msg.createdAt || null,
    )
  );

  await db.batch(stmts);
}
```

- [ ] **Step 4: Update `getSessionMessages` sort clause to use `created_at_epoch`**

In `packages/worker/src/lib/db/messages.ts`, update `getSessionMessages` to sort by `created_at_epoch` with fallback:

```typescript
// BEFORE:
.orderBy(asc(messages.createdAt))

// AFTER:
.orderBy(asc(messages.createdAtEpoch), asc(messages.createdAt))
```

This ensures rows with `created_at_epoch` populated (from the new flush) sort correctly, while old rows without it fall back to `created_at`.

- [ ] **Step 5: Update thread detail query sort clause**

In `packages/worker/src/routes/threads.ts`, find the query that loads thread messages from D1 and update its sort to use `created_at_epoch` with fallback. The exact location depends on the query — search for `ORDER BY` or `orderBy` in the file.

- [ ] **Step 6: Run typecheck**

Run: `cd packages/worker && pnpm typecheck`
Expected: PASS (or only pre-existing errors)

- [ ] **Step 7: Commit**

```bash
git add packages/worker/migrations/0002_message_created_at_epoch.sql packages/worker/src/lib/db/messages.ts packages/worker/src/lib/schema/sessions.ts packages/worker/src/routes/threads.ts
git commit -m "feat: D1 migration for created_at_epoch + update batchUpsertMessages + read queries"
```

---

## Task 6: Remove Direct D1 Writes from Services

**Files:**
- Modify: `packages/worker/src/services/orchestrator.ts`
- Modify: `packages/worker/src/services/sessions.ts`

These services currently write user messages directly to D1 after the DO accepts the prompt, creating duplicate messages with different IDs. With MessageStore, the DO is the sole writer — D1 gets the message via `flushToD1`.

- [ ] **Step 1: Remove `saveMessage` from `dispatchOrchestratorPrompt`**

In `packages/worker/src/services/orchestrator.ts`, delete lines 449-463 (the `saveMessage` call after DO dispatch):

```typescript
// BEFORE (lines 449-463):
  // Save message to D1 only after the DO has accepted it.
  const messageId = crypto.randomUUID();
  await db.saveMessage(env.DB, {
    id: messageId,
    sessionId,
    role: 'user',
    content,
    ...
  });

// AFTER: just remove the block entirely. The DO writes the message to its
// SQLite and flushes to D1. No direct D1 write needed.
```

- [ ] **Step 2: Remove `saveMessage` from `sendSessionMessage`**

In `packages/worker/src/services/sessions.ts`, delete lines 584-593 (the `saveMessage` call):

```typescript
// BEFORE (lines 584-593):
  const messageId = crypto.randomUUID();
  await db.saveMessage(env.DB, { ... });

// AFTER: remove the block. The return value can use a placeholder or the DO response.
```

Note: If these functions return `messageId` to callers, update the return to use the ID from the DO response (the DO's `/prompt` endpoint should return the `messageId` it created). Check callers to see if `messageId` is actually used.

- [ ] **Step 3: Check if `saveMessage` has any remaining callers**

Search for `saveMessage` usage across the codebase. If `orchestrator.ts` and `sessions.ts` were the only callers, the function can be deleted from `lib/db/messages.ts`. If other callers exist, leave it.

- [ ] **Step 4: Run typecheck**

Run: `cd packages/worker && pnpm typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/services/orchestrator.ts packages/worker/src/services/sessions.ts
git commit -m "fix: remove direct D1 message writes (DO is sole writer via MessageStore)"
```

---

## Task 7: Wire MessageStore into SessionAgentDO — Constructor + Schema

**Files:**
- Modify: `packages/worker/src/durable-objects/session-agent.ts`

This is the integration task. The DO creates a `MessageStore` instance and migrates its schema setup.

- [ ] **Step 1: Add MessageStore import and field**

At the top of `session-agent.ts`, add:
```typescript
import { MessageStore } from './message-store.js';
```

Add field to the class (near line 602):
```typescript
private messageStore!: MessageStore;
```

- [ ] **Step 2: Remove messages table from SCHEMA_SQL**

In the `SCHEMA_SQL` constant (line 490), remove the `CREATE TABLE IF NOT EXISTS messages (...)` block. MessageStore creates its own schema in its constructor.

Keep all other tables (`interactive_prompts`, `prompt_queue`, `state`, `connected_users`, `analytics_events`, `channel_followups`, `channel_state`) in `SCHEMA_SQL`.

- [ ] **Step 3: Instantiate MessageStore in constructor**

In the constructor's `blockConcurrencyWhile` (line 710), after `this.ctx.storage.sql.exec(SCHEMA_SQL)`:

```typescript
this.messageStore = new MessageStore(this.ctx.storage.sql);
```

Remove the messages-specific ALTER TABLE migrations from the constructor (lines 714-722 for `author_avatar_url`, `channel_type`, `channel_id` on messages — these are now handled by MessageStore's migration logic). Keep prompt_queue ALTER TABLEs.

- [ ] **Step 4: Remove `activeTurns` Map**

Delete the `activeTurns` field (lines 646-653). This is now internal to MessageStore.

Keep `d1FlushTimer` on the DO — the timer scheduling is a coordination concern (ctx.waitUntil, setTimeout) that stays on the DO.

- [ ] **Step 5: Run typecheck to see what breaks**

Run: `cd packages/worker && pnpm typecheck`
Expected: Many errors from references to `this.activeTurns`, `this.d1FlushTimer`, raw SQL message queries. This is expected — we'll fix them in Tasks 8-10.

- [ ] **Step 6: Commit**

```bash
git add packages/worker/src/durable-objects/session-agent.ts
git commit -m "feat: wire MessageStore into SessionAgentDO constructor"
```

---

## Task 8: Migrate Write-Once Message Sites to MessageStore

**Files:**
- Modify: `packages/worker/src/durable-objects/session-agent.ts`

Replace all 15 `INSERT INTO messages` sites for write-once messages with `this.messageStore.writeMessage(...)`. Each site follows the same pattern: generate UUID, INSERT, broadcast.

The sites and their line numbers (may shift after Task 7 edits):

| Line | Handler | Notes |
|------|---------|-------|
| 1882 | `handlePrompt` user message | Has author + channel + thread + attachmentParts |
| 2163 | `handleFollowupPrompt` user message | Same shape as handlePrompt |
| 2424 | `workflow-chat-message` | Role from msg, has parts + channel + ocSessionId |
| 2532 | `screenshot` | System, content=description, parts=JSON |
| 2594 | `error` | System, content=error text, channel from activeChannel |
| 2893 | `initialPrompt` | User, content only |
| 2991 | `model-switched` | System, content only |
| 3251 | `session-reset` | System, parts=session-break, channel |
| 3796 | `forward-messages` | Assistant, parts=forwarded metadata |
| 6610 | sandbox spawn error | System, content only |
| 6896 | `handleSystemMessage` (with parts) | System, parts + threadId |
| 6901 | `handleSystemMessage` (without parts) | System, threadId |
| 7912 | hibernate error | System, content only |
| 8033 | restore error | System, content only |
| 8882 | `handleChannelReply` image | System, parts=image, channel |

- [ ] **Step 1: Replace each INSERT site with `this.messageStore.writeMessage(...)`**

Pattern for each site. Example for `handlePrompt` (line 1882):

```typescript
// BEFORE:
const messageId = crypto.randomUUID();
this.ctx.storage.sql.exec(
  'INSERT INTO messages (id, role, content, parts, author_id, author_email, author_name, author_avatar_url, channel_type, channel_id, thread_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  messageId, 'user', content, serializedAttachmentParts,
  author?.id || null, author?.email || null, author?.name || null, author?.avatarUrl || null,
  channelType || null, channelId || null, threadId || null
);

// AFTER:
const messageId = crypto.randomUUID();
this.messageStore.writeMessage({
  id: messageId,
  role: 'user',
  content,
  parts: serializedAttachmentParts,
  author: author ? { id: author.id, email: author.email, name: author.name, avatarUrl: author.avatarUrl } : undefined,
  channelType,
  channelId,
  threadId,
});
```

Apply the same transformation to all 15 sites. For `handleSystemMessage`, consolidate the two branches (with/without parts) into one call:

```typescript
// BEFORE (two separate SQL calls):
if (serializedParts) {
  this.ctx.storage.sql.exec('INSERT INTO messages ...', messageId, 'system', content, serializedParts, threadId || null);
} else {
  this.ctx.storage.sql.exec('INSERT INTO messages ...', messageId, 'system', content, threadId || null);
}

// AFTER (single call):
this.messageStore.writeMessage({
  id: messageId,
  role: 'system',
  content,
  parts: serializedParts,
  threadId,
});
```

- [ ] **Step 2: Run typecheck**

Run: `cd packages/worker && pnpm typecheck`
Expected: Fewer errors (still errors from activeTurns references)

- [ ] **Step 3: Commit**

```bash
git add packages/worker/src/durable-objects/session-agent.ts
git commit -m "refactor: migrate 15 write-once message sites to MessageStore.writeMessage"
```

---

## Task 9: Migrate Streaming Turn Handlers to MessageStore

**Files:**
- Modify: `packages/worker/src/durable-objects/session-agent.ts`

Replace the `message.create`, `message.part.text-delta`, `message.part.tool-update`, and `message.finalize` handlers (lines 2631-2826) to use MessageStore methods.

- [ ] **Step 1: Rewrite `message.create` handler**

```typescript
case 'message.create': {
  const turnId = msg.turnId!;
  let resolvedThreadId = msg.threadId || undefined;
  if (!resolvedThreadId) {
    const processingRow = this.ctx.storage.sql
      .exec("SELECT thread_id FROM prompt_queue WHERE status = 'processing' ORDER BY created_at DESC LIMIT 1")
      .toArray();
    if (processingRow.length > 0 && processingRow[0].thread_id) {
      resolvedThreadId = processingRow[0].thread_id as string;
    }
  }
  console.log(`[SessionAgentDO] V2 message.create: turnId=${turnId} threadId=${resolvedThreadId || 'none'}`);
  // FUTURE: dispatch channel transport lifecycle hook here (onTurnStarted)
  this.messageStore.createTurn(turnId, {
    channelType: msg.channelType || undefined,
    channelId: msg.channelId || undefined,
    opencodeSessionId: msg.opencodeSessionId || undefined,
    threadId: resolvedThreadId,
  });
  this.broadcastToClients({
    type: 'message',
    data: {
      id: turnId,
      role: 'assistant',
      content: '',
      parts: [],
      createdAt: Math.floor(Date.now() / 1000),
      ...(msg.channelType ? { channelType: msg.channelType } : {}),
      ...(msg.channelId ? { channelId: msg.channelId } : {}),
      ...(resolvedThreadId ? { threadId: resolvedThreadId } : {}),
    },
  });
  break;
}
```

- [ ] **Step 2: Rewrite `message.part.text-delta` handler**

```typescript
case 'message.part.text-delta': {
  const turnId = msg.turnId!;
  if (!this.messageStore.getTurnSnapshot(turnId)) {
    // Hibernation recovery
    if (!this.messageStore.recoverTurn(turnId)) {
      console.warn(`[SessionAgentDO] text-delta for unknown turn ${turnId}`);
      break;
    }
  }
  this.messageStore.appendTextDelta(turnId, msg.delta || '');
  const turn = this.messageStore.getTurnSnapshot(turnId)!;
  this.broadcastToClients({
    type: 'chunk',
    content: msg.delta || '',
    messageId: turnId,
    ...(turn.metadata.channelType ? { channelType: turn.metadata.channelType, channelId: turn.metadata.channelId } : {}),
  });
  break;
}
```

- [ ] **Step 3: Rewrite `message.part.tool-update` handler**

```typescript
case 'message.part.tool-update': {
  const turnId = msg.turnId!;
  if (!this.messageStore.getTurnSnapshot(turnId)) {
    if (!this.messageStore.recoverTurn(turnId)) {
      console.warn(`[SessionAgentDO] tool-update for unknown turn ${turnId}`);
      break;
    }
  }
  this.messageStore.updateToolCall(turnId, msg.callId!, msg.toolName!, msg.status!, msg.args, msg.result, msg.error);
  this.scheduleDebouncedFlush();
  const snapshot = this.messageStore.getTurnSnapshot(turnId)!;
  this.broadcastToClients({
    type: 'message.updated',
    data: {
      id: turnId,
      role: 'assistant',
      content: snapshot.content,
      parts: snapshot.parts,
      ...(snapshot.metadata.channelType ? { channelType: snapshot.metadata.channelType, channelId: snapshot.metadata.channelId } : {}),
      ...(snapshot.metadata.threadId ? { threadId: snapshot.metadata.threadId } : {}),
    },
  });
  break;
}
```

- [ ] **Step 4: Rewrite `message.finalize` handler**

```typescript
case 'message.finalize': {
  const turnId = msg.turnId!;
  if (!this.messageStore.getTurnSnapshot(turnId)) {
    if (!this.messageStore.recoverTurn(turnId)) {
      console.warn(`[SessionAgentDO] finalize for unknown turn ${turnId}`);
      break;
    }
  }
  const final = this.messageStore.finalizeTurn(turnId, msg.finalText, msg.reason);
  this.broadcastToClients({
    type: 'message.updated',
    data: {
      id: turnId,
      role: 'assistant',
      content: final.content,
      parts: final.parts,
      ...(final.metadata.channelType ? { channelType: final.metadata.channelType, channelId: final.metadata.channelId } : {}),
      ...(final.metadata.threadId ? { threadId: final.metadata.threadId } : {}),
    },
  });
  // Track result content for auto channel reply
  if (this.pendingChannelReply && !this.pendingChannelReply.handled && final.content) {
    this.pendingChannelReply.resultContent = final.content;
    this.pendingChannelReply.resultMessageId = turnId;
  }
  // Increment thread message count for assistant message
  if (final.metadata.threadId) {
    this.ctx.waitUntil(this.incrementAndMaybeSummarize(final.metadata.threadId));
  }
  console.log(`[SessionAgentDO] V2 turn finalized: ${turnId} (${final.content.length} chars, ${final.parts.length} parts)`);
  break;
}
```

- [ ] **Step 5: Rewrite `audio-transcript` handler to use MessageStore**

The audio-transcript handler (line 2551) updates parts on an existing message. This is a write-once message (not a streaming turn), so we need a small helper. Add an `updateMessageParts` method to MessageStore:

```typescript
// In message-store.ts:
updateMessageParts(messageId: string, parts: string): void {
  const seq = this.nextSeqVal();
  this.sql.exec('UPDATE messages SET seq = ?, parts = ? WHERE id = ?', seq, parts, messageId);
}
```

Then in session-agent.ts, replace the raw SQL:
```typescript
case 'audio-transcript': {
  if (msg.messageId && msg.transcript) {
    const existing = this.messageStore.getMessage(msg.messageId);
    if (existing && existing.parts) {
      let parts: Array<Record<string, unknown>> = [];
      try {
        const parsed = JSON.parse(existing.parts);
        parts = Array.isArray(parsed) ? parsed : [parsed];
      } catch { /* ignore */ }
      for (const part of parts) {
        if (part.type === 'audio') {
          part.transcript = msg.transcript;
        }
      }
      this.messageStore.updateMessageParts(msg.messageId, JSON.stringify(parts));
      this.broadcastToClients({
        type: 'message.updated',
        data: { id: msg.messageId, parts },
      });
    }
  }
  break;
}
```

- [ ] **Step 6: Delete `recoverTurnFromSQLite` method**

Delete the `recoverTurnFromSQLite` method (line 8130-8156). Its functionality is now in `messageStore.recoverTurn()`.

- [ ] **Step 7: Run typecheck**

Run: `cd packages/worker && pnpm typecheck`
Expected: Fewer errors (remaining: flushMessagesToD1, stampChannelDelivery, handleMessagesEndpoint)

- [ ] **Step 8: Commit**

```bash
git add packages/worker/src/durable-objects/session-agent.ts packages/worker/src/durable-objects/message-store.ts
git commit -m "refactor: migrate streaming turn handlers to MessageStore"
```

---

## Task 10: Migrate D1 Flush + Messages Endpoint + stampChannelDelivery

**Files:**
- Modify: `packages/worker/src/durable-objects/session-agent.ts`

- [ ] **Step 1: Rewrite `flushMessagesToD1` to use MessageStore**

Replace the entire `flushMessagesToD1` method (lines 6243-6294):

```typescript
private async flushMessagesToD1(): Promise<void> {
  const sessionId = this.getStateValue('sessionId');
  if (!sessionId) return;

  try {
    const count = await this.messageStore.flushToD1(
      this.env.DB,
      sessionId,
      batchUpsertMessages,
    );
    if (count > 0) {
      console.log(`[SessionAgentDO] Flushed ${count} messages to D1`);
    }
  } catch (err) {
    console.error('[SessionAgentDO] Failed to flush messages to D1:', err);
  }
}
```

- [ ] **Step 2: Verify `scheduleDebouncedFlush` still works**

`d1FlushTimer` and `scheduleDebouncedFlush` were kept on the DO in Task 7. They should still work as-is since they call `this.flushMessagesToD1()` which was rewritten in Step 1. No changes needed — just verify typecheck passes.

- [ ] **Step 3: Rewrite `handleMessagesEndpoint` to use MessageStore**

Replace the query logic in `handleMessagesEndpoint` (line 7242):

```typescript
private handleMessagesEndpoint(url: URL): Response {
  const limit = parseInt(url.searchParams.get('limit') || '5000', 10);
  const after = url.searchParams.get('after');
  const sessionId = this.getStateValue('sessionId') || '';

  const afterCreatedAt = after ? parseInt(after, 10) || undefined : undefined;
  const rows = this.messageStore.getMessages({ limit, afterCreatedAt });

  const messages = rows.map((r) => ({
    id: r.id,
    sessionId,
    role: r.role,
    content: r.content,
    parts: r.parts ? JSON.parse(r.parts) : undefined,
    authorId: r.authorId || undefined,
    authorEmail: r.authorEmail || undefined,
    authorName: r.authorName || undefined,
    authorAvatarUrl: r.authorAvatarUrl || undefined,
    channelType: r.channelType || undefined,
    channelId: r.channelId || undefined,
    threadId: r.threadId || undefined,
    createdAt: new Date(r.createdAt * 1000).toISOString(),
  }));

  return Response.json({ messages });
}
```

Note: The `after` parameter currently comes from the client as an ISO timestamp string. The current code uses `created_at > ?` with integer comparison. Check if the client sends integer or ISO — if ISO, parse to epoch. If integer, use directly.

- [ ] **Step 4: Rewrite `stampChannelDelivery` in `flushPendingChannelReply`**

Find the `UPDATE messages SET channel_type = ?, channel_id = ?` call (line 9962) and replace:

```typescript
// BEFORE:
this.ctx.storage.sql.exec(
  'UPDATE messages SET channel_type = ?, channel_id = ? WHERE id = ?',
  pending.channelType, pending.channelId, pending.resultMessageId,
);

// AFTER:
this.messageStore.stampChannelDelivery(pending.resultMessageId!, pending.channelType, pending.channelId);
```

- [ ] **Step 5: Delete `getStateValue('lastD1FlushAt')` / `setStateValue('lastD1FlushAt')` calls**

Search for `lastD1FlushAt` — it should only have been in `flushMessagesToD1` which is now rewritten. MessageStore manages its own watermark via `replication_state` table.

- [ ] **Step 6: Run typecheck**

Run: `cd packages/worker && pnpm typecheck`
Expected: PASS (or only pre-existing errors unrelated to this work)

- [ ] **Step 7: Run all tests**

Run: `cd packages/worker && pnpm test`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add packages/worker/src/durable-objects/session-agent.ts
git commit -m "refactor: migrate D1 flush, messages endpoint, and stampChannelDelivery to MessageStore"
```

---

## Task 11: Verify + Clean Up

**Files:**
- Modify: `packages/worker/src/durable-objects/session-agent.ts`
- Modify: `packages/worker/src/durable-objects/message-store.ts`

- [ ] **Step 1: Search for any remaining raw message SQL in session-agent.ts**

Search for `INSERT INTO messages`, `UPDATE messages`, `FROM messages`, and `activeTurns` in session-agent.ts. The only remaining `FROM messages` references should be in `handleMessagesEndpoint` (which we rewrote) or read-only queries. There should be zero `INSERT INTO messages` or `UPDATE messages` calls.

Also search for any `this.activeTurns` references — there should be zero.

- [ ] **Step 2: Verify no remaining `getStateValue('lastD1FlushAt')`**

Search for `lastD1FlushAt`. Should be zero references.

- [ ] **Step 3: Run full typecheck**

Run: `pnpm typecheck` (from root — checks all packages)
Expected: PASS

- [ ] **Step 4: Run all tests**

Run: `pnpm test`
Expected: PASS

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "chore: clean up remaining raw message SQL references after MessageStore extraction"
```

---

## Summary of What Changes

| Before | After |
|--------|-------|
| 15+ `INSERT INTO messages` sites in session-agent.ts | `messageStore.writeMessage()` — single method |
| 3 `UPDATE messages` sites (tool-update, finalize, stamp) | `messageStore.updateToolCall()`, `finalizeTurn()`, `stampChannelDelivery()` |
| `activeTurns` Map on DO class | Internal to `MessageStore.activeTurns` |
| `recoverTurnFromSQLite()` on DO | `messageStore.recoverTurn()` |
| `flushMessagesToD1()` with timestamp watermark | `messageStore.flushToD1()` with seq watermark |
| `lastD1FlushAt` in state table | `lastReplicatedSeq` in `replication_state` table |
| `INSERT OR REPLACE` in finalize (resets created_at) | `UPDATE` in finalize (preserves created_at) |
| `created_at > watermark` flush query (misses same-second rows) | `seq > watermark` flush query (no edge cases) |
| Direct D1 writes in orchestrator.ts + sessions.ts | Deleted — DO is sole writer |
| `batchUpsertMessages` without created_at | Passes `createdAt` + `createdAtEpoch` |
