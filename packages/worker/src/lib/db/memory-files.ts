import type { D1Database } from '@cloudflare/workers-types';
import type { MemoryFile, MemoryFileListing, MemoryFileSearchResult, PatchOperation, PatchResult } from '@valet/shared';
import { eq, and, sql } from 'drizzle-orm';
import type { AppDb } from '../drizzle.js';
import { orchestratorMemoryFiles } from '../schema/memory-files.js';
import { extractTitle, buildFTS5Query, normalizeBM25, extractSnippet, pathBoost } from './memory-search-helpers.js';

const MEMORY_CAP = 200;

// ─── Path Normalization ─────────────────────────────────────────────────────

function normalizePath(raw: string): string {
  // Strip leading slashes
  let p = raw.replace(/^\/+/, '');
  // Lowercase
  p = p.toLowerCase();
  // Kebab-case: replace spaces and underscores with hyphens
  p = p.replace(/[\s_]+/g, '-');
  // Remove invalid characters (keep alphanumeric, hyphens, dots, slashes)
  p = p.replace(/[^a-z0-9\-./]/g, '');
  // Split into segments, remove traversal (.. and .), rejoin
  const segments = p.split('/').filter((s) => s !== '..' && s !== '.' && s !== '');
  p = segments.join('/');
  return p;
}

function validatePath(path: string): string | null {
  if (!path || path.length === 0) return 'Path is required';
  if (path.length > 256) return 'Path too long (max 256 chars)';
  const depth = path.split('/').filter(Boolean).length;
  if (depth > 4) return 'Path too deep (max 4 levels)';
  return null;
}

// ─── Row-to-Domain Converter ────────────────────────────────────────────────

function rowToMemoryFile(row: typeof orchestratorMemoryFiles.$inferSelect): MemoryFile {
  return {
    id: row.id,
    userId: row.userId,
    orgId: row.orgId,
    path: row.path,
    content: row.content,
    title: row.title,
    relevance: row.relevance,
    pinned: row.pinned === 1,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastAccessedAt: row.lastAccessedAt,
  };
}

// ─── Read Operations ────────────────────────────────────────────────────────

export async function readMemoryFile(db: AppDb, userId: string, path: string): Promise<MemoryFile | null> {
  const normalized = normalizePath(path);
  const row = await db
    .select()
    .from(orchestratorMemoryFiles)
    .where(and(eq(orchestratorMemoryFiles.userId, userId), eq(orchestratorMemoryFiles.path, normalized)))
    .get();
  return row ? rowToMemoryFile(row) : null;
}

export async function listMemoryFiles(db: AppDb, userId: string, pathPrefix: string): Promise<MemoryFileListing[]> {
  const normalized = normalizePath(pathPrefix);
  const prefix = normalized.endsWith('/') ? normalized : (normalized ? normalized + '/' : '');

  const rows = await db
    .select({
      path: orchestratorMemoryFiles.path,
      updatedAt: orchestratorMemoryFiles.updatedAt,
      contentLength: sql<number>`LENGTH(${orchestratorMemoryFiles.content})`,
      pinned: orchestratorMemoryFiles.pinned,
    })
    .from(orchestratorMemoryFiles)
    .where(
      prefix
        ? and(eq(orchestratorMemoryFiles.userId, userId), sql`${orchestratorMemoryFiles.path} LIKE ${prefix + '%'}`)
        : eq(orchestratorMemoryFiles.userId, userId)
    )
    .orderBy(orchestratorMemoryFiles.path);

  return rows.map((r) => ({
    path: r.path,
    size: r.contentLength,
    updatedAt: r.updatedAt,
    pinned: r.pinned === 1,
  }));
}

// ─── Write Operations ───────────────────────────────────────────────────────

