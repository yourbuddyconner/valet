/**
 * Workflow Copilot panel — collapsible side rail in the workflow
 * editor. Streams chat from /api/copilot/chat via the Vercel AI SDK.
 *
 * Structure:
 *   <CopilotPanel>  owns thread list + active threadId
 *     <ThreadStream key={threadId}>  owns chat state for that thread
 *
 * Keying the inner component by threadId means switching threads
 * remounts cleanly and starts with the persisted messages already in
 * hand — no after-mount state sync.
 */
import { useState, useEffect, useRef, type ReactNode } from 'react';
import {
  useCopilotChat,
  useCopilotMessages,
  useCopilotThreads,
  isToolPart,
  type UiMessage,
  type UiMessagePart,
  type CopilotMessage,
  type ToolPart,
} from '@/api/copilot';
import { ToolPayload } from '@/components/payload/tool-payload';
import { DeferredMarkdownContent } from '@/components/chat/markdown/deferred-markdown-content';
import { useQueryClient } from '@tanstack/react-query';
import { workflowKeys, type GetDraftResponse } from '@/api/workflows';
import type { WorkflowDefinition } from '@valet/shared';

interface CopilotPanelProps {
  workflowId: string;
}

export function CopilotPanel({ workflowId }: CopilotPanelProps) {
  const { data: threadsData, isLoading: threadsLoading } = useCopilotThreads(workflowId);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [threadMenuOpen, setThreadMenuOpen] = useState(false);
  // Bumping this key remounts ThreadStream (i.e. resets chat-local
  // state). We do so on explicit user actions — selecting a thread,
  // clicking "+ New" — but NOT when the chat hook surfaces a
  // server-assigned thread id mid-conversation. That would otherwise
  // wipe the conversation the user is actively having.
  const [mountKey, setMountKey] = useState(0);

  const autoSelectedFor = useRef<string | null>(null);
  useEffect(() => {
    if (threadsLoading) return;
    if (autoSelectedFor.current === workflowId) return;
    autoSelectedFor.current = workflowId;
    const mostRecent = threadsData?.threads[0]?.id ?? null;
    setActiveThreadId(mostRecent);
    setMountKey((k) => k + 1);
  }, [workflowId, threadsLoading, threadsData]);

  const handleNewThread = () => {
    setActiveThreadId(null);
    setMountKey((k) => k + 1);
    setThreadMenuOpen(false);
  };

  const handleSelectThread = (id: string) => {
    if (id === activeThreadId) return;
    setActiveThreadId(id);
    setMountKey((k) => k + 1);
    setThreadMenuOpen(false);
  };

  // Sync without remount: hook discovered or invented its thread id
  // during a live stream. Update state so the switcher highlights it,
  // but DON'T bump mountKey — that would tear down the conversation.
  const handleThreadDiscovered = (id: string) => {
    setActiveThreadId((current) => (current === id ? current : id));
  };

  return (
    <div className="flex h-full flex-col border-l border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-950">
      <header className="relative flex items-center gap-2 border-b border-neutral-200 px-3 py-2 dark:border-neutral-800">
        <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-violet-500/10 text-[10px] font-semibold text-violet-600 dark:text-violet-300">
          ✦
        </span>
        <span className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
          Copilot
        </span>
        <button
          type="button"
          onClick={() => setThreadMenuOpen((v) => !v)}
          className="ml-auto inline-flex items-center gap-1 rounded border border-neutral-200 px-1.5 py-0.5 text-[10px] text-neutral-500 hover:border-neutral-300 hover:text-neutral-900 dark:border-neutral-700 dark:text-neutral-400 dark:hover:border-neutral-600 dark:hover:text-neutral-100"
          title="Conversations"
        >
          {(threadsData?.threads.length ?? 0)} thread{(threadsData?.threads.length ?? 0) === 1 ? '' : 's'}
          <span className="inline-block">▾</span>
        </button>
        <button
          type="button"
          onClick={handleNewThread}
          className="inline-flex items-center rounded border border-violet-300 px-1.5 py-0.5 text-[10px] font-medium text-violet-700 hover:bg-violet-50 dark:border-violet-700 dark:text-violet-300 dark:hover:bg-neutral-900"
          title="Start a new conversation"
        >
          + New
        </button>

        {threadMenuOpen && (
          <ThreadList
            threads={threadsData?.threads ?? []}
            activeThreadId={activeThreadId}
            onSelect={handleSelectThread}
            onClose={() => setThreadMenuOpen(false)}
          />
        )}
      </header>

      <ThreadStream
        key={mountKey}
        workflowId={workflowId}
        threadId={activeThreadId}
        onThreadDiscovered={handleThreadDiscovered}
      />
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Per-thread streaming view
// ────────────────────────────────────────────────────────────────────────

function ThreadStream({
  workflowId,
  threadId,
  onThreadDiscovered,
}: {
  workflowId: string;
  threadId: string | null;
  onThreadDiscovered: (id: string) => void;
}) {
  const qc = useQueryClient();
  // Load persisted messages for this thread (if any). When threadId is
  // null we render the empty state directly; no fetch.
  const { data: messagesData, isLoading: messagesLoading } = useCopilotMessages(threadId);
  // Once we know we have a thread but messages are still fetching, show
  // a thin skeleton instead of empty-state to avoid a flicker.
  const showSkeleton = threadId !== null && messagesLoading && !messagesData;

  const initialMessages = messagesData
    ? toUiMessages(messagesData.messages)
    : [];

  const { messages, send, stop, status, error, threadId: liveThreadId } = useCopilotChat({
    workflowId,
    initialThreadId: threadId,
    // Pass already-loaded messages; the hook reads this once but since
    // we're keyed by threadId in the parent, the component remounts on
    // switch and re-reads.
    initialMessages,
  });

  // Surface the server-assigned id up so the switcher highlights it.
  // The parent intentionally syncs without remounting — preserves the
  // live conversation across the null → real-id transition.
  useEffect(() => {
    if (liveThreadId && liveThreadId !== threadId) {
      onThreadDiscovered(liveThreadId);
      qc.invalidateQueries({ queryKey: ['copilot', 'threads', workflowId] });
    }
  }, [liveThreadId, threadId, onThreadDiscovered, qc, workflowId]);

  // When the model lands a tool result that mutated the workflow, the
  // server returns the new definition inline. Push it straight into the
  // React Query cache instead of invalidating — avoids a redundant
  // ~100 ms GET /workflows/:id/draft round-trip. Fall back to invalidate
  // if the tool doesn't include a definition (getWorkflow, getNodeSchema,
  // listModels, etc. return other shapes).
  const seenToolResults = useRef<Set<string>>(new Set());
  useEffect(() => {
    const last = messages[messages.length - 1];
    if (!last || last.role !== 'assistant') return;
    let sawMutation = false;
    let nextDefinition: WorkflowDefinition | null = null;
    for (const part of last.parts) {
      if (!isToolPart(part)) continue;
      if (part.state !== 'output-available') continue;
      if (seenToolResults.current.has(part.toolCallId)) continue;
      seenToolResults.current.add(part.toolCallId);
      const output = unwrapOutput(part.output);
      const asRecord = isRecord(output) ? output : null;
      if (!asRecord || asRecord.ok !== true) continue;
      sawMutation = true;
      const def = asRecord.definition;
      if (isWorkflowDefinitionShape(def)) nextDefinition = def;
    }
    if (nextDefinition) {
      qc.setQueryData<GetDraftResponse>(
        workflowKeys.draft(workflowId),
        (prev) => ({
          draft: nextDefinition,
          ui: nextDefinition.ui ?? prev?.ui ?? null,
          publishedVersionId: prev?.publishedVersionId ?? null,
        }),
      );
    } else if (sawMutation) {
      qc.invalidateQueries({ queryKey: workflowKeys.draft(workflowId) });
    }
  }, [messages, qc, workflowId]);

  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, status]);

  const [input, setInput] = useState('');
  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text || status === 'streaming') return;
    setInput('');
    void send(text);
  };

  return (
    <>
      <div ref={scrollRef} className="flex-1 overflow-auto px-3 py-3">
        {showSkeleton ? (
          <ThreadSkeleton />
        ) : messages.length === 0 ? (
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
    </>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Thread list popover
// ────────────────────────────────────────────────────────────────────────

interface ThreadSummary {
  id: string;
  title: string | null;
  messageCount: number;
  updatedAt: string;
}

function ThreadList({
  threads,
  activeThreadId,
  onSelect,
  onClose,
}: {
  threads: ThreadSummary[];
  activeThreadId: string | null;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  return (
    <div
      className="absolute right-3 top-10 z-30 w-[260px] overflow-hidden rounded-md border border-neutral-200 bg-white shadow-lg dark:border-neutral-700 dark:bg-neutral-900"
      role="dialog"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="border-b border-neutral-200 px-3 py-2 text-[10px] font-medium uppercase tracking-wider text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
        Conversations
      </div>
      {threads.length === 0 ? (
        <div className="px-3 py-4 text-xs text-neutral-500 dark:text-neutral-400">
          No prior conversations. The next message starts a new thread.
        </div>
      ) : (
        <ul className="max-h-[280px] overflow-y-auto">
          {threads.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                onClick={() => onSelect(t.id)}
                className={`flex w-full items-start justify-between gap-2 px-3 py-2 text-left text-xs hover:bg-neutral-50 dark:hover:bg-neutral-800 ${
                  t.id === activeThreadId
                    ? 'bg-violet-50/60 dark:bg-violet-950/40'
                    : ''
                }`}
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-neutral-900 dark:text-neutral-100">
                    {t.title ?? `Thread ${t.id.slice(0, 8)}`}
                  </p>
                  <p className="mt-0.5 text-[10px] text-neutral-500 dark:text-neutral-400">
                    {t.messageCount} message{t.messageCount === 1 ? '' : 's'} · {formatRelative(t.updatedAt)}
                  </p>
                </div>
                {t.id === activeThreadId && (
                  <span className="mt-0.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-violet-500" />
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        onClick={onClose}
        className="block w-full border-t border-neutral-200 bg-neutral-50 px-3 py-1.5 text-[10px] text-neutral-500 hover:bg-neutral-100 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800"
      >
        Close
      </button>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Cache-injection helpers
// ────────────────────────────────────────────────────────────────────────

/**
 * SDK wraps tool outputs as `{ type: 'json' | 'text', value | text }`
 * at some transport boundaries. Same unwrap the render layer does — we
 * duplicate it here so the effect that pushes to React Query stays
 * decoupled from render.
 */
function unwrapOutput(value: unknown): unknown {
  if (isRecord(value)) {
    if (value.type === 'json' && 'value' in value) return value.value;
    if (value.type === 'text' && typeof value.text === 'string') return value.text;
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isWorkflowDefinitionShape(value: unknown): value is WorkflowDefinition {
  return isRecord(value)
    && value.version === 'dag/v1'
    && Array.isArray(value.nodes)
    && Array.isArray(value.edges);
}

function formatRelative(iso: string): string {
  const now = Date.now();
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const seconds = Math.floor((now - then) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

// ────────────────────────────────────────────────────────────────────────
// Persisted-message → UiMessage conversion
// ────────────────────────────────────────────────────────────────────────

function toUiMessages(persisted: CopilotMessage[]): UiMessage[] {
  // Persisted assistant messages carry UIMessage-shape parts directly
  // (unified tool parts with state/input/output). User messages are
  // just their text. Legacy `tool` role rows are ignored — they only
  // existed in the old ModelMessage-based persistence and are now
  // superseded by the tool parts embedded in the assistant message.
  const out: UiMessage[] = [];
  for (const m of persisted) {
    if (m.role === 'tool') continue;
    if (m.role === 'user') {
      out.push({ id: m.id, role: 'user', parts: [{ type: 'text', text: m.content }] });
      continue;
    }
    const parts = Array.isArray(m.parts) ? (m.parts as UiMessagePart[]) : [];
    if (parts.length === 0 && m.content) {
      parts.push({ type: 'text', text: m.content });
    }
    out.push({ id: m.id, role: 'assistant', parts });
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────────
// Misc UI
// ────────────────────────────────────────────────────────────────────────

function ThreadSkeleton() {
  return (
    <div className="space-y-2.5 px-1 py-2">
      <div className="ml-auto h-6 w-2/3 animate-pulse rounded-lg bg-neutral-200 dark:bg-neutral-800" />
      <div className="h-12 w-full animate-pulse rounded-lg bg-neutral-100 dark:bg-neutral-900" />
      <div className="ml-auto h-6 w-1/2 animate-pulse rounded-lg bg-neutral-200 dark:bg-neutral-800" />
    </div>
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

function renderPart(part: UiMessagePart, i: number): ReactNode {
  if (part.type === 'text') {
    const text = (part as { text: string }).text;
    if (!text) return null;
    return (
      <div key={i} className="copilot-markdown text-sm text-neutral-800 dark:text-neutral-200">
        <DeferredMarkdownContent content={text} isStreaming />
      </div>
    );
  }
  if (isToolPart(part)) {
    return <ToolInvocationCard key={i} part={part} />;
  }
  return null;
}

/**
 * A single UIMessage tool part progresses through states — we render
 * a single card whose contents (and status pill) change with state,
 * rather than emitting two separate call/result cards.
 *
 * Output can arrive as the raw value OR as a ToolResultOutput wrapper
 * `{ type: 'json' | 'text', value }` depending on where in the SDK
 * the value crossed a wire boundary. We unwrap once so the payload
 * viewer always sees the actual data.
 */
function ToolInvocationCard({ part }: { part: ToolPart }) {
  const [open, setOpen] = useState(false);
  const state = part.state;
  const isFinal = state === 'output-available' || state === 'output-error';
  const label = part.toolName || 'tool';

  const [pillColor, pillText] = pillFor(state);

  const unwrappedOutput = unwrapToolResultOutput(part.output);

  return (
    <div className="overflow-hidden rounded-md border border-neutral-200 bg-neutral-50/60 dark:border-neutral-800 dark:bg-neutral-950/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-2 py-1 text-left text-[11px] font-mono text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-900"
      >
        <span className="text-violet-600 dark:text-violet-400">↳</span>
        <span className="font-semibold">{label}</span>
        <span className={`ml-2 rounded px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider ${pillColor}`}>
          {pillText}
        </span>
        {!isFinal && (
          <span className="ml-2 inline-flex h-1.5 w-1.5 rounded-full bg-violet-500 animate-pulse" aria-hidden />
        )}
        <span className="ml-auto text-[10px] text-neutral-400">{open ? '−' : '+'}</span>
      </button>
      {open && (
        <div className="space-y-2 border-t border-neutral-200 p-2 dark:border-neutral-800">
          {part.input !== undefined && (
            <section>
              <div className="mb-1 text-[9.5px] font-medium uppercase tracking-wider text-neutral-400 dark:text-neutral-500">
                Input
              </div>
              <ToolPayload value={part.input} />
            </section>
          )}
          {state === 'output-error' && part.errorText && (
            <section>
              <div className="mb-1 text-[9.5px] font-medium uppercase tracking-wider text-red-500">
                Error
              </div>
              <div className="rounded-md border border-red-200 bg-red-50 px-2 py-1.5 text-xs text-red-700 dark:border-red-900/40 dark:bg-red-950/40 dark:text-red-300">
                {part.errorText}
              </div>
            </section>
          )}
          {state === 'output-available' && (
            <section>
              <div className="mb-1 text-[9.5px] font-medium uppercase tracking-wider text-neutral-400 dark:text-neutral-500">
                Result
              </div>
              <ToolPayload value={unwrappedOutput} />
            </section>
          )}
        </div>
      )}
    </div>
  );
}

function pillFor(state: ToolPart['state']): [string, string] {
  switch (state) {
    case 'input-streaming':
      return ['bg-neutral-200 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300', 'building'];
    case 'input-available':
      return ['bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300', 'running'];
    case 'output-available':
      return ['bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300', 'done'];
    case 'output-error':
      return ['bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300', 'error'];
    default:
      return ['bg-neutral-200 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300', String(state)];
  }
}

/**
 * SDK ToolResultOutput wraps raw values as `{ type: 'json' | 'text', value }`
 * at some boundaries. Unwrap once so callers see the raw value.
 */
function unwrapToolResultOutput(value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as { type?: unknown; value?: unknown; text?: unknown };
    if (obj.type === 'json' && 'value' in obj) return obj.value;
    if (obj.type === 'text' && typeof obj.text === 'string') return obj.text;
  }
  return value;
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
    // Find any tool part not yet at a terminal state — that's what
    // the model is waiting on right now.
    const pendingTool = [...last.parts].reverse().find((p) => {
      if (!isToolPart(p)) return false;
      return p.state === 'input-streaming' || p.state === 'input-available';
    }) as ToolPart | undefined;
    if (pendingTool) {
      label = `Calling ${pendingTool.toolName || 'tool'}`;
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
