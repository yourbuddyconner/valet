/**
 * Scoped approval resolution with sibling sweep.
 *
 * When a user resolves a pending approval and chooses a scope wider than
 * `once`, two things must happen consistently:
 *
 *   1. A grant is persisted that quiets future matching invocations
 *      (runtime_grants for session/execution scopes; action_policies user
 *      grant for durable scope).
 *
 *   2. Already-pending sibling invocations in the same context that the
 *      grant now covers are auto-resolved against the same decision —
 *      otherwise a session with parallel pending tool calls or a foreach
 *      with concurrent pending iterations leaves the user clicking
 *      individually through each one.
 *
 * The helper returns the originating + swept invocation rows so the
 * caller can run any context-specific post-approval dispatch (workflow
 * `instance.sendEvent`; SessionAgentDO's in-memory tool dispatch).
 */

import { and, eq, ne, isNull } from 'drizzle-orm';
import type { AppDb } from '../lib/drizzle.js';
import { actionInvocations } from '../lib/schema/index.js';
import {
  getInvocation,
  upsertActionPolicy,
  upsertRuntimeGrant,
  type ActionInvocationRow,
} from '../lib/db/actions.js';
import { approveInvocation, denyInvocation } from './actions.js';

export type ApprovalScope = 'once' | 'session' | 'workflow_execution' | 'durable_policy';

export interface ResolveWithScopeInput {
  invocationId: string;
  decision: 'approved' | 'denied';
  userId: string;
  scope: ApprovalScope;
  /** When set on `workflow_execution` scope, narrows the grant to invocations
   *  produced by this exact workflow node — required for "Approve remaining
   *  rows" on a foreach body so the grant doesn't bleed across other approval
   *  nodes that share the same service+actionId. */
  nodeId?: string | null;
  /** Denial reason, recorded on the originating invocation. */
  reason?: string;
}

export type ResolveWithScopeResult =
  | { kind: 'not_found' }
  | { kind: 'already_resolved'; status: string }
  | { kind: 'expired' }
  | {
      kind: 'resolved';
      decision: 'approved' | 'denied';
      /** Persisted runtime_grant or action_policies row id, when the scope
       *  is not 'once'. */
      grantId: string | null;
      /** The originating row plus any siblings the sweep resolved. Callers
       *  use these for post-approval dispatch (workflow sendEvent;
       *  session-side tool runs). */
      resolved: ActionInvocationRow[];
    };

/**
 * Resolve a pending invocation with an optional scope. Denials with a
 * wider scope behave like `once` for now — runtime grants are allow-only
 * per the spec, so a "deny for this session" doesn't write a grant. The
 * sweep also only runs on the `approved` path.
 */
