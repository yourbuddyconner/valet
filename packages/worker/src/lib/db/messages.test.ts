import { beforeEach, describe, expect, it } from 'vitest';
import type BetterSqlite3 from 'better-sqlite3';
import { createTestDb } from '../../test-utils/db.js';
import { batchUpsertMessages, getSessionMessages, getThreadMessages } from './messages.js';

const SESSION_ID = 'session-msgs-test';
const USER_ID = 'user-msgs-test';
const THREAD_ID = 'thread-msgs-test';

// ─── Minimal D1Database adapter over better-sqlite3 ─────────────────────────
//
// batchUpsertMessages uses three D1Database methods: prepare(), bind(), batch(),
// and run(). This adapter wraps better-sqlite3 so FK constraints fire exactly as
// they do in D1, and translates the error message to match the D1 format that
// the production code string-matches on ("FOREIGN KEY").
function createD1Mock(sqlite: BetterSqlite3.Database) {
  return {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          const execute = () => { sqlite.prepare(sql).run(...args); };
          return { execute, run: execute };
        },
      };
    },
    batch(stmts: Array<{ execute(): void }>) {
      const runAll = sqlite.transaction(() => {
        for (const s of stmts) s.execute();
      });
      try {
        runAll();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.toLowerCase().includes('foreign key')) {
          throw new Error(`D1_ERROR: FOREIGN KEY constraint failed: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_FOREIGNKEY)`);
        }
        throw err;
      }
    },
  };
}

function makeMsg(id: string, overrides: Partial<Parameters<typeof batchUpsertMessages>[2][number]> = {}) {
  return {
    id,
    role: 'assistant' as const,
    content: 'hello',
    parts: null,
    authorId: USER_ID,
    authorEmail: null,
    authorName: null,
    authorAvatarUrl: null,
    channelType: null,
    channelId: null,
    opencodeSessionId: null,
    messageFormat: 'v2',
    threadId: THREAD_ID,
    ...overrides,
  };
}

describe('batchUpsertMessages', () => {
  let sqlite: BetterSqlite3.Database;

  beforeEach(() => {
    ({ sqlite } = createTestDb());
    sqlite.prepare('INSERT INTO users (id, email) VALUES (?, ?)').run(USER_ID, 'test@example.com');
    sqlite.prepare('INSERT INTO sessions (id, user_id, workspace, status) VALUES (?, ?, ?, ?)').run(SESSION_ID, USER_ID, '/tmp/test', 'running');
    sqlite.prepare('INSERT INTO session_threads (id, session_id) VALUES (?, ?)').run(THREAD_ID, SESSION_ID);
  });

  it('inserts all messages when all FK references are valid', async () => {
    const d1 = createD1Mock(sqlite);
    await batchUpsertMessages(d1 as any, SESSION_ID, [makeMsg('msg-1'), makeMsg('msg-2')]);
    const ids = sqlite.prepare('SELECT id FROM messages WHERE session_id = ?')
      .all(SESSION_ID).map((r: any) => r.id);
    expect(ids).toEqual(expect.arrayContaining(['msg-1', 'msg-2']));
  });

  it('stores D1 created_at from the DO message timestamp when available', async () => {
    const d1 = createD1Mock(sqlite);
    const createdAt = Date.parse('2026-05-13T16:30:53Z') / 1000;

    await batchUpsertMessages(d1 as any, SESSION_ID, [makeMsg('msg-event-time', { createdAt })]);

    const row = sqlite.prepare('SELECT created_at, created_at_epoch FROM messages WHERE id = ?')
      .get('msg-event-time') as { created_at: string; created_at_epoch: number };
    expect(row).toEqual({
      created_at: '2026-05-13 16:30:53',
      created_at_epoch: createdAt,
    });
  });

  it('falls back to individual inserts on batch FK failure, skipping only the bad row', async () => {
    const d1 = createD1Mock(sqlite);
    const msgs = [
      makeMsg('msg-valid'),
      makeMsg('msg-bad-thread', { threadId: 'does-not-exist' }),
    ];
    // Should not throw even though one message has an invalid thread_id
    await expect(batchUpsertMessages(d1 as any, SESSION_ID, msgs)).resolves.toBeUndefined();

    const ids = sqlite.prepare('SELECT id FROM messages WHERE session_id = ?')
      .all(SESSION_ID).map((r: any) => r.id);
    expect(ids).toContain('msg-valid');
    expect(ids).not.toContain('msg-bad-thread');
  });

  it('re-throws non-FK errors from the batch without falling back', async () => {
    const d1 = {
      ...createD1Mock(sqlite),
      batch() { throw new Error('UNIQUE constraint failed: messages.id'); },
    };
    await expect(batchUpsertMessages(d1 as any, SESSION_ID, [makeMsg('msg-1')])).rejects.toThrow('UNIQUE constraint');
  });

  it('re-throws non-FK errors from individual inserts during fallback', async () => {
    // Simulate: batch throws FK (triggers fallback), then individual insert hits a non-FK error
    let callCount = 0;
    const d1 = {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return {
              execute() { callCount++; },
              run() {
                callCount++;
                throw new Error('disk I/O error');
              },
            };
          },
        };
      },
      batch() { throw new Error('D1_ERROR: FOREIGN KEY constraint failed: SQLITE_CONSTRAINT'); },
    };
    await expect(batchUpsertMessages(d1 as any, SESSION_ID, [makeMsg('msg-1')])).rejects.toThrow('disk I/O error');
  });
});

