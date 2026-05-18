import { Link } from '@tanstack/react-router';
import { Check, X, XCircle, ArrowUpRight } from 'lucide-react';
import type { Execution } from '@/api/executions';
import { formatRelativeTime } from '@/lib/format';
import { Badge, StatusDot } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';

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

function formatStatus(s: Execution['status']): string {
  return s.replace(/_/g, ' ');
}

export function ExecutionHeader({ execution, onCancel, onApprove, onDeny, onToggleJson }: Props) {
  const variant = STATUS_VARIANT[execution.status];
  const isRunning = execution.status === 'running';
  const isWaitingApproval = execution.status === 'waiting_approval';
  return (
    <div className="px-4 py-2.5 bg-surface-0 border-b border-border">
      {/* Row 1: name + status + id chip on the left, actions on the right. */}
      <div className="flex items-center justify-between gap-4 h-7">
        <div className="flex items-center gap-2.5 min-w-0">
          <h1 className="text-base font-semibold text-foreground truncate">
            {execution.workflowName ?? 'Workflow'}
          </h1>
          <Badge variant={variant} className={cn('capitalize', isRunning && 'text-accent')}>
            {isRunning && <StatusDot variant="default" />}
            {isWaitingApproval && <StatusDot variant="warning" />}
            {isRunning ? `Running · ${formatRelativeTime(execution.startedAt)}` : formatStatus(execution.status)}
          </Badge>
          <code className="bg-surface-2 text-neutral-500 dark:text-neutral-400 font-mono px-1.5 py-0.5 rounded text-[10px]">
            {execution.id.slice(0, 8)}
          </code>
        </div>
        <div className="flex gap-2 shrink-0">
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
      {/* Row 2: subtitle meta line in muted small text — kept on a separate row so action buttons retain their size. */}
      <div className="h-6 flex items-center text-[11px] text-neutral-500 truncate">
        Triggered by <strong className="font-medium mx-1">{execution.triggerType}</strong>
        {' · started '}
        {formatRelativeTime(execution.startedAt)}
        {execution.sessionId && (
          <>
            {' · '}
            <Link
              to="/sessions/$sessionId"
              params={{ sessionId: execution.sessionId }}
              className="text-accent hover:underline inline-flex items-center gap-0.5 ml-1"
            >
              view session
              <ArrowUpRight className="w-3 h-3 inline-block" />
            </Link>
          </>
        )}
      </div>
      {execution.error && (execution.status === 'failed' || execution.status === 'cancelled') && (
        <div className="mt-2 text-xs text-red-600 dark:text-red-400 bg-red-500/10 border border-red-500/30 rounded px-3 py-2 font-mono whitespace-pre-wrap break-words">
          {execution.error}
        </div>
      )}
    </div>
  );
}
