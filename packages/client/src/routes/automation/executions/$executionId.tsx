import * as React from 'react';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { isActiveExecutionStatus, useCancelExecution, useExecution, useRetryExecution } from '@/api/executions';
import { useWorkflow } from '@/api/workflows';
import type { Execution, ExecutionNode } from '@/api/executions';
import type { WorkflowDefinition } from '@valet/shared';
import { ExecutionApprovalPanel } from '@/components/workflows/execution-approval-panel';
import { WorkflowExecutionViewer } from '@/components/workflows/workflow-execution-viewer';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { toastError, toastSuccess } from '@/hooks/use-toast';
import { formatRelativeTime } from '@/lib/format';
import { cn } from '@/lib/cn';

export const Route = createFileRoute('/automation/executions/$executionId')({
  component: ExecutionDetailPage,
});

function ExecutionDetailPage() {
  const { executionId } = Route.useParams();
  const navigate = useNavigate();
  const { data, isLoading, error } = useExecution(executionId);
  const cancel = useCancelExecution();
  const retryExecution = useRetryExecution();
  const execution = data?.execution;
  // Persist the toggle across reloads — switching to Canvas should
  // stick. localStorage avoids dragging URL state for what's a pure UI
  // preference. Default to 'canvas' since that's the more graphical
  // view of the same data.
  const [view, setView] = React.useState<'canvas' | 'trace'>(() => {
    if (typeof window === 'undefined') return 'canvas';
    return (localStorage.getItem('exec.detail.view') as 'canvas' | 'trace' | null) ?? 'canvas';
  });
  React.useEffect(() => {
    if (typeof window !== 'undefined') localStorage.setItem('exec.detail.view', view);
  }, [view]);
  const [selectedNodeId, setSelectedNodeId] = React.useState<string | null>(null);
  // Fetch the workflow only when canvas view is selected; the table
  // view doesn't need the DAG. enabled-by-presence on the workflow id
  // keeps the request out of flight until both prerequisites land.
  const { data: workflowData } = useWorkflow(execution?.workflowId ?? '');
  const definition: WorkflowDefinition | null = workflowData?.workflow.data
    ? (workflowData.workflow.data as unknown as WorkflowDefinition)
    : null;

  const onCancel = async () => {
    try {
      await cancel.mutateAsync({ executionId, data: { reason: 'Cancelled from execution details' } });
      toastSuccess('Execution cancelled');
    } catch (err) {
      toastError('Cancel failed', err instanceof Error ? err.message : 'unknown error');
    }
  };

  const onRetry = async () => {
    try {
      const result = await retryExecution.mutateAsync({ executionId });
      toastSuccess(`Retry started (${result.executionId})`);
      navigate({ to: '/automation/executions/$executionId', params: { executionId: result.executionId } });
    } catch (err) {
      toastError('Retry failed', err instanceof Error ? err.message : 'unknown error');
    }
  };

  if (isLoading) return <ExecutionDetailSkeleton />;

  if (error || !execution) {
    return (
      <div className="space-y-4">
        <BackLink />
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 dark:border-red-800 dark:bg-red-950">
          <p className="text-sm text-pretty text-red-600 dark:text-red-400">
            Failed to load execution.
          </p>
        </div>
      </div>
    );
  }

  const nodes = execution.nodes ?? [];
  const isActive = isActiveExecutionStatus(execution.status);

  return (
    <div className="space-y-5">
      <BackLink />

      <header className="flex flex-col gap-3 border-b border-neutral-200 pb-4 dark:border-neutral-800 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="truncate text-xl font-semibold text-neutral-950 dark:text-neutral-50">
              {execution.workflowName ?? 'Workflow execution'}
            </h1>
            <ExecutionStatusBadge status={execution.status} />
            {execution.mode && <Badge variant="secondary">{execution.mode}</Badge>}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-neutral-500 dark:text-neutral-400">
            <code>{execution.id}</code>
            <span>{execution.triggerType}</span>
            <span>started {formatRelativeTime(execution.startedAt)}</span>
            {execution.completedAt && <span>{formatDuration(execution.startedAt, execution.completedAt)}</span>}
          </div>
          {execution.triggerName && (
            <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
              Trigger: {execution.triggerName}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="secondary" onClick={onRetry} disabled={retryExecution.isPending}>
            <RetryIcon />
            {retryExecution.isPending ? 'Retrying...' : 'Retry'}
          </Button>
          {isActive && (
            <Button variant="destructive" onClick={onCancel} disabled={cancel.isPending}>
              <CancelIcon />
              {cancel.isPending ? 'Cancelling...' : 'Cancel'}
            </Button>
          )}
        </div>
      </header>

      {execution.error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 dark:border-red-800 dark:bg-red-950">
          <h2 className="mb-2 text-sm font-medium text-red-700 dark:text-red-300">Error</h2>
          <pre className="whitespace-pre-wrap break-words text-xs text-red-700 dark:text-red-300">
            {execution.error}
          </pre>
        </div>
      )}

      <ExecutionApprovalPanel
        executionId={execution.id}
        title="Action required"
      />

      <ViewToggle value={view} onChange={setView} />

      {view === 'canvas' ? (
        <section className="h-[640px] overflow-hidden rounded-lg border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-950">
          <WorkflowExecutionViewer
            definition={definition}
            execution={execution}
            executions={[execution]}
            isLoadingExecution={isLoading}
            selectedExecutionId={execution.id}
            selectedNodeId={selectedNodeId}
            onSelectExecution={() => undefined}
            onSelectNode={setSelectedNodeId}
            onRetryExecution={() => onRetry()}
            isRetryingExecution={retryExecution.isPending}
            embedded
          />
        </section>
      ) : (
        <>
          <section className="grid gap-4 md:grid-cols-3">
            <SummaryItem label="Workflow ID" value={execution.workflowId} />
            <SummaryItem label="Trigger ID" value={execution.triggerId ?? 'manual'} />
            <SummaryItem label="Node traces" value={String(nodes.length)} />
          </section>

          <section>
            <h2 className="mb-2 text-sm font-medium text-neutral-900 dark:text-neutral-100">
              Node trace
            </h2>
            <NodeTraceTable nodes={nodes} />
          </section>

          <section className="grid gap-4 lg:grid-cols-3">
            <JsonPanel title="Trigger data" value={execution.triggerData} />
            <JsonPanel title="Outputs" value={execution.outputs} />
            <JsonPanel title="Trigger metadata" value={execution.triggerMetadata} />
          </section>
        </>
      )}
    </div>
  );
}

function ViewToggle({
  value,
  onChange,
}: {
  value: 'canvas' | 'trace';
  onChange: (v: 'canvas' | 'trace') => void;
}) {
  return (
    <div className="inline-flex rounded-md border border-neutral-200 bg-neutral-50 p-0.5 dark:border-neutral-800 dark:bg-neutral-900">
      {(['canvas', 'trace'] as const).map((opt) => (
        <button
          key={opt}
          type="button"
          onClick={() => onChange(opt)}
          className={cn(
            'rounded px-3 py-1 text-xs font-medium transition-colors',
            value === opt
              ? 'bg-white text-neutral-900 shadow-sm dark:bg-neutral-700 dark:text-neutral-100'
              : 'text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100',
          )}
        >
          {opt === 'canvas' ? 'Canvas' : 'Trace'}
        </button>
      ))}
    </div>
  );
}

function BackLink() {
  return (
    <Link
      to="/automation/executions"
      className="inline-flex items-center gap-1 text-sm text-neutral-500 hover:text-neutral-950 dark:text-neutral-400 dark:hover:text-neutral-50"
    >
      <ArrowLeftIcon />
      Executions
    </Link>
  );
}

function ArrowLeftIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m12 19-7-7 7-7" />
      <path d="M19 12H5" />
    </svg>
  );
}

function CancelIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <path d="m15 9-6 6" />
      <path d="m9 9 6 6" />
    </svg>
  );
}

function RetryIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 12a9 9 0 1 0 3-6.7" />
      <path d="M3 4v6h6" />
    </svg>
  );
}

function SummaryItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-900">
      <div className="text-xs text-neutral-500 dark:text-neutral-400">{label}</div>
      <div className="mt-1 truncate font-mono text-sm text-neutral-900 dark:text-neutral-100" title={value}>
        {value}
      </div>
    </div>
  );
}

function NodeTraceTable({ nodes }: { nodes: ExecutionNode[] }) {
  if (nodes.length === 0) {
    return (
      <div className="rounded-lg border border-neutral-200 bg-white p-6 text-sm text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400">
        No node trace rows recorded.
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
      <div className="overflow-x-auto">
        <table className="min-w-full">
          <thead>
            <tr className="border-b border-neutral-200 bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-950">
              <TableHead>Node</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Duration</TableHead>
              <TableHead>Output / error</TableHead>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-200 dark:divide-neutral-800">
            {nodes.map((node) => (
              <tr key={node.id}>
                <td className="px-4 py-3">
                  <div className="font-mono text-xs text-neutral-900 dark:text-neutral-100">
                    {node.nodeId}
                  </div>
                  <div className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                    {node.nodeType}
                  </div>
                </td>
                <td className="px-4 py-3">
                  <NodeStatusBadge status={node.status} />
                </td>
                <td className="px-4 py-3 text-xs tabular-nums text-neutral-500 dark:text-neutral-400">
                  {typeof node.durationMs === 'number' ? `${node.durationMs}ms` : '—'}
                </td>
                <td className="max-w-[520px] px-4 py-3">
                  <pre className={cn(
                    'max-h-28 overflow-auto whitespace-pre-wrap break-words rounded-md p-2 text-xs',
                    node.error
                      ? 'bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300'
                      : 'bg-neutral-50 text-neutral-700 dark:bg-neutral-950 dark:text-neutral-300',
                  )}>
                    {node.error ?? node.output ?? node.reason ?? '—'}
                  </pre>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TableHead({ children }: { children: React.ReactNode }) {
  return (
    <th className="px-4 py-3 text-left text-xs font-medium uppercase text-neutral-500 dark:text-neutral-400">
      {children}
    </th>
  );
}

function JsonPanel({ title, value }: { title: string; value: unknown }) {
  return (
    <div className="rounded-lg border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
      <div className="border-b border-neutral-200 px-4 py-3 text-sm font-medium text-neutral-900 dark:border-neutral-800 dark:text-neutral-100">
        {title}
      </div>
      <pre className="max-h-80 overflow-auto p-4 text-xs text-neutral-700 dark:text-neutral-300">
        {value === null || value === undefined ? 'null' : JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

function ExecutionStatusBadge({ status }: { status: Execution['status'] }) {
  return <Badge variant={statusBadgeVariant(status)}>{formatStatus(status)}</Badge>;
}

function NodeStatusBadge({ status }: { status: ExecutionNode['status'] }) {
  return <Badge variant={statusBadgeVariant(status)}>{formatStatus(status)}</Badge>;
}

function statusBadgeVariant(
  status: Execution['status'] | ExecutionNode['status'],
): 'default' | 'success' | 'warning' | 'error' | 'secondary' {
  if (status === 'completed') return 'success';
  if (status === 'failed') return 'error';
  if (status === 'waiting_approval' || status === 'waiting_time' || status === 'pending') return 'warning';
  if (status === 'running' || status === 'cancelling') return 'default';
  return 'secondary';
}

function formatStatus(status: string) {
  return status.replace(/_/g, ' ');
}

function formatDuration(start: string, end: string): string {
  const durationMs = new Date(end).getTime() - new Date(start).getTime();
  if (durationMs < 1000) return `${durationMs}ms`;
  if (durationMs < 60000) return `${(durationMs / 1000).toFixed(1)}s`;
  if (durationMs < 3600000) return `${Math.floor(durationMs / 60000)}m ${Math.floor((durationMs % 60000) / 1000)}s`;
  return `${Math.floor(durationMs / 3600000)}h ${Math.floor((durationMs % 3600000) / 60000)}m`;
}

function ExecutionDetailSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-5 w-28" />
      <Skeleton className="h-16 w-full" />
      <Skeleton className="h-40 w-full" />
      <div className="grid gap-4 lg:grid-cols-3">
        <Skeleton className="h-56 w-full" />
        <Skeleton className="h-56 w-full" />
        <Skeleton className="h-56 w-full" />
      </div>
    </div>
  );
}
