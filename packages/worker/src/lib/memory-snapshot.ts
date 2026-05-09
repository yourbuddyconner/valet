import type { D1Database } from '@cloudflare/workers-types';

// ─── Types ──────────────────────────────────────────────────────────────────

interface SnapshotFile {
  path: string;
  content: string;
}

export interface MemorySnapshot {
  files: SnapshotFile[];
  totalTokensEstimate: number;
  truncated: boolean;
}

// ─── Load Snapshot ──────────────────────────────────────────────────────────

/**
 * Load pinned memory files and recent journals for auto-injection into
 * the orchestrator's system prompt at session start.
 *
 * Priority order:
 * 1. Pinned files (preferences/*) — always included, dropped last
 * 2. Today's journal — included if it exists
 * 3. Yesterday's journal — included if it fits
 *
 * If the total exceeds the token budget, journals are truncated first,
 * then least-recently-accessed pinned files are dropped.
 */
export async function loadMemorySnapshot(
  rawDb: D1Database,
  userId: string,
  tokenBudget = 8000,
): Promise<MemorySnapshot> {
  // 1. Fetch all pinned files
  const pinnedRows = await rawDb
    .prepare(
      'SELECT path, content, last_accessed_at FROM orchestrator_memory_files WHERE user_id = ? AND pinned = 1 ORDER BY last_accessed_at DESC',
    )
    .bind(userId)
    .all<{ path: string; content: string; last_accessed_at: string }>();
  const pinnedFiles: (SnapshotFile & { lastAccessedAt: string })[] = (pinnedRows.results || []).map(
    (r) => ({
      path: r.path,
      content: r.content,
      lastAccessedAt: r.last_accessed_at,
    }),
  );

  // 2. Fetch today's and yesterday's journal
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const journalPaths = [`journal/${today}.md`, `journal/${yesterday}.md`];

  const journalRows = await rawDb
    .prepare(
      'SELECT path, content FROM orchestrator_memory_files WHERE user_id = ? AND path IN (?, ?)',
    )
    .bind(userId, journalPaths[0], journalPaths[1])
    .all<{ path: string; content: string }>();
  // Sort: today first, then yesterday
  const journalFiles: SnapshotFile[] = journalPaths
    .map((p) => (journalRows.results || []).find((r) => r.path === p))
    .filter((r): r is { path: string; content: string } => !!r && r.content.trim().length > 0);

  // 3. Estimate tokens and fit within budget
  const estimateTokens = (s: string) => Math.ceil(s.length / 4);

  let totalTokens = 0;
  let truncated = false;
  const result: SnapshotFile[] = [];

  // Add pinned files first
  for (const f of pinnedFiles) {
    const tokens = estimateTokens(f.content);
    if (totalTokens + tokens <= tokenBudget) {
      result.push({ path: f.path, content: f.content });
      totalTokens += tokens;
    } else {
      // Over budget — remaining pinned files (least-recently-accessed) are dropped
      truncated = true;
    }
  }

  // Add journals (today first, then yesterday) — truncate content if needed
  for (const f of journalFiles) {
    const tokens = estimateTokens(f.content);
    const remaining = tokenBudget - totalTokens;

    if (remaining <= 0) {
      truncated = true;
      break;
    }

    if (tokens <= remaining) {
      result.push({ path: f.path, content: f.content });
      totalTokens += tokens;
    } else {
      // Truncate journal content to fit
      const charBudget = remaining * 4;
      const truncatedContent = f.content.slice(0, charBudget) + '\n\n[... truncated]';
      result.push({ path: f.path, content: truncatedContent });
      totalTokens += remaining;
      truncated = true;
    }
  }

  return {
    files: result,
    totalTokensEstimate: totalTokens,
    truncated,
  };
}

// ─── Format Snapshot ────────────────────────────────────────────────────────

/**
 * Render a memory snapshot as markdown for injection into the orchestrator's
 * persona files. Returns empty string if no files were loaded.
 */
export function formatMemorySnapshot(snapshot: MemorySnapshot): string {
  if (snapshot.files.length === 0) return '';

  const lines: string[] = [
    '## Memory Snapshot (auto-loaded)',
    '',
    'The following files were loaded from your memory at session start. You do NOT need to call `mem_read` for these — they are already in context.',
    '',
  ];

  for (const file of snapshot.files) {
    lines.push(`### ${file.path}`, '', file.content, '');
  }

  if (snapshot.truncated) {
    lines.push(
      '> Some files were omitted or truncated to fit the token budget. Use `mem_read` to access them.',
      '',
    );
  }

  return lines.join('\n');
}
