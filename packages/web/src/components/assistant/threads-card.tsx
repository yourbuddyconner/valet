import { Link } from "@tanstack/react-router";
import type { OrchestratorChildSummary, ThreadSummary } from "@valet/api/wire";
import { Spinner } from "~/components/primitives";
import { useOrchestratorChildren, useWorkspaceRuntimeInfo } from "~/api/orchestrator";
import { useThreads } from "~/api/queries";
import { relativeTime } from "~/lib/relative-time";
import { threadOriginBucket, type ThreadOriginBucket } from "~/lib/thread-origin";
import { cn } from "~/lib/cn";

const RECENT_LIMIT = 20;

/** Origin pill styling — the dashboard's one deliberate splash of color.
 * Tailwind default-palette colors (alpha-capable), NOT the CSS-var tokens
 * (whose opacity modifiers silently no-op — see theme.css). `amber-N`
 * works only because tailwind.config.ts restores the numeric amber scale
 * alongside the `amber` var token. */
const ORIGIN_PILL: Record<Exclude<ThreadOriginBucket, "all">, { label: string; className: string }> = {
  chat: { label: "chat", className: "bg-sky-500/10 text-sky-700 dark:text-sky-300" },
  auto: { label: "auto", className: "bg-amber-500/15 text-amber-700 dark:text-amber-300" },
  channel: { label: "channel", className: "bg-violet-500/10 text-violet-700 dark:text-violet-300" },
  other: { label: "other", className: "bg-neutral-500/10 text-muted" },
};

export interface ThreadActivity {
  thread: ThreadSummary;
  running: number;
  settled: number;
}

/**
 * Pure: newest-first threads (capped) joined with their children's
 * running/settled counts — the "what's going on" summary the dashboard
 * card renders. Testable without queries.
 */
export function threadActivity(
  threads: ThreadSummary[],
  children: OrchestratorChildSummary[],
  limit = RECENT_LIMIT,
): ThreadActivity[] {
  const byThread = new Map<string, { running: number; settled: number }>();
  for (const c of children) {
    const entry = byThread.get(c.parentThreadId) ?? { running: 0, settled: 0 };
    if (c.status === "settled") entry.settled += 1;
    else entry.running += 1;
    byThread.set(c.parentThreadId, entry);
  }
  return [...threads]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit)
    .map((thread) => ({
      thread,
      running: byThread.get(thread.id)?.running ?? 0,
      settled: byThread.get(thread.id)?.settled ?? 0,
    }));
}

/**
 * Dashboard threads card — replaces the old single-pane chat log. The
 * orchestrator is threaded: several strands of work can be live at once,
 * so an interleaved message log reads as noise. This card answers "what's
 * going on": recent threads, newest first, each with its running/settled
 * child counts. Clicking a row opens that thread in /chat.
 */
function OriginPill({ thread }: { thread: Pick<ThreadSummary, "key"> }) {
  const pill = ORIGIN_PILL[threadOriginBucket(thread)];
  return (
    <span
      className={cn(
        "shrink-0 rounded-full px-1.5 py-px text-[9px] font-medium uppercase tracking-wide",
        pill.className,
      )}
    >
      {pill.label}
    </span>
  );
}

export function ThreadsCard() {
  const info = useWorkspaceRuntimeInfo("user");
  const sessionId = info.data?.sessionId;

  const threadsQ = useThreads(sessionId ?? "");
  const childrenQ = useOrchestratorChildren();
  const rows = threadActivity(threadsQ.data?.threads ?? [], childrenQ.data?.children ?? []);

  return (
    <section className="min-w-0 rounded-lg border border-line bg-paper flex flex-col min-h-0">
      <header className="px-4 py-3 border-b border-line flex flex-wrap items-center justify-between gap-x-3">
        <h2 className="font-display text-base text-ink">
          <Link to="/chat" className="inline-flex min-h-11 items-center hover:text-moss sm:min-h-0">
            Threads
          </Link>
        </h2>
        <Link to="/chat" className="inline-flex min-h-11 items-center text-xs text-muted hover:text-moss sm:min-h-0">
          Open chat
        </Link>
      </header>

      <div className="flex-1 overflow-y-auto max-h-64">
        {threadsQ.isLoading && (
          <div className="px-4 py-3 flex items-center gap-2 text-xs text-muted">
            <Spinner size={14} /> Loading…
          </div>
        )}
        {threadsQ.error && (
          <div className="px-4 py-3 text-xs text-danger-500">
            Couldn't load threads.{" "}
            <button type="button" className="min-h-11 px-2 underline sm:min-h-0" onClick={() => threadsQ.refetch()}>
              Retry
            </button>
          </div>
        )}
        {!threadsQ.isLoading && !threadsQ.error && rows.length === 0 && (
          <p className="px-4 py-3 text-sm text-muted">
            No threads yet — open the chat to start a conversation.
          </p>
        )}
        <ul>
          {rows.map(({ thread, running, settled }) => (
            <li key={thread.id}>
              <Link
                to="/chat"
                search={{ thread: thread.id }}
                className="flex min-h-11 flex-wrap items-center gap-x-2.5 gap-y-1 px-4 py-3 sm:flex-nowrap sm:py-2 hover:bg-ink-wash transition-colors"
              >
                <span
                  className={cn(
                    "h-1.5 w-1.5 shrink-0 rounded-full",
                    // `bg-muted-wash`, not `bg-muted/40` — the slash modifier
                    // on a `var()` token emits no rule (theme.css trap note),
                    // so the idle dot rendered invisible. Same trap killed the
                    // row hover above: `hover:bg-ink-wash/60` emitted nothing;
                    // the wash token carries its own alpha, so it is used bare.
                    running > 0 ? "bg-moss animate-pulse motion-reduce:animate-none" : "bg-muted-wash",
                  )}
                  aria-label={running > 0 ? `${running} running` : "idle"}
                />
                <span className="min-w-0 basis-4/5 grow break-words text-sm text-ink sm:basis-auto sm:truncate">
                  {thread.title || "Untitled thread"}
                </span>
                <OriginPill thread={thread} />
                {running > 0 && (
                  <span className="shrink-0 text-[10px] font-medium text-moss">
                    {running} running
                  </span>
                )}
                {running === 0 && settled > 0 && (
                  <span className="shrink-0 text-[10px] text-muted">{settled} done</span>
                )}
                <span className="shrink-0 text-xs text-muted">{relativeTime(thread.createdAt)}</span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
