/**
 * Workflow-attributed approval resolution. Used by both API surfaces:
 *   - Nested:   POST /api/workflows/:id/executions/:execId/approvals/:apprId/{approve,deny}
 *   - Flat:     POST /api/executions/:id/approvals/:apprId/{approve,deny}
 *
 * Post-consolidation (migration 0022), there is no separate
 * `workflow_approvals` table — the approval gate IS the
 * `action_invocations` row. This helper:
 *   1. Looks up the action_invocation, asserts it's workflow-attributed
 *      and matches the URL execution.
 *   2. Verifies editor access on the parent workflow.
 *   3. Delegates to `resolveInvocationWithScope`, which persists the
 *      grant (if scope > 'once'), resolves the originating row, and
 *      sweeps already-pending sibling invocations in the same execution.
 *   4. Dispatches the Cloudflare Workflows resume event for the
 *      originating row AND each swept sibling so every paused
 *      `step.waitForEvent` completes.
 */

import { eq } from 'drizzle-orm';
import { NotFoundError } from '@valet/shared';
import type { Env } from '../env.js';
import { getDb } from '../lib/drizzle.js';
import { getInvocation } from '../lib/db/actions.js';
import type { ActionInvocationRow } from '../lib/db/actions.js';
import { assertWorkflowAccess } from '../lib/workflow-access.js';
import { workflowExecutions } from '../lib/schema/workflows.js';
import { resolveInvocationWithScope, type ApprovalScope } from './scoped-approvals.js';

export type ApprovalResolveResult =
  | { kind: 'resolved'; status: 'approved' | 'denied'; sweptCount: number }
  | { kind: 'already_resolved'; status: string }
  | { kind: 'expired' };

export interface ResolveApprovalInput {
  env: Env;
  user: { id: string };
  /** action_invocations row id. */
  approvalId: string;
  /** Required for cross-tenant safety — the route MUST pass the URL's
   *  executionId so we can refuse approvals whose execution doesn't
   *  match. */
  executionId: string;
  /** Optional: the nested route already has the workflow id from the
   *  URL. The flat route omits this and lets the helper resolve it from
   *  the execution row. Either way, the helper asserts editor access on
   *  the workflow before dispatching the event. */
  expectedWorkflowId?: string;
  result: 'approved' | 'denied';
  reason?: string;
  /** Scope of the approval decision. Defaults to 'once'. With
   *  'workflow_execution' + a nodeId, "Approve remaining rows" on a
   *  foreach body sweeps every pending iteration of that body. With
   *  'workflow_execution' and no nodeId, "Approve for this run" sweeps
   *  every pending workflow-attributed invocation in the execution. */
  scope?: ApprovalScope;
  /** Optional workflow node id narrower for the scope. Set by the
   *  "Approve remaining rows" UI. */
  nodeId?: string;
}

export async function resolveWorkflowApprovalRequest(input: ResolveApprovalInput): Promise<ApprovalResolveResult> {
  const db = getDb(input.env.DB);
  const scope: ApprovalScope = input.scope ?? 'once';

  const invocation = await getInvocation(db, input.approvalId);
  if (!invocation || invocation.workflowExecutionId !== input.executionId) {
    throw new NotFoundError('WorkflowApproval', input.approvalId);
  }

  const execRow = await db.select({ workflowId: workflowExecutions.workflowId })
    .from(workflowExecutions)
    .where(eq(workflowExecutions.id, input.executionId))
    .get();
  if (!execRow?.workflowId) {
    throw new NotFoundError('WorkflowApproval', input.approvalId);
  }
  if (input.expectedWorkflowId && execRow.workflowId !== input.expectedWorkflowId) {
    throw new NotFoundError('WorkflowApproval', input.approvalId);
  }

  // Editor access on the resolved workflow id.
  await assertWorkflowAccess(db, input.user, execRow.workflowId, 'editor');

  // Session-scoped or durable-policy scopes don't make sense on a
  // workflow-attributed approval; reject early so the caller's UI doesn't
  // silently degrade.
  if (scope === 'session' || scope === 'durable_policy') {
    throw new Error(`scope "${scope}" is not valid for workflow approvals`);
  }

  const result = await resolveInvocationWithScope(db, {
    invocationId: input.approvalId,
    decision: input.result,
    userId: input.user.id,
    scope,
    nodeId: input.nodeId,
    reason: input.reason,
  });

  if (result.kind === 'not_found') {
    throw new NotFoundError('WorkflowApproval', input.approvalId);
  }
  if (result.kind === 'already_resolved') {
    return { kind: 'already_resolved', status: result.status };
  }
  if (result.kind === 'expired') {
    return { kind: 'expired' };
  }

  // Dispatch the resume event for the originating row AND each swept
  // sibling. Best-effort — the stuck-approval sweep retries any failures.
  for (const row of result.resolved) {
    try {
      await dispatchResume(input.env, row, input.user.id, input.reason);
    } catch (err) {
      console.warn(
        `[workflow-approvals] sendEvent failed for ${row.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return {
    kind: 'resolved',
    status: input.result,
    sweptCount: Math.max(0, result.resolved.length - 1),
  };
}

async function dispatchResume(
  env: Env,
  invocation: ActionInvocationRow,
  userId: string,
  reason?: string,
): Promise<void> {
  if (!invocation.workflowExecutionId || !invocation.nodeId) return;
  const iterSuffix = typeof invocation.iterationIndex === 'number'
    ? `_i_${invocation.iterationIndex}`
    : '';
  const eventType = `approval_${invocation.nodeId}${iterSuffix}`;
  const instance = await env.WORKFLOW_INTERPRETER.get(invocation.workflowExecutionId);
  await instance.sendEvent({
    type: eventType,
    payload: {
      result: invocation.status as 'approved' | 'denied',
      userId,
      ...(reason !== undefined ? { reason } : {}),
    },
  });
}