export async function writeMemoryFile(
  rawDb: D1Database,
  userId: string,
  path: string,
  content: string,
): Promise<MemoryFile> {
  const normalized = normalizePath(path);
  const error = validatePath(normalized);
  if (error) throw new Error(error);

  const id = crypto.randomUUID();
  const pinned = normalized.startsWith('preferences/') ? 1 : 0;
  const title = extractTitle(content, normalized);

  // Check if file exists to determine if this is an update
  const existing = await rawDb
    .prepare('SELECT id, version, rowid, created_at, relevance, org_id FROM orchestrator_memory_files WHERE user_id = ? AND path = ?')
    .bind(userId, normalized)
    .first<{ id: string; version: number; rowid: number; created_at: string; relevance: number; org_id: string }>();

  if (existing) {
    // Update existing file
    await rawDb
      .prepare(
        `UPDATE orchestrator_memory_files SET content = ?, title = ?, version = version + 1, updated_at = datetime('now'), pinned = ? WHERE id = ?`
      )
      .bind(content, title, pinned, existing.id)
      .run();

    // Resync FTS index
    await rawDb.prepare('DELETE FROM orchestrator_memory_files_fts WHERE rowid = ?').bind(existing.rowid).run();
    await rawDb
      .prepare('INSERT INTO orchestrator_memory_files_fts(rowid, path, title, content) VALUES (?, ?, ?, ?)')
      .bind(existing.rowid, normalized, title, content)
      .run();

    return {
      id: existing.id,
      userId,
      orgId: existing.org_id,
      path: normalized,
      content,
      title,
      relevance: existing.relevance,
      pinned: pinned === 1,
      version: existing.version + 1,
      createdAt: existing.created_at,
      updatedAt: new Date().toISOString(),
      lastAccessedAt: new Date().toISOString(),
    };
  }

  // Insert new file
  await rawDb
    .prepare(
      `INSERT INTO orchestrator_memory_files (id, user_id, path, title, content, pinned) VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(id, userId, normalized, title, content, pinned)
    .run();

  // Sync FTS index
  const inserted = await rawDb
    .prepare('SELECT rowid FROM orchestrator_memory_files WHERE id = ?')
    .bind(id)
    .first<{ rowid: number }>();
  if (inserted) {
    await rawDb
      .prepare('INSERT INTO orchestrator_memory_files_fts(rowid, path, title, content) VALUES (?, ?, ?, ?)')
      .bind(inserted.rowid, normalized, title, content)
      .run();
  }

  // Auto-prune if over cap (non-pinned files only)
  await enforceMemoryCap(rawDb, userId);

  return {
    id,
    userId,
    orgId: 'default',
    path: normalized,
    content,
    title,
    relevance: 1.0,
    pinned: pinned === 1,
    version: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastAccessedAt: new Date().toISOString(),
  };
}

// ─── Patch Operations ───────────────────────────────────────────────────────

export async function patchMemoryFile(
  rawDb: D1Database,
  userId: string,
  path: string,
  operations: PatchOperation[],
): Promise<PatchResult> {
  const normalized = normalizePath(path);
  const error = validatePath(normalized);
  if (error) throw new Error(error);

  // Read current content
  const existing = await rawDb
    .prepare('SELECT id, content, version, rowid FROM orchestrator_memory_files WHERE user_id = ? AND path = ?')
    .bind(userId, normalized)
    .first<{ id: string; content: string; version: number; rowid: number }>();

  let content = existing?.content ?? '';
  let applied = 0;
  const skipped: string[] = [];
  const fileExists = !!existing;

  for (const op of operations) {
    switch (op.op) {
      case 'append': {
        content += op.content;
        applied++;
        break;
      }
      case 'prepend': {
        content = op.content + content;
        applied++;
        break;
      }
      case 'replace': {
        if (!fileExists && !content) {
          skipped.push(`replace '${op.old.slice(0, 40)}' — file not found`);
          break;
        }
        if (!op.old) {
          skipped.push(`replace — empty search string`);
          break;
        }
        const idx = content.indexOf(op.old);
        if (idx === -1) {
          skipped.push(`replace '${op.old.slice(0, 40)}' — not found`);
        } else {
          content = content.slice(0, idx) + op.new + content.slice(idx + op.old.length);
          applied++;
        }
        break;
      }
      case 'replace_all': {
        if (!fileExists && !content) {
          skipped.push(`replace_all '${op.old.slice(0, 40)}' — file not found`);
          break;
        }
        if (!op.old) {
          skipped.push(`replace_all — empty search string`);
          break;
        }
        if (!content.includes(op.old)) {
          skipped.push(`replace_all '${op.old.slice(0, 40)}' — 0 matches`);
        } else {
          content = content.split(op.old).join(op.new);
          applied++;
        }
        break;
      }
      case 'insert_after': {
        if (!fileExists && !content) {
          skipped.push(`insert_after '${op.anchor.slice(0, 40)}' — file not found`);
          break;
        }
        const lines = content.split('\n');
        const lineIdx = lines.findIndex((l) => l.includes(op.anchor));
        if (lineIdx === -1) {
          skipped.push(`insert_after '${op.anchor.slice(0, 40)}' — anchor not found`);
        } else {
          lines.splice(lineIdx + 1, 0, op.content);
          content = lines.join('\n');
          applied++;
        }
        break;
      }
      case 'delete_section': {
        if (!fileExists && !content) {
          skipped.push(`delete_section '${op.heading.slice(0, 40)}' — file not found`);
          break;
        }
        const headingLevel = op.heading.match(/^#+/)?.[0]?.length ?? 0;
        if (headingLevel === 0) {
          skipped.push(`delete_section '${op.heading.slice(0, 40)}' — must be a markdown heading (e.g. ## Section)`);
          break;
        }
        const sectionLines = content.split('\n');
        const startIdx = sectionLines.findIndex((l) => l.trim() === op.heading.trim());
        if (startIdx === -1) {
          skipped.push(`delete_section '${op.heading.slice(0, 40)}' — heading not found`);
        } else {
          // Find end: next heading of same or higher level
          let endIdx = sectionLines.length;
          for (let i = startIdx + 1; i < sectionLines.length; i++) {
            const lineHeadingMatch = sectionLines[i].match(/^(#+)\s/);
            if (lineHeadingMatch && lineHeadingMatch[1].length <= headingLevel) {
              endIdx = i;
              break;
            }
          }
          sectionLines.splice(startIdx, endIdx - startIdx);
          content = sectionLines.join('\n');
          applied++;
        }
        break;
      }
    }
  }

  // If nothing changed, skip the write
  if (applied === 0) {
    if (fileExists) {
      return { content: existing!.content, version: existing!.version, applied: 0, skipped };
    }
    // All ops skipped on non-existent file — don't create an empty file
    return { content: '', version: 0, applied: 0, skipped };
  }

  const title = extractTitle(content, normalized);

  if (fileExists) {
    // Update existing
    const newVersion = existing!.version + 1;
    await rawDb
      .prepare(`UPDATE orchestrator_memory_files SET content = ?, title = ?, version = ?, updated_at = datetime('now') WHERE id = ?`)
      .bind(content, title, newVersion, existing!.id)
      .run();

    // Resync FTS
    await rawDb.prepare('DELETE FROM orchestrator_memory_files_fts WHERE rowid = ?').bind(existing!.rowid).run();
    await rawDb
      .prepare('INSERT INTO orchestrator_memory_files_fts(rowid, path, title, content) VALUES (?, ?, ?, ?)')
      .bind(existing!.rowid, normalized, title, content)
      .run();

    return { content, version: newVersion, applied, skipped };
  } else {
    // Create file (only valid for append/prepend)
    const file = await writeMemoryFile(rawDb, userId, normalized, content);
    return { content, version: file.version, applied, skipped };
  }
}

