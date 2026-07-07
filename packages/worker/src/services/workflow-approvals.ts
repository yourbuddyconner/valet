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
import { NotFoundError, ValidationError } from '@valet/shared';
import type { Env } from '../env.js';
import { getDb } from '../lib/drizzle.js';
import { getInvocation, isSessionDescendantOfExecution } from '../lib/db/actions.js';
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
  if (!invocation) {
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

  // Session-attributed branch. The invocation isn't owned by this workflow
  // execution; it lives on a session the workflow spawned. We forward to
  // the SessionAgentDO so the runner-side waiter resolves and the tool
  // actually dispatches — flipping the DB row alone would leave the agent
  // parked forever.
  if (invocation.workflowExecutionId !== input.executionId) {
    if (!invocation.sessionId) {
      throw new NotFoundError('WorkflowApproval', input.approvalId);
    }
    if (scope !== 'once') {
      throw new ValidationError(`scope "${scope}" is not valid for session-attributed approvals; use "once"`);
    }
    const isDescendant = await isSessionDescendantOfExecution(db, input.executionId, invocation.sessionId);
    if (!isDescendant) {
      throw new NotFoundError('WorkflowApproval', input.approvalId);
    }
    return forwardSessionApprovalToDO(input.env, invocation.sessionId, input.approvalId, input.result, input.user.id);
  }

  // Session-scoped or durable-policy scopes don't make sense on a
  // workflow-attributed approval; reject early so the caller's UI doesn't
  // silently degrade.
  if (scope === 'session' || scope === 'durable_policy') {
    throw new ValidationError(`scope "${scope}" is not valid for workflow approvals; use "once" or "workflow_execution"`);
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
  // sibling in parallel. Best-effort — the stuck-approval sweep retries
  // any failures. allSettled keeps one slow sibling from blocking
  // others (a foreach sweep can resolve dozens of iterations at once).
  await Promise.allSettled(
    result.resolved.map((row) =>
      dispatchResume(input.env, row, input.user.id, input.reason).catch((err) => {
        console.warn(
          `[workflow-approvals] sendEvent failed for ${row.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }),
    ),
  );

  return {
    kind: 'resolved',
    status: input.result,
    sweptCount: Math.max(0, result.resolved.length - 1),
  };
}

/**
 * Forward a propagated approval resolution from the workflow execution
 * view to the SessionAgentDO that owns the invocation. The DO's
 * `/prompt-resolved` endpoint runs the full session-side path: DB
 * update, runner tool dispatch, broadcast to session clients. Mapping:
 *   - approved → 'allow_once' (session/durable scopes are not exposed
 *     through this surface; user wanting those can deep-link into the
 *     session and use the in-session card)
 *   - denied   → 'cancel'
 */
async function forwardSessionApprovalToDO(
  env: Env,
  sessionId: string,
  invocationId: string,
  result: 'approved' | 'denied',
  userId: string,
): Promise<ApprovalResolveResult> {
  const stub = env.SESSIONS.idFromName(sessionId);
  const session = env.SESSIONS.get(stub);
  const actionId = result === 'approved' ? 'allow_once' : 'cancel';
  const response = await session.fetch(new Request('http://do/prompt-resolved', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ promptId: invocationId, actionId, resolvedBy: userId }),
  }));
  if (response.status === 403) {
    throw new ValidationError('only the session owner can resolve this approval');
  }
  if (response.status === 404) {
    // DO returns 404 when the prompt has already been resolved or expired.
    return { kind: 'already_resolved', status: 'resolved' };
  }
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`SessionAgentDO /prompt-resolved failed (${response.status}): ${text}`);
  }
  return { kind: 'resolved', status: result, sweptCount: 0 };
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
