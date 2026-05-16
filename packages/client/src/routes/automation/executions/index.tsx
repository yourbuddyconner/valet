import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useInfiniteExecutions } from '@/api/executions';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { LoadMoreButton } from '@/components/ui/load-more-button';
import { formatRelativeTime } from '@/lib/format';
import { cn } from '@/lib/cn';
import * as React from 'react';

export const Route = createFileRoute('/automation/executions/')({
  component: ExecutionsPage,
});

const STATUS_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'pending', label: 'Pending' },
  { value: 'running', label: 'Running' },
  { value: 'completed', label: 'Completed' },
  { value: 'failed', label: 'Failed' },
] as const;

function ExecutionsPage() {
  const nav = useNavigate();
  const [statusFilter, setStatusFilter] = React.useState<string>('all');
  const { data, isLoading, error, fetchNextPage, isFetchingNextPage, hasNextPage } =
    useInfiniteExecutions(statusFilter === 'all' ? undefined : { status: statusFilter });

  const executions = data?.executions ?? [];

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        {STATUS_OPTIONS.map((option) => (
          <button
            key={option.value}
            onClick={() => setStatusFilter(option.value)}
            className={cn(
              'rounded-md px-3 py-1.5 text-sm font-medium',
              statusFilter === option.value
                ? 'bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900'
                : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-700'
            )}
          >
            {option.label}
          </button>
        ))}
      </div>

      {isLoading ? (
        <ExecutionListSkeleton />
      ) : error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 dark:border-red-800 dark:bg-red-950">
          <p className="text-sm text-pretty text-red-600 dark:text-red-400">
            Failed to load executions. Please try again.
          </p>
        </div>
      ) : executions.length === 0 ? (
        <div className="rounded-lg border border-neutral-200 bg-white p-8 text-center dark:border-neutral-700 dark:bg-neutral-800">
          <p className="text-sm text-pretty text-neutral-500 dark:text-neutral-400">
            No executions found. Run a workflow to see execution history.
          </p>
        </div>
      ) : (
        <>
          <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white dark:border-neutral-700 dark:bg-neutral-800">
            <table className="w-full">
              <thead>
                <tr className="border-b border-neutral-200 bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-800">
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase text-neutral-500 dark:text-neutral-400">
                    Status
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase text-neutral-500 dark:text-neutral-400">
                    Workflow
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase text-neutral-500 dark:text-neutral-400">
                    Trigger
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase text-neutral-500 dark:text-neutral-400">
                    Started
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase text-neutral-500 dark:text-neutral-400">
                    Duration
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase text-neutral-500 dark:text-neutral-400">
                    Session
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-200 dark:divide-neutral-700">
                {executions.map((execution) => (
                  <tr
                    key={execution.id}
                    onClick={() =>
                      nav({
                        to: '/automation/executions/$executionId',
                        params: { executionId: execution.id },
                      })
                    }
                    className="cursor-pointer hover:bg-neutral-50 dark:hover:bg-neutral-700/50"
                  >
                    <td className="px-4 py-3">
                      <ExecutionStatusBadge status={execution.status} />
                    </td>
                    <td className="px-4 py-3">
                      <div>
                        <p className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
                          {execution.workflowName || 'Unknown'}
                        </p>
                        <p className="text-xs text-neutral-500 dark:text-neutral-400">
                          {execution.id.slice(0, 8)}...
                        </p>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <TriggerTypeIcon type={execution.triggerType} />
                        <span className="text-sm text-neutral-600 dark:text-neutral-300">
                          {execution.triggerType}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm text-neutral-500 tabular-nums dark:text-neutral-400">
                      {formatRelativeTime(execution.startedAt)}
                    </td>
                    <td className="px-4 py-3 text-sm text-neutral-500 tabular-nums dark:text-neutral-400">
                      {execution.completedAt
                        ? formatDuration(execution.startedAt, execution.completedAt)
                        : '—'}
                    </td>
                    <td className="px-4 py-3 text-sm">
                      {execution.sessionId ? (
                        <Link
                          to="/sessions/$sessionId"
                          params={{ sessionId: execution.sessionId }}
                          onClick={(e) => e.stopPropagation()}
                          className="text-accent hover:underline"
                        >
                          {execution.sessionId.slice(0, 8)}...
                        </Link>
                      ) : (
                        <span className="text-neutral-400 dark:text-neutral-500">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <LoadMoreButton
            onClick={() => fetchNextPage()}
            isLoading={isFetchingNextPage}
            hasMore={hasNextPage ?? false}
          />
        </>
      )}
    </div>
  );
}

function ExecutionStatusBadge({ status }: { status: string }) {
  const variants: Record<string, 'default' | 'success' | 'warning' | 'error' | 'secondary'> = {
    pending: 'warning',
    running: 'default',
    waiting_approval: 'warning',
    completed: 'success',
    failed: 'error',
  };

  return <Badge variant={variants[status] ?? 'secondary'}>{status}</Badge>;
}

function TriggerTypeIcon({ type }: { type: string }) {
  const iconClass = "size-4 text-neutral-400";

  if (type === 'webhook') {
    return (
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={iconClass}>
        <path d="M18 16.98h-5.99c-1.1 0-1.95.94-2.48 1.9A4 4 0 0 1 2 17c.01-.7.2-1.4.57-2" />
        <path d="m6 17 3.13-5.78c.53-.97.1-2.18-.5-3.1a4 4 0 1 1 6.89-4.06" />
        <path d="m12 6 3.13 5.73C15.66 12.7 16.9 13 18 13a4 4 0 0 1 0 8" />
      </svg>
    );
  }

  if (type === 'schedule') {
    return (
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={iconClass}>
        <circle cx="12" cy="12" r="10" />
        <polyline points="12 6 12 12 16 14" />
      </svg>
    );
  }

  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={iconClass}>
      <polygon points="6 3 20 12 6 21 6 3" />
    </svg>
  );
}

function formatDuration(start: string, end: string): string {
  const startTime = new Date(start).getTime();
  const endTime = new Date(end).getTime();
  const durationMs = endTime - startTime;

  if (durationMs < 1000) return `${durationMs}ms`;
  if (durationMs < 60000) return `${(durationMs / 1000).toFixed(1)}s`;
  if (durationMs < 3600000) return `${Math.floor(durationMs / 60000)}m ${Math.floor((durationMs % 60000) / 1000)}s`;
  return `${Math.floor(durationMs / 3600000)}h ${Math.floor((durationMs % 3600000) / 60000)}m`;
}

function ExecutionListSkeleton() {
  return (
    <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white dark:border-neutral-700 dark:bg-neutral-800">
      <div className="divide-y divide-neutral-200 dark:divide-neutral-700">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="flex items-center gap-4 p-4">
            <Skeleton className="h-6 w-20" />
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-4 w-16" />
          </div>
        ))}
      </div>
    </div>
  );
}