// ─── Delete Operations ──────────────────────────────────────────────────────

export async function deleteMemoryFile(rawDb: D1Database, userId: string, path: string): Promise<number> {
  const normalized = normalizePath(path);

  // Get rowid before deleting for FTS cleanup
  const row = await rawDb
    .prepare('SELECT rowid FROM orchestrator_memory_files WHERE user_id = ? AND path = ?')
    .bind(userId, normalized)
    .first<{ rowid: number }>();

  const result = await rawDb
    .prepare('DELETE FROM orchestrator_memory_files WHERE user_id = ? AND path = ?')
    .bind(userId, normalized)
    .run();

  const changes = result.meta?.changes ?? 0;
  if (row && changes > 0) {
    await rawDb.prepare('DELETE FROM orchestrator_memory_files_fts WHERE rowid = ?').bind(row.rowid).run();
  }

  return changes;
}

export async function deleteMemoryFilesUnderPath(rawDb: D1Database, userId: string, pathPrefix: string): Promise<number> {
  const normalized = normalizePath(pathPrefix);
  const prefix = normalized.endsWith('/') ? normalized : normalized + '/';

  // Get rowids before deleting for FTS cleanup
  const rows = await rawDb
    .prepare('SELECT rowid FROM orchestrator_memory_files WHERE user_id = ? AND path LIKE ?')
    .bind(userId, prefix + '%')
    .all<{ rowid: number }>();

  const result = await rawDb
    .prepare('DELETE FROM orchestrator_memory_files WHERE user_id = ? AND path LIKE ?')
    .bind(userId, prefix + '%')
    .run();

  const changes = result.meta?.changes ?? 0;
  if (changes > 0) {
    for (const row of rows.results || []) {
      await rawDb.prepare('DELETE FROM orchestrator_memory_files_fts WHERE rowid = ?').bind(row.rowid).run();
    }
  }

  return changes;
}

