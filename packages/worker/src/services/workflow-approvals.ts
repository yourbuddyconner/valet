/**
 * Workflow-attributed approval resolution. Used by both API surfaces:
 *   - Nested:   POST /api/workflows/:id/executions/:execId/approvals/:apprId/{approve,deny}
 *   - Flat:     POST /api/executions/:id/approvals/:apprId/{approve,deny}
 *
 * Post-consolidation (migration 0023), there is no separate
 * `workflow_approvals` table — the approval gate IS the
 * `action_invocations` row. This helper:
 *   1. Looks up the action_invocation by id, asserts it's
 *      workflow-attributed and matches the URL execution.
 *   2. Verifies editor access on the parent workflow.
 *   3. Transitions the invocation via the unified approve/deny path.
 *   4. Dispatches the Cloudflare Workflows resume event so the paused
 *      step.waitForEvent completes.
 */

import { eq } from 'drizzle-orm';
import { NotFoundError } from '@valet/shared';
import type { Env } from '../env.js';
import { getDb } from '../lib/drizzle.js';
import { getInvocation } from '../lib/db/actions.js';
import { assertWorkflowAccess } from '../lib/workflow-access.js';
import { workflowExecutions } from '../lib/schema/workflows.js';
import { approveInvocation, denyInvocation } from './actions.js';

export type ApprovalResolveResult =
  | { kind: 'resolved'; status: 'approved' | 'denied' }
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
}

export async function resolveWorkflowApprovalRequest(input: ResolveApprovalInput): Promise<ApprovalResolveResult> {
  const db = getDb(input.env.DB);

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

  // Editor access on the resolved workflow id — same gate as
  // approve/deny via the nested route.
  await assertWorkflowAccess(db, input.user, execRow.workflowId, 'editor');

  if (invocation.status !== 'pending') {
    return { kind: 'already_resolved', status: invocation.status };
  }

  // Per-row timeout check. Without this, a user who races a deadline
  // could resolve a stale approval that the runtime has already moved
  // past via step.waitForEvent's natural timeout.
  if (invocation.expiresAt && new Date(invocation.expiresAt).getTime() <= Date.now()) {
    // The expired status transition happens inside approveInvocation /
    // denyInvocation's CAS path; here we just surface the timeout.
    return { kind: 'expired' };
  }

  const transition = input.result === 'approved'
    ? await approveInvocation(db, input.approvalId, input.user.id)
    : await denyInvocation(db, input.approvalId, input.user.id, input.reason);

  if (!transition.ok) {
    if (transition.invocation?.status === 'expired') {
      return { kind: 'expired' };
    }
    return { kind: 'already_resolved', status: transition.invocation?.status ?? 'unknown' };
  }

  // Cloudflare Workflows resume dispatch. The DB row is already updated;
  // the cancel-cleanup stuck-approval sweep is the safety net if this
  // throws (transient instance hiccup).
  const nodeId = invocation.nodeId;
  if (!nodeId) {
    console.warn(`[workflow-approvals] invocation ${input.approvalId} is workflow-attributed but missing nodeId; cannot dispatch resume event`);
    return { kind: 'resolved', status: input.result };
  }
  const iterSuffix = typeof invocation.iterationIndex === 'number'
    ? `_i_${invocation.iterationIndex}`
    : '';
  const eventType = `approval_${nodeId}${iterSuffix}`;
  try {
    const instance = await input.env.WORKFLOW_INTERPRETER.get(input.executionId);
    await instance.sendEvent({
      type: eventType,
      payload: {
        result: input.result,
        userId: input.user.id,
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
      },
    });
  } catch (err) {
    console.warn(`[workflow-approvals] sendEvent failed for ${input.approvalId}: ${err instanceof Error ? err.message : String(err)}`);
  }

  return { kind: 'resolved', status: input.result };
}
