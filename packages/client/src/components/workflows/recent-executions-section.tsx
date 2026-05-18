import { Link } from '@tanstack/react-router';
import { ArrowRight } from 'lucide-react';
import { useWorkflowExecutions } from '@/api/executions';
import { formatRelativeTime } from '@/lib/format';
import { Badge, StatusDot } from '@/components/ui/badge';

type BadgeVariant = 'default' | 'success' | 'warning' | 'error' | 'secondary';

const STATUS_VARIANT: Record<string, BadgeVariant> = {
  pending: 'secondary',
  running: 'default',
  waiting_approval: 'warning',
  completed: 'success',
  failed: 'error',
  cancelled: 'secondary',
};

interface Props {
  workflowId: string;
  limit?: number;
}

export function RecentExecutionsSection({ workflowId, limit = 10 }: Props) {
  const { data } = useWorkflowExecutions(workflowId);
  const rows = (data?.executions ?? []).slice(0, limit);
  const total = data?.executions.length ?? 0;
  if (rows.length === 0) {
    return <div className="text-sm text-neutral-500">No runs yet.</div>;
  }
  return (
    <div className="flex flex-col gap-1.5">
      {rows.map((e) => {
        const ago = formatRelativeTime(e.startedAt);
        const duration = e.completedAt
          ? `${((new Date(e.completedAt).getTime() - new Date(e.startedAt).getTime()) / 1000).toFixed(1)}s`
          : 'running';
        const variant = STATUS_VARIANT[e.status] ?? 'secondary';
        const isRunning = e.status === 'running';
        return (
          <Link
            key={e.id}
            to="/automation/executions/$executionId"
            params={{ executionId: e.id }}
            className="flex items-center gap-3 px-3 py-2 rounded-lg border border-border bg-surface-1 transition-colors hover:bg-surface-2"
          >
            <Badge variant={variant} className={isRunning ? 'text-accent' : undefined}>
              {isRunning && <StatusDot variant="default" />}
              {e.status}
            </Badge>
            <span className="text-sm text-neutral-700 dark:text-neutral-300">{e.triggerType}</span>
            <span className="text-xs text-neutral-500 ml-auto">
              {ago} · {duration}
            </span>
          </Link>
        );
      })}
      {total > limit && (
        <Link
          to="/automation/executions"
          className="text-xs text-neutral-500 hover:text-foreground mt-1 inline-flex items-center gap-1"
        >
          View all {total} runs
          <ArrowRight className="w-3 h-3 inline-block" />
        </Link>
      )}
    </div>
  );
}
