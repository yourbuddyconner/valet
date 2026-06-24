import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../../test-utils/db.js';
import { writeMemoryFile, exportMemoryFiles, importMemoryFiles } from './memory-files.js';

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
  let sqlite: any;

  // Read a row straight from the underlying SQLite (bypasses Drizzle).
  const getRow = (userId: string, path: string) =>
    sqlite
      .prepare('SELECT path, content, version, pinned FROM orchestrator_memory_files WHERE user_id = ? AND path = ?')
      .get(userId, path) as { path: string; content: string; version: number; pinned: number } | undefined;

  const seedUser = (id: string) =>
    sqlite.prepare("INSERT INTO users (id, email, role) VALUES (?, ?, 'member')").run(id, `${id}@test.com`);

  beforeEach(async () => {
    ({ sqlite } = createTestDb());
    rawDb = makeD1Adapter(sqlite);
    seedUser(USER_A);
    seedUser(USER_B);

    await writeMemoryFile(rawDb, USER_A, 'projects/valet/overview.md', '# Valet\n\nA hosted coding agent.');
    await writeMemoryFile(rawDb, USER_A, 'preferences/coding-style.md', '# Style\n\nUse TypeScript strict mode.');
    await writeMemoryFile(rawDb, USER_A, 'journal/2026-03-08.md', '# 2026-03-08\n\nShipped the import/export feature.');
  });

  it('exports every file with full content, ordered by path', async () => {
    const files = await exportMemoryFiles(rawDb, USER_A);

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
    const files = await exportMemoryFiles(rawDb, USER_A);
    expect(files.find((f) => f.path === 'preferences/coding-style.md')?.pinned).toBe(true);
    expect(files.find((f) => f.path === 'journal/2026-03-08.md')?.pinned).toBe(false);
  });

  it('scopes the export to a single user', async () => {
    await writeMemoryFile(rawDb, USER_B, 'projects/other/notes.md', '# Other user');
    const exportedA = await exportMemoryFiles(rawDb, USER_A);
    expect(exportedA.every((f) => f.path !== 'projects/other/notes.md')).toBe(true);
  });

  it('round-trips: export from one user, import into another, contents match', async () => {
    const bundle = await exportMemoryFiles(rawDb, USER_A);

    const result = await importMemoryFiles(rawDb, USER_B, bundle);
    expect(result.imported).toBe(3);
    expect(result.skipped).toEqual([]);

    const exportedB = await exportMemoryFiles(rawDb, USER_B);
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
    expect(await exportMemoryFiles(rawDb, 'user-with-nothing')).toEqual([]);
  });
});
