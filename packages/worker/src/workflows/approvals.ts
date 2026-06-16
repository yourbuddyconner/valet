/**
 * Shared approval helper used by both the `approval` node and the
 * `tool` node (when its policy resolves to require_approval).
 *
 * Inserts a pending workflow_approvals row, then calls
 * step.waitForEvent to suspend the Cloudflare Workflow until the
 * approve/deny API endpoint dispatches a matching event.
 */

import type { WorkflowStep } from 'cloudflare:workers';
import { createWorkflowApproval, expireWorkflowApproval, type ApprovalKind } from '../lib/db/workflow-approvals.js';
import { getDb } from '../lib/drizzle.js';
import { parseDurationMs } from '../lib/workflow-dag/duration.js';
import type { Env } from '../env.js';

export interface RequestApprovalArgs {
  env: Env;
  step: WorkflowStep;
  executionId: string;
  /** Workflow instance ID — matches the CF Workflow's instance, used by the API endpoint to send the resume event. */
  workflowInstanceId: string;
  nodeId: string;
  kind: ApprovalKind;
  prompt: string;
  summary?: string;
  details?: unknown;
  /** Compact duration string ("5m", "1h", "2d") or undefined for no timeout. */
  timeout?: string;
  /**
   * Foreach iteration index when this approval is requested by a tool
   * node inside a foreach body. Scopes approvalId, the step.do row name,
   * the step.waitForEvent name, and the event type so concurrent
   * iterations don't collide on the same CF cache key.
   */
  iterationIndex?: number;
}

export type ApprovalOutcome =
  | { result: 'approved'; approvedBy: string; respondedAt: string }
  | { result: 'denied'; deniedBy: string; respondedAt: string; reason?: string }
  | { result: 'timed_out' }
  /** System-initiated cancel — different from user-denial. The executor
   * MUST treat this as a hard cancel (throw), not as the onDeny path. */
  | { result: 'cancelled'; cancelledBy: string };

const DEFAULT_APPROVAL_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * Cloudflare event types only allow letters, digits, hyphen, and
 * underscore. Node IDs are already restricted to that charset by the
 * Zod schema validator, so this is a straight prefix concatenation —
 * any non-matching char would mean a validator bypass, which we want
 * to fail loudly rather than silently collide with another node.
 */
function eventTypeFor(nodeId: string, iterationIndex?: number): string {
  if (!/^[A-Za-z0-9_-]+$/.test(nodeId)) {
    throw new Error(`approval event type cannot be derived from node id "${nodeId}" — node id must match [A-Za-z0-9_-]+`);
  }
  // CF event types allow [A-Za-z0-9_-]; use underscore for the iteration
  // separator. Without the suffix, parallel foreach iterations of a
  // tool-with-approval node would all wait on the same event type and
  // a single sendEvent would wake them all.
  const suffix = typeof iterationIndex === 'number' ? `_i_${iterationIndex}` : '';
  return `approval_${nodeId}${suffix}`;
}

/**
 * Create the approval row and wait for the resume event. Returns the
 * decision (approved / denied / timed_out). Callers translate that to
 * node success / failure / skip per their own policy (e.g. approval
 * node's onDeny; tool node's onPolicyDeny).
 */
export async function requestApproval(args: RequestApprovalArgs): Promise<ApprovalOutcome> {
  const eventType = eventTypeFor(args.nodeId, args.iterationIndex);
  // Every name below appends the iteration suffix so concurrent foreach
  // iterations don't collide on CF cache keys.
  const iterSuffix = typeof args.iterationIndex === 'number' ? `:i:${args.iterationIndex}` : '';
  const approvalId = `approval:${args.executionId}:${args.nodeId}${iterSuffix}`;

  const timeoutMs = args.timeout ? (parseDurationMs(args.timeout) ?? DEFAULT_APPROVAL_TIMEOUT_MS) : DEFAULT_APPROVAL_TIMEOUT_MS;

  // Persist the row inside step.do so this side effect is cached and
  // doesn't re-fire on hibernation replay. timeoutAt is computed INSIDE
  // step.do for replay determinism — outside the cache boundary it
  // would drift across hibernate/wake.
  await args.step.do(`approval:${args.nodeId}${iterSuffix}:row`, async () => {
    const db = getDb(args.env.DB);
    const timeoutAt = new Date(Date.now() + timeoutMs).toISOString();
    await createWorkflowApproval(db, {
      id: approvalId,
      executionId: args.executionId,
      workflowInstanceId: args.workflowInstanceId,
      nodeId: args.nodeId,
      kind: args.kind,
      eventType,
      prompt: args.prompt,
      summary: args.summary,
      details: args.details !== undefined ? JSON.stringify(args.details) : undefined,
      timeoutAt,
    });
    return null;
  });

  // Suspend until the resume event arrives. Cloudflare cleans up
  // automatically on instance.terminate() per spec §"Verified
  // assumptions" (pending the pre-Phase-5 spike result).
  try {
    const event = await args.step.waitForEvent<{ result: 'approved' | 'denied' | 'cancelled'; userId: string; reason?: string }>(
      `approval:${args.nodeId}${iterSuffix}:wait`,
      { type: eventType, timeout: timeoutMs },
    );
    if (event.payload.result === 'cancelled') {
      // System-initiated cancel. Executor must NOT run onDeny logic.
      return { result: 'cancelled', cancelledBy: event.payload.userId };
    }
    // respondedAt captured inside step.do so it's stable across replays.
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
    // Cloudflare throws when timeout elapses without an event; treat
    // as timed_out and drive the approval row to 'expired' inside
    // step.do so the audit chain reflects the timeout. Without this
    // the row stays 'pending' forever (the runtime moves on, but the
    // approve API endpoint would still see status='pending').
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('timeout') || message.includes('timed out')) {
      await args.step.do(`approval:${args.nodeId}${iterSuffix}:expire`, async () => {
        await expireWorkflowApproval(getDb(args.env.DB), approvalId);
        return null;
      });
      return { result: 'timed_out' };
    }
    throw err;
  }
}
