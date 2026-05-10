import { useEffect, useMemo, useRef } from "react";
import type { Message } from "@valet/api/wire";
import { MessageItem } from "./message-item";

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
}: {
  messages: Message[];
  threadId?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);

  const visible = useMemo(() => {
    if (!threadId) return messages;
    return messages.filter((m) => m.threadId === threadId);
  }, [messages, threadId]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [visible]);

  function onScroll() {
    const el = containerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - (el.scrollTop + el.clientHeight);
    stickToBottomRef.current = distanceFromBottom < 80; // "near bottom"
  }

  if (visible.length === 0) {
    return (
      <div className="flex-1 grid place-items-center text-sm text-[--muted]">
        No messages yet — try sending a prompt below.
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      onScroll={onScroll}
      className="flex-1 overflow-y-auto divide-y divide-[--border]"
    >
      {visible.map((m) => (
        <MessageItem key={m.id} message={m} />
      ))}
    </div>
  );
}
