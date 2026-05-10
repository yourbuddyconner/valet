import {
  useNavigate,
  useParams,
  useSearch,
  Link,
} from "@tanstack/react-router";
import { MessageSquare, Plus } from "lucide-react";
import type { ThreadSummary } from "@valet/api/wire";
import {
  useCreateThread,
  useSetThreadModel,
  useThreads,
} from "~/api/queries";
import { Button, ScrollArea, Separator, Spinner } from "~/components/primitives";
import { ModelPicker } from "./model-picker";
import { modelLabel } from "~/lib/models";
import { cn } from "~/lib/cn";

/**
 * Sidebar pane: lists threads for the currently active session and lets the
 * user create new ones. Active selection lives in the URL (`?thread=…`),
 * defaulting to the first thread (engine's `web:default`) when absent.
 *
 * Caveat (v1): the WS init only loads default-thread history. Reloading the
 * page while on a non-default thread shows that thread's old messages only
 * once the user sends something new and we receive live events. Fix landing
 * with REST-driven history loading is a follow-up.
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
  const createThread = useCreateThread(sessionId);
  const navigate = useNavigate();

  // The session detail route owns the typed search; from this nested
  // (non-strict) context we read it loosely.
  const search = (useSearch({ strict: false }) ?? {}) as { thread?: string };
  const threads = data?.threads ?? [];
  // Active thread = explicit URL param, else the first (default) thread.
  const activeId = search.thread ?? threads[0]?.id;

  async function onNewThread() {
    try {
      const created = await createThread.mutateAsync();
      // Switch to the new thread immediately.
      navigate({
        to: "/sessions/$sessionId",
        params: { sessionId },
        search: { thread: created.id },
      });
    } catch (err) {
      console.error("create thread failed:", err);
    }
  }

  return (
    <>
      <header className="px-4 py-3 flex items-center justify-between gap-2">
        <h2 className="text-[10px] font-semibold uppercase tracking-wider text-[--muted]">
          Threads
        </h2>
        <Button
          variant="ghost"
          size="sm"
          onClick={onNewThread}
          disabled={createThread.isPending}
          aria-label="New thread"
          className="-mr-1"
        >
          {createThread.isPending ? <Spinner size={14} /> : <Plus className="h-4 w-4" />}
        </Button>
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
          {threads.map((t, i) => (
            <ThreadItem
              key={t.id}
              sessionId={sessionId}
              thread={t}
              index={i}
              active={t.id === activeId}
            />
          ))}
        </nav>
      </ScrollArea>
    </>
  );
}

function ThreadItem({
  sessionId,
  thread,
  index,
  active,
}: {
  sessionId: string;
  thread: ThreadSummary;
  index: number;
  active: boolean;
}) {
  const label = thread.title ?? (index === 0 ? "Default thread" : `Thread ${index + 1}`);
  const setModel = useSetThreadModel(sessionId);
  const subtitle = thread.model
    ? modelLabel(thread.model)
    : "inherits session model";

  return (
    <div
      className={cn(
        "rounded transition-colors",
        active
          ? "bg-neutral-200 dark:bg-neutral-800"
          : "hover:bg-neutral-100 dark:hover:bg-neutral-900",
      )}
    >
      <Link
        to="/sessions/$sessionId"
        params={{ sessionId }}
        // Only the default thread (index 0) renders without ?thread= so the URL
        // stays clean. Explicit threads carry their id.
        search={index === 0 ? {} : { thread: thread.id }}
        className="block w-full text-left px-3 pt-2 pb-1 text-sm"
      >
        <div className="flex items-start gap-2 min-w-0">
          <MessageSquare className="h-3.5 w-3.5 mt-0.5 text-[--muted] shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="font-medium truncate text-[--fg]">{label}</div>
            <div
              className={cn(
                "text-[10px] truncate",
                thread.model
                  ? "text-violet-700 dark:text-violet-400"
                  : "text-[--muted]/70",
              )}
            >
              {subtitle}
            </div>
          </div>
        </div>
      </Link>
      {/* Inline model picker — only visible when this is the active thread,
          to keep the sidebar dense for the rest. */}
      {active && (
        <div className="px-2 pb-1.5">
          <ModelPicker
            variant="row"
            currentId={thread.model}
            isOverride={!!thread.model}
            disabled={setModel.isPending}
            inheritLabel="Use session default"
            onSelect={(id) =>
              setModel.mutate({ threadId: thread.id, model: id })
            }
            onClear={() =>
              setModel.mutate({ threadId: thread.id, model: null })
            }
          />
        </div>
      )}
    </div>
  );
}
