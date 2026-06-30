/**
 * Workflow Copilot panel — collapsible side rail in the workflow
 * editor. Streams chat from /api/copilot/chat via the Vercel AI SDK.
 *
 * MVP: text + tool-call rendering, single thread per workflow (first
 * load picks the most recent or creates a new one). Model picker and
 * thread switcher come in follow-up commits.
 */
import { useState, useEffect, useRef, type ReactNode } from 'react';
import { useCopilotChat, useCopilotMessages, useCopilotThreads, type UiMessage } from '@/api/copilot';
import { ToolPayload } from '@/components/payload/tool-payload';
import { DeferredMarkdownContent } from '@/components/chat/markdown/deferred-markdown-content';
import { useQueryClient } from '@tanstack/react-query';

interface CopilotPanelProps {
  workflowId: string;
  /** Invalidate workflow draft + executions when the copilot edits */
  onWorkflowChange?: () => void;
}

export function CopilotPanel({ workflowId, onWorkflowChange }: CopilotPanelProps) {
  const qc = useQueryClient();
  const { data: threadsData } = useCopilotThreads(workflowId);
  const initialThreadId = threadsData?.threads[0]?.id ?? null;
  const { data: messagesData } = useCopilotMessages(initialThreadId);

  // Seed local state from the persisted thread once it loads.
  const [bootstrapped, setBootstrapped] = useState(false);
  const initial: UiMessage[] = bootstrapped || !messagesData
    ? []
    : messagesData.messages
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({
          id: m.id,
          role: m.role as 'user' | 'assistant',
          parts: (m.parts ?? [{ type: 'text', text: m.content }]) as UiMessage['parts'],
        }));

  const { messages, send, stop, status, error, threadId } = useCopilotChat({
    workflowId,
    initialThreadId,
    initialMessages: initial,
  });

  useEffect(() => {
    if (messagesData && !bootstrapped) setBootstrapped(true);
  }, [messagesData, bootstrapped]);

  // Whenever a tool call lands that mutates the workflow, invalidate.
  const lastToolCount = useRef(0);
  useEffect(() => {
    const toolCount = messages.reduce(
      (acc, m) => acc + m.parts.filter((p) => p.type === 'tool-result').length,
      0,
    );
    if (toolCount > lastToolCount.current) {
      onWorkflowChange?.();
      qc.invalidateQueries({ queryKey: ['workflow', workflowId] });
      qc.invalidateQueries({ queryKey: ['workflowDraft', workflowId] });
      lastToolCount.current = toolCount;
    }
  }, [messages, onWorkflowChange, qc, workflowId]);

  // Auto-scroll on new messages.
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages]);

  const [input, setInput] = useState('');
  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text || status === 'streaming') return;
    setInput('');
    void send(text);
  };

  return (
    <div className="flex h-full flex-col border-l border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-950">
      <header className="flex items-center justify-between border-b border-neutral-200 px-3 py-2 dark:border-neutral-800">
        <div className="flex items-center gap-2">
          <span className="inline-flex h-5 w-5 items-center justify-center rounded-md bg-violet-500/10 text-[10px] font-semibold text-violet-600 dark:text-violet-300">
            ✦
          </span>
          <span className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
            Copilot
          </span>
        </div>
        {threadId && (
          <span className="font-mono text-[10px] text-neutral-400">{threadId.slice(0, 8)}</span>
        )}
      </header>

      <div ref={scrollRef} className="flex-1 overflow-auto px-3 py-3">
        {messages.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="space-y-3">
            {messages.map((m) => (
              <MessageBubble key={m.id} message={m} />
            ))}
            {status === 'streaming' && <CookingIndicator messages={messages} />}
            {error && (
              <p className="rounded-md border border-red-200 bg-red-50 px-2 py-1.5 text-xs text-red-700 dark:border-red-900/40 dark:bg-red-950/40 dark:text-red-300">
                {error}
              </p>
            )}
          </div>
        )}
      </div>

      <form
        onSubmit={onSubmit}
        className="border-t border-neutral-200 p-2 dark:border-neutral-800"
      >
        <div className="flex items-end gap-2 rounded-md border border-neutral-200 bg-neutral-50 px-2 py-1.5 focus-within:border-violet-400 dark:border-neutral-800 dark:bg-neutral-900">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void onSubmit(e as unknown as React.FormEvent);
              }
            }}
            rows={1}
            placeholder={status === 'streaming' ? 'Cooking…' : 'Ask the copilot to build, edit, or fix this workflow'}
            className="min-h-[28px] flex-1 resize-none bg-transparent text-sm text-neutral-900 outline-none placeholder:text-neutral-400 dark:text-neutral-100"
            disabled={status === 'streaming'}
          />
          {status === 'streaming' ? (
            <button
              type="button"
              onClick={() => stop()}
              className="shrink-0 rounded-md border border-neutral-300 bg-white px-2.5 py-1 text-[11px] font-medium text-neutral-700 shadow-sm hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200 dark:hover:bg-neutral-800"
              title="Stop"
            >
              Stop
            </button>
          ) : (
            <button
              type="submit"
              disabled={!input.trim()}
              className="shrink-0 rounded-md bg-violet-600 px-2.5 py-1 text-[11px] font-medium text-white shadow-sm transition disabled:cursor-not-allowed disabled:opacity-50 hover:bg-violet-700"
            >
              Send
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

/**
 * "Cooking" indicator — derives a contextual label from the last
 * assistant turn so the user knows what the model is actively doing,
 * not just that it's still alive. Three states:
 *   • a tool call landed but no result yet  → "Calling X…"
 *   • text is streaming                     → "Writing…"
 *   • nothing yet on the new assistant turn → "Thinking…"
 */
function CookingIndicator({ messages }: { messages: UiMessage[] }) {
  const last = messages[messages.length - 1];
  let label = 'Thinking';
  if (last && last.role === 'assistant' && last.parts.length > 0) {
    // Find the last tool-call without a matching tool-result.
    const calls = new Map<string, { name: string }>();
    const resolved = new Set<string>();
    for (const p of last.parts) {
      if (p.type === 'tool-call') {
        const tc = p as { toolCallId: string; toolName: string };
        calls.set(tc.toolCallId, { name: tc.toolName });
      } else if (p.type === 'tool-result') {
        const tr = p as { toolCallId: string };
        resolved.add(tr.toolCallId);
      }
    }
    const pending = [...calls.entries()].find(([id]) => !resolved.has(id));
    if (pending) {
      label = `Calling ${pending[1].name}`;
    } else {
      const lastPart = last.parts[last.parts.length - 1];
      if (lastPart?.type === 'text') label = 'Writing';
    }
  }
  return (
    <div className="flex items-center gap-2 px-1 py-0.5 text-xs text-neutral-500 dark:text-neutral-400">
      <ShimmerDot />
      <span className="bg-gradient-to-r from-neutral-500 via-violet-500 to-neutral-500 bg-[length:200%_100%] bg-clip-text text-transparent animate-cooking-shimmer dark:from-neutral-400 dark:via-violet-300 dark:to-neutral-400">
        {label}…
      </span>
    </div>
  );
}

function ShimmerDot() {
  return (
    <span className="relative flex h-2 w-2 shrink-0">
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-violet-500/50" />
      <span className="relative inline-flex h-2 w-2 rounded-full bg-violet-500" />
    </span>
  );
}

function EmptyState() {
  return (
    <div className="space-y-2 px-1 py-4 text-sm text-neutral-500 dark:text-neutral-400">
      <p className="font-medium text-neutral-700 dark:text-neutral-300">Hi — I&apos;m the workflow copilot.</p>
      <p>I have your draft loaded. Try:</p>
      <ul className="list-disc space-y-1 pl-4 text-xs">
        <li>&ldquo;Add a Slack trigger that fires on every #alerts message&rdquo;</li>
        <li>&ldquo;What does the second node do?&rdquo;</li>
        <li>&ldquo;Validate and tell me what&apos;s wrong&rdquo;</li>
        <li>&ldquo;Wire an approval gate before the send_message step&rdquo;</li>
      </ul>
    </div>
  );
}

function MessageBubble({ message }: { message: UiMessage }) {
  if (message.role === 'user') {
    const text = message.parts
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join('\n');
    return (
      <div className="ml-auto w-fit max-w-[85%] whitespace-pre-wrap rounded-lg bg-neutral-100 px-3 py-1.5 text-sm text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100">
        {text}
      </div>
    );
  }
  return (
    <div className="space-y-1.5">
      {message.parts.map((p, i) => renderPart(p, i))}
    </div>
  );
}

function renderPart(part: UiMessage['parts'][number], i: number): ReactNode {
  if (part.type === 'text') {
    const text = (part as { text: string }).text;
    if (!text) return null;
    return (
      <div key={i} className="copilot-markdown text-sm text-neutral-800 dark:text-neutral-200">
        <DeferredMarkdownContent content={text} isStreaming />
      </div>
    );
  }
  if (part.type === 'tool-call') {
    const p = part as { toolName: string; args: unknown };
    return (
      <ToolCallCard key={i} kind="call" toolName={p.toolName} payload={p.args} />
    );
  }
  if (part.type === 'tool-result') {
    const p = part as { result: unknown };
    return (
      <ToolCallCard key={i} kind="result" toolName="result" payload={p.result} />
    );
  }
  return null;
}

function ToolCallCard({ kind, toolName, payload }: { kind: 'call' | 'result'; toolName: string; payload: unknown }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="overflow-hidden rounded-md border border-neutral-200 bg-neutral-50/60 dark:border-neutral-800 dark:bg-neutral-950/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-2 py-1 text-left text-[11px] font-mono text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-900"
      >
        <span className={kind === 'call' ? 'text-violet-600 dark:text-violet-400' : 'text-emerald-600 dark:text-emerald-400'}>
          {kind === 'call' ? '→' : '←'}
        </span>
        <span className="font-semibold">{toolName}</span>
        <span className="ml-auto text-[10px] text-neutral-400">{open ? '−' : '+'}</span>
      </button>
      {open && (
        <div className="border-t border-neutral-200 p-2 dark:border-neutral-800">
          <ToolPayload value={payload} />
        </div>
      )}
    </div>
  );
}
