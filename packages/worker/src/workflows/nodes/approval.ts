/**
 * `approval` node executor — pauses the workflow until a human
 * approves, denies, or the timeout elapses.
 *
 * The DAG `approval` node is authoring sugar; at runtime it invokes
 * the built-in `workflows.request_approval` action through the same
 * unified `invokeWorkflowAction` path as any other tool. The resulting
 * `action_invocations` row is the gate; `waitForApprovalEvent`
 * suspends on the matching Cloudflare Workflows event.
 */

import type { ApprovalNode } from '@valet/shared';
import { renderTemplate, renderJsonTemplates } from '../../lib/workflow-dag/expression.js';
import { buildTemplateContext } from '../context.js';
import { coerceTemplateString } from '../templates.js';
import { waitForApprovalEvent } from '../approvals.js';
import { invokeWorkflowAction, markExecuted, markFailed } from '../../services/actions.js';
import { getDb } from '../../lib/drizzle.js';
import { setExecutionStatus } from '../execution-status.js';
import { CancelledError, iterationSuffix } from '../types.js';
import type { NodeExecutorArgs } from '../types.js';

export interface ApprovalNodeOutput {
  approved: boolean;
  approvedBy?: string;
  deniedBy?: string;
  respondedAt?: string;
  reason?: string;
  timedOut?: boolean;
}

export async function executeApproval(args: NodeExecutorArgs<ApprovalNode>): Promise<ApprovalNodeOutput> {
  const ctx = buildTemplateContext(args.state, args.aliases);
  const prompt = coerceTemplateString(renderTemplate(args.node.prompt, ctx));
  const summary = args.node.summary !== undefined ? coerceTemplateString(renderTemplate(args.node.summary, ctx)) : undefined;
  const details = args.node.details !== undefined ? renderJsonTemplates(args.node.details, ctx) : undefined;

  const iSuffix = iterationSuffix(args.aliases);
  const iterIdx = args.aliases?.__iterationIndex;
  const iterationIndex = typeof iterIdx === 'number' ? iterIdx : undefined;
  // Deterministic invocation id: idempotent on Cloudflare step.do replays.
  const invocationId = `approval:${args.params.executionId}:${args.node.id}${iSuffix}`;
  if (args.correlations) args.correlations.approvalId = invocationId;

  await setExecutionStatus({
    env: args.env,
    step: args.step,
    executionId: args.params.executionId,
    status: 'waiting_approval',
    stepKey: `node:${args.node.id}:enter:waiting_approval`,
    allowedPrior: ['running'],
  });

  // Create the action_invocation that backs this approval gate. Inside
  // step.do so the side effect is cached on replays. invokeWorkflowAction
  // is idempotent on invocationId, so a step.do retry returns the cached
  // policy decision instead of re-resolving.
  const policy = await args.step.do(`approval:${args.node.id}${iSuffix}:invoke`, async () => {
    return invokeWorkflowAction(getDb(args.env.DB), {
      invocationId,
      executionId: args.params.executionId,
      userId: args.params.userId,
      service: 'workflows',
      actionId: 'request_approval',
      riskLevel: 'medium',
      params: { prompt, summary, details },
      nodeId: args.node.id,
      iterationIndex,
    });
  });

  // Persist a waiting_approval trace row so the execution UI links this
  // node to its pending action_invocations row while still open.
  const waitStartedAt = await args.step.do(
    `approval:${args.node.id}${iSuffix}:wait-started-at`,
    async () => new Date().toISOString(),
  );
  await args.recordWaiting?.({
    nodeId: args.node.id,
    nodeType: 'approval',
    status: 'waiting_approval',
    startedAt: waitStartedAt,
    approvalId: invocationId,
  });

  // If a runtime grant or admin allow already covers this approval, the
  // resolver short-circuits — no wait required, treat as approved.
  if (policy.outcome === 'allowed') {
    await markExecuted(getDb(args.env.DB), invocationId, { autoApproved: true });
    await setExecutionStatus({
      env: args.env,
      step: args.step,
      executionId: args.params.executionId,
      status: 'running',
      stepKey: `node:${args.node.id}:exit:running`,
      allowedPrior: ['waiting_approval'],
    });
    return { approved: true, respondedAt: waitStartedAt };
  }
  if (policy.outcome === 'denied') {
    await markFailed(getDb(args.env.DB), invocationId, 'denied by admin policy');
    await setExecutionStatus({
      env: args.env,
      step: args.step,
      executionId: args.params.executionId,
      status: 'running',
      stepKey: `node:${args.node.id}:exit:running`,
      allowedPrior: ['waiting_approval'],
    });
    const onDeny = args.node.onDeny ?? 'fail';
    if (onDeny === 'skip') return { approved: false };
    throw new Error(`approval node "${args.node.id}" denied by admin policy`);
  }

  // try/finally guarantees the exit transition fires even if the wait
  // throws (timeout error, denial throw, sendEvent race). Without this,
  // a thrown approval would leave the execution row stuck in
  // waiting_approval and the runtime's terminal write would no-op.
  let outcome: Awaited<ReturnType<typeof waitForApprovalEvent>>;
  try {
    outcome = await waitForApprovalEvent({
      env: args.env,
      step: args.step,
      invocationId,
      nodeId: args.node.id,
      ...(args.node.timeout !== undefined ? { timeout: args.node.timeout } : {}),
      ...(iterationIndex !== undefined ? { iterationIndex } : {}),
    });
  } finally {
    await setExecutionStatus({
      env: args.env,
      step: args.step,
      executionId: args.params.executionId,
      status: 'running',
      stepKey: `node:${args.node.id}:exit:running`,
      allowedPrior: ['waiting_approval'],
    });
  }

  if (outcome.result === 'approved') {
    return { approved: true, approvedBy: outcome.approvedBy, respondedAt: outcome.respondedAt };
  }

  // System-initiated cancel — bypass onDeny entirely so downstream nodes
  // don't run as if the user denied. Throw CancelledError so the runtime
  // tags the trace row with reason='cancelled' instead of 'failed'.
  if (outcome.result === 'cancelled') {
    throw new CancelledError(`approval node "${args.node.id}" cancelled by ${outcome.cancelledBy}`);
  }

  // onDeny defaults to 'fail' per spec. Timed-out approvals follow the
  // same path as denials.
  const onDeny = args.node.onDeny ?? 'fail';
  if (outcome.result === 'timed_out') {
    if (onDeny === 'skip') return { approved: false, timedOut: true };
    throw new Error(`approval node "${args.node.id}" timed out`);
  }

  if (onDeny === 'skip') {
    return {
      approved: false,
      deniedBy: outcome.deniedBy,
      respondedAt: outcome.respondedAt,
      ...(outcome.reason ? { reason: outcome.reason } : {}),
    };
  }
  throw new Error(`approval node "${args.node.id}" denied by ${outcome.deniedBy}${outcome.reason ? `: ${outcome.reason}` : ''}`);
}
