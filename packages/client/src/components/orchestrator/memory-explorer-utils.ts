export interface ImportableFile {
  path: string;
  content: string;
}

/**
 * Pulls importable { path, content } entries out of a parsed JSON value.
 * Accepts either an export bundle (`{ files: [...] }`) or a bare array, and
 * drops anything that isn't a non-empty string path with string content.
 */
export function extractImportFiles(parsed: unknown): ImportableFile[] {
  const raw = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { files?: unknown }).files)
      ? (parsed as { files: unknown[] }).files
      : [];

  const out: ImportableFile[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const { path, content } = item as { path?: unknown; content?: unknown };
    if (typeof path === 'string' && path.trim() && typeof content === 'string') {
      out.push({ path, content });
    }
  }
  return out;
}
