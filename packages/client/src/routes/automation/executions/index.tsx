import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { Clock, Webhook, Play } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useInfiniteExecutions } from '@/api/executions';
import { Badge, StatusDot } from '@/components/ui/badge';
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
    <div className="space-y-4 bg-surface-0">
      <div className="inline-flex bg-surface-2 rounded-full p-0.5">
        {STATUS_OPTIONS.map((option) => (
          <button
            key={option.value}
            onClick={() => setStatusFilter(option.value)}
            aria-pressed={statusFilter === option.value}
            className={cn(
              'px-3 py-1 text-[11px] uppercase tracking-wider font-mono rounded-full transition-colors',
              statusFilter === option.value
                ? 'bg-surface-0 text-foreground shadow-panel'
                : 'text-neutral-500 hover:text-foreground'
            )}
          >
            {option.label}
          </button>
        ))}
      </div>

      {isLoading ? (
        <ExecutionListSkeleton />
      ) : error ? (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-4">
          <p className="text-sm text-pretty text-red-600 dark:text-red-400">
            Failed to load executions. Please try again.
          </p>
        </div>
      ) : executions.length === 0 ? (
        <div className="rounded-lg border border-border bg-surface-1 p-8 text-center">
          <p className="text-sm text-pretty text-neutral-500 dark:text-neutral-400">
            No executions found. Run a workflow to see execution history.
          </p>
        </div>
      ) : (
        <>
          <div className="overflow-hidden rounded-lg border border-border bg-surface-1">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border bg-surface-2">
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
              <tbody className="divide-y divide-border">
                {executions.map((execution) => (
                  <tr
                    key={execution.id}
                    onClick={() =>
                      nav({
                        to: '/automation/executions/$executionId',
                        params: { executionId: execution.id },
                      })
                    }
                    tabIndex={0}
                    className="cursor-pointer transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  >
                    <td className="px-4 py-3">
                      <ExecutionStatusBadge status={execution.status} />
                    </td>
                    <td className="px-4 py-3">
                      <div>
                        <p className="text-sm font-medium text-foreground">
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
    pending: 'secondary',
    running: 'default',
    waiting_approval: 'warning',
    completed: 'success',
    failed: 'error',
    cancelled: 'secondary',
  };
  const variant = variants[status] ?? 'secondary';
  const isRunning = status === 'running';
  return (
    <Badge variant={variant} className={isRunning ? 'text-accent' : undefined}>
      {isRunning && <StatusDot variant="default" />}
      {status}
    </Badge>
  );
}

const TRIGGER_ICONS: Record<string, LucideIcon> = {
  webhook: Webhook,
  schedule: Clock,
  manual: Play,
};

function TriggerTypeIcon({ type }: { type: string }) {
  const Icon = TRIGGER_ICONS[type] ?? Play;
  return <Icon className="size-4 text-neutral-400" />;
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
    <div className="overflow-hidden rounded-lg border border-border bg-surface-1">
      <div className="divide-y divide-border">
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
