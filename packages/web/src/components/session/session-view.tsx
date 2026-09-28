import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { X, ExternalLink } from "lucide-react";
import {
  useMessages,
  useSession,
  useThreads,
} from "~/api/queries";
import { useSessionWebSocket } from "~/api/ws";
import {
  queueBusy,
  useSessionStream,
  useStreamStore,
  usePendingGateForThread,
  useQueueStateForThread,
  useThreadLiveStatus,
  useErrorForThread,
  useCompactingForThread,
} from "~/stores/stream";
import { Composer } from "~/components/session/composer";
import {
  ComposerDropContext,
  type ComposerDropChannel,
  type ComposerDropIntake,
} from "~/components/session/composer-drop-context";
import { DecisionGateCard } from "~/components/session/decision-gate-card";
import { MessageList } from "~/components/session/message-list";
import { PageDropTarget } from "~/components/session/page-drop-target";
import { SandboxTabs, type SandboxTabId } from "~/components/session/sandbox-tabs";
import { BrowserOverlay } from "~/components/session/browser/browser-overlay";
import { useBrowserWatch } from "~/components/session/browser/use-browser-watch";
import { WorkArtifacts } from "~/components/session/work-discovery";
import { SessionHeader } from "~/components/session/session-header";
import { useMe } from "~/api/settings";
import { useInvalidateSessionOnModelSwitch } from "~/hooks/use-invalidate-session-on-model-switch";
import { useInvalidateMessagesOnCompaction } from "~/hooks/use-invalidate-messages-on-compaction";
import { usePendingGatesSeed } from "~/hooks/use-pending-gates-seed";
import { Button, Spinner } from "~/components/primitives";
import type { MessageReplyReference } from "@valet/api/wire";
import { defaultThreadId } from "~/lib/thread-default";

/**
 * Reusable session view (assistant-centered web UI, decisions 13/14):
 * threads/gates/tool cards/WS resume/optimistic messages — everything the
 * old `/sessions/$sessionId` route did inline — now lives here so `/chat`,
 * the child slide-over, and the standalone session page all share one
 * implementation instead of three copies.
 *
 * `panel` selects the header chrome, and nothing else. The threads/
 * thread-tree *sidebar* is NOT rendered here — it's a root-layout concern
 * (`__root.tsx` swaps `ThreadTree`/nothing based on the current route),
 * because the sidebar lives outside this component's DOM subtree in the
 * app shell's `<aside>`.
 *
 * - default: the existing `SessionHeader` (title, model picker,
 *   sandbox/connection/status chips, delete).
 * - `panel`: compact header (title, "open full page", and a ✕ close for a
 *   host that passes `onClose`) instead, with no delete/model-picker
 *   chrome — this is a lightweight peek, not the session's home.
 */
