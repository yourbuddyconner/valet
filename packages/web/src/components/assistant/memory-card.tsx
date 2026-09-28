import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import type { MemoryTreeEntry } from "@valet/api/wire";
import { api } from "~/api/client";
import { useMemoryTree } from "~/api/memory";
import { Spinner } from "~/components/primitives";
import { relativeTime } from "~/lib/relative-time";

/** Pure — UTC date, matches the server's `journal/YYYY-MM-DD.md` convention
 * (`packages/api/src/orchestrator/bootstrap.ts` `todayJournalPath`). */
export function todayJournalPath(now: Date = new Date()): string {
  return `journal/${now.toISOString().slice(0, 10)}.md`;
}

export interface MemoryStats {
  files: number;
  journalDays: number;
  notes: number;
  pinned: number;
  lastUpdatedAt: number | null;
}

/** Pure: tree entries → the card's stat tiles. `journalDays` counts
 * journal/* files (one per day by convention); `notes` is everything
 * else. Testable without queries. */
export function memoryStats(entries: readonly MemoryTreeEntry[]): MemoryStats {
  let journalDays = 0;
  let pinned = 0;
  let lastUpdatedAt: number | null = null;
  for (const e of entries) {
    if (e.path.startsWith("journal/")) journalDays += 1;
    if (e.pinned) pinned += 1;
    if (lastUpdatedAt === null || e.updatedAt > lastUpdatedAt) lastUpdatedAt = e.updatedAt;
  }
  return {
    files: entries.length,
    journalDays,
    notes: entries.length - journalDays,
    pinned,
    lastUpdatedAt,
  };
}

/**
 * Dashboard memory card — stats + a generated one-line TL;DR of today's
 * journal, replacing the raw-text excerpt (unreadable at card size). The
 * summary comes from GET /api/memory/journal-summary (Haiku, cached
 * server-side per journal edit); stats derive from the tree query.
 */
export function MemoryCard() {
  const treeQ = useMemoryTree();
  const summaryQ = useQuery({
    queryKey: ["memory", "journal-summary"],
    queryFn: () => api.getJournalSummary(),
    refetchInterval: 5 * 60_000,
  });

  const entries = treeQ.data?.entries ?? [];
  const stats = memoryStats(entries);
  const empty = treeQ.data !== undefined && entries.length === 0;

  return (
    <section className="min-w-0 rounded-lg border border-line bg-paper flex flex-col min-h-0">
      <header className="px-4 py-3 border-b border-line flex flex-wrap items-center justify-between gap-x-3">
        <h2 className="font-display text-base text-ink">
          <Link to="/memory" className="inline-flex min-h-11 items-center hover:text-moss sm:min-h-0">
            Memory
          </Link>
        </h2>
        <Link to="/memory" className="inline-flex min-h-11 items-center text-xs text-muted hover:text-moss sm:min-h-0">
          Browse
        </Link>
      </header>

      <div className="flex-1 px-4 py-3 space-y-3 overflow-y-auto max-h-64">
        {treeQ.isLoading && (
          <div className="flex items-center gap-2 text-xs text-muted">
            <Spinner size={14} /> Loading…
          </div>
        )}
        {treeQ.error && (
          <div className="text-xs text-danger-500">
            Couldn't load memory.{" "}
            <button type="button" className="min-h-11 px-2 underline sm:min-h-0" onClick={() => treeQ.refetch()}>
              Retry
            </button>
          </div>
        )}

        {empty && (
          <p className="text-sm text-muted">
            Nothing remembered yet. Start a thread, or import a bundle from the{" "}
            <Link to="/memory" className="underline hover:text-moss">
              Memory page
            </Link>
            .
          </p>
        )}

        {!treeQ.isLoading && !treeQ.error && !empty && (
          <>
            <div className="grid grid-cols-3 gap-2">
              <StatTile label="Journal days" value={stats.journalDays} />
              <StatTile label="Notes" value={stats.notes} />
              <StatTile label="Pinned" value={stats.pinned} />
            </div>

            <div className="space-y-1">
              <div className="flex items-baseline justify-between">
                <h3 className="text-[10px] font-medium uppercase tracking-wider text-muted">
                  Today
                </h3>
                {stats.lastUpdatedAt !== null && (
                  <span className="text-[10px] text-muted">
                    updated {relativeTime(stats.lastUpdatedAt)}
                  </span>
                )}
              </div>
              {summaryQ.isLoading && (
                <div className="flex items-center gap-2 text-xs text-muted">
                  <Spinner size={12} /> Summarizing…
                </div>
              )}
              {!summaryQ.isLoading && summaryQ.data?.summary && (
                <Link
                  to="/memory/$"
                  params={{ _splat: todayJournalPath() }}
                  className="block min-h-11 text-sm sm:min-h-0 text-ink leading-snug hover:text-moss"
                >
                  {summaryQ.data.summary}
                </Link>
              )}
              {!summaryQ.isLoading && !summaryQ.data?.summary && (
                <p className="text-xs text-muted">No journal entry yet today.</p>
              )}
            </div>
          </>
        )}
      </div>
    </section>
  );
}

function StatTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="min-w-0 break-words rounded-md bg-moss-wash px-2.5 py-2">
      <div className="font-display text-lg text-ink leading-tight tabular-nums">{value}</div>
      <div className="text-[10px] uppercase tracking-wider text-muted">{label}</div>
    </div>
  );
}
