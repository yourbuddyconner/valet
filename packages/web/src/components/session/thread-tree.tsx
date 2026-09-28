import { useWorkspaceRuntimeInfo } from "~/api/workspace-runtime";
import { useChildWork, flattenChildWork, useDismissChild } from "~/api/child-work";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import {
  Archive,
  ArchiveRestore,
  ArrowDownUp,
  Bell,
  Check,
  ChevronDown,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import type {
  DecisionGate,
  GetModelTiersResponse,
  ModelInfo,
  ChildWorkSummary,
  ThreadSummary,
} from "@valet/api/wire";
import {
  useArchivedThreads,
  useCreateThread,
  useRenameThread,
  useReplaceSandbox,
  useSession,
  useSetThreadArchived,
  useThreads,
} from "~/api/queries";
import { useComposerPrefillStore } from "~/stores/composer-prefill";
import { useChatHotkeysStore } from "~/stores/chat-hotkeys";
import { useModels, useModelTiers } from "~/api/settings";
import { usePendingGatesSeed } from "~/hooks/use-pending-gates-seed";
import { useStreamStore } from "~/stores/stream";
import { createDebouncer } from "~/lib/debounce";
import { formatChord } from "~/lib/chat-keybindings";
import {
  bucketCounts,
  filterThreads,
  THREAD_ORIGIN_FILTERS,
  threadOriginBucket,
  type ThreadOriginBucket,
} from "~/lib/thread-origin";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Spinner,
  Tooltip,
} from "~/components/primitives";
import { formatWhen } from "~/lib/format-when";
import { cn } from "~/lib/cn";
import { sameModelSpec } from "~/lib/models";
import { isSizeTier, selectionLabel, tierSubtitle, TIER_LABELS } from "~/lib/model-tiers";
import { getSubconversationsCollapsed, setSubconversationsCollapsed } from "~/lib/preferences";
import { defaultThreadId } from "~/lib/thread-default";

/** Creation order, not the current sidebar order, determines this label. */
export function untitledThreadLabel(thread: ThreadSummary, isNewestCreated: boolean): string {
  return isNewestCreated ? "New thread" : formatWhen(thread.createdAt);
}

const BUCKET_STORAGE_KEY = "valet:thread-bucket";
const THREAD_SORT_STORAGE_KEY = "valet:thread-sort";

export const THREAD_SORT_MODES = [
  { id: "last-user-activity", label: "Last user activity" },
  { id: "created", label: "Created" },
] as const;

export type ThreadSortMode = (typeof THREAD_SORT_MODES)[number]["id"];

function loadStoredThreadSort(): ThreadSortMode {
  try {
    const raw = window.localStorage.getItem(THREAD_SORT_STORAGE_KEY);
    const mode = THREAD_SORT_MODES.find((candidate) => candidate.id === raw);
    if (mode) return mode.id;
  } catch {
    // Fall through.
  }
  return "last-user-activity";
}

/** Pure: orders active threads by the selected per-user preference. */
export function sortThreads(threads: ThreadSummary[], mode: ThreadSortMode): ThreadSummary[] {
  return [...threads].sort((a, b) => {
    if (mode === "created") return b.createdAt - a.createdAt;
    return b.lastUserActivityAt - a.lastUserActivityAt || b.createdAt - a.createdAt;
  });
}

function loadStoredBucket(): ThreadOriginBucket {
  try {
    const raw = window.localStorage.getItem(BUCKET_STORAGE_KEY);
    if (raw && THREAD_ORIGIN_FILTERS.some((f) => f.id === raw)) return raw as ThreadOriginBucket;
  } catch {
    // Fall through.
  }
  return "all";
}

const CHILDREN_POLL_MS = 30_000;
const CHILDREN_INVALIDATE_DEBOUNCE_MS = 500;

/** Stable no-op so the live-update effect doesn't re-subscribe each render
 * when children are turned off. */
const NO_REFETCH = () => {};