export function SessionView({
  sessionId,
  panel,
  activeThreadId,
  onClose,
  onOpenChild,
  activeTab,
  onTabChange,
  enableReplies = false,
}: {
  sessionId: string;
  /** Renders the compact slide-over header instead of `SessionHeader`. */
  panel?: boolean;
  /**
   * Controlled active thread id, typically derived from the host route's
   * `?thread=` search param (full/standalone). When omitted (panel), the
   * view falls back to the session's first/default thread.
   */
  activeThreadId?: string;
  /**
   * panel-only: closes the slide-over. Omitted by a host whose panel is
   * permanent — the workflow editor's assistant column is the surface
   * itself, so a ✕ there would offer to close something that must stay.
   */
  onClose?: () => void;
  /**
   * Called when a child-card signal is clicked. When omitted, `SignalCard`
   * falls back to a plain link to the child's full-page session view.
   */
  onOpenChild?: (childSessionId: string) => void;
  /**
   * Controlled active tab (Chat/Terminal/VS Code), typically derived from
   * the host route's `?tab=` search param (`/sessions/$sessionId`). When
   * omitted, this view falls back to internal state defaulting to "chat" —
   * the other hosts have no `?tab=` search param of their own.
   */
  activeTab?: SandboxTabId;
  /** Required alongside a controlled `activeTab`; ignored otherwise. */
  onTabChange?: (tab: SandboxTabId) => void;
  /** Enable message-level replies on an orchestrator chat surface. */
  enableReplies?: boolean;
}) {
  const session = useSession(sessionId);
  // Keep the header's model picker honest for switches this client did not
  // make itself (/model command, other tabs, direct API).
  useInvalidateSessionOnModelSwitch(sessionId);
  // Surface the compaction divider as soon as a compaction lands: the
  // engine persists the CompactionEntry before emitting `compaction_end`,
  // and this refetch is what pulls it into the transcript.
  useInvalidateMessagesOnCompaction(sessionId);
  const [localTab, setLocalTab] = useState<SandboxTabId>("chat");
  const tab = activeTab ?? localTab;
  const setTab = onTabChange ?? setLocalTab;
  const viewRef = useRef<HTMLDivElement>(null);
  const restoreTabFocus = useRef(false);
  function changeTab(next: SandboxTabId) {
    const active = document.activeElement;
    restoreTabFocus.current = next !== tab && active instanceof HTMLElement
      && active.getAttribute("role") === "tab"
      && Boolean(viewRef.current?.contains(active));
    setTab(next);
  }
  useLayoutEffect(() => {
    if (!restoreTabFocus.current) return;
    restoreTabFocus.current = false;
    // Chat owns the sliding strip; gateway tabs own the fixed strip.
    // Keep keyboard focus on the selected replacement when it moves.
    viewRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus({ preventScroll: true });
  }, [tab]);
  const threads = useThreads(sessionId);
  // Open the WS — pipes events into the store keyed by sessionId.
  useSessionWebSocket(sessionId);
  const stream = useSessionStream(sessionId);

  // The shared default keeps an omitted ?thread aligned with the sidebar, regardless of its sort mode.
  const effectiveThreadId = activeThreadId ?? defaultThreadId(threads.data?.threads ?? []);
  const [replyTarget, setReplyTarget] = useState<MessageReplyReference>();
  useEffect(() => setReplyTarget(undefined), [effectiveThreadId]);

  // Load this thread's persisted messages from REST and pipe into the
  // stream store. Background refetches are disabled (see `useMessages`) so
  // this never wipes live state mid-session.
  const messagesQ = useMessages(sessionId, effectiveThreadId);
  // Viewer identity, for message attribution: the list renders another
  // member's user messages under their name instead of "You".
  const me = useMe();
  const setThreadMessages = useStreamStore((s) => s.setThreadMessages);
  useEffect(() => {
    if (!effectiveThreadId || !messagesQ.data) return;
    setThreadMessages(
      sessionId,
      effectiveThreadId,
      messagesQ.data.messages,
      messagesQ.data.hasMore,
    );
  }, [sessionId, effectiveThreadId, messagesQ.data, setThreadMessages]);

  usePendingGatesSeed(sessionId);

  const pendingGate = usePendingGateForThread(sessionId, effectiveThreadId);
  const threadError = useErrorForThread(sessionId, effectiveThreadId);
  const compacting = useCompactingForThread(sessionId, effectiveThreadId);

  // "Agent is busy" for the header badge and the transcript indicator, from
  // the same two signals the composer's Stop/Escape affordance uses: the
  // live `status` events plus the durable queue state (which the WS
  // handshake seeds, so it survives a mid-turn page load or reconnect).
  const threadQueueState = useQueueStateForThread(sessionId, effectiveThreadId);
  const queuedMessages = useMemo(() => {
    const byItemId = new Map(
      stream.messages
        .filter((message) => message.role === "user" && message.queueItemId)
        .map((message) => [message.queueItemId, message]),
    );
    return (threadQueueState?.pendingIds ?? [])
      .map((itemId) => byItemId.get(itemId))
      .filter((message) => message !== undefined);
  }, [stream.messages, threadQueueState?.pendingIds]);
  const threadStatus = useThreadLiveStatus(sessionId, effectiveThreadId);
  const agentBusy =
    (threadStatus.status !== "idle" && threadStatus.status !== "error") ||
    queueBusy(threadQueueState);

  const browserWatch = useBrowserWatch({
    sessionId,
    threadId: effectiveThreadId,
    messages: stream.messages,
    agentBusy,
  });
  function closeBrowserPreview() {
    browserWatch.close();
    viewRef.current
      ?.querySelector<HTMLElement>('[aria-label="Watch browser"]')
      ?.focus({ preventScroll: true });
  }
  function expandBrowserPreview() {
    restoreTabFocus.current = true;
    setTab("browser");
  }

  // Composer publishes its intake pipeline into this ref. The page-level
  // drop target reads it on drop — SessionView is the closest common
  // ancestor of Composer and the chat body, so it owns the handshake. Ref,
  // not state, so a republish (composer's `intakeBlocked` flip) doesn't
  // re-render the drop target and re-attach its `document` listeners.
  const dropIntakeRef = useRef<ComposerDropIntake | null>(null);
  const dropChannel = useMemo<ComposerDropChannel>(
    () => ({
      // The proxy intake reads through the ref on each call. Its identity
      // is stable across renders, so PageDropTarget's `useEffect` doesn't
      // re-attach listeners when the composer republishes.
      intake: {
        addFiles: (files) => dropIntakeRef.current?.addFiles(files),
        // Blocked-by-default: no composer published yet means no intake.
        get blocked() {
          return dropIntakeRef.current?.blocked ?? true;
        },
        get ownedEl() {
          return dropIntakeRef.current?.ownedEl ?? null;
        },
      },
      publish: (next) => {
        dropIntakeRef.current = next;
      },
    }),
    [],
  );

  if (session.isLoading) {
    return (
      <div className="flex-1 grid place-items-center text-sm text-muted">
        <Spinner /> Loading session…
      </div>
    );
  }
  if (session.error || !session.data) {
    return (
      <div className="flex-1 grid place-items-center text-center text-sm text-danger-500 p-8">
        Failed to load session
        <div className="text-xs text-muted mt-1">{(session.error as Error)?.message}</div>
      </div>
    );
  }

  const sessionHeader = (
    <SessionHeader
      session={session.data}
      agentStatus={threadStatus.status}
      turnStartedAt={threadStatus.turnStartedAt}
      conn={stream.conn}
      sandbox={stream.sandbox}
      threadId={effectiveThreadId}
      messages={stream.messages}
    />
  );
  const sandboxTabs = (
    <SandboxTabs
      sessionId={sessionId}
      profile={session.data.profile}
      activeTab={tab}
      onTabChange={changeTab}
      sandbox={stream.sandbox}
      onWatchBrowser={browserWatch.open}
      browserPreviewOpen={browserWatch.mode === "open"}
    />
  );

  return (
    <ComposerDropContext.Provider value={dropChannel}>
    <div ref={viewRef} className="flex-1 flex flex-col min-h-0 min-w-0">
      {(panel || tab !== "chat") && (
        <>
          {panel ? <PanelHeader sessionId={sessionId} title={session.data.title} onClose={onClose} /> : sessionHeader}
          {sandboxTabs}
        </>
      )}
      {tab === "chat" ? (
        <PageDropTarget>
          <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
            {effectiveThreadId && <div className="border-b border-line px-4 pb-2"><WorkArtifacts
              key={`${sessionId}:${effectiveThreadId}`} sessionId={sessionId} threadId={effectiveThreadId}
              owner={{ ownerType: session.data.owner.type, ownerId: session.data.owner.id }}
            /></div>}
            <MessageList
              header={panel ? undefined : <>{sessionHeader}{sandboxTabs}</>}
              messages={stream.messages}
              threadId={effectiveThreadId}
              onOpenChild={onOpenChild}
              agentBusy={agentBusy}
              pendingIds={threadQueueState?.pendingIds}
              viewerId={me.data?.id}
              onReply={enableReplies ? setReplyTarget : undefined}
            />
            {(browserWatch.mode === "open" || browserWatch.mode === "minimized") && (
              <BrowserOverlay
                key={JSON.stringify([sessionId, effectiveThreadId])}
                sessionId={sessionId}
                threadId={effectiveThreadId}
                working={browserWatch.working}
                minimized={browserWatch.mode === "minimized"}
                onMinimize={browserWatch.minimize}
                onRestore={browserWatch.open}
                onClose={closeBrowserPreview}
                onExpand={expandBrowserPreview}
              />
            )}
          </div>
          {compacting && (
            <div className="border-t border-[--border] px-4 py-1.5 text-[11px] text-muted">
              Compacting context…
            </div>
          )}
          {threadError && (
            <div className="border-t border-danger-500/30 bg-danger-500/5 px-4 py-2 text-xs text-danger-600">
              <span className="font-medium">{threadError.code}:</span> {threadError.message}
            </div>
          )}
          {/* Keyed by gate id: the question input's draft must not carry
              over when the pending gate changes (e.g. a thread switch to a
              different pending gate). */}
          {pendingGate && (
            <DecisionGateCard key={pendingGate.id} sessionId={sessionId} gate={pendingGate} />
          )}
          {/* No key: drafts are per-thread in the composer-drafts store, so
              a thread switch swaps the draft without a remount (a remount
              would orphan in-flight uploads). */}
          <Composer
            sessionId={sessionId}
            threadId={effectiveThreadId}
            agentStatus={threadStatus.status}
            queuedMessages={queuedMessages}
            queuedItemCount={threadQueueState?.pendingIds.length ?? 0}
            replyTarget={replyTarget}
            onCancelReply={() => setReplyTarget(undefined)}
          />
        </PageDropTarget>
      ) : null}
    </div>
    </ComposerDropContext.Provider>
  );
}

function PanelHeader({
  sessionId,
  title,
  onClose,
}: {
  sessionId: string;
  title?: string;
  onClose?: () => void;
}) {
  return (
    <header className="border-b border-line px-4 py-3 flex items-center gap-3">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold tracking-tight truncate text-ink">
          {title || "Untitled session"}
        </div>
      </div>
      <Link
        to="/sessions/$sessionId"
        params={{ sessionId }}
        className="inline-flex items-center gap-1 text-xs text-muted hover:text-moss"
        aria-label="Open full page"
      >
        <ExternalLink className="h-3.5 w-3.5" />
        open full page
      </Link>
      {onClose && (
        <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close panel">
          <X className="h-4 w-4" />
        </Button>
      )}
    </header>
  );
}