describe('message readers', () => {
  let sqlite: BetterSqlite3.Database;
  let db: ReturnType<typeof createTestDb>['db'];

  beforeEach(() => {
    ({ db, sqlite } = createTestDb());
    sqlite.prepare('INSERT INTO users (id, email) VALUES (?, ?)').run(USER_ID, 'test@example.com');
    sqlite.prepare('INSERT INTO sessions (id, user_id, workspace, status) VALUES (?, ?, ?, ?)').run(SESSION_ID, USER_ID, '/tmp/test', 'running');
    sqlite.prepare('INSERT INTO session_threads (id, session_id) VALUES (?, ?)').run(THREAD_ID, SESSION_ID);
  });

  it('returns message createdAt from created_at_epoch instead of D1 insertion time', async () => {
    const eventEpoch = Date.parse('2026-05-13T16:30:53Z') / 1000;
    sqlite.prepare(`
      INSERT INTO messages
        (id, session_id, role, content, message_format, thread_id, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'msg-backfilled',
      SESSION_ID,
      'user',
      'old local message',
      'v2',
      THREAD_ID,
      '2026-06-02 15:45:52',
      eventEpoch,
    );

    const sessionMessages = await getSessionMessages(db, SESSION_ID);
    const threadMessages = await getThreadMessages(db, THREAD_ID);

    expect(sessionMessages[0]?.createdAt.toISOString()).toBe('2026-05-13T16:30:53.000Z');
    expect(threadMessages[0]?.createdAt.toISOString()).toBe('2026-05-13T16:30:53.000Z');
  });

  it('filters after cursors using actual message time, not D1 insertion time', async () => {
    sqlite.prepare(`
      INSERT INTO messages
        (id, session_id, role, content, message_format, thread_id, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'msg-historical-backfill',
      SESSION_ID,
      'user',
      'historical backfill',
      'v2',
      THREAD_ID,
      '2026-06-02 15:45:52',
      Date.parse('2026-05-13T16:30:53Z') / 1000,
    );
    sqlite.prepare(`
      INSERT INTO messages
        (id, session_id, role, content, message_format, thread_id, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'msg-current',
      SESSION_ID,
      'user',
      'current message',
      'v2',
      THREAD_ID,
      '2026-06-02 15:45:52',
      Date.parse('2026-06-02T15:45:52Z') / 1000,
    );

    const messages = await getSessionMessages(db, SESSION_ID, {
      after: '2026-06-02T15:00:00.000Z',
    });

    expect(messages.map((m) => m.id)).toEqual(['msg-current']);
  });

  it('orders mixed legacy and epoch messages by actual message time', async () => {
    sqlite.prepare(`
      INSERT INTO messages
        (id, session_id, role, content, message_format, thread_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      'msg-legacy-later',
      SESSION_ID,
      'user',
      'legacy later message',
      'v1',
      THREAD_ID,
      '2026-06-02 15:46:00',
    );
    sqlite.prepare(`
      INSERT INTO messages
        (id, session_id, role, content, message_format, thread_id, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'msg-epoch-earlier',
      SESSION_ID,
      'user',
      'epoch earlier message',
      'v2',
      THREAD_ID,
      '2026-06-02 15:50:00',
      Date.parse('2026-06-02T15:45:00Z') / 1000,
    );

    const sessionMessages = await getSessionMessages(db, SESSION_ID);
    const threadMessages = await getThreadMessages(db, THREAD_ID);

    expect(sessionMessages.map((m) => m.id)).toEqual(['msg-epoch-earlier', 'msg-legacy-later']);
    expect(threadMessages.map((m) => m.id)).toEqual(['msg-epoch-earlier', 'msg-legacy-later']);
  });

  it('filters thread after cursors using actual message time', async () => {
    sqlite.prepare(`
      INSERT INTO messages
        (id, session_id, role, content, message_format, thread_id, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'msg-thread-historical-backfill',
      SESSION_ID,
      'user',
      'historical thread backfill',
      'v2',
      THREAD_ID,
      '2026-06-02 15:45:52',
      Date.parse('2026-05-13T16:30:53Z') / 1000,
    );
    sqlite.prepare(`
      INSERT INTO messages
        (id, session_id, role, content, message_format, thread_id, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'msg-thread-current',
      SESSION_ID,
      'user',
      'current thread message',
      'v2',
      THREAD_ID,
      '2026-06-02 15:45:52',
      Date.parse('2026-06-02T15:45:52Z') / 1000,
    );

    const messages = await getThreadMessages(db, THREAD_ID, {
      after: '2026-06-02T15:00:00.000Z',
    });

    expect(messages.map((m) => m.id)).toEqual(['msg-thread-current']);
  });
});
