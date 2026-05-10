import { useState, type KeyboardEvent } from "react";
import { Send } from "lucide-react";
import { Button, Textarea } from "~/components/primitives";
import { useSendPrompt } from "~/api/queries";
import { useStreamStore, type AgentStatus } from "~/stores/stream";

export function Composer({ sessionId, agentStatus }: { sessionId: string; agentStatus: AgentStatus }) {
  const [text, setText] = useState("");
  const send = useSendPrompt(sessionId);
  const addUserMessage = useStreamStore((s) => s.addUserMessage);

  // Disable submit while engine is mid-turn — prompts queue server-side, but
  // the UX is clearer if we wait for idle.
  const busy = send.isPending || (agentStatus !== "idle" && agentStatus !== "error");

  async function submit() {
    const t = text.trim();
    if (!t || busy) return;
    setText("");
    // Optimistic local add — the engine doesn't emit a wire event for the
    // user's own message, so without this the prompt would only appear after
    // the next WS init (page reload). The next init replaces this row with
    // the server's persisted copy.
    addUserMessage(sessionId, t);
    try {
      await send.mutateAsync(t);
    } catch (err) {
      // Restore the draft on failure so the user can retry. The optimistic
      // message stays visible — they can see what they sent + retry; on the
      // next reload it'll be reconciled against server truth.
      setText(t);
      console.error("send failed:", err);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter submits; Shift+Enter inserts a newline. Skip while an IME
    // composition is active so Enter confirms the composition instead of
    // sending a half-finished message.
    if (e.key !== "Enter") return;
    if (e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    void submit();
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      className="border-t border-[--border] p-3 bg-[--bg]"
    >
      <div className="flex gap-2 items-end">
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Send a message — Enter to send, Shift+Enter for a new line"
          rows={2}
          className="flex-1"
          disabled={send.isPending}
        />
        <Button type="submit" disabled={!text.trim() || busy} size="lg">
          <Send className="h-4 w-4" />
          <span>Send</span>
        </Button>
      </div>
    </form>
  );
}
