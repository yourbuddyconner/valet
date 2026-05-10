import { useEffect, useRef } from "react";
import type { Message } from "@valet/api/wire";
import { MessageItem } from "./message-item";

/**
 * Scrolling message list. Auto-scrolls to bottom when new messages arrive
 * unless the user has scrolled up — in which case we leave them alone so
 * they can read history.
 */
export function MessageList({ messages }: { messages: Message[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  function onScroll() {
    const el = containerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - (el.scrollTop + el.clientHeight);
    stickToBottomRef.current = distanceFromBottom < 80; // "near bottom"
  }

  if (messages.length === 0) {
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
      {messages.map((m) => (
        <MessageItem key={m.id} message={m} />
      ))}
    </div>
  );
}
