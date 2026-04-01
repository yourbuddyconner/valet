import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useThread, useContinueThread } from '@/api/threads';
import { MessageList } from '@/components/chat/message-list';
import { setPendingContinuation } from '@/components/chat/chat-container';
import { formatRelativeTime } from '@/lib/format';

export const Route = createFileRoute('/sessions/$sessionId/threads/$threadId')({
  component: ThreadDetailPage,
});

function ThreadDetailPage() {
  const { sessionId, threadId } = Route.useParams();
  const { data, isLoading, isError } = useThread(sessionId, threadId);
  const continueThread = useContinueThread(sessionId);
  const navigate = useNavigate();

  const thread = data?.thread;
  const messages = data?.messages ?? [];

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
            className="font-mono text-[11px] text-neutral-400 transition-colors hover:text-neutral-700 dark:text-neutral-500 dark:hover:text-neutral-200"
          >
            &larr; Threads
          </Link>
          <div className="min-w-0">
            <h1 className="truncate font-mono text-sm font-semibold text-neutral-800 dark:text-neutral-100">
              {thread?.title || thread?.firstMessagePreview || 'Untitled thread'}
            </h1>
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
