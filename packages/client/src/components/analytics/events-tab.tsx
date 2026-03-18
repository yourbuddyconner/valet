import * as React from 'react';
import { useAnalyticsEvents } from '@/api/analytics';
import { Link } from '@tanstack/react-router';

const TYPE_FILTERS = [
  { label: 'All', value: undefined },
  { label: 'LLM', value: 'llm_' },
  { label: 'Turn', value: 'turn_' },
  { label: 'Queue', value: 'queue_' },
  { label: 'Sandbox', value: 'sandbox_' },
  { label: 'Session', value: 'session.' },
  { label: 'Agent', value: 'agent.' },
  { label: 'Workflow', value: 'workflow.' },
] as const;

const PAGE_SIZE = 50;

function formatRelativeTime(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffMs = now - then;
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

function formatDuration(ms: number | null): string {
  if (ms === null) return '-';
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

function truncate(str: string | null, maxLen: number): string {
  if (!str) return '-';
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + '...';
}

export function EventsTab({ period }: { period: number }) {
  const [typeFilter, setTypeFilter] = React.useState<string | undefined>(undefined);
  const [page, setPage] = React.useState(0);

  // Reset page when filter changes
  React.useEffect(() => {
    setPage(0);
  }, [typeFilter]);

  const offset = page * PAGE_SIZE;
  const { data, isLoading } = useAnalyticsEvents(period, typeFilter, PAGE_SIZE, offset);

  const totalPages = data ? Math.ceil(data.total / PAGE_SIZE) : 0;

  return (
    <div className="space-y-4">
      {/* Filter pills */}
      <div className="flex flex-wrap gap-1.5">
        {TYPE_FILTERS.map((f) => (
          <button
            key={f.label}
            onClick={() => setTypeFilter(f.value)}
            className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              typeFilter === f.value
                ? 'bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900'
                : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-700'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Table */}
      <div className="rounded-lg border border-neutral-200/80 bg-white p-6 shadow-[0_1px_2px_0_rgb(0_0_0/0.04)] dark:border-neutral-800 dark:bg-surface-1 dark:shadow-none">
        {isLoading ? (
          <div className="space-y-3 animate-pulse">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="h-8 rounded bg-neutral-100 dark:bg-neutral-800" />
            ))}
          </div>
        ) : !data || data.events.length === 0 ? (
          <div className="flex h-48 items-center justify-center text-sm text-neutral-400">
            No events found
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-neutral-100 dark:border-neutral-800">
                  <th className="pb-2 pr-4 text-left font-mono text-2xs font-medium text-neutral-400">Time</th>
                  <th className="pb-2 px-4 text-left font-mono text-2xs font-medium text-neutral-400">Event Type</th>
                  <th className="pb-2 px-4 text-right font-mono text-2xs font-medium text-neutral-400">Duration</th>
                  <th className="pb-2 px-4 text-left font-mono text-2xs font-medium text-neutral-400">Summary</th>
                  <th className="pb-2 pl-4 text-left font-mono text-2xs font-medium text-neutral-400">Session</th>
                </tr>
              </thead>
              <tbody>
                {data.events.map((event) => (
                  <tr key={event.id} className="border-b border-neutral-50 last:border-0 dark:border-neutral-800/50">
                    <td className="py-2.5 pr-4 whitespace-nowrap font-mono text-xs text-neutral-500 dark:text-neutral-400">
                      {formatRelativeTime(event.createdAt)}
                    </td>
                    <td className="py-2.5 px-4">
                      <code className="rounded bg-neutral-100 px-1.5 py-0.5 font-mono text-xs text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">
                        {event.eventType}
                      </code>
                    </td>
                    <td className="py-2.5 px-4 text-right font-mono text-xs tabular-nums text-neutral-600 dark:text-neutral-300">
                      {formatDuration(event.durationMs)}
                    </td>
                    <td className="py-2.5 px-4 text-xs text-neutral-600 dark:text-neutral-300 max-w-[300px]">
                      {truncate(event.summary, 60)}
                    </td>
                    <td className="py-2.5 pl-4">
                      <Link
                        to="/sessions/$sessionId"
                        params={{ sessionId: event.sessionId }}
                        className="font-mono text-xs text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
                      >
                        {event.sessionId.slice(0, 8)}
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination */}
        {data && data.total > PAGE_SIZE && (
          <div className="mt-4 flex items-center justify-between border-t border-neutral-100 pt-4 dark:border-neutral-800">
            <span className="font-mono text-2xs text-neutral-400">
              {offset + 1}-{Math.min(offset + PAGE_SIZE, data.total)} of {data.total}
            </span>
            <div className="flex gap-2">
              <button
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={page === 0}
                className="rounded-md border border-neutral-200 px-3 py-1.5 text-xs font-medium text-neutral-600 transition-colors hover:bg-neutral-50 disabled:opacity-40 disabled:cursor-not-allowed dark:border-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800"
              >
                Previous
              </button>
              <button
                onClick={() => setPage((p) => p + 1)}
                disabled={page >= totalPages - 1}
                className="rounded-md border border-neutral-200 px-3 py-1.5 text-xs font-medium text-neutral-600 transition-colors hover:bg-neutral-50 disabled:opacity-40 disabled:cursor-not-allowed dark:border-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
