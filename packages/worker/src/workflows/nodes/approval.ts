/**
 * `approval` node executor — pauses the workflow until a human
 * approves, denies, or the timeout elapses. Delegates the row
 * persistence + step.waitForEvent dance to the shared
 * `requestApproval` helper (also used by the `tool` node when its
 * action policy resolves to require_approval).
 */

import type { ApprovalNode } from '@valet/shared';
import { renderTemplate, renderJsonTemplates } from '../../lib/workflow-dag/expression.js';
import { buildTemplateContext } from '../context.js';
import { coerceTemplateString } from '../templates.js';
import { requestApproval } from '../approvals.js';
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

  // Surface the deterministic approval id (computed identically to
  // requestApproval's internal id, including the iteration suffix for
  // approval-nodes-inside-foreach if that ever lands — today approval
  // is not a foreach body type so iSuffix will be empty here, but the
  // pattern stays uniform).
  const iSuffix = iterationSuffix(args.aliases);
  const iterIdx = args.aliases?.__iterationIndex;
  const iterationIndex = typeof iterIdx === 'number' ? iterIdx : undefined;
  const approvalId = `approval:${args.params.executionId}:${args.node.id}${iSuffix}`;
  if (args.correlations) args.correlations.approvalId = approvalId;

  await setExecutionStatus({
    env: args.env,
    step: args.step,
    executionId: args.params.executionId,
    status: 'waiting_approval',
    stepKey: `node:${args.node.id}:enter:waiting_approval`,
    allowedPrior: ['running'],
  });

  // Persist a waiting_approval trace row (with approvalId already on
  // correlations from above) so the execution detail UI links this node
  // to its pending workflow_approvals row while the approval is still
  // open. The runtime's running trace was written with approvalId=NULL
  // before the executor ran; this waiting row is the first place the id
  // becomes available.
  const waitStartedAt = await args.step.do(`approval:${args.node.id}${iSuffix}:wait-started-at`, async () => new Date().toISOString());
  await args.recordWaiting?.({
    nodeId: args.node.id,
    nodeType: 'approval',
    status: 'waiting_approval',
    startedAt: waitStartedAt,
    approvalId,
  });

  // try/finally guarantees the exit transition fires even if
  // requestApproval throws (timeout error, denial throw, sendEvent
  // race). Without this, a thrown approval would leave the execution
  // row stuck in waiting_approval and the runtime's terminal write
  // (allowedPrior: ['running']) would no-op.
  let outcome: Awaited<ReturnType<typeof requestApproval>>;
  try {
    outcome = await requestApproval({
      env: args.env,
      step: args.step,
      executionId: args.params.executionId,
      workflowInstanceId: args.params.executionId,
      nodeId: args.node.id,
      kind: 'explicit',
      prompt,
      ...(summary !== undefined ? { summary } : {}),
      ...(details !== undefined ? { details } : {}),
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

  // System-initiated cancel — bypass onDeny entirely so downstream
  // nodes don't run as if the user denied. Throw CancelledError so the
  // runtime tags the trace row with reason='cancelled' instead of
  // 'failed'.
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