// ─── Search Operations ──────────────────────────────────────────────────────

export async function searchMemoryFiles(
  rawDb: D1Database,
  userId: string,
  query: string,
  pathPrefix?: string,
  limit = 20,
): Promise<MemoryFileSearchResult[]> {
  let ftsQuery = buildFTS5Query(query);
  if (!ftsQuery) return [];

  const queryTerms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length >= 2)
    .map((t) => t.replace(/[^\w]/g, ''));

  const runSearch = async (q: string): Promise<any[]> => {
    let sqlStr = `
      SELECT m.path, m.title, m.content,
             bm25(orchestrator_memory_files_fts, 5, 10, 1) as bm25_score
      FROM orchestrator_memory_files m
      JOIN orchestrator_memory_files_fts ON orchestrator_memory_files_fts.rowid = m.rowid
      WHERE orchestrator_memory_files_fts MATCH ? AND m.user_id = ?`;
    const params: (string | number)[] = [q, userId];

    if (pathPrefix) {
      const normalized = normalizePath(pathPrefix);
      const prefix = normalized.endsWith('/') ? normalized : normalized + '/';
      sqlStr += ' AND m.path LIKE ?';
      params.push(prefix + '%');
    }

    const safeLimit = Math.max(1, Math.min(Math.floor(limit), 200));
    sqlStr += ` ORDER BY bm25_score LIMIT ${safeLimit}`;
    const result = await rawDb.prepare(sqlStr).bind(...params).all();
    return result.results || [];
  };

  let rows = await runSearch(ftsQuery);
  if (rows.length === 0 && ftsQuery.includes(' AND ')) {
    // Fallback: try OR instead of AND, but strip NOT clauses to avoid
    // precedence issues (e.g. "a OR b NOT c" groups as "a OR (b NOT c)")
    const orQuery = ftsQuery.replace(/ NOT (\([^)]+\)|"[^"]*"\*?)/, '').replace(/ AND /g, ' OR ');
    rows = await runSearch(orQuery);
  }

  const scored = rows.map((row: any) => {
    const bm25 = normalizeBM25(row.bm25_score as number);
    const boost = pathBoost(row.path as string, queryTerms);
    return {
      path: row.path as string,
      snippet: extractSnippet(row.content as string, queryTerms),
      relevance: Math.min(bm25 + boost, 1.0),
    };
  });

  scored.sort((a, b) => b.relevance - a.relevance);
  return scored;
}

// ─── Relevance Boost ────────────────────────────────────────────────────────