/** Pure: groups children by the thread that spawned them. */
export function groupChildrenByThread(
  children: ChildWorkSummary[],
): Map<string, ChildWorkSummary[]> {
  const map = new Map<string, ChildWorkSummary[]>();
  for (const c of children) {
    const list = map.get(c.parentThreadId);
    if (list) list.push(c);
    else map.set(c.parentThreadId, [c]);
  }
  return map;
}

/**
 * Pure: the ids of threads that hold at least one pending gate. Feeds the
 * per-thread response-required bell (TKAI-258): the gate card and header badge are
 * scoped to the ACTIVE thread, so this bell is the only in-session surface
 * for a gate pending on a thread you are not looking at.
 */
export function threadIdsWithPendingGates(
  gates: Record<string, DecisionGate> | undefined,
): Set<string> {
  const ids = new Set<string>();
  for (const g of Object.values(gates ?? {})) ids.add(g.threadId);
  return ids;
}

/**
 * Pure: the rows the tree renders. Applies the origin-bucket and search
 * filters, but a thread with a pending gate is exempt from both — hiding
 * the row would hide the only in-session surface for its gate.
 */
export function visibleThreads(
  threads: ThreadSummary[],
  bucket: ThreadOriginBucket,
  query: string,
  gatedThreadIds: Set<string>,
): ThreadSummary[] {
  const filtered = filterThreads(threads, bucket, query);
  if (gatedThreadIds.size === 0) return filtered;
  const shown = new Set(filtered.map((t) => t.id));
  return threads.filter((t) => shown.has(t.id) || gatedThreadIds.has(t.id));
}

/**
 * Pure: true when a pending gate sits on a thread that is NOT in the
 * active-thread list — an archived thread. Marks the "Show archived"
 * toggle so the gate has a surface while the section is closed.
 */
export function hasGateOutsideList(
  threads: ThreadSummary[],
  gatedThreadIds: Set<string>,
): boolean {
  if (gatedThreadIds.size === 0) return false;
  const listed = new Set(threads.map((t) => t.id));
  for (const id of gatedThreadIds) {
    if (!listed.has(id)) return true;
  }
  return false;
}

/** Pure: status-dot class for a child row. Calm-companion visual language —
 * running is moss with a subtle pulse, settled is a muted checkmark. */
export function childStatusDotClassName(status: ChildWorkSummary["status"]): string {
  return status === "running"
    ? "bg-moss animate-pulse motion-reduce:animate-none"
    : "bg-muted";
}

/**
 * Chat sidebar (assistant-centered web UI, decision 12): the assistant's
 * threads with children nested beneath the thread that spawned them.
 *
 * Design: no section header — the sidebar IS the threads list. "New
 * thread" is the first affordance (top of the list, where creation
 * belongs), rows are plain truncated titles with one active-state
 * treatment (moss left rail + soft ink wash), and the full title is
 * recoverable via hover tooltip when truncated.
 */
export function ThreadTree({ sessionId: override, showChildren = true }: ThreadTreeProps = {}) {
  const info = useWorkspaceRuntimeInfo(override ? undefined : "user");
  // No `override` means the caller's own assistant — the original and still
  // the default behavior.
  const sessionId = override ?? info.data?.sessionId;

  if (!sessionId) return <ThreadTreeWaiting />;

  return <ThreadTreeInner sessionId={sessionId} showChildren={showChildren} />;
}

/**
 * The tree's empty state: what stands in its place while the session it
 * would list is not yet known, or not yet created. The rail draws it for an
 * assistant whose session the page is still ensuring, so the tree's reads
 * do not run against a session that does not exist.
 */
export function ThreadTreeWaiting() {
  return (
    <div className="px-4 py-6 text-center text-xs text-muted">
      <Spinner size={14} />
    </div>
  );
}

export interface ThreadTreeProps {
  /** Whose threads to show. Defaults to the caller's own assistant. */
  sessionId?: string;
  /**
   * Nest child sessions under the thread that spawned them. Safe for any
   * assistant the caller can view: `GET /api/sessions/:sessionId/children`
   * scopes the list to THIS `sessionId` (access-checked), so a team
   * assistant's runs nest under its own threads rather than borrowing the
   * caller's personal children.
   */
  showChildren?: boolean;
}

