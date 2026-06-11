import { beforeEach, describe, expect, it } from 'vitest';
import Database, { type Database as DatabaseType } from 'better-sqlite3';
import type { D1Database } from '@cloudflare/workers-types';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getChannelThreadMapping, getOrCreateChannelThread, registerChannelThread } from './channel-threads.js';
import { createThread, getThread } from './threads.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Wraps a better-sqlite3 instance in the D1Database interface.
 * better-sqlite3 is synchronous; we wrap calls in Promise.resolve().
 */
function makeD1(sqlite: DatabaseType): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              return (sqlite.prepare(sql).get(...(args as Parameters<typeof sqlite.prepare>)) as T | undefined) ?? null;
            },
            async run() {
              sqlite.prepare(sql).run(...(args as Parameters<typeof sqlite.prepare>));
              return { success: true, meta: { duration: 0, last_row_id: 0, changes: 0, changed_db: false, size_after: 0, rows_read: 0, rows_written: 0 } };
            },
            async all<T>() {
              return { results: sqlite.prepare(sql).all(...(args as Parameters<typeof sqlite.prepare>)) as T[], success: true, meta: {} as never };
            },
          };
        },
        async first<T>() {
          return (sqlite.prepare(sql).get() as T | undefined) ?? null;
        },
        async run() {
          sqlite.prepare(sql).run();
          return { success: true, meta: { duration: 0, last_row_id: 0, changes: 0, changed_db: false, size_after: 0, rows_read: 0, rows_written: 0 } };
        },
        async all<T>() {
          return { results: sqlite.prepare(sql).all() as T[], success: true, meta: {} as never };
        },
      };
    },
    async batch() { return []; },
    async exec() { return { count: 0, duration: 0 }; },
    async dump() { return new ArrayBuffer(0); },
  } as unknown as D1Database;
}

function createD1Db(): D1Database {
  const sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  // Foreign keys disabled so test data can be inserted without satisfying the full
  // sessions → session_threads → channel_thread_mappings FK chain.
  sqlite.pragma('foreign_keys = OFF');

  const migrationsDir = path.resolve(__dirname, '../../../migrations');
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    sqlite.exec(fs.readFileSync(path.join(migrationsDir, file), 'utf-8'));
  }

  return makeD1(sqlite);
}

describe('registerChannelThread + getOrCreateChannelThread', () => {
  let d1: D1Database;

  beforeEach(() => {
    d1 = createD1Db();
  });

  it('getOrCreate returns the pre-registered thread ID instead of creating a new one', async () => {
    await registerChannelThread(d1, {
      channelType: 'slack',
      channelId: 'D_DM_CHANNEL',
      externalThreadId: '1700000000.000001', // bot's message ts
      userId: 'user-1',
      sessionId: 'orchestrator:user-1',
      threadId: 'existing-web-thread-uuid',
    });

    const threadId = await getOrCreateChannelThread(d1, {
      channelType: 'slack',
      channelId: 'D_DM_CHANNEL',
      externalThreadId: '1700000000.000001',
      sessionId: 'orchestrator:user-1',
      userId: 'user-1',
    });

    expect(threadId).toBe('existing-web-thread-uuid');
  });

  it('getOrCreate returns a new UUID when no pre-registration exists', async () => {
    const threadId = await getOrCreateChannelThread(d1, {
      channelType: 'slack',
      channelId: 'D_DM_CHANNEL',
      externalThreadId: '1700000000.000001',
      sessionId: 'orchestrator:user-1',
      userId: 'user-1',
    });

    expect(threadId).toBeDefined();
    expect(typeof threadId).toBe('string');
    expect(threadId).not.toBe('existing-web-thread-uuid');
  });

  it('creates new Slack channel threads with Slack origin metadata', async () => {
    const threadId = await getOrCreateChannelThread(d1, {
      channelType: 'slack',
      channelId: 'D_DM_CHANNEL',
      externalThreadId: '1700000000.000001',
      sessionId: 'orchestrator:user-1',
      userId: 'user-1',
    });

    const thread = await getThread(d1, threadId);
    expect(thread).toMatchObject({
      originType: 'slack',
      originChannelType: 'slack',
      originChannelId: 'D_DM_CHANNEL',
    });
  });

  it('does not relabel an existing web-origin thread when registering a Slack reply mapping', async () => {
    await createThread(d1, {
      id: 'existing-web-thread',
      sessionId: 'orchestrator:user-1',
      originType: 'web',
    });

    await registerChannelThread(d1, {
      channelType: 'slack',
      channelId: 'D_DM_CHANNEL',
      externalThreadId: '1700000000.000001',
      userId: 'user-1',
      sessionId: 'orchestrator:user-1',
      threadId: 'existing-web-thread',
    });

    const threadId = await getOrCreateChannelThread(d1, {
      channelType: 'slack',
      channelId: 'D_DM_CHANNEL',
      externalThreadId: '1700000000.000001',
      sessionId: 'orchestrator:user-1',
      userId: 'user-1',
    });
    const thread = await getThread(d1, threadId);

    expect(thread?.id).toBe('existing-web-thread');
    expect(thread?.originType).toBe('web');
  });

  it('registerChannelThread overwrites a stale mapping with the new thread ID', async () => {
    await registerChannelThread(d1, {
      channelType: 'slack',
      channelId: 'D_DM_CHANNEL',
      externalThreadId: '1700000000.000001',
      userId: 'user-1',
      sessionId: 'orchestrator:user-1',
      threadId: 'stale-thread-uuid',
    });

    await registerChannelThread(d1, {
      channelType: 'slack',
      channelId: 'D_DM_CHANNEL',
      externalThreadId: '1700000000.000001',
      userId: 'user-1',
      sessionId: 'orchestrator:user-1',
      threadId: 'fresh-thread-uuid',
    });

    const mapping = await getChannelThreadMapping(d1, 'slack', 'D_DM_CHANNEL', '1700000000.000001', 'user-1');
    expect(mapping?.threadId).toBe('fresh-thread-uuid');
  });

  it('mappings are scoped by userId — different users do not share thread mappings', async () => {
    await registerChannelThread(d1, {
      channelType: 'slack',
      channelId: 'D_DM_CHANNEL',
      externalThreadId: '1700000000.000001',
      userId: 'user-1',
      sessionId: 'orchestrator:user-1',
      threadId: 'user-1-thread',
    });

    // user-2 has no mapping yet — should get a new thread, not user-1's
    const threadId = await getOrCreateChannelThread(d1, {
      channelType: 'slack',
      channelId: 'D_DM_CHANNEL',
      externalThreadId: '1700000000.000001',
      sessionId: 'orchestrator:user-2',
      userId: 'user-2',
    });

    expect(threadId).not.toBe('user-1-thread');
  });
});
