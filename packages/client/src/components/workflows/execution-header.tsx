import { Link } from '@tanstack/react-router';
import type { Execution } from '@/api/executions';
import { formatRelativeTime } from '@/lib/format';
import { cn } from '@/lib/cn';

const STATUS_CLASSES: Record<Execution['status'], string> = {
  pending: 'bg-neutral-100 text-neutral-700',
  running: 'bg-blue-100 text-blue-800',
  waiting_approval: 'bg-orange-100 text-orange-800',
  completed: 'bg-emerald-100 text-emerald-800',
  failed: 'bg-red-100 text-red-800',
  cancelled: 'bg-neutral-200 text-neutral-700',
};

interface Props {
  execution: Execution;
  onCancel?: () => void;
  onApprove?: () => void;
  onDeny?: () => void;
  onToggleJson?: () => void;
}

export function ExecutionHeader({ execution, onCancel, onApprove, onDeny, onToggleJson }: Props) {
  return (
    <div className="px-6 py-4 bg-white border-b border-neutral-200">
      <div className="text-xs text-neutral-500 tracking-wider mb-1">AUTOMATION / EXECUTIONS</div>
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-xl font-semibold text-neutral-900">{execution.workflowName ?? 'Workflow'}</h1>
            <span
              className={cn(
                'text-[11px] px-2.5 py-0.5 rounded-full font-bold uppercase tracking-wider',
                STATUS_CLASSES[execution.status],
              )}
            >
              {execution.status === 'running'
                ? `● Running · ${formatRelativeTime(execution.startedAt)}`
                : execution.status}
            </span>
          </div>
          <div className="text-sm text-neutral-600 mt-1.5">
            Triggered by <strong>{execution.triggerType}</strong> · started {formatRelativeTime(execution.startedAt)} ·
            <code className="bg-neutral-100 px-1.5 py-0.5 rounded text-xs ml-1">{execution.id.slice(0, 8)}</code>
            {execution.sessionId && (
              <>
                {' · '}
                <Link
                  to="/sessions/$sessionId"
                  params={{ sessionId: execution.sessionId }}
                  className="text-indigo-600 hover:underline"
                >
                  view session ↗
                </Link>
              </>
            )}
          </div>
        </div>
        <div className="flex gap-2">
          {onToggleJson && <SmallButton onClick={onToggleJson}>{`{ } JSON`}</SmallButton>}
          {execution.status === 'waiting_approval' && (
            <>
              {onApprove && (
                <SmallButton variant="success" onClick={onApprove}>
                  ✓ Approve
                </SmallButton>
              )}
              {onDeny && (
                <SmallButton variant="danger" onClick={onDeny}>
                  Deny
                </SmallButton>
              )}
            </>
          )}
          {(execution.status === 'running' || execution.status === 'pending') && onCancel && (
            <SmallButton variant="danger" onClick={onCancel}>
              ✕ Cancel
            </SmallButton>
          )}
        </div>
      </div>
    </div>
  );
}

function SmallButton({
  variant,
  className,
  ...rest
}: { variant?: 'danger' | 'success' } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const v =
    variant === 'danger'
      ? 'bg-red-50 text-red-800 border-red-200 hover:bg-red-100'
      : variant === 'success'
        ? 'bg-emerald-50 text-emerald-800 border-emerald-200 hover:bg-emerald-100'
        : 'bg-white text-neutral-700 border-neutral-300 hover:bg-neutral-50';
  return <button {...rest} className={cn('text-sm px-3 py-1.5 rounded-md border font-medium', v, className)} />;
}
