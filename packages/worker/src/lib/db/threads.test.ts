import { beforeEach, describe, expect, it } from 'vitest';
import Database, { type Database as DatabaseType } from 'better-sqlite3';
import type {
  D1Database,
  D1DatabaseSession,
  D1ExecResult,
  D1PreparedStatement,
  D1Result,
  D1SessionBookmark,
  D1SessionConstraint,
} from '@cloudflare/workers-types';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerChannelThread } from './channel-threads.js';
import { createThread, getThread, listThreads } from './threads.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function d1Result<T>(results: T[]): D1Result<T> {
  return {
    results,
    success: true,
    meta: {
      duration: 0,
      last_row_id: 0,
      changes: 0,
      changed_db: false,
      size_after: 0,
      rows_read: 0,
      rows_written: 0,
    },
  };
}

class SqliteD1PreparedStatement implements D1PreparedStatement {
  constructor(
    private readonly sqlite: DatabaseType,
    private readonly sql: string,
    private readonly values: unknown[] = [],
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    return new SqliteD1PreparedStatement(this.sqlite, this.sql, values);
  }

  async first<T = unknown>(colName: string): Promise<T | null>;
  async first<T = Record<string, unknown>>(): Promise<T | null>;
  async first<T = Record<string, unknown>>(colName?: string): Promise<T | null> {
    const row = this.sqlite.prepare<unknown[], Record<string, unknown>>(this.sql).get(...this.values);
    if (!row) return null;
    if (colName !== undefined) {
      return (row[colName] as T | undefined) ?? null;
    }
    return row as T;
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    this.sqlite.prepare(this.sql).run(...this.values);
    return d1Result<T>([]);
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const results = this.sqlite.prepare<unknown[], T>(this.sql).all(...this.values);
    return d1Result(results);
  }

  async raw<T = unknown[]>(options: { columnNames: true }): Promise<[string[], ...T[]]>;
  async raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
  async raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[] | [string[], ...T[]]> {
    const statement = this.sqlite.prepare<unknown[], T>(this.sql).raw(true);
    const rows = statement.all(...this.values);
    if (options?.columnNames) {
      const columnNames = statement.columns().map((column) => column.name);
      return [columnNames, ...rows];
    }
    return rows;
  }
}

class SqliteD1DatabaseSession implements D1DatabaseSession {
  constructor(private readonly sqlite: DatabaseType) {}

  prepare(query: string): D1PreparedStatement {
    return new SqliteD1PreparedStatement(this.sqlite, query);
  }

  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    return Promise.all(statements.map((statement) => statement.run<T>()));
  }

  getBookmark(): D1SessionBookmark | null {
    return null;
  }
}

class SqliteD1Database implements D1Database {
  constructor(private readonly sqlite: DatabaseType) {}

  prepare(query: string): D1PreparedStatement {
    return new SqliteD1PreparedStatement(this.sqlite, query);
  }

  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    return Promise.all(statements.map((statement) => statement.run<T>()));
  }

  async exec(query: string): Promise<D1ExecResult> {
    this.sqlite.exec(query);
    return { count: 0, duration: 0 };
  }

  withSession(_constraintOrBookmark?: D1SessionBookmark | D1SessionConstraint): D1DatabaseSession {
    return new SqliteD1DatabaseSession(this.sqlite);
  }

  async dump(): Promise<ArrayBuffer> {
    return new ArrayBuffer(0);
  }
}

function createD1Db(options: { skipMigrations?: string[] } = {}): D1Database {
  const sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = OFF');

  const migrationsDir = path.resolve(__dirname, '../../../migrations');
  const skipMigrations = new Set(options.skipMigrations ?? []);
  const files = fs
    .readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql') && !skipMigrations.has(file))
    .sort();
  for (const file of files) {
    sqlite.exec(fs.readFileSync(path.join(migrationsDir, file), 'utf-8'));
  }

  return new SqliteD1Database(sqlite);
}

describe('threads db helpers', () => {
  let d1: D1Database;

  beforeEach(() => {
    d1 = createD1Db();
  });

  it('persists default web origin for newly-created threads', async () => {
    const thread = await createThread(d1, { id: 'thread-web', sessionId: 'orchestrator:user-1' });

    expect(thread.originType).toBe('web');

    const stored = await getThread(d1, 'thread-web');
    expect(stored?.originType).toBe('web');
  });

  it('creates threads before origin metadata migration is applied', async () => {
    const legacyD1 = createD1Db({
      skipMigrations: ['0018_session_thread_origin_metadata.sql'],
    });

    const thread = await createThread(legacyD1, {
      id: 'thread-legacy',
      sessionId: 'orchestrator:user-1',
    });

    expect(thread).toMatchObject({
      id: 'thread-legacy',
      sessionId: 'orchestrator:user-1',
      originType: 'web',
    });
  });

  it('returns origin metadata separately from legacy routing channel metadata', async () => {
    await createThread(d1, {
      id: 'thread-automation',
      sessionId: 'orchestrator:user-1',
      originType: 'automation',
      originTriggerId: 'trigger-1',
      originTriggerType: 'schedule',
    });

    await registerChannelThread(d1, {
      channelType: 'slack',
      channelId: 'D123',
      externalThreadId: '1700000000.000001',
      userId: 'user-1',
      sessionId: 'orchestrator:user-1',
      threadId: 'thread-automation',
    });

    const result = await listThreads(d1, 'orchestrator:user-1');
    expect(result.threads).toHaveLength(1);
    expect(result.threads[0]).toMatchObject({
      id: 'thread-automation',
      originType: 'automation',
      originTriggerId: 'trigger-1',
      originTriggerType: 'schedule',
      channelType: 'slack',
      channelId: 'D123',
    });
  });

  it('does not duplicate a thread with multiple legacy routing mappings', async () => {
    await createThread(d1, { id: 'thread-web', sessionId: 'orchestrator:user-1' });
    await registerChannelThread(d1, {
      channelType: 'slack',
      channelId: 'D123',
      externalThreadId: '1700000000.000001',
      userId: 'user-1',
      sessionId: 'orchestrator:user-1',
      threadId: 'thread-web',
    });
    await registerChannelThread(d1, {
      channelType: 'slack',
      channelId: 'D123',
      externalThreadId: '1700000000.000002',
      userId: 'user-1',
      sessionId: 'orchestrator:user-1',
      threadId: 'thread-web',
    });

    const result = await listThreads(d1, 'orchestrator:user-1');
    expect(result.threads.map((thread) => thread.id)).toEqual(['thread-web']);
  });

  it('does not duplicate a thread with multiple legacy routing mappings in page mode', async () => {
    await createThread(d1, { id: 'thread-web', sessionId: 'orchestrator:user-1' });
    await registerChannelThread(d1, {
      channelType: 'slack',
      channelId: 'D123',
      externalThreadId: '1700000000.000001',
      userId: 'user-1',
      sessionId: 'orchestrator:user-1',
      threadId: 'thread-web',
    });
    await registerChannelThread(d1, {
      channelType: 'slack',
      channelId: 'D123',
      externalThreadId: '1700000000.000002',
      userId: 'user-1',
      sessionId: 'orchestrator:user-1',
      threadId: 'thread-web',
    });

    const result = await listThreads(d1, 'orchestrator:user-1', { page: 1, pageSize: 10 });
    expect(result.threads.map((thread) => thread.id)).toEqual(['thread-web']);
    expect(result).toMatchObject({
      hasMore: false,
      page: 1,
      pageSize: 10,
      totalCount: 1,
      totalPages: 1,
    });
  });
});