function ThreadTreeInner({ sessionId, showChildren }: { sessionId: string; showChildren: boolean }) {
  const threadsQ = useThreads(sessionId);
  // Session default model, for the pin chip: a chip renders only on threads
  // whose pin DIVERGES from it (every new thread pins at creation, so an
  // always-on chip would just be noise).
  const sessionQ = useSession(sessionId);
  const sessionModel = sessionQ.data?.model;
  const modelsQ = useModels();
  const tierMapQ = useModelTiers();
  const childrenQ = useChildWork(sessionId, {
    refetchInterval: CHILDREN_POLL_MS,
    enabled: showChildren,
  });
  // `refetch()` fires even on a disabled query, so gate the live-update
  // hook too rather than relying on `enabled` alone.
  useInvalidateChildrenOnQueueState(sessionId, showChildren ? childrenQ.refetch : NO_REFETCH);
  const createThread = useCreateThread(sessionId);
  const setArchived = useSetThreadArchived(sessionId);
  const renameThread = useRenameThread(sessionId);
  const replaceSandbox = useReplaceSandbox(sessionId);
  const dismissChild = useDismissChild(sessionId);
  const [showArchived, setShowArchived] = useState(false);
  const archivedQ = useArchivedThreads(sessionId, { enabled: showArchived });
  const navigate = useNavigate({ from: "/chat" });

  const search = (useSearch({ strict: false }) ?? {}) as { thread?: string; child?: string };
  const [sortMode, setSortMode] = useState<ThreadSortMode>(() => loadStoredThreadSort());
  const threads = useMemo(
    () => sortThreads(threadsQ.data?.threads ?? [], sortMode),
    [threadsQ.data, sortMode],
  );
  // Both the sidebar and SessionView use this creation-order default. Sort only changes row order.
  const defaultId = defaultThreadId(threads);
  const activeThreadId = search.thread ?? defaultId;
  const grouped = groupChildrenByThread(showChildren ? (childrenQ.error ? [] : flattenChildWork(childrenQ.data)) : []);

  // Seed pending gates from REST for ourselves — the tree must not depend
  // on a SessionView being mounted for the same session. Live updates
  // arrive via the wire (`gate.*` frames); the record's identity only
  // changes when a gate opens or resolves, so the derived set is cheap.
  usePendingGatesSeed(sessionId);
  const pendingGates = useStreamStore((s) => s.bySession[sessionId]?.pendingGates);
  const gatedThreadIds = useMemo(() => threadIdsWithPendingGates(pendingGates), [pendingGates]);

  const [bucket, setBucket] = useState<ThreadOriginBucket>(() => loadStoredBucket());
  const [query, setQuery] = useState("");
  const counts = useMemo(() => bucketCounts(threads), [threads]);
  // Chips earn their row only when threads actually span buckets — a
  // chat-only session keeps the sidebar clean.
  const bucketsInUse = THREAD_ORIGIN_FILTERS.filter((f) => f.id !== "all" && counts[f.id] > 0);
  const showFilters = bucketsInUse.length > 1;
  const effectiveBucket = showFilters ? bucket : "all";
  const visible = useMemo(
    () => visibleThreads(threads, effectiveBucket, query, gatedThreadIds),
    [threads, effectiveBucket, query, gatedThreadIds],
  );
  // A gate on an archived thread has no row in `visible`; without this the
  // gate would be invisible while the archived section is closed.
  const archivedGated = threadsQ.data !== undefined && hasGateOutsideList(threads, gatedThreadIds);

  // Auto-switch when the ACTIVE thread would be filtered out (deep link
  // into an automation thread while the chip says Chat) — the selection
  // must always be visible in the list.
  useEffect(() => {
    if (!showFilters || bucket === "all") return;
    const active = threads.find((t) => t.id === activeThreadId);
    if (active && threadOriginBucket(active) !== bucket) {
      setBucket("all");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeThreadId, threads, showFilters]);

  function selectThreadSort(next: ThreadSortMode) {
    setSortMode(next);
    try {
      window.localStorage.setItem(THREAD_SORT_STORAGE_KEY, next);
    } catch {
      // In-session only when storage is unavailable.
    }
  }

  function selectBucket(next: ThreadOriginBucket) {
    setBucket(next);
    try {
      window.localStorage.setItem(BUCKET_STORAGE_KEY, next);
    } catch {
      // In-session only when storage is unavailable.
    }
  }

  const searchInputRef = useRef<HTMLInputElement>(null);

  async function createAndNavigate() {
    const thread = await createThread.mutateAsync(
      activeThreadId ? { sourceThreadId: activeThreadId } : {},
    );
    navigate({ search: (prev) => ({ ...prev, view: undefined, thread: thread.id, child: undefined }) });
    // Land the cursor in the composer — a fresh thread exists to be
    // typed into.
    useComposerPrefillStore.getState().requestFocus();
  }

  const archiveActive = useCallback(() => {
    if (!activeThreadId) return;
    void setArchived.mutateAsync({ threadId: activeThreadId, archived: true });
    navigate({ search: (prev) => ({ ...prev, view: undefined, thread: undefined, child: undefined }) });
  }, [activeThreadId, navigate, setArchived]);

  // Register this surface's hotkey targets for the global listener.
  useEffect(() => {
    return useChatHotkeysStore.getState().register({
      newThread: () => void createAndNavigate(),
      archiveActiveThread: archiveActive,
      focusThreadSearch: () => searchInputRef.current?.focus(),
    });
    // createAndNavigate closes over createThread/navigate; re-register when
    // those identities change so the hotkey never calls a stale mutator.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [archiveActive, createThread, navigate]);

  return (
    <>
      {/* Match the search field below (`px-2`). The collapse toggle no
          longer floats over the sidebar — it now sits in the top nav
          (see `SidebarControls` in `app-shell.tsx`), so there is nothing
          left to reserve room for at the aside's top-right corner. */}
      <div className="flex items-center gap-1 px-2 pt-2">
        <button
          type="button"
          onClick={() => void createAndNavigate()}
          disabled={createThread.isPending}
          className="flex-1 flex items-center gap-2 rounded px-2 py-1.5 text-sm text-muted hover:text-ink hover:bg-ink-wash transition-colors focus-visible:outline-none focus-visible:bg-ink-wash disabled:opacity-50 whitespace-nowrap"
        >
          <Plus className="h-3.5 w-3.5 shrink-0" />
          <span>New thread</span>
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Sort threads"
              className="inline-flex items-center justify-center rounded p-1.5 text-muted hover:text-ink hover:bg-ink-wash focus-visible:outline-none focus-visible:bg-ink-wash"
            >
              <ArrowDownUp className="h-3.5 w-3.5" aria-hidden />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" aria-label="Thread sort order">
            {THREAD_SORT_MODES.map((mode) => (
              <DropdownMenuItem
                key={mode.id}
                onSelect={() => selectThreadSort(mode.id)}
                aria-checked={sortMode === mode.id}
                role="menuitemradio"
              >
                {sortMode === mode.id && <Check className="h-3.5 w-3.5" aria-hidden />}
                {mode.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="px-2 pt-1 pb-2 space-y-1.5">
        <div className="flex items-center gap-1.5 rounded border border-line bg-[--bg] px-2 focus-within:border-moss/60">
          <Search className="h-3.5 w-3.5 text-muted shrink-0" aria-hidden />
          <input
            ref={searchInputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search threads…"
            aria-label="Search threads"
            className="h-7 w-full min-w-0 bg-transparent text-sm text-ink placeholder:text-muted focus:outline-none"
          />
          {query && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setQuery("")}
              className="text-muted hover:text-ink"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        {showFilters && (
          <div className="flex flex-wrap gap-1" role="tablist" aria-label="Thread origin">
            {[THREAD_ORIGIN_FILTERS[0]!, ...bucketsInUse].map((f) => (
              <button
                key={f.id}
                type="button"
                role="tab"
                aria-selected={effectiveBucket === f.id}
                onClick={() => selectBucket(f.id)}
                className={cn(
                  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] transition-colors",
                  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-moss",
                  effectiveBucket === f.id
                    ? "bg-moss-wash-strong text-ink font-medium"
                    : "text-muted hover:text-ink hover:bg-ink-wash",
                )}
              >
                {f.label}
                <span className="tabular-nums text-[10px] opacity-70">{counts[f.id]}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      {/* Plain overflow div, NOT the Radix ScrollArea — its viewport wraps
          content in a `display: table` div that sizes to intrinsic content
          width, which defeats both the sidebar's max-content sizing and
          row truncation when clamped. */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <nav className="pb-3">
          {threadsQ.isLoading && (
            <div className="px-4 py-3 flex items-center gap-2 text-sm text-muted">
              <Spinner size={14} /> Loading…
            </div>
          )}
          {threadsQ.error && (
            <div className="px-4 py-3 text-sm text-danger-500">Failed to load threads</div>
          )}
          {!threadsQ.isLoading && !threadsQ.error && visible.length === 0 && threads.length > 0 && (
            <div className="px-4 py-3 text-xs text-muted">
              No threads match{query ? ` "${query}"` : " this filter"}.
            </div>
          )}
          {visible.map((t) => (
            <ThreadNode
              key={t.id}
              thread={t}
              isDefault={t.id === defaultId}
              sessionModel={sessionModel}
              models={modelsQ.data?.models ?? []}
              tierMap={tierMapQ.data}
              active={t.id === activeThreadId}
              hasPendingGate={gatedThreadIds.has(t.id)}
              childSessions={grouped.get(t.id) ?? []}
              activeChildId={search.child}
              onArchive={(threadId) => {
                void setArchived.mutateAsync({ threadId, archived: true });
                // Archiving the thread you're looking at would strand the
                // view on a thread absent from the list — return to the
                // default thread.
                if (threadId === activeThreadId) {
                  navigate({ search: (prev) => ({ ...prev, view: undefined, thread: undefined, child: undefined }) });
                }
              }}
              onReplaceSandbox={() => void replaceSandbox.mutateAsync()}
              onDismissChild={(childSessionId) => void dismissChild.mutateAsync(childSessionId)}
              onRename={(threadId, title) =>
                void renameThread.mutateAsync({ threadId, title })
              }
            />
          ))}
        </nav>
        {showChildren && childrenQ.isLoading && <p className="px-4 py-2 text-xs text-muted">Loading work…</p>}
        {showChildren && childrenQ.error && <p className="px-4 py-2 text-xs text-danger-500">Could not load work. <button onClick={() => void childrenQ.refetch()} className="underline">Retry</button></p>}
        {showChildren && !childrenQ.error && childrenQ.hasNextPage && <button className="px-4 py-2 text-xs text-moss" disabled={childrenQ.isFetchingNextPage} onClick={() => void childrenQ.fetchNextPage()}>{childrenQ.isFetchingNextPage ? "Loading…" : "Load more work"}</button>}
        <div className="border-t border-line/60 px-2 py-1.5">
          <button
            type="button"
            onClick={() => setShowArchived((v) => !v)}
            aria-expanded={showArchived}
            className="w-full max-md:min-h-11 flex items-center gap-2 rounded px-2 py-1 text-xs text-muted hover:text-ink hover:bg-ink-wash transition-colors focus-visible:outline-none focus-visible:bg-ink-wash"
          >
            <Archive className="h-3 w-3 shrink-0" aria-hidden />
            <span>{showArchived ? "Hide archived" : "Show archived"}</span>
            {archivedGated && (
              <span role="img" aria-label="Response required" title="Response required">
                <Bell className="h-3 w-3 shrink-0 text-amber-600 dark:text-amber-300" aria-hidden />
              </span>
            )}
          </button>
          {showArchived && (
            <ul className="mt-1 space-y-0.5">
              {(archivedQ.data?.threads ?? []).length === 0 && !archivedQ.isLoading && (
                <li className="px-2 py-1 text-xs text-muted">No archived threads.</li>
              )}
              {(archivedQ.data?.threads ?? []).map((t) => (
                <li key={t.id} className="flex items-center gap-1 px-2 py-1 text-xs text-muted">
                  <span className="flex-1 truncate">{t.title ?? t.id}</span>
                  {gatedThreadIds.has(t.id) && (
                    <span role="img" aria-label="Response required" title="Response required">
                      <Bell className="h-3 w-3 shrink-0 text-amber-600 dark:text-amber-300" aria-hidden />
                    </span>
                  )}
                  <button
                    type="button"
                    aria-label={`Unarchive ${t.title ?? t.id}`}
                    onClick={() => void setArchived.mutateAsync({ threadId: t.id, archived: false })}
                    className="inline-flex items-center justify-center max-md:min-h-11 max-md:min-w-11 shrink-0 rounded p-0.5 hover:text-ink hover:bg-ink-wash focus-visible:outline-none focus-visible:bg-ink-wash"
                  >
                    <ArchiveRestore className="h-3 w-3" aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </>
  );
}

function ThreadNode({
  thread,
  isDefault,
  sessionModel,
  models,
  tierMap,
  active,
  hasPendingGate,
  childSessions,
  activeChildId,
  onArchive,
  onReplaceSandbox,
  onDismissChild,
  onRename,
}: {
  thread: ThreadSummary;
  isDefault: boolean;
  /** Session default model — the pin chip shows only when the thread's pin diverges from it. */
  sessionModel?: string;
  models: ModelInfo[];
  tierMap?: GetModelTiersResponse;
  active: boolean;
  /** The thread holds a pending decision gate — show the response-required bell. */
  hasPendingGate: boolean;
  childSessions: ChildWorkSummary[];
  activeChildId?: string;
  onArchive: (threadId: string) => void;
  onReplaceSandbox: () => void;
  onDismissChild: (childSessionId: string) => void;
  /** Send `null` to clear the stored title. */
  onRename: (threadId: string, title: string | null) => void;
}) {
  const label = thread.title ?? untitledThreadLabel(thread, isDefault);
  const [collapsed, setCollapsed] = useState(() => getSubconversationsCollapsed(thread.id));

  useEffect(() => {
    setCollapsed(getSubconversationsCollapsed(thread.id));
  }, [thread.id]);

  function toggleCollapsed() {
    const next = !collapsed;
    setCollapsed(next);
    setSubconversationsCollapsed(thread.id, next);
  }

  // Pin chip: the thread runs on a model other than the session default.
  // Requires a KNOWN session default — while the session query loads, and
  // for non-live sessions (GET /sessions/:id omits `model` unless the
  // engine session is materialized), divergence is unknowable and a chip on
  // every stamped thread would be pure noise.
  const pinnedModel =
    sessionModel && thread.model && !sameModelSpec(thread.model, sessionModel)
      ? thread.model
      : undefined;
  const pinnedTier = isSizeTier(pinnedModel) ? pinnedModel : undefined;
  const pinnedModelLabel = pinnedModel
    ? pinnedTier
      ? tierSubtitle(pinnedTier, tierMap, models)
      : selectionLabel(pinnedModel, tierMap, models)
    : undefined;

  // Port the v1 inline editor. Enter and blur save. Escape cancels.
  // `savedRef` prevents Enter and its following blur from saving twice.
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const savedRef = useRef(false);

  useEffect(() => {
    if (!isEditing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [isEditing]);

  const startEditing = () => {
    setDraft(thread.title ?? "");
    savedRef.current = false;
    setIsEditing(true);
  };

  const commit = () => {
    if (savedRef.current) return;
    savedRef.current = true;
    const trimmed = draft.trim();
    const currentTitle = thread.title?.trim() ?? "";
    if (trimmed !== currentTitle) {
      onRename(thread.id, trimmed.length === 0 ? null : trimmed);
    }
    setIsEditing(false);
  };

  const cancel = () => {
    savedRef.current = true;
    setIsEditing(false);
  };

  const [menuOpen, setMenuOpen] = useState(false);
  // The menu-scoped `A`, plus the global chord shown beside it as a hint.
  const archiveGlobalHint = formatChord({ shift: true, code: "Backspace", key: "Backspace" });

  const handleMenuKeyDown = useCallback(
    (e: ReactKeyboardEvent) => {
      // A bare `A` only. Without this, Select All (⌘A / Ctrl+A) pressed
      // while the menu happens to be open archives the thread.
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "A" || e.key === "a") {
        e.preventDefault();
        onArchive(thread.id);
        setMenuOpen(false);
      }
    },
    [onArchive, thread.id],
  );

  return (
    <div>
      {/* Row = link + context menu side by side; nesting the menu button
          inside the Link would make it part of the navigation target. */}
      <div
        className={cn(
          "group flex items-center pr-2 transition-colors",
          active
            ? "bg-moss-wash-strong border-l-2 border-moss"
            : "hover:bg-ink-wash/60 border-l-2 border-transparent",
        )}
      >
        {isEditing ? (
          <div className={cn("flex-1 min-w-0 py-1", active ? "pl-[calc(1rem-2px)]" : "pl-4")}>
            <input
              ref={inputRef}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  commit();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  cancel();
                }
              }}
              onBlur={commit}
              maxLength={200}
              aria-label={`Rename thread: ${label}`}
              placeholder="Thread name"
              className={cn(
                "w-full rounded border border-line bg-surface px-1.5 py-0.5 text-sm text-ink",
                "outline-none focus:ring-1 focus:ring-moss",
              )}
            />
          </div>
        ) : (
          <Tooltip content={label} delayDuration={600}>
            <Link
              to="/chat"
              search={(prev) => ({
                ...prev,
                view: undefined,
                thread: isDefault ? undefined : thread.id,
                child: undefined,
              })}
              className={cn(
                "flex-1 min-w-0 max-md:min-h-11 flex items-center py-2 text-sm",
                "focus-visible:outline-none focus-visible:bg-ink-wash",
                active ? "text-ink pl-[calc(1rem-2px)] font-medium" : "text-ink/85 pl-4",
              )}
              onDoubleClick={(event) => {
                event.stopPropagation();
                startEditing();
              }}
            >
              <span className="flex-1 truncate">{label}</span>
              {pinnedModelLabel && (
                <span className="ml-2 flex min-w-0 items-center gap-1" title={pinnedModelLabel}>
                  <span className="max-w-28 truncate text-[10px] font-normal text-muted">
                    {pinnedModelLabel}
                  </span>
                  {pinnedTier && (
                    <span className="shrink-0 rounded-sm bg-ink-wash px-1 py-0.5 text-[9px] font-normal text-muted">
                      {TIER_LABELS[pinnedTier]}
                    </span>
                  )}
                </span>
              )}
              {hasPendingGate && (
                <span role="img" aria-label="Response required" title="Response required">
                  <Bell
                    className="ml-2 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-300"
                    aria-hidden
                  />
                </span>
              )}
            </Link>
          </Tooltip>
        )}
        {childSessions.length > 0 && (
          <button
            type="button"
            aria-label={`${collapsed ? "Expand" : "Collapse"} subconversations for ${label}`}
            aria-expanded={!collapsed}
            onClick={toggleCollapsed}
            className="inline-flex items-center justify-center max-md:min-h-11 max-md:min-w-11 shrink-0 rounded p-1 text-muted hover:text-ink hover:bg-ink-wash focus-visible:outline-none focus-visible:bg-ink-wash"
          >
            <ChevronDown
              className={cn("h-3.5 w-3.5 transition-transform", collapsed && "-rotate-90")}
              aria-hidden
            />
          </button>
        )}
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={`Thread menu: ${label}`}
              className="inline-flex items-center justify-center max-md:min-h-11 max-md:min-w-11 shrink-0 rounded p-1 text-muted opacity-0 max-md:opacity-100 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 hover:text-ink hover:bg-ink-wash focus-visible:outline-none"
            >
              <MoreHorizontal className="h-3.5 w-3.5" aria-hidden />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" onKeyDown={handleMenuKeyDown}>
            <DropdownMenuItem
              onSelect={() => onArchive(thread.id)}
              className="justify-between gap-3"
            >
              <span className="inline-flex items-center gap-2">
                <Archive className="h-3.5 w-3.5" aria-hidden />
                Archive thread
              </span>
              <span className="text-[10px] text-muted tabular-nums" title={archiveGlobalHint}>
                A
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => startEditing()}>
              <Pencil className="h-3.5 w-3.5 mr-2" aria-hidden />
              Rename thread
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onReplaceSandbox}>
              <RefreshCw className="h-3.5 w-3.5 mr-2" aria-hidden />
              Replace sandbox (all threads)
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {childSessions.length > 0 && !collapsed && (
        <ul className="ml-8 mt-0.5 mb-1 border-l border-line/60 pl-2 space-y-0.5">
          {childSessions.map((c) => (
            <li key={c.sessionId} className="group/child flex items-center gap-1">
              <Link
                to="/chat"
                search={(prev) => ({ ...prev, view: undefined, child: c.sessionId })}
                className={cn(
                  "flex-1 min-w-0 max-md:min-h-11 flex items-center gap-2 rounded px-2 py-1.5 text-xs transition-colors",
                  "focus-visible:outline-none focus-visible:bg-ink-wash",
                  // Settled children recede: their work is done and their
                  // compute reclaimed — visually distinct from live ones.
                  c.status === "settled" && "opacity-60",
                  c.sessionId === activeChildId
                    ? "bg-moss-wash-strong text-ink"
                    : "text-muted hover:bg-ink-wash/60 hover:text-ink",
                )}
              >
                <MessageSquare className="h-3 w-3 shrink-0" />
                <span className="flex-1 truncate">{c.title || c.sessionId}</span>
                {c.status === "settled" ? (
                  <span role="img" aria-label="settled" className="shrink-0 text-muted">
                    ✓
                  </span>
                ) : (
                  <span
                    role="img"
                    aria-label="running"
                    className={cn("h-1.5 w-1.5 shrink-0 rounded-full", childStatusDotClassName(c.status))}
                  />
                )}
              </Link>
              {c.status === "settled" && (
                <button
                  type="button"
                  aria-label={`Dismiss ${c.title || c.sessionId}`}
                  onClick={() => onDismissChild(c.sessionId)}
                  className="inline-flex items-center justify-center max-md:min-h-11 max-md:min-w-11 shrink-0 rounded p-0.5 text-muted opacity-0 max-md:opacity-100 group-hover/child:opacity-100 focus-visible:opacity-100 hover:text-ink hover:bg-ink-wash focus-visible:outline-none"
                >
                  <X className="h-3 w-3" aria-hidden />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Live-updates the children query (decision 12): refetch on any
 * `queue.state` frame for the assistant session, debounced so a burst of
 * frames only triggers one refetch. The 30s poll (`refetchInterval` on
 * `useChildWork`) is the fallback for when no WS frames arrive.
 */
function useInvalidateChildrenOnQueueState(sessionId: string, refetch: () => void) {
  const queueByThread = useStreamStore((s) => s.bySession[sessionId]?.queueByThread);
  const debouncerRef = useRef<ReturnType<typeof createDebouncer> | null>(null);

  useEffect(() => {
    const debouncer = createDebouncer(refetch, CHILDREN_INVALIDATE_DEBOUNCE_MS);
    debouncerRef.current = debouncer;
    return () => debouncer.cancel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  useEffect(() => {
    if (!queueByThread) return;
    debouncerRef.current?.trigger();
  }, [queueByThread]);
}
