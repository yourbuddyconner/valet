import { useState, useRef, useCallback } from 'react';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useThread, useContinueThread, useRenameThread } from '@/api/threads';
import { MessageList } from '@/components/chat/message-list';
import { setPendingContinuation } from '@/components/chat/chat-container';
import { formatRelativeTime } from '@/lib/format';
import type { Message, MessagePart, ToolCallPart } from '@valet/shared';

export const Route = createFileRoute('/sessions/$sessionId/threads/$threadId')({
  component: ThreadDetailPage,
});

// ---------------------------------------------------------------------------
// Thread export
// ---------------------------------------------------------------------------

function formatToolCall(part: ToolCallPart): string {
  const lines: string[] = [];
  lines.push(`  [tool] ${part.toolName} (${part.status})`);
  if (part.args != null) {
    const argsStr = typeof part.args === 'string' ? part.args : JSON.stringify(part.args, null, 2);
    lines.push(`  ARGS:`);
    for (const line of argsStr.split('\n')) lines.push(`    ${line}`);
  }
  if (part.result != null) {
    const resultStr = typeof part.result === 'string' ? part.result : JSON.stringify(part.result, null, 2);
    lines.push(`  RESULT:`);
    for (const line of resultStr.split('\n')) lines.push(`    ${line}`);
  }
  if (part.error) {
    lines.push(`  ERROR: ${part.error}`);
  }
  return lines.join('\n');
}

function formatPart(part: MessagePart): string {
  switch (part.type) {
    case 'text':
      return part.text;
    case 'tool-call':
      return formatToolCall(part);
    case 'error':
      return `[error] ${part.message}`;
    case 'finish':
      return '';
    default:
      return '';
  }
}

