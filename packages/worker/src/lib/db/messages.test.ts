import { beforeEach, describe, expect, it } from 'vitest';
import type BetterSqlite3 from 'better-sqlite3';
import { createTestDb } from '../../test-utils/db.js';
import { batchUpsertMessages } from './messages.js';

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