export async function boostMemoryFileRelevance(db: AppDb, userId: string, path: string): Promise<void> {
  const normalized = normalizePath(path);
  await db
    .update(orchestratorMemoryFiles)
    .set({
      relevance: sql`MIN(${orchestratorMemoryFiles.relevance} + 0.1, 2.0)`,
      lastAccessedAt: sql`datetime('now')`,
    })
    .where(and(eq(orchestratorMemoryFiles.userId, userId), eq(orchestratorMemoryFiles.path, normalized)));
}

// ─── Journal Auto-Creation ──────────────────────────────────────────────────

export async function ensureTodayJournal(rawDb: D1Database, userId: string): Promise<void> {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const path = `journal/${today}.md`;
  const normalized = normalizePath(path);
  const existing = await rawDb
    .prepare('SELECT id FROM orchestrator_memory_files WHERE user_id = ? AND path = ?')
    .bind(userId, normalized)
    .first();
  if (existing) return;
  try {
    await writeMemoryFile(rawDb, userId, path, `# ${today}\n\n`);
  } catch {
    // Unique constraint race — another concurrent restart created it first. Safe to ignore.
  }
}

// ─── Journal Pruning ────────────────────────────────────────────────────────

/**
 * Delete journal files from previous days that were never written to
 * (still contain only the auto-created stub header "# YYYY-MM-DD\n\n").
 */
export async function pruneEmptyJournals(rawDb: D1Database): Promise<number> {
  const today = new Date().toISOString().slice(0, 10);
  const todayPath = normalizePath(`journal/${today}.md`);

  // Find empty journal stubs: path starts with "journal/", not today's, content is just the header
  const toDelete = await rawDb
    .prepare(
      `SELECT id, rowid, path, content FROM orchestrator_memory_files
       WHERE path LIKE 'journal/%.md'
         AND path != ?
         AND pinned = 0
         AND LENGTH(TRIM(content)) <= 14`
    )
    .bind(todayPath)
    .all<{ id: string; rowid: number; path: string; content: string }>();

  let pruned = 0;
  for (const row of toDelete.results || []) {
    // Verify content is just the stub: "# YYYY-MM-DD" with optional whitespace
    const trimmed = row.content.trim();
    if (!/^#\s+\d{4}-\d{2}-\d{2}\s*$/.test(trimmed)) continue;

    await rawDb.prepare('DELETE FROM orchestrator_memory_files WHERE id = ?').bind(row.id).run();
    await rawDb.prepare('DELETE FROM orchestrator_memory_files_fts WHERE rowid = ?').bind(row.rowid).run();
    pruned++;
  }

  return pruned;
}

// ─── Cap Enforcement ────────────────────────────────────────────────────────

async function enforceMemoryCap(rawDb: D1Database, userId: string): Promise<void> {
  const countResult = await rawDb
    .prepare('SELECT COUNT(*) as cnt FROM orchestrator_memory_files WHERE user_id = ? AND pinned = 0')
    .bind(userId)
    .first<{ cnt: number }>();

  if (!countResult || countResult.cnt <= MEMORY_CAP) return;

  const excess = countResult.cnt - MEMORY_CAP;

  // Get rowids before deleting for FTS cleanup
  const toDelete = await rawDb
    .prepare(
      `SELECT rowid FROM orchestrator_memory_files WHERE id IN (
        SELECT id FROM orchestrator_memory_files WHERE user_id = ? AND pinned = 0
        ORDER BY relevance ASC, last_accessed_at ASC LIMIT ?
      )`
    )
    .bind(userId, excess)
    .all<{ rowid: number }>();

  await rawDb
    .prepare(
      `DELETE FROM orchestrator_memory_files WHERE id IN (
        SELECT id FROM orchestrator_memory_files WHERE user_id = ? AND pinned = 0
        ORDER BY relevance ASC, last_accessed_at ASC LIMIT ?
      )`
    )
    .bind(userId, excess)
    .run();

  for (const row of toDelete.results || []) {
    await rawDb.prepare('DELETE FROM orchestrator_memory_files_fts WHERE rowid = ?').bind(row.rowid).run();
  }
}