export async function resolveInvocationWithScope(
  db: AppDb,
  input: ResolveWithScopeInput,
): Promise<ResolveWithScopeResult> {
  const original = await getInvocation(db, input.invocationId);
  if (!original) return { kind: 'not_found' };
  if (original.status !== 'pending') {
    return { kind: 'already_resolved', status: original.status };
  }
  if (original.expiresAt && new Date(original.expiresAt).getTime() <= Date.now()) {
    return { kind: 'expired' };
  }

  let grantId: string | null = null;

  // Step 1: persist the grant. Only on the approved path with a wider
  // scope — once-scope and denials skip this.
  if (input.decision === 'approved' && input.scope !== 'once') {
    grantId = await persistGrantForScope(db, original, input);
  }

  // Step 2: resolve the originating invocation.
  const originalTransition = input.decision === 'approved'
    ? await approveInvocation(db, input.invocationId, input.userId)
    : await denyInvocation(db, input.invocationId, input.userId, input.reason);

  if (!originalTransition.ok) {
    const refreshed = originalTransition.invocation;
    if (refreshed?.status === 'expired') return { kind: 'expired' };
    return { kind: 'already_resolved', status: refreshed?.status ?? 'unknown' };
  }

  const resolved: ActionInvocationRow[] = [originalTransition.invocation as ActionInvocationRow];

  // Step 3: sweep matching pending siblings, on the approved path only.
  if (input.decision === 'approved' && input.scope !== 'once') {
    const siblings = await findSweepCandidates(db, original, input);
    for (const sib of siblings) {
      // Best-effort: keep going on individual failures. The stuck-approval
      // sweep is the safety net for any sibling whose post-approval
      // dispatch fails downstream.
      try {
        const t = await approveInvocation(db, sib.id, input.userId);
        if (t.ok && t.invocation) {
          resolved.push(t.invocation as ActionInvocationRow);
        }
      } catch (err) {
        console.warn(
          `[scoped-approvals] sibling sweep failed for ${sib.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  return {
    kind: 'resolved',
    decision: input.decision,
    grantId,
    resolved,
  };
}

// ─── Internal helpers ────────────────────────────────────────────────────────

async function persistGrantForScope(
  db: AppDb,
  original: ActionInvocationRow,
  input: ResolveWithScopeInput,
): Promise<string | null> {
  const service = original.service;
  const actionId = original.actionId;
  const riskLevel = original.riskLevel;

  if (input.scope === 'durable_policy') {
    // User durable grant. Phase 1 has no param matchers — exact (service,
    // actionId) match. Phase 2 will accept matcher input via this path.
    const id = `approval:${input.invocationId}:durable`;
    return upsertActionPolicy(db, {
      id,
      service,
      actionId,
      riskLevel,
      mode: 'allow',
      managedBy: 'user',
      principalType: 'user',
      principalId: input.userId,
      subjectType: 'tool_action',
      origin: 'approval_prompt',
      sourceApprovalId: input.invocationId,
      createdBy: input.userId,
    });
  }

  if (input.scope === 'session') {
    if (!original.sessionId) {
      // Session-scoped grant on a workflow-attributed invocation makes no
      // sense; fall back to no grant.
      return null;
    }
    const id = `approval:${input.invocationId}:session`;
    return upsertRuntimeGrant(db, {
      id,
      userId: input.userId,
      sessionId: original.sessionId,
      subjectType: 'tool_action',
      service,
      actionId,
      riskLevel,
      policyKey: `session:${original.sessionId}:${service}.${actionId}:`,
    });
  }

  if (input.scope === 'workflow_execution') {
    if (!original.workflowExecutionId) return null;
    const nodeId = input.nodeId ?? null;
    const id = `approval:${input.invocationId}:execution${nodeId ? `:${nodeId}` : ''}`;
    return upsertRuntimeGrant(db, {
      id,
      userId: input.userId,
      workflowExecutionId: original.workflowExecutionId,
      subjectType: 'tool_action',
      service,
      actionId,
      riskLevel,
      nodeId,
      policyKey: `exec:${original.workflowExecutionId}:${nodeId ?? '*'}:${service}.${actionId}:`,
    });
  }

  return null;
}

/**
 * Find pending invocations in the same originating context that the new
 * grant would cover.
 *
 * Phase 1 keeps the sweep scoped to the SAME context (same session or
 * same execution) so the caller can dispatch swept rows naturally —
 * cross-DO / cross-context sweeps (child sessions inheriting a parent
 * grant) would require a wake-up signal to the foreign DO, which is a
 * follow-up enhancement, not Phase 1.
 */
async function findSweepCandidates(
  db: AppDb,
  original: ActionInvocationRow,
  input: ResolveWithScopeInput,
): Promise<Array<{ id: string }>> {
  const baseConditions = [
    eq(actionInvocations.status, 'pending'),
    ne(actionInvocations.id, original.id),
    eq(actionInvocations.service, original.service),
    eq(actionInvocations.actionId, original.actionId),
  ];

  if (input.scope === 'session' || input.scope === 'durable_policy') {
    if (!original.sessionId) return [];
    baseConditions.push(eq(actionInvocations.sessionId, original.sessionId));
  } else if (input.scope === 'workflow_execution') {
    if (!original.workflowExecutionId) return [];
    baseConditions.push(eq(actionInvocations.workflowExecutionId, original.workflowExecutionId));
    // When the grant carries a nodeId narrower, only sweep invocations
    // from that exact node. Without this, "Approve remaining rows" on a
    // foreach body would silently approve every other approval node in
    // the execution (all of them share the same service+actionId).
    if (input.nodeId) {
      baseConditions.push(eq(actionInvocations.nodeId, input.nodeId));
    } else {
      // No nodeId on the grant → run-wide grant → only sweep run-wide
      // (non-node-scoped) invocations? In practice every workflow tool
      // invocation has a nodeId, so a run-wide grant covers ALL of them.
      // No additional filter.
    }
  } else {
    return [];
  }

  return db
    .select({ id: actionInvocations.id })
    .from(actionInvocations)
    .where(and(...baseConditions, isNull(actionInvocations.resolvedAt)))
    .all();
}
