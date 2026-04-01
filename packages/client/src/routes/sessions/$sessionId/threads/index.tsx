import { createFileRoute, Link } from '@tanstack/react-router';
import { useThreads } from '@/api/threads';
import { formatRelativeTime } from '@/lib/format';
import { getThreadHistoryPages } from '../../-thread-history-pagination';

export const Route = createFileRoute('/sessions/$sessionId/threads/')({
  component: ThreadHistoryPage,
  validateSearch: (search: Record<string, unknown>) => ({
    page: typeof search.page === 'number'
      ? search.page
      : typeof search.page === 'string'
        ? parseInt(search.page, 10)
        : undefined,
  }),
});

function ThreadHistoryPage() {
  const { sessionId } = Route.useParams();
  const { page } = Route.useSearch();
  const safePage = typeof page === 'number' && Number.isFinite(page) && page > 0 ? page : 1;
  const { data, isLoading, isError } = useThreads(sessionId, { page: safePage, pageSize: 30 });

  const threads = data?.threads ?? [];
  const totalPages = data?.totalPages ?? 1;
  const pages = getThreadHistoryPages(safePage, totalPages);

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between border-b border-border px-5 py-3">
        <div className="flex items-center gap-3">
          <Link
            to="/sessions/$sessionId"
            params={{ sessionId }}
            className="font-mono text-[11px] text-neutral-400 transition-colors hover:text-neutral-700 dark:text-neutral-500 dark:hover:text-neutral-200"
          >
            &larr; Back
          </Link>
          <h1 className="font-mono text-sm font-semibold text-neutral-800 dark:text-neutral-100">
            Thread History
          </h1>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-5 py-4">
        {isLoading && (
          <div className="flex items-center gap-2 py-8">
            <div className="h-3 w-3 animate-spin rounded-full border border-neutral-300 border-t-transparent dark:border-neutral-600 dark:border-t-transparent" />
            <span className="font-mono text-[11px] text-neutral-400">Loading threads...</span>
          </div>
        )}

        {isError && (
          <div className="py-8 text-center font-mono text-[11px] text-red-500">
            Failed to load threads.
          </div>
        )}

        {!isLoading && !isError && threads.length === 0 && (
          <div className="py-8 text-center font-mono text-[11px] text-neutral-400 dark:text-neutral-500">
            No threads yet.
          </div>
        )}

        {!isLoading && !isError && threads.length > 0 && (
          <>
            <div className="space-y-2">
              {threads.map((thread) => (
                <Link
                  key={thread.id}
                  to="/sessions/$sessionId/threads/$threadId"
                  params={{ sessionId, threadId: thread.id }}
                  className="group block rounded-md border border-border/60 bg-surface-1/40 px-4 py-3 transition-colors hover:bg-surface-1 dark:bg-surface-2/40 dark:hover:bg-surface-2"
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="truncate font-mono text-[12px] font-medium text-neutral-800 transition-colors group-hover:text-accent dark:text-neutral-200 dark:group-hover:text-accent">
                      {thread.title || thread.firstMessagePreview || 'Untitled thread'}
                    </span>
                    <span className="shrink-0 font-mono text-[10px] tabular-nums text-neutral-400 dark:text-neutral-500">
                      {formatRelativeTime(thread.lastActiveAt)}
                    </span>
                  </div>

                  {thread.title && thread.firstMessagePreview && (
                    <p className="mt-1 line-clamp-2 font-mono text-[11px] leading-relaxed text-neutral-500 dark:text-neutral-400">
                      {thread.firstMessagePreview}
                    </p>
                  )}

                  <div className="mt-2 flex items-center gap-3">
                    <span className="font-mono text-[10px] text-neutral-400 dark:text-neutral-500">
                      {thread.messageCount} {thread.messageCount === 1 ? 'message' : 'messages'}
                    </span>
                    {thread.summaryFiles > 0 && (
                      <span className="font-mono text-[10px] tabular-nums text-neutral-400 dark:text-neutral-500">
                        <span className="text-emerald-600 dark:text-emerald-400">+{thread.summaryAdditions}</span>
                        {' '}
                        <span className="text-red-500 dark:text-red-400">-{thread.summaryDeletions}</span>
                        {' '}across {thread.summaryFiles} {thread.summaryFiles === 1 ? 'file' : 'files'}
                      </span>
                    )}
                  </div>
                </Link>
              ))}
            </div>

            {totalPages > 1 && (
              <div className="mt-4 flex items-center gap-2">
                <span className="font-mono text-[10px] text-neutral-400 dark:text-neutral-500">
                  {data?.totalCount ?? threads.length} threads
                </span>
                <div className="flex items-center gap-1">
                  {pages.map((nextPage) => (
                    <Link
                      key={nextPage}
                      to="/sessions/$sessionId/threads"
                      params={{ sessionId }}
                      search={{ page: nextPage }}
                      className={[
                        'rounded border px-2 py-1 font-mono text-[10px] transition-colors',
                        nextPage === safePage
                          ? 'border-accent bg-accent text-white'
                          : 'border-border text-neutral-500 hover:bg-surface-1 dark:text-neutral-400 dark:hover:bg-surface-2',
                      ].join(' ')}
                    >
                      {nextPage}
                    </Link>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
