import { Link } from '@tanstack/react-router';
import { Check, X, XCircle, ArrowUpRight } from 'lucide-react';
import type { Execution } from '@/api/executions';
import { formatRelativeTime } from '@/lib/format';
import { Badge, StatusDot } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

type BadgeVariant = 'default' | 'success' | 'warning' | 'error' | 'secondary';

const STATUS_VARIANT: Record<Execution['status'], BadgeVariant> = {
  pending: 'secondary',
  running: 'default',
  waiting_approval: 'warning',
  completed: 'success',
  failed: 'error',
  cancelled: 'secondary',
};

interface Props {
  execution: Execution;
  onCancel?: () => void;
  onApprove?: () => void;
  onDeny?: () => void;
  onToggleJson?: () => void;
}

export function ExecutionHeader({ execution, onCancel, onApprove, onDeny, onToggleJson }: Props) {
  const variant = STATUS_VARIANT[execution.status];
  const isRunning = execution.status === 'running';
  return (
    <div className="px-6 py-4 bg-surface-0 border-b border-border">
      <div className="text-xs text-neutral-500 tracking-wider mb-1">AUTOMATION / EXECUTIONS</div>
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-xl font-semibold text-foreground">{execution.workflowName ?? 'Workflow'}</h1>
            <Badge variant={variant} className={isRunning ? 'text-accent' : undefined}>
              {isRunning && <StatusDot variant="default" />}
              {isRunning
                ? `Running · ${formatRelativeTime(execution.startedAt)}`
                : execution.status}
            </Badge>
            {isRunning && (
              <span className="text-xs text-neutral-500 tabular-nums animate-number-in">
                {formatRelativeTime(execution.startedAt)}
              </span>
            )}
          </div>
          <div className="text-sm text-neutral-600 dark:text-neutral-400 mt-1.5">
            Triggered by <strong>{execution.triggerType}</strong> · started {formatRelativeTime(execution.startedAt)} ·
            <code className="bg-surface-2 text-neutral-500 dark:text-neutral-400 font-mono px-1.5 py-0.5 rounded text-xs ml-1">
              {execution.id.slice(0, 8)}
            </code>
            {execution.sessionId && (
              <>
                {' · '}
                <Link
                  to="/sessions/$sessionId"
                  params={{ sessionId: execution.sessionId }}
                  className="text-accent hover:underline inline-flex items-center gap-0.5"
                >
                  view session
                  <ArrowUpRight className="w-3 h-3 inline-block" />
                </Link>
              </>
            )}
          </div>
        </div>
        <div className="flex gap-2">
          {onToggleJson && (
            <Button variant="secondary" size="sm" onClick={onToggleJson}>
              {`{ } JSON`}
            </Button>
          )}
          {execution.status === 'waiting_approval' && (
            <>
              {onApprove && (
                <Button variant="primary" size="sm" onClick={onApprove}>
                  <Check className="w-3.5 h-3.5 mr-1" />
                  Approve
                </Button>
              )}
              {onDeny && (
                <Button variant="destructive" size="sm" onClick={onDeny}>
                  <X className="w-3.5 h-3.5 mr-1" />
                  Deny
                </Button>
              )}
            </>
          )}
          {(execution.status === 'running' || execution.status === 'pending') && onCancel && (
            <Button variant="destructive" size="sm" onClick={onCancel}>
              <XCircle className="w-3.5 h-3.5 mr-1" />
              Cancel
            </Button>
          )}
        </div>
      </div>
      {execution.error && (execution.status === 'failed' || execution.status === 'cancelled') && (
        <div className="mt-3 text-xs text-red-600 dark:text-red-400 bg-red-500/10 border border-red-500/30 rounded px-3 py-2 font-mono whitespace-pre-wrap break-words">
          {execution.error}
        </div>
      )}
    </div>
  );
}
