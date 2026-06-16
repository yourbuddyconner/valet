import * as React from 'react';
import {
  type ExecutionApproval,
  useExecutionApprovals,
  useApproveExecutionApproval,
  useDenyExecutionApproval,
} from '@/api/executions';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { toastError, toastSuccess } from '@/hooks/use-toast';
import { formatRelativeTime } from '@/lib/format';

interface ExecutionApprovalPanelProps {
  executionId: string;
  /** Pass the parent's already-fetched approval list if available, so
   *  the panel doesn't fire its own poll on top of the execution detail
   *  query. When omitted, the panel polls /api/executions/:id/approvals
   *  every few seconds. */
  approvals?: ExecutionApproval[] | undefined;
  /** Optional title override. Defaults to "Pending approvals". */
  title?: string;
  /** Compact rendering — used inside the executions list row. */
  variant?: 'panel' | 'inline';
}

/**
 * Surfaces every pending approval for a given execution with approve /
 * deny buttons. The execution detail endpoint returns approvals nested
 * under `execution.approvals`; the parent passes those in via the
 * `approvals` prop. When the parent only has the executionId, this
 * component polls the approvals endpoint directly.
 */
export function ExecutionApprovalPanel({
  executionId,
  approvals,
  title = 'Pending approvals',
  variant = 'panel',
}: ExecutionApprovalPanelProps) {
  // Only poll when the parent didn't pass approvals already.
  const fetched = useExecutionApprovals(executionId, {
    enabled: approvals === undefined,
  });

  const list: ExecutionApproval[] = approvals ?? fetched.data?.approvals ?? [];
  const pending = list.filter((a) => a.status === 'pending');

  if (pending.length === 0) return null;

  if (variant === 'inline') {
    return (
      <div className="space-y-2">
        {pending.map((approval) => (
          <ApprovalRow key={approval.id} executionId={executionId} approval={approval} />
        ))}
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50/60 p-4 dark:border-amber-800/60 dark:bg-amber-950/30">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-medium text-amber-900 dark:text-amber-200">
          {title}
        </h3>
        <Badge variant="default">{pending.length}</Badge>
      </div>
      <div className="space-y-3">
        {pending.map((approval) => (
          <ApprovalRow key={approval.id} executionId={executionId} approval={approval} />
        ))}
      </div>
    </div>
  );
}

function ApprovalRow({ executionId, approval }: { executionId: string; approval: ExecutionApproval }) {
  const approve = useApproveExecutionApproval();
  const deny = useDenyExecutionApproval();
  const [reason, setReason] = React.useState('');
  const busy = approve.isPending || deny.isPending;

  const onApprove = async () => {
    try {
      await approve.mutateAsync({ executionId, approvalId: approval.id });
      toastSuccess('Approved', `Approval for ${approval.nodeId} dispatched.`);
    } catch (err) {
      toastError('Approve failed', err instanceof Error ? err.message : 'unknown error');
    }
  };

  const onDeny = async () => {
    try {
      await deny.mutateAsync({
        executionId,
        approvalId: approval.id,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      });
      toastSuccess('Denied', `Approval for ${approval.nodeId} denied.`);
    } catch (err) {
      toastError('Deny failed', err instanceof Error ? err.message : 'unknown error');
    }
  };

  return (
    <div className="rounded-md border border-amber-200 bg-white p-3 text-sm dark:border-amber-900/60 dark:bg-neutral-900">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Badge variant="secondary" className="text-xs">{approval.kind === 'tool_policy' ? 'tool' : 'approval'}</Badge>
            <span className="truncate font-mono text-xs text-neutral-500 dark:text-neutral-400">{approval.nodeId}</span>
          </div>
          <p className="mt-1 whitespace-pre-wrap text-pretty text-neutral-900 dark:text-neutral-100">
            {approval.prompt}
          </p>
          {approval.summary && (
            <p className="mt-1 text-xs text-pretty text-neutral-500 dark:text-neutral-400">
              {approval.summary}
            </p>
          )}
          {approval.details !== null && (
            <details className="mt-2">
              <summary className="cursor-pointer text-xs text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100">
                Details
              </summary>
              <pre className="mt-1 overflow-x-auto rounded bg-neutral-50 p-2 text-xs dark:bg-neutral-800">
                {JSON.stringify(approval.details, null, 2)}
              </pre>
            </details>
          )}
          <div className="mt-2 flex items-center gap-3 text-xs text-neutral-500 dark:text-neutral-400">
            <span>requested {formatRelativeTime(approval.createdAt)}</span>
            {approval.timeoutAt && (
              <span title={approval.timeoutAt}>
                expires {formatRelativeTime(approval.timeoutAt)}
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="mt-3 space-y-2">
        <input
          type="text"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Reason (optional, sent on deny)"
          className="w-full rounded-md border border-neutral-200 bg-white px-3 py-1.5 text-xs text-neutral-900 placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-neutral-900 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100 dark:placeholder:text-neutral-500 dark:focus:ring-neutral-100"
        />
        <div className="flex gap-2">
          <Button size="sm" onClick={onApprove} disabled={busy}>
            {approve.isPending ? 'Approving…' : 'Approve'}
          </Button>
          <Button size="sm" variant="destructive" onClick={onDeny} disabled={busy}>
            {deny.isPending ? 'Denying…' : 'Deny'}
          </Button>
        </div>
      </div>
    </div>
  );
}
