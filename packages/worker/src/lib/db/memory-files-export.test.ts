import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../../test-utils/db.js';
import { writeMemoryFile, exportMemoryFiles, importMemoryFiles, searchMemoryFiles } from './memory-files.js';

// Thin adapter: wraps better-sqlite3 sync API to match the D1Database async interface.
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

const USER_A = 'user-export-a';
const USER_B = 'user-export-b';

describe('exportMemoryFiles / importMemoryFiles', () => {
  let rawDb: any;
  let db: any;
  let sqlite: any;

  // Read a row straight from the underlying SQLite (bypasses Drizzle).
  const getRow = (userId: string, path: string) =>
    sqlite
      .prepare('SELECT path, content, version, pinned FROM orchestrator_memory_files WHERE user_id = ? AND path = ?')
      .get(userId, path) as { path: string; content: string; version: number; pinned: number } | undefined;

  const seedUser = (id: string) =>
    sqlite.prepare("INSERT INTO users (id, email, role) VALUES (?, ?, 'member')").run(id, `${id}@test.com`);

  beforeEach(async () => {
    ({ db, sqlite } = createTestDb());
    rawDb = makeD1Adapter(sqlite);
    seedUser(USER_A);
    seedUser(USER_B);

    await writeMemoryFile(rawDb, USER_A, 'projects/valet/overview.md', '# Valet\n\nA hosted coding agent.');
    await writeMemoryFile(rawDb, USER_A, 'preferences/coding-style.md', '# Style\n\nUse TypeScript strict mode.');
    await writeMemoryFile(rawDb, USER_A, 'journal/2026-03-08.md', '# 2026-03-08\n\nShipped the import/export feature.');
  });

  it('exports every file with full content, ordered by path', async () => {
    const files = await exportMemoryFiles(db, USER_A);

    expect(files).toHaveLength(3);
    expect(files.map((f) => f.path)).toEqual([
      'journal/2026-03-08.md',
      'preferences/coding-style.md',
      'projects/valet/overview.md',
    ]);
    const overview = files.find((f) => f.path === 'projects/valet/overview.md');
    expect(overview?.content).toBe('# Valet\n\nA hosted coding agent.');
  });

  it('marks preferences files as pinned in the export', async () => {
    const files = await exportMemoryFiles(db, USER_A);
    expect(files.find((f) => f.path === 'preferences/coding-style.md')?.pinned).toBe(true);
    expect(files.find((f) => f.path === 'journal/2026-03-08.md')?.pinned).toBe(false);
  });

  it('scopes the export to a single user', async () => {
    await writeMemoryFile(rawDb, USER_B, 'projects/other/notes.md', '# Other user');
    const exportedA = await exportMemoryFiles(db, USER_A);
    expect(exportedA.every((f) => f.path !== 'projects/other/notes.md')).toBe(true);
  });

  it('round-trips: export from one user, import into another, contents match', async () => {
    const bundle = await exportMemoryFiles(db, USER_A);

    const result = await importMemoryFiles(rawDb, USER_B, bundle);
    expect(result.imported).toBe(3);
    expect(result.skipped).toEqual([]);

    const exportedB = await exportMemoryFiles(db, USER_B);
    expect(exportedB.map((f) => f.path)).toEqual(bundle.map((f) => f.path));
    expect(exportedB.map((f) => f.content)).toEqual(bundle.map((f) => f.content));
  });

  it('merges on import: same-path files are overwritten, others untouched', async () => {
    const before = getRow(USER_A, 'projects/valet/overview.md');

    const result = await importMemoryFiles(rawDb, USER_A, [
      { path: 'projects/valet/overview.md', content: '# Valet\n\nUpdated overview.' },
      { path: 'projects/new/plan.md', content: '# Plan\n\nBrand new file.' },
    ]);

    expect(result.imported).toBe(2);

    const updated = getRow(USER_A, 'projects/valet/overview.md');
    expect(updated?.content).toBe('# Valet\n\nUpdated overview.');
    expect(updated?.version).toBe((before?.version ?? 0) + 1);

    // Untouched file survives unchanged.
    expect(getRow(USER_A, 'preferences/coding-style.md')?.content).toBe('# Style\n\nUse TypeScript strict mode.');
    // New file created.
    expect(getRow(USER_A, 'projects/new/plan.md')?.content).toBe('# Plan\n\nBrand new file.');
  });

  it('skips empty-content files and reports them', async () => {
    const result = await importMemoryFiles(rawDb, USER_B, [
      { path: 'notes/keep.md', content: '# Keep me' },
      { path: 'notes/empty.md', content: '' },
    ]);

    expect(result.imported).toBe(1);
    expect(result.skipped).toEqual([{ path: 'notes/empty.md', reason: 'empty content' }]);
    expect(getRow(USER_B, 'notes/empty.md')).toBeUndefined();
  });

  it('skips files with invalid paths without failing the whole import', async () => {
    const result = await importMemoryFiles(rawDb, USER_B, [
      { path: 'valid/note.md', content: '# Valid' },
      { path: 'a/b/c/d/e/too-deep.md', content: '# Too deep' },
    ]);

    expect(result.imported).toBe(1);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].path).toBe('a/b/c/d/e/too-deep.md');
    expect(result.skipped[0].reason).toMatch(/too deep/i);
    expect(getRow(USER_B, 'valid/note.md')).toBeDefined();
  });

  it('returns an empty bundle for a user with no memory', async () => {
    expect(await exportMemoryFiles(db, 'user-with-nothing')).toEqual([]);
  });

  // ── Large files (regression for the 50k import 400) ──────────────────────────
  // Real memory files grow past 50k via the agent's uncapped PATCH/append writes,
  // so a real export bundle contains oversized files. Import must round-trip them.

  it('imports a file over 50k characters losslessly', async () => {
    const content = '# Big\n\n' + 'x'.repeat(60001);
    const result = await importMemoryFiles(rawDb, USER_B, [{ path: 'big/note.md', content }]);

    expect(result.imported).toBe(1);
    expect(result.skipped).toEqual([]);

    // Round-trip via export and assert byte-for-byte (no truncation).
    const exported = await exportMemoryFiles(db, USER_B);
    const big = exported.find((f) => f.path === 'big/note.md');
    expect(big?.content.length).toBe(content.length);
    expect(big?.content).toBe(content);
  });

  it('imports a large file alongside small ones in one bundle (no 400)', async () => {
    const result = await importMemoryFiles(rawDb, USER_B, [
      { path: 'notes/a.md', content: '# A' },
      { path: 'notes/huge.md', content: '#\n' + 'y'.repeat(70000) },
      { path: 'notes/b.md', content: '# B' },
    ]);

    expect(result.imported).toBe(3);
    expect(result.skipped).toEqual([]);
  });

  it('preserves pinning, merge, and FTS sync on a mixed >50k bundle', async () => {
    const overviewBefore = getRow(USER_A, 'projects/valet/overview.md');
    expect(overviewBefore?.version).toBe(1);

    const result = await importMemoryFiles(rawDb, USER_A, [
      { path: 'preferences/big-pref.md', content: '# Pref\n\n' + 'p'.repeat(60000) },
      { path: 'notes/big-note.md', content: '# Note\n\n' + 'n'.repeat(60000) },
      // Overwrite an existing seeded file with a searchable token.
      { path: 'projects/valet/overview.md', content: '# Valet\n\nNow mentions reindexedtoken explicitly.' },
    ]);

    expect(result.imported).toBe(3);
    expect(result.skipped).toEqual([]);

    // Pinning derived from path: preferences/* pinned, others not.
    expect(getRow(USER_A, 'preferences/big-pref.md')?.pinned).toBe(1);
    expect(getRow(USER_A, 'notes/big-note.md')?.pinned).toBe(0);

    // Merge overwrote the existing file (version bumped), didn't duplicate.
    expect(getRow(USER_A, 'projects/valet/overview.md')?.version).toBe(2);

    // FTS index was re-synced on overwrite — the new token is searchable.
    const hits = await searchMemoryFiles(rawDb, USER_A, 'reindexedtoken');
    expect(hits.some((h) => h.path === 'projects/valet/overview.md')).toBe(true);
  });

  // ── Cap interaction: import respects the 200 non-pinned cap and reports it ────

  const countRows = (userId: string, pinned: 0 | 1) =>
    (sqlite
      .prepare('SELECT COUNT(*) AS c FROM orchestrator_memory_files WHERE user_id = ? AND pinned = ?')
      .get(userId, pinned) as { c: number }).c;

  it('imports past the 200-file cap: keeps 200 non-pinned + all pinned, reports pruned', async () => {
    const files = [
      ...Array.from({ length: 250 }, (_, i) => ({ path: `notes/n-${i}.md`, content: `# note ${i}` })),
      ...Array.from({ length: 10 }, (_, i) => ({ path: `preferences/p-${i}.md`, content: `# pref ${i}` })),
    ];

    const result = await importMemoryFiles(rawDb, USER_B, files);

    // All 260 writes succeeded; the cap then pruned the non-pinned excess (250 - 200).
    expect(result.imported).toBe(260);
    expect(result.skipped).toEqual([]);
    expect(result.pruned).toBe(50);

    // Exactly 200 non-pinned survive; all 10 pinned preferences/* survive.
    expect(countRows(USER_B, 0)).toBe(200);
    expect(countRows(USER_B, 1)).toBe(10);
  });

  it('does not prune a normal under-cap import', async () => {
    const result = await importMemoryFiles(rawDb, USER_B, [
      { path: 'notes/a.md', content: '# A' },
      { path: 'notes/b.md', content: '# B' },
    ]);
    expect(result.imported).toBe(2);
    expect(result.pruned).toBe(0);
  });

  it('normalizes paths on import while preserving content verbatim', async () => {
    const content = '# My Note\n\nVerbatim body — unchanged.';
    const result = await importMemoryFiles(rawDb, USER_B, [{ path: 'Notes/My Note.md', content }]);

    expect(result.imported).toBe(1);
    // Path is normalized (lowercased, spaces → hyphens); content is byte-for-byte.
    expect(getRow(USER_B, 'notes/my-note.md')?.content).toBe(content);
  });

  it('a duplicate path within one bundle collapses to one write with the last content', async () => {
    const result = await importMemoryFiles(rawDb, USER_B, [
      { path: 'notes/dup.md', content: '# first' },
      { path: 'notes/dup.md', content: '# second' },
    ]);

    // Same-path entries are deduped (last wins) before writing, so it's one
    // import and one row — concurrent writes never collide on the unique index.
    expect(result.imported).toBe(1);
    const rows = sqlite
      .prepare("SELECT content FROM orchestrator_memory_files WHERE user_id = ? AND path = 'notes/dup.md'")
      .all(USER_B) as { content: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe('# second');
  });
});
