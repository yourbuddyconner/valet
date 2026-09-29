import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { cn } from "~/lib/cn";
import { useScrollHeader } from "~/hooks/use-scroll-header";
import { ArrowDown } from "lucide-react";
import type { StreamMessage } from "~/stores/stream";
import type { MessageReplyReference } from "@valet/api/wire";
import { MessageItem } from "./message-item";
import { SignalCard } from "./signal-card";
import { CommandResult } from "./command-result";
import { CompactionDivider } from "./compaction-divider";

/**
 * Scrolling message list. Auto-scrolls to bottom when new messages arrive
 * unless the user has scrolled up — in which case we leave them alone so
 * they can read history.
 *
 * `threadId` strictly scopes the visible messages to a single thread:
 * a message shows up iff its `threadId` field equals the active id.
 * When `threadId` is undefined (threads query still loading), nothing is
 * filtered — but the Composer is also disabled in that state so no new
 * messages can be added with a missing thread tag.
 *
 * Earlier versions accepted `m.threadId === null` as a fallback for
 * optimistic user messages with no thread tag. That caused user messages
 * sent in one thread to appear in every other thread's view after a
 * switch. The Composer now requires `threadId` before submitting, so
 * optimistic messages always carry the right tag and we can filter
 * strictly here.
 */
export function MessageList({
  messages,
  threadId,
  onOpenChild,
  agentBusy = false,
  pendingIds,
  viewerId,
  header,
  onReply,
}: {
  messages: StreamMessage[];
  threadId?: string;
  /**
   * Forwarded to `SignalCard` for `child.settled` cards — opens the child
   * in the slide-over. Falls back to a full-page link when omitted.
   */
  onOpenChild?: (childSessionId: string) => void;
  /**
   * True while the agent is actively working. Suppresses the "(no
   * response)" placeholder on the LAST assistant message — a mid-stream
   * message is legitimately empty between `message_start` and its first
   * token, and must not flash as a failure.
   */
  agentBusy?: boolean;
  /** Engine queue item ids still waiting. These messages render above the composer. */
  pendingIds?: string[];
  /**
   * The signed-in user's id. A user message from someone else (a teammate
   * on a shared session) renders under the sender's name; the viewer's own
   * messages keep "You". Undefined while `/me` loads — senders then show
   * by name, which is accurate, just not "You"-ified.
   */
  viewerId?: string;
  /** Full-page chat controls share the transcript sticky layer. */
  header?: ReactNode;
  onReply?: (target: MessageReplyReference) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const scrollHeader = useScrollHeader(containerRef, threadId);
  // The ref above drives the auto-scroll effect and must stay a ref: the
  // effect reads it in the same tick a message lands. This mirror exists
  // only so the button can render, and it flips at the same threshold.
  const [scrolledAway, setScrolledAway] = useState(false);

  const visible = useMemo(() => {
    const pending = new Set(pendingIds ?? []);
    return messages.filter(
      (message) =>
        (!threadId || message.threadId === threadId) &&
        (!message.queueItemId || !pending.has(message.queueItemId)),
    );
  }, [messages, pendingIds, threadId]);

  // A thread switch starts at the bottom: the previous thread's scroll
  // position must not decide whether the new thread auto-scrolls or shows
  // the "Latest" button. Reset only — `visible` recomputes on the same
  // threadId change, so the effect below (declared after this one, runs
  // after it) does the single scroll write.
  useLayoutEffect(() => {
    stickToBottomRef.current = true;
    setScrolledAway(false);
  }, [threadId]);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
      scrollHeader.syncPosition();
    }
  }, [visible, scrollHeader.syncPosition]);

  function onScroll() {
    const el = containerRef.current;
    if (!el) return;
    scrollHeader.onScroll();
    const distanceFromBottom = el.scrollHeight - (el.scrollTop + el.clientHeight);
    const nearBottom = distanceFromBottom < 80; // "near bottom"
    stickToBottomRef.current = nearBottom;
    // Return `prev` unchanged when the side did not flip. Scroll fires on
    // every wheel tick, and React skips the re-render on an equal value.
    setScrolledAway((prev) => (prev === !nearBottom ? prev : !nearBottom));
  }

  function scrollToBottom() {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    scrollHeader.syncPosition();
    // Set both here rather than waiting for the scroll event. A programmatic
    // scroll to an already-bottom list fires no event, which would leave the
    // button on screen with nothing left to do.
    stickToBottomRef.current = true;
    setScrolledAway(false);
  }


  return (
    <div className="flex-1 relative min-h-0 min-w-0">
      <div
        ref={containerRef}
        onScroll={onScroll}
        onWheelCapture={(event) => scrollHeader.recordIntent(event.target)}
        onTouchMove={(event) => scrollHeader.recordIntent(event.target)}
        onPointerDown={(event) => scrollHeader.recordIntent(event.target)}
        onPointerMove={(event) => { if (event.buttons) scrollHeader.recordIntent(event.target); }}
        onKeyDown={(event) => {
          if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) {
            scrollHeader.recordIntent(event.target);
          }
        }}
        tabIndex={0}
        aria-label="Conversation"
        data-testid="message-list"
        className="flex h-full w-full min-w-0 flex-col overflow-x-hidden overflow-y-auto overscroll-y-contain"
      >
        {header && (
          <div
            ref={scrollHeader.headerRef}
            data-testid="thread-header"
            data-hidden={scrollHeader.hidden}
            onFocusCapture={scrollHeader.onFocus}
            onBlurCapture={scrollHeader.onBlur}
            className={cn(
              "sticky top-0 z-20 shrink-0 bg-paper transition-transform duration-200 ease-out motion-reduce:transition-none sm:transform-none",
              scrollHeader.hidden ? "-translate-y-full" : "translate-y-0",
            )}
          >
            {header}
          </div>
        )}
        {visible.length === 0 ? (
          <div className="flex-1 grid place-items-center text-sm text-muted">
            No messages yet — try sending a prompt below.
          </div>
        ) : (
          <div className="shrink-0 space-y-2 py-4">
            {visible.map((m, i) =>
              m.compaction ? (
                <CompactionDivider key={m.id} message={m} />
              ) : m.signal ? (
                <SignalCard key={m.id} message={m} onOpenChild={onOpenChild} />
              ) : m.command ? (
                <CommandResult key={m.id} message={m} />
              ) : (
                <MessageItem
                  key={m.id}
                  message={m}
                  suppressEmptyPlaceholder={agentBusy && i === visible.length - 1}
                  viewerId={viewerId}
                  onReply={onReply}
                />
              ),
            )}
          </div>
        )}
      </div>
      {/* Only while the reader is away from the bottom. At the bottom the
          list already follows the agent, so the control has no job. */}
      {visible.length > 0 && scrolledAway && (
        <button
          type="button"
          onClick={scrollToBottom}
          aria-label="Jump to latest message"
          className="absolute bottom-3 left-1/2 z-10 -translate-x-1/2 flex items-center gap-1.5 rounded-full border border-line bg-paper max-sm:min-h-11 px-3 py-1 text-xs text-muted shadow-sm transition-colors hover:text-[--fg] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/40"
        >
          <ArrowDown className="h-3 w-3" aria-hidden />
          Latest
        </button>
      )}
    </div>
  );
}
