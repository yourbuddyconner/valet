import { useEffect, useMemo, useRef } from "react";
import type { Message } from "@valet/api/wire";
import { MessageItem } from "./message-item";

/**
 * Scrolling message list. Auto-scrolls to bottom when new messages arrive
 * unless the user has scrolled up — in which case we leave them alone so
 * they can read history.
 *
 * `threadId` filters the visible messages to a single thread. When undefined
 * (no thread known yet), every message is shown.
 *
 * Note: optimistic user messages have `threadId: null` because the client
 * doesn't yet know the resolved thread id at submit time. We render those
 * regardless of thread filter so the user sees their text immediately;
 * the next WS init replaces them with the server's persisted copy carrying
 * the right thread id.
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
    return messages.filter(
      (m) => m.threadId === null || m.threadId === threadId,
    );
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
