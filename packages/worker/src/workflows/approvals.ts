/**
 * Approval wait helper for workflow nodes that have already created an
 * `action_invocations` row in `require_approval` mode. Suspends the
 * Cloudflare Workflow via `step.waitForEvent` until the unified
 * approve/deny path dispatches the resume event for this node.
 *
 * As of the workflow-approvals consolidation (migration 0023), every
 * approval — whether from a `tool` node policy hold or an explicit
 * `approval` node invocation of the built-in `workflows.request_approval`
 * action — is represented as a single `action_invocations` row. The
 * separate `workflow_approvals` table is retired.
 */

import type { WorkflowStep } from 'cloudflare:workers';
import { updateInvocationStatus } from '../lib/db/actions.js';
import { getDb } from '../lib/drizzle.js';
import { parseDurationMs } from '../lib/workflow-dag/duration.js';
import type { Env } from '../env.js';

export interface WaitForApprovalArgs {
  env: Env;
  step: WorkflowStep;
  /** action_invocations row id; the resume hook dispatches against this row. */
  invocationId: string;
  nodeId: string;
  /** Foreach iteration index when this approval is requested by a node
   *  inside a foreach body. Scopes the step.waitForEvent name and event
   *  type so concurrent iterations don't collide on the same CF cache key. */
  iterationIndex?: number;
  /** Compact duration string ("5m", "1h", "2d") or undefined for the default. */
  timeout?: string;
}

export type ApprovalOutcome =
  | { result: 'approved'; approvedBy: string; respondedAt: string }
  | { result: 'denied'; deniedBy: string; respondedAt: string; reason?: string }
  | { result: 'timed_out' }
  /** System-initiated cancel — different from user-denial. The executor
   *  MUST treat this as a hard cancel (throw), not as the onDeny path. */
  | { result: 'cancelled'; cancelledBy: string };

const DEFAULT_APPROVAL_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * Cloudflare event types only allow letters, digits, hyphen, and
 * underscore. Node IDs are restricted to that charset by the Zod schema
 * validator, so this is a straight prefix concatenation.
 */
export function eventTypeFor(nodeId: string, iterationIndex?: number): string {
  if (!/^[A-Za-z0-9_-]+$/.test(nodeId)) {
    throw new Error(`approval event type cannot be derived from node id "${nodeId}" — node id must match [A-Za-z0-9_-]+`);
  }
  const suffix = typeof iterationIndex === 'number' ? `_i_${iterationIndex}` : '';
  return `approval_${nodeId}${suffix}`;
}

/**
 * Suspend the Cloudflare Workflow on `step.waitForEvent` for the named
 * approval event. Returns the decision (approved / denied / cancelled /
 * timed_out). On timeout, transitions the action_invocation to `expired`
 * so the audit chain reflects the resolution; without that, the row
 * stays `pending` forever even though the runtime has moved on.
 *
 * Callers translate the outcome to node success / failure / skip per
 * their own policy (approval node's onDeny, tool node's onPolicyDeny).
 */
export async function waitForApprovalEvent(args: WaitForApprovalArgs): Promise<ApprovalOutcome> {
  const eventType = eventTypeFor(args.nodeId, args.iterationIndex);
  const iterSuffix = typeof args.iterationIndex === 'number' ? `:i:${args.iterationIndex}` : '';
  const timeoutMs = args.timeout
    ? (parseDurationMs(args.timeout) ?? DEFAULT_APPROVAL_TIMEOUT_MS)
    : DEFAULT_APPROVAL_TIMEOUT_MS;

  try {
    const event = await args.step.waitForEvent<{
      result: 'approved' | 'denied' | 'cancelled';
      userId: string;
      reason?: string;
    }>(
      `approval:${args.nodeId}${iterSuffix}:wait`,
      { type: eventType, timeout: timeoutMs },
    );
    if (event.payload.result === 'cancelled') {
      return { result: 'cancelled', cancelledBy: event.payload.userId };
    }
    const respondedAt = await args.step.do(
      `approval:${args.nodeId}${iterSuffix}:responded-at`,
      async () => new Date().toISOString(),
    );
    if (event.payload.result === 'approved') {
      return { result: 'approved', approvedBy: event.payload.userId, respondedAt };
    }
    return {
      result: 'denied',
      deniedBy: event.payload.userId,
      respondedAt,
      ...(event.payload.reason ? { reason: event.payload.reason } : {}),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('timeout') || message.includes('timed out')) {
      await args.step.do(`approval:${args.nodeId}${iterSuffix}:expire`, async () => {
        await updateInvocationStatus(getDb(args.env.DB), args.invocationId, {
          status: 'expired',
          expectedStatus: 'pending',
        });
        return null;
      });
      return { result: 'timed_out' };
    }
    throw err;
  }
}
