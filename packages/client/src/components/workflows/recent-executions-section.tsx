import { Link } from '@tanstack/react-router';
import { useWorkflowExecutions } from '@/api/executions';
import { formatRelativeTime } from '@/lib/format';

const STATUS_CLASSES: Record<string, string> = {
  pending: 'bg-neutral-100 text-neutral-700',
  running: 'bg-blue-100 text-blue-800',
  waiting_approval: 'bg-orange-100 text-orange-800',
  completed: 'bg-emerald-100 text-emerald-800',
  failed: 'bg-red-100 text-red-800',
  cancelled: 'bg-neutral-200 text-neutral-700',
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
        return (
          <Link
            key={e.id}
            to="/automation/executions/$executionId"
            params={{ executionId: e.id }}
            className="flex items-center gap-3 px-3 py-2 rounded-lg border border-neutral-200 hover:bg-neutral-50"
          >
            <span
              className={`text-[11px] px-2 py-0.5 rounded-full font-medium ${
                STATUS_CLASSES[e.status] ?? 'bg-neutral-100'
              }`}
            >
              {e.status}
            </span>
            <span className="text-sm text-neutral-700">{e.triggerType}</span>
            <span className="text-xs text-neutral-500 ml-auto">
              {ago} · {duration}
            </span>
          </Link>
        );
      })}
      {total > limit && (
        <Link
          to="/automation/executions"
          className="text-xs text-neutral-500 hover:text-neutral-800 mt-1"
        >
          View all {total} runs →
        </Link>
      )}
    </div>
  );
}
