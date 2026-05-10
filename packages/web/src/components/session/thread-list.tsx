import { useParams } from "@tanstack/react-router";
import { MessageSquare } from "lucide-react";
import type { ThreadSummary } from "@valet/api/wire";
import { useThreads } from "~/api/queries";
import { ScrollArea, Separator, Spinner } from "~/components/primitives";
import { cn } from "~/lib/cn";

/**
 * Sidebar pane: lists threads for the currently active session. v1 is a single
 * `web:default` thread per session (server returns just that one), so the
 * list is short — but the structure is in place for multi-thread support.
 *
 * No selection state in v1: clicking a thread is a no-op since there's
 * always one. Once the server exposes thread CRUD we'll wire selection
 * through a URL query param.
 */
export function ThreadList() {
  const params = useParams({ strict: false }) as { sessionId?: string };
  const sessionId = params.sessionId;

  if (!sessionId) {
    return (
      <div className="px-4 py-6 text-center text-xs text-[--muted]">
        Pick a session from the top bar — its threads show up here.
      </div>
    );
  }

  return <ThreadListInner sessionId={sessionId} />;
}

function ThreadListInner({ sessionId }: { sessionId: string }) {
  const { data, isLoading, error } = useThreads(sessionId);

  return (
    <>
      <header className="px-4 py-3">
        <h2 className="text-[10px] font-semibold uppercase tracking-wider text-[--muted]">
          Threads
        </h2>
      </header>
      <Separator />
      <ScrollArea className="flex-1">
        <nav className="p-2 space-y-0.5">
          {isLoading && (
            <div className="px-3 py-2 flex items-center gap-2 text-sm text-[--muted]">
              <Spinner size={14} /> Loading…
            </div>
          )}
          {error && (
            <div className="px-3 py-2 text-sm text-danger-500">Failed to load threads</div>
          )}
          {data?.threads.map((t, i) => (
            // First thread is the default and always considered active in v1.
            <ThreadItem key={t.id} thread={t} active={i === 0} />
          ))}
        </nav>
      </ScrollArea>
    </>
  );
}

function ThreadItem({ thread, active }: { thread: ThreadSummary; active: boolean }) {
  return (
    <div
      className={cn(
        "block w-full text-left rounded px-3 py-2 text-sm transition-colors",
        active
          ? "bg-neutral-200 dark:bg-neutral-800 text-[--fg]"
          : "hover:bg-neutral-100 dark:hover:bg-neutral-900 text-[--fg]/90",
      )}
    >
      <div className="flex items-start gap-2 min-w-0">
        <MessageSquare className="h-3.5 w-3.5 mt-0.5 text-[--muted] shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="font-medium truncate">{thread.title || "Default thread"}</div>
        </div>
      </div>
    </div>
  );
}
