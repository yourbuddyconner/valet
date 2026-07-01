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
import { ToolPayload } from '@/components/payload/tool-payload';

interface ExecutionApprovalPanelProps {
  executionId: string;
  /** Optional title override. Defaults to "Approval required" / "Pending
   *  approvals" based on the pending count from the poll. */
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
  title,
  variant = 'panel',
}: ExecutionApprovalPanelProps) {
  // Always poll the pending-approvals endpoint. It already merges
  // workflow-direct gates with descendant invocations from any session
  // this execution spawned (transitively) — letting the parent pass
  // execution.approvals here would silently hide every cross-context
  // approval, which is exactly the propagation surface this view is
  // supposed to expose.
  const fetched = usePendingExecutionApprovals(executionId);

  const list: ExecutionApproval[] = fetched.data?.approvals ?? [];
  const pending = list.filter((a) => a.status === 'pending');

  if (pending.length === 0) return null;

  const resolvedTitle = title ?? (pending.length > 1 ? 'Pending approvals' : 'Approval required');

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
          {resolvedTitle}
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
  // A pending approval whose timeout has already passed will be rejected
  // by the server with "approval has expired" — there's no periodic
  // sweep that flips status to 'expired' in the DB, so we detect it
  // client-side and render the expired state instead of approve buttons.
  const isExpired = approval.status === 'pending'
    && typeof approval.timeoutAt === 'string'
    && new Date(approval.timeoutAt).getTime() <= Date.now();
  const isPending = approval.status === 'pending' && !isExpired;
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

  // Workflow authors sometimes template raw node output into approval
  // prompts, which ends up as a huge JSON blob embedded in prose. Split
  // it out so the text stays readable and the payload gets rendered by
  // ToolPayload's proper viewer (with its own scroll, table view, etc.).
  const { prose, payloads } = splitPromptPayloads(approval.prompt);

  return (
    <div className="rounded-md border border-amber-200 bg-white p-3 text-xs dark:border-amber-900/60 dark:bg-neutral-900">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <Badge variant="secondary" className="text-[10px]">{approval.kind === 'tool_policy' ? 'tool' : 'approval'}</Badge>
          {isPropagated && (
            <Badge variant="default" className="text-[10px]" title="Raised in a session this workflow spawned">
              from session
            </Badge>
          )}
          <span className="truncate font-mono text-[10px] text-neutral-500 dark:text-neutral-400">{approval.nodeId}</span>
        </div>
        {prose && (
          <div className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap text-pretty text-[13px] leading-snug text-neutral-900 dark:text-neutral-100">
            {prose}
          </div>
        )}
        {payloads.map((payload, i) => (
          <div key={i} className="mt-2">
            <ToolPayload value={payload} />
          </div>
        ))}
        {approval.summary && (
          <p className="mt-2 text-[11px] text-pretty text-neutral-500 dark:text-neutral-400">
            {approval.summary}
          </p>
        )}
        {approval.details !== null && (
          <details className="mt-2">
            <summary className="cursor-pointer text-[11px] text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100">
              Details
            </summary>
            <div className="mt-1">
              <ToolPayload value={approval.details} />
            </div>
          </details>
        )}
        <div className="mt-2 flex items-center gap-3 text-[11px] text-neutral-500 dark:text-neutral-400">
          <span>requested {formatRelativeTime(approval.createdAt)}</span>
          {approval.timeoutAt && (
            <span title={approval.timeoutAt}>
              expires {formatRelativeTime(approval.timeoutAt)}
            </span>
          )}
        </div>
      </div>

      {isPending && isPropagated ? (
        <div className="mt-3 space-y-2">
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => onApprove('once')} disabled={busy}>
              {approve.isPending ? 'Approving…' : 'Approve once'}
            </Button>
            <Button size="sm" variant="destructive" onClick={onDeny} disabled={busy}>
              {deny.isPending ? 'Denying…' : 'Deny'}
            </Button>
          </div>
          <div className="flex items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
            <span>Wider scopes (allow for session / always allow):</span>
            <Link
              to="/sessions/$sessionId"
              params={{ sessionId: approval.originSessionId as string }}
              className="text-amber-700 underline hover:text-amber-900 dark:text-amber-300 dark:hover:text-amber-100"
            >
              open session
            </Link>
          </div>
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
      ) : isExpired ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
          <Badge variant="error">expired</Badge>
          <span>timed out {formatRelativeTime(approval.timeoutAt as string)}</span>
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

/**
 * Split an approval prompt into human prose + zero or more structured
 * payloads. Workflow authors commonly interpolate raw node output
 * into their approval prompt template (e.g. `Approve: {{ nodes.x.data }}`
 * where the node returns a big JSON object) and the runtime substitutes
 * a stringified blob. Rendering that as a wall of text is unreadable.
 *
 * Heuristic: find top-level balanced `{...}` or `[...]` spans that
 * successfully JSON-parse. Everything else stays in prose. This handles
 * both mid-sentence embedded JSON and prompts that are pure JSON.
 */
export function splitPromptPayloads(prompt: string): { prose: string; payloads: unknown[] } {
  const payloads: unknown[] = [];
  const proseParts: string[] = [];
  let i = 0;

  while (i < prompt.length) {
    const ch = prompt[i];
    if (ch === '{' || ch === '[') {
      const end = findMatchingBracket(prompt, i);
      if (end > i) {
        const candidate = prompt.slice(i, end + 1);
        try {
          const parsed: unknown = JSON.parse(candidate);
          // Reject trivial matches — `{}` or `[]` alone or a one-line
          // interpolation like `{{...}}` (template braces, not JSON).
          if (
            (typeof parsed === 'object' && parsed !== null && !isTriviallySmall(parsed))
          ) {
            payloads.push(parsed);
            i = end + 1;
            continue;
          }
        } catch {
          /* not JSON, treat as prose */
        }
      }
    }
    proseParts.push(ch);
    i++;
  }

  return {
    prose: proseParts.join('').replace(/\n{3,}/g, '\n\n').trim(),
    payloads,
  };
}

function findMatchingBracket(s: string, start: number): number {
  const open = s[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let j = start; j < s.length; j++) {
    const c = s[j];
    if (escape) {
      escape = false;
      continue;
    }
    if (c === '\\' && inString) {
      escape = true;
      continue;
    }
    if (c === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return j;
    }
  }
  return -1;
}

function isTriviallySmall(value: object): boolean {
  if (Array.isArray(value)) return value.length === 0;
  return Object.keys(value).length === 0;
}
