/**
 * Shared resolve-approval helper used by both API surfaces:
 *   - Nested:   POST /api/workflows/:id/executions/:execId/approvals/:apprId/{approve,deny}
 *   - Flat:     POST /api/executions/:id/approvals/:apprId/{approve,deny}
 *
 * The flat surface is what the UI uses when it has just an executionId
 * (most pending-approval views don't track workflowId separately). Both
 * routes funnel through this helper so access checks and Cloudflare
 * sendEvent semantics stay identical.
 */

import { eq } from 'drizzle-orm';
import { NotFoundError } from '@valet/shared';
import type { Env } from '../env.js';
import { getDb } from '../lib/drizzle.js';
import {
  getWorkflowApproval,
  resolveWorkflowApproval,
  expireWorkflowApproval,
} from '../lib/db/workflow-approvals.js';
import { assertWorkflowAccess } from '../lib/workflow-access.js';
import { workflowExecutions } from '../lib/schema/workflows.js';

export type ApprovalResolveResult =
  | { kind: 'resolved'; status: 'approved' | 'denied' }
  | { kind: 'already_resolved'; status: string }
  | { kind: 'expired' };

export interface ResolveApprovalInput {
  env: Env;
  user: { id: string };
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

  const approval = await getWorkflowApproval(db, input.approvalId);
  if (!approval || approval.executionId !== input.executionId) {
    throw new NotFoundError('WorkflowApproval', input.approvalId);
  }

  // Resolve the workflow id from the execution row when the caller
  // didn't supply one (flat route), and cross-check when they did
  // (nested route — defense against a URL with mismatched workflow +
  // execution ids).
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

  if (approval.status !== 'pending') {
    return { kind: 'already_resolved', status: approval.status };
  }

  // Per-row timeout check. Without this, a user who races a deadline
  // could resolve a stale approval that the runtime has already moved
  // past via step.waitForEvent's natural timeout.
  if (approval.timeoutAt && new Date(approval.timeoutAt).getTime() <= Date.now()) {
    await expireWorkflowApproval(db, input.approvalId);
    return { kind: 'expired' };
  }

  const updated = await resolveWorkflowApproval(db, input.approvalId, {
    status: input.result,
    resolvedBy: input.user.id,
  });
  if (!updated) {
    // CAS missed — either another caller resolved first, or the
    // timeoutAt deadline slipped between our pre-check and the UPDATE.
    const refreshed = await getWorkflowApproval(db, input.approvalId);
    if (refreshed?.status === 'pending'
        && refreshed.timeoutAt
        && new Date(refreshed.timeoutAt).getTime() <= Date.now()) {
      await expireWorkflowApproval(db, input.approvalId);
      return { kind: 'expired' };
    }
    return { kind: 'already_resolved', status: refreshed?.status ?? 'unknown' };
  }

  // sendEvent dispatch. The DB row is already updated; sweepStuckApprovals
  // is the safety net if this throws (transient instance hiccup).
  try {
    const instance = await input.env.WORKFLOW_INTERPRETER.get(approval.workflowInstanceId);
    await instance.sendEvent({
      type: approval.eventType,
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
