import * as React from 'react';
import { Link } from '@tanstack/react-router';
import {
  type ExecutionApproval,
  usePendingExecutionApprovals,
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
  // Pending-approvals endpoint returns workflow-attributed gates AND
  // approvals from any session this execution spawned (transitively).
  // The execution-detail prop still passes its own workflow-direct
  // list; the propagation poll fills in the spawned-session view.
  const fetched = usePendingExecutionApprovals(executionId, {
    enabled: approvals === undefined,
  });

  const list: ExecutionApproval[] = approvals ?? fetched.data?.approvals ?? [];
  const pending = list.filter((a) => a.status === 'pending');

  if (pending.length === 0) return null;

  if (variant === 'inline') {
    return (
      <div className="space-y-2">
        {pending.map((approval) => (
          <ExecutionApprovalCard key={approval.id} executionId={executionId} approval={approval} />
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
          <ExecutionApprovalCard key={approval.id} executionId={executionId} approval={approval} />
        ))}
      </div>
    </div>
  );
}

export function ExecutionApprovalCard({ executionId, approval }: { executionId: string; approval: ExecutionApproval }) {
  const approve = useApproveExecutionApproval();
  const deny = useDenyExecutionApproval();
  const [reason, setReason] = React.useState('');
  const busy = approve.isPending || deny.isPending;
  const isPending = approval.status === 'pending';
  // iterationIndex is set when the approval was raised inside a foreach
  // body. The card uses this to offer the scoped "Approve remaining rows"
  // button — which creates an execution-scoped grant narrowed to this
  // foreach node, sweeping every pending iteration of the same body to
  // approved in one click.
  const isForeachIteration = typeof approval.iterationIndex === 'number';
  // Propagated from a session this execution spawned. The execution
  // approve/deny routes only resolve workflow-attributed invocations, so
  // for these rows we surface a deep link to the originating session
  // (where the existing session approval card can resolve it) instead
  // of rendering inline buttons.
  const isPropagated = typeof approval.originSessionId === 'string' && approval.originSessionId.length > 0;

  const onApprove = async (scope: 'once' | 'workflow_execution' = 'once', narrowToNode = false) => {
    try {
      await approve.mutateAsync({
        executionId,
        approvalId: approval.id,
        scope,
        ...(narrowToNode && approval.nodeId ? { nodeId: approval.nodeId } : {}),
      });
      const successMessage = scope === 'workflow_execution'
        ? narrowToNode
          ? `Approved remaining iterations of ${approval.nodeId}.`
          : `Approved for the rest of this run.`
        : `Approval for ${approval.nodeId} dispatched.`;
      toastSuccess('Approved', successMessage);
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
            {isPropagated && (
              <Badge variant="default" className="text-xs" title="Raised in a session this workflow spawned">
                from session
              </Badge>
            )}
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

      {isPending && isPropagated ? (
        <div className="mt-3 flex items-center gap-2 text-xs text-neutral-600 dark:text-neutral-300">
          <span>Resolve from the originating session:</span>
          <Link
            to="/sessions/$sessionId"
            params={{ sessionId: approval.originSessionId as string }}
            className="font-mono text-xs text-amber-700 underline hover:text-amber-900 dark:text-amber-300 dark:hover:text-amber-100"
          >
            {approval.originSessionId}
          </Link>
        </div>
      ) : isPending ? (
        <div className="mt-3 space-y-2">
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Reason (optional, sent on deny)"
            className="w-full rounded-md border border-neutral-200 bg-white px-3 py-1.5 text-xs text-neutral-900 placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-neutral-900 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100 dark:placeholder:text-neutral-500 dark:focus:ring-neutral-100"
          />
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => onApprove('once')} disabled={busy}>
              {approve.isPending ? 'Approving…' : 'Approve once'}
            </Button>
            {isForeachIteration && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => onApprove('workflow_execution', true)}
                disabled={busy}
                title="Auto-approve every remaining iteration of this foreach body"
              >
                Approve remaining rows
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              onClick={() => onApprove('workflow_execution')}
              disabled={busy}
              title="Auto-approve any matching approval gate for the rest of this run"
            >
              Approve for this run
            </Button>
            <Button size="sm" variant="destructive" onClick={onDeny} disabled={busy}>
              {deny.isPending ? 'Denying…' : 'Deny'}
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
          <Badge variant="secondary">{approval.status}</Badge>
          {approval.resolvedAt && <span>resolved {formatRelativeTime(approval.resolvedAt)}</span>}
          {approval.resolvedBy && <span className="truncate">by {approval.resolvedBy}</span>}
        </div>
      )}
    </div>
  );
}