function exportThread(thread: { title?: string; firstMessagePreview?: string; createdAt: Date }, messages: Message[]): string {
  const lines: string[] = [];
  const title = thread.title || thread.firstMessagePreview || 'Untitled thread';
  lines.push(`# ${title}`);
  lines.push(`Exported: ${new Date().toISOString()}`);
  lines.push(`Thread started: ${new Date(thread.createdAt).toISOString()}`);
  lines.push(`Messages: ${messages.length}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of messages) {
    const timestamp = new Date(msg.createdAt).toISOString();
    const author = msg.authorName || msg.authorEmail || msg.role;
    lines.push(`## [${msg.role.toUpperCase()}] ${author} — ${timestamp}`);
    lines.push('');

    if (msg.parts && msg.parts.length > 0) {
      for (const part of msg.parts) {
        const formatted = formatPart(part);
        if (formatted) {
          lines.push(formatted);
          lines.push('');
        }
      }
    } else if (msg.content) {
      lines.push(msg.content);
      lines.push('');
    }

    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}

function downloadText(filename: string, content: string) {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function copyToClipboard(text: string): Promise<void> {
  return navigator.clipboard.writeText(text);
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

function ThreadDetailPage() {
  const { sessionId, threadId } = Route.useParams();
  const { data, isLoading, isError } = useThread(sessionId, threadId);
  const continueThread = useContinueThread(sessionId);
  const renameThread = useRenameThread(sessionId);
  const navigate = useNavigate();

  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [editTitleValue, setEditTitleValue] = useState('');
  const titleInputRef = useRef<HTMLInputElement>(null);

  const thread = data?.thread;
  const messages = data?.messages ?? [];

  const startEditingTitle = useCallback(() => {
    setEditTitleValue(thread?.title || thread?.firstMessagePreview || '');
    setIsEditingTitle(true);
    setTimeout(() => titleInputRef.current?.select(), 0);
  }, [thread?.title, thread?.firstMessagePreview]);

  const saveTitle = useCallback(() => {
    const trimmed = editTitleValue.trim();
    if (trimmed !== (thread?.title || '')) {
      renameThread.mutate({ threadId, title: trimmed });
    }
    setIsEditingTitle(false);
  }, [editTitleValue, thread?.title, threadId, renameThread]);

  const handleContinue = () => {
    continueThread.mutate(threadId, {
      onSuccess: (data) => {
        if (data.continuationContext) {
          setPendingContinuation(data.thread.id, data.continuationContext);
        }
        void navigate({
          to: '/sessions/$sessionId',
          params: { sessionId },
          search: { threadId: data.thread.id },
        });
      },
    });
  };

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between border-b border-border px-5 py-3">
        <div className="flex items-center gap-3">
          <Link
            to="/sessions/$sessionId/threads"
            params={{ sessionId }}
            search={{ page: undefined }}
            className="font-mono text-[11px] text-neutral-400 transition-colors hover:text-neutral-700 dark:text-neutral-500 dark:hover:text-neutral-200"
          >
            &larr; Threads
          </Link>
          <div className="min-w-0">
            {isEditingTitle ? (
              <input
                ref={titleInputRef}
                value={editTitleValue}
                onChange={(e) => setEditTitleValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') saveTitle();
                  if (e.key === 'Escape') setIsEditingTitle(false);
                }}
                onBlur={saveTitle}
                className="w-full rounded border border-violet-300 bg-white px-1 py-0.5 font-mono text-sm font-semibold text-neutral-800 outline-none focus:ring-1 focus:ring-violet-400 dark:border-violet-600 dark:bg-neutral-900 dark:text-neutral-100"
                autoFocus
                maxLength={200}
              />
            ) : (
              <h1 className="group flex items-center gap-1.5 truncate font-mono text-sm font-semibold text-neutral-800 dark:text-neutral-100">
                <span className="truncate">{thread?.title || thread?.firstMessagePreview || 'Untitled thread'}</span>
                <span
                  role="button"
                  tabIndex={-1}
                  onClick={startEditingTitle}
                  className="shrink-0 rounded p-0.5 text-neutral-400 opacity-0 transition-opacity hover:bg-neutral-200 hover:text-neutral-600 group-hover:opacity-100 dark:hover:bg-neutral-700 dark:hover:text-neutral-300"
                  title="Rename"
                >
                  <PencilIcon className="h-3 w-3" />
                </span>
              </h1>
            )}
            {thread && (
              <div className="flex items-center gap-2 font-mono text-[10px] text-neutral-400 dark:text-neutral-500">
                <span>{messages.length} {messages.length === 1 ? 'message' : 'messages'}</span>
                <span>&middot;</span>
                <span>{formatRelativeTime(thread.lastActiveAt)}</span>
                {thread.summaryFiles > 0 && (
                  <>
                    <span>&middot;</span>
                    <span className="tabular-nums">
                      <span className="text-emerald-600 dark:text-emerald-400">+{thread.summaryAdditions}</span>
                      {' '}
                      <span className="text-red-500 dark:text-red-400">-{thread.summaryDeletions}</span>
                      {' '}across {thread.summaryFiles} {thread.summaryFiles === 1 ? 'file' : 'files'}
                    </span>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
        {thread && messages.length > 0 && (
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => {
                const text = exportThread(thread, messages);
                copyToClipboard(text);
              }}
              className="rounded-md px-2.5 py-1.5 font-mono text-[10px] text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-700 dark:text-neutral-500 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
              title="Copy full thread to clipboard"
            >
              Copy
            </button>
            <button
              type="button"
              onClick={() => {
                const text = exportThread(thread, messages);
                const slug = (thread.title || 'thread').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
                downloadText(`${slug}-${threadId.slice(0, 8)}.txt`, text);
              }}
              className="rounded-md px-2.5 py-1.5 font-mono text-[10px] text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-700 dark:text-neutral-500 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
              title="Download full thread as text file"
            >
              Download
            </button>
          </div>
        )}
      </div>

      {/* Messages */}
      {isLoading && (
        <div className="flex flex-1 items-center justify-center">
          <div className="flex items-center gap-2">
            <div className="h-3 w-3 animate-spin rounded-full border border-neutral-300 border-t-transparent dark:border-neutral-600 dark:border-t-transparent" />
            <span className="font-mono text-[11px] text-neutral-400">Loading thread...</span>
          </div>
        </div>
      )}

      {isError && (
        <div className="flex flex-1 items-center justify-center">
          <span className="font-mono text-[11px] text-red-500">Failed to load thread.</span>
        </div>
      )}

      {!isLoading && !isError && (
        <>
          <MessageList messages={messages} />

          {/* Continue button */}
          <div className="shrink-0 border-t border-border px-5 py-3">
            <button
              type="button"
              onClick={handleContinue}
              disabled={continueThread.isPending}
              className="rounded-md bg-accent px-4 py-2 font-mono text-[12px] font-medium text-white transition-colors hover:bg-accent/90 disabled:opacity-50"
            >
              {continueThread.isPending ? 'Continuing...' : 'Continue Thread'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function PencilIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" /><path d="m15 5 4 4" />
    </svg>
  );
}
