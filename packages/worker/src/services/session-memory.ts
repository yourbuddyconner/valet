import type { AppDb } from '../lib/drizzle.js';
import {
  listMemoryFiles,
  readMemoryFile,
  writeMemoryFile,
  patchMemoryFile,
  deleteMemoryFile,
  deleteMemoryFilesUnderPath,
  searchMemoryFiles,
  boostMemoryFileRelevance,
} from '../lib/db.js';

// ─── memRead ────────────────────────────────────────────────────────────────

export type MemReadResult =
  | { files: Awaited<ReturnType<typeof listMemoryFiles>>; file?: undefined; error?: undefined }
  | { file: Awaited<ReturnType<typeof readMemoryFile>>; files?: undefined; error?: undefined }
  | { error: string; files?: undefined; file?: undefined };

export async function memRead(
  db: AppDb,
  userId: string,
  path?: string,
): Promise<MemReadResult> {
  const p = path || '';
  if (!p || p.endsWith('/')) {
    const files = await listMemoryFiles(db, userId, p);
    return { files };
  } else {
    const file = await readMemoryFile(db, userId, p);
    if (file) {
      boostMemoryFileRelevance(db, userId, p).catch(() => {});
    }
    return { file };
  }
}

// ─── memWrite ───────────────────────────────────────────────────────────────

export type MemWriteResult =
  | { file: Awaited<ReturnType<typeof writeMemoryFile>>; error?: undefined }
  | { error: string; file?: undefined };

export async function memWrite(
  envDB: D1Database,
  userId: string,
  path: string,
  content: string,
): Promise<MemWriteResult> {
  const file = await writeMemoryFile(envDB, userId, path, content);
  return { file };
}

// ─── memPatch ───────────────────────────────────────────────────────────────

export type MemPatchResult =
  | { result: Awaited<ReturnType<typeof patchMemoryFile>>; error?: undefined }
  | { error: string; result?: undefined };

export async function memPatch(
  envDB: D1Database,
  userId: string,
  path: string,
  operations: any,
): Promise<MemPatchResult> {
  const result = await patchMemoryFile(envDB, userId, path, operations);
  return { result };
}

// ─── memRm ──────────────────────────────────────────────────────────────────

export type MemRmResult =
  | { deleted: number; error?: undefined }
  | { error: string; deleted?: undefined };

export async function memRm(
  envDB: D1Database,
  userId: string,
  path: string,
): Promise<MemRmResult> {
  let deleted: number;
  if (path.endsWith('/')) {
    deleted = await deleteMemoryFilesUnderPath(envDB, userId, path);
  } else {
    deleted = await deleteMemoryFile(envDB, userId, path);
  }
  return { deleted };
}

// ─── memSearch ──────────────────────────────────────────────────────────────

export type MemSearchResult =
  | { results: Awaited<ReturnType<typeof searchMemoryFiles>>; error?: undefined }
  | { error: string; results?: undefined };

export async function memSearch(
  envDB: D1Database,
  userId: string,
  query: string,
  path?: string,
  limit?: number,
): Promise<MemSearchResult> {
  const results = await searchMemoryFiles(envDB, userId, query, path, limit ?? 20);
  return { results };
}
