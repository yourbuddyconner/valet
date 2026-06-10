import { beforeEach, describe, expect, it } from 'vitest';
import type BetterSqlite3 from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { createTestDb } from '../../test-utils/db.js';
import { requestMetrics } from '../schema/index.js';
import { getAccessDenials, getHeavyRequests, getSlowestRequests } from './request-forensics.js';

const HOUR = 60 * 60 * 1000;

interface SeedRow {
  method?: string;
  route: string;
  status: number;
  durationMs?: number;
  requestBytes?: number | null;
  requestId?: string | null;
  userId?: string | null;
  ageMs?: number;
}

function seed(db: BetterSQLite3Database, rows: SeedRow[]): void {
  for (const r of rows) {
    db.insert(requestMetrics).values({
      id: crypto.randomUUID(),
      createdAt: new Date(Date.now() - (r.ageMs ?? 60_000)).toISOString(),
      method: r.method ?? 'GET',
      route: r.route,
      status: r.status,
      durationMs: r.durationMs ?? 1,
      requestId: r.requestId ?? null,
      requestBytes: r.requestBytes ?? null,
      userId: r.userId ?? null,
    }).run();
  }
}

describe('request-forensics queries', () => {
  let db: BetterSQLite3Database;
  let sqlite: BetterSqlite3.Database;
  beforeEach(() => {
    ({ db, sqlite } = createTestDb());
  });

  it('groups authorization failures by actor + route, most frequent first', async () => {
    // user_id is an FK to users — seed the actors the denials reference.
    for (const id of ['user-a', 'user-b']) {
      sqlite.prepare('INSERT INTO users (id, email) VALUES (?, ?)').run(id, `${id}@example.com`);
    }
    seed(db, [
      { route: '/api/sessions/:id', status: 403, userId: 'user-a' },
      { route: '/api/sessions/:id', status: 403, userId: 'user-a' },
      { route: '/api/sessions/:id', status: 403, userId: 'user-a' },
      { route: '/api/files', status: 401, userId: 'user-a' },
      { route: '/api/files', status: 401, userId: 'user-a' },
      { route: '/api/sessions/:id', status: 403, userId: 'user-b' },
      { route: '/api/sessions/:id', status: 200, userId: 'user-a' }, // success — excluded
      { route: '/api/sessions/:id', status: 403, userId: 'user-a', ageMs: 2 * HOUR }, // out of window
    ]);

    const periodStart = new Date(Date.now() - HOUR).toISOString();
    const denials = await getAccessDenials(db, periodStart);

    expect(denials).toEqual([
      { userId: 'user-a', route: '/api/sessions/:id', status: 403, count: 3 },
      { userId: 'user-a', route: '/api/files', status: 401, count: 2 },
      { userId: 'user-b', route: '/api/sessions/:id', status: 403, count: 1 },
    ]);
  });

  it('returns the heaviest inbound payloads, excluding rows without a size', async () => {
    seed(db, [
      { route: '/api/files', status: 200, requestBytes: 5_000, requestId: 'req-mid' },
      { route: '/api/files', status: 413, requestBytes: 1_000_000, requestId: 'req-big' },
      { route: '/api/sessions', status: 200, requestBytes: null }, // no size — excluded
      { route: '/api/files', status: 200, requestBytes: 250, requestId: 'req-small' },
    ]);

    const periodStart = new Date(Date.now() - HOUR).toISOString();
    const heavy = await getHeavyRequests(db, periodStart);

    expect(heavy.map((r) => r.requestBytes)).toEqual([1_000_000, 5_000, 250]);
    // The biggest one failed (413) — exactly the large-file symptom we want to surface.
    expect(heavy[0]).toMatchObject({ route: '/api/files', status: 413, requestId: 'req-big' });
  });

  it('returns the slowest requests with a pivotable request id', async () => {
    seed(db, [
      { route: '/api/a', status: 200, durationMs: 10, requestId: 'req-fast' },
      { route: '/api/b', status: 504, durationMs: 30_000, requestId: 'req-timeout' },
      { route: '/api/c', status: 200, durationMs: 200, requestId: 'req-mid' },
    ]);

    const periodStart = new Date(Date.now() - HOUR).toISOString();
    const slowest = await getSlowestRequests(db, periodStart, 2);

    expect(slowest.map((r) => r.durationMs)).toEqual([30_000, 200]);
    expect(slowest[0]).toMatchObject({ route: '/api/b', status: 504, requestId: 'req-timeout' });
  });
});
