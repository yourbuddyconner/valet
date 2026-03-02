import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useApproveAction, useDenyAction } from '@/api/action-invocations';

export interface PendingActionApproval {
  invocationId: string;
  toolId: string;
  service: string;
  actionId: string;
  riskLevel: string;
  params?: Record<string, unknown>;
  expiresAt?: number;
  status: 'pending' | 'approved' | 'denied' | 'expired';
}

function riskBadgeVariant(level: string): 'success' | 'warning' | 'error' | 'default' {
  switch (level) {
    case 'low': return 'success';
    case 'medium': return 'warning';
    case 'high': return 'error';
    case 'critical': return 'error';
    default: return 'default';
  }
}

function formatParams(params?: Record<string, unknown>): string {
  if (!params || Object.keys(params).length === 0) return '';
  try {
    const entries = Object.entries(params).slice(0, 4);
    return entries.map(([k, v]) => {
      const val = typeof v === 'string' ? (v.length > 60 ? v.slice(0, 57) + '...' : v) : JSON.stringify(v);
      return `${k}: ${val}`;
    }).join(', ');
  } catch {
    return '';
  }
}

function useCountdown(expiresAt?: number) {
  const [remaining, setRemaining] = React.useState<string>('');

  React.useEffect(() => {
    if (!expiresAt) return;

    function update() {
      const diff = expiresAt! - Date.now();
      if (diff <= 0) {
        setRemaining('expired');
        return;
      }
      const mins = Math.floor(diff / 60000);
      const secs = Math.floor((diff % 60000) / 1000);
      setRemaining(`${mins}:${secs.toString().padStart(2, '0')}`);
    }

    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [expiresAt]);

  return remaining;
}

interface ActionApprovalCardProps {
  approval: PendingActionApproval;
  /** If provided, send via WS. If not, use HTTP mutation. */
  onApproveWs?: (invocationId: string) => void;
  onDenyWs?: (invocationId: string) => void;
}

export function ActionApprovalCard({ approval, onApproveWs, onDenyWs }: ActionApprovalCardProps) {
  const approveMutation = useApproveAction();
  const denyMutation = useDenyAction();
  const countdown = useCountdown(approval.expiresAt);

  const isResolved = approval.status !== 'pending';
  const isLoading = approveMutation.isPending || denyMutation.isPending;

  function handleApprove() {
    if (onApproveWs) {
      onApproveWs(approval.invocationId);
    } else {
      approveMutation.mutate(approval.invocationId);
    }
  }

  function handleDeny() {
    if (onDenyWs) {
      onDenyWs(approval.invocationId);
    } else {
      denyMutation.mutate({ invocationId: approval.invocationId });
    }
  }

  const paramSummary = formatParams(approval.params);

  return (
    <div className="my-2 rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-800/50 dark:bg-amber-900/20">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
              Action requires approval
            </span>
            <Badge variant={riskBadgeVariant(approval.riskLevel)}>
              {approval.riskLevel}
            </Badge>
          </div>
          <p className="mt-1 font-mono text-xs text-neutral-600 dark:text-neutral-400">
            {approval.service}:{approval.actionId}
          </p>
          {paramSummary && (
            <p className="mt-1 truncate text-xs text-neutral-500 dark:text-neutral-500">
              {paramSummary}
            </p>
          )}
        </div>

        {!isResolved && countdown && countdown !== 'expired' && (
          <span className="shrink-0 text-xs text-neutral-500 dark:text-neutral-400">
            {countdown}
          </span>
        )}
      </div>

      {isResolved ? (
        <div className="mt-2">
          <Badge variant={approval.status === 'approved' ? 'success' : approval.status === 'denied' ? 'error' : 'secondary'}>
            {approval.status === 'approved' ? 'Approved' : approval.status === 'denied' ? 'Denied' : 'Expired'}
          </Badge>
        </div>
      ) : (
        <div className="mt-3 flex gap-2">
          <Button
            size="sm"
            variant="default"
            onClick={handleApprove}
            disabled={isLoading}
            className="bg-emerald-600 hover:bg-emerald-700 text-white"
          >
            {approveMutation.isPending ? 'Approving...' : 'Approve'}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={handleDeny}
            disabled={isLoading}
            className="border-red-300 text-red-600 hover:bg-red-50 dark:border-red-700 dark:text-red-400 dark:hover:bg-red-900/20"
          >
            {denyMutation.isPending ? 'Denying...' : 'Deny'}
          </Button>
        </div>
      )}
    </div>
  );
}
