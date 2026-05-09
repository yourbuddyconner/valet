import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../../test-utils/db.js';
import { writeMemoryFile, searchMemoryFiles } from './memory-files.js';

// Thin adapter: wraps better-sqlite3 sync API to match D1Database async interface
function makeD1Adapter(sqlite: any) {
  return {
    prepare(sql: string) {
      return {
        bind(...args: any[]) {
          const stmt = sqlite.prepare(sql);
          return {
            async run() { return stmt.run(...args); },
            async all() { return { results: stmt.all(...args) }; },
            async first() { return stmt.get(...args) ?? null; },
          };
        },
      };
    },
  } as any;
}

const USER_ID = 'user-test-mem-search';

describe('searchMemoryFiles', () => {
  let rawDb: any;

  beforeEach(async () => {
    const { sqlite } = createTestDb();
    rawDb = makeD1Adapter(sqlite);

    // Seed user row to satisfy FK on orchestrator_memory_files.user_id
    sqlite.prepare(
      "INSERT INTO users (id, email, role) VALUES (?, ?, 'member')"
    ).run(USER_ID, `${USER_ID}@test.com`);

    await writeMemoryFile(rawDb, USER_ID, 'projects/valet/overview.md',
      '# Valet Project\n\nValet is a hosted coding agent platform built on Cloudflare Workers.');
    await writeMemoryFile(rawDb, USER_ID, 'preferences/coding-style.md',
      '# Coding Style\n\nAlways use TypeScript strict mode. Prefer functional patterns.');
    await writeMemoryFile(rawDb, USER_ID, 'journal/2026-03-08.md',
      '# 2026-03-08\n\n## 10:00 — Deployed auth fix\n\n- PR #42 merged.\n- Fixed Cloudflare D1 migration.');
  });

  it('finds files by content keyword', async () => {
    const results = await searchMemoryFiles(rawDb, USER_ID, 'cloudflare');
    expect(results.length).toBeGreaterThan(0);
    expect(results.some(r => r.path.includes('valet'))).toBe(true);
  });

  it('gives path boost to files whose path matches the query', async () => {
    const results = await searchMemoryFiles(rawDb, USER_ID, 'valet');
    const valetResult = results.find(r => r.path === 'projects/valet/overview.md');
    expect(valetResult).toBeDefined();
    expect(valetResult!.relevance).toBeGreaterThan(0.5);
  });

  it('returns match-aware snippets containing the search term', async () => {
    const results = await searchMemoryFiles(rawDb, USER_ID, 'auth');
    const journal = results.find(r => r.path.includes('journal'));
    expect(journal?.snippet).toContain('auth');
  });

  it('scopes results to pathPrefix when provided', async () => {
    const results = await searchMemoryFiles(rawDb, USER_ID, 'typescript', 'preferences/');
    expect(results.length).toBeGreaterThan(0);
    expect(results.every(r => r.path.startsWith('preferences/'))).toBe(true);
  });

  it('falls back to OR when AND returns no results', async () => {
    const results = await searchMemoryFiles(rawDb, USER_ID, 'valet typescript');
    expect(results.length).toBeGreaterThan(0);
  });

  it('returns empty array for nonsense query', async () => {
    const results = await searchMemoryFiles(rawDb, USER_ID, 'xyzzy123nonsense');
    expect(results).toEqual([]);
  });
});
