import type { AppDb } from '../lib/drizzle.js';
import {
  createInvocation,
  getInvocation,
  updateInvocationStatus,
} from '../lib/db.js';
import { resolveEffectiveMode } from './action-policy.js';
import type { ActionMode } from '@valet/shared';

const APPROVAL_EXPIRY_MS = 240 * 1000;

export interface InvokeActionParams {
  sessionId: string;
  userId: string;
  service: string;
  actionId: string;
  riskLevel: string;
  params?: Record<string, unknown>;
}

export interface InvokeActionResult {
  outcome: 'allowed' | 'pending_approval' | 'denied';
  invocationId: string;
  mode: ActionMode;
  policyId: string | null;
}

function isExpiredTimestamp(value: string | null, nowMs: number): boolean {
  if (!value) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp <= nowMs;
}

/**
 * Create an invocation record and resolve the action mode.
 * Does NOT execute the action — the caller must handle execution based on outcome.
 */
export async function invokeAction(
  db: AppDb,
  input: InvokeActionParams,
): Promise<InvokeActionResult> {
  const policy = await resolveEffectiveMode(db, {
    userId: input.userId,
    sessionId: input.sessionId,
    service: input.service,
    actionId: input.actionId,
    riskLevel: input.riskLevel,
  });
  const invocationId = crypto.randomUUID();

  const expiresAt = policy.mode === 'require_approval'
    ? new Date(Date.now() + APPROVAL_EXPIRY_MS).toISOString()
    : undefined;

  const status = policy.mode === 'deny' ? 'denied' : policy.mode === 'allow' ? 'executed' : 'pending';

  await createInvocation(db, {
    id: invocationId,
    sessionId: input.sessionId,
    userId: input.userId,
    service: input.service,
    actionId: input.actionId,
    riskLevel: input.riskLevel,
    resolvedMode: policy.mode,
    params: input.params ? JSON.stringify(input.params) : undefined,
    expiresAt,
    policyId: policy.orgPolicyId,
    orgPolicyId: policy.orgPolicyId,
    baseMode: policy.baseMode,
    baseSource: policy.baseSource,
    userOverrideId: policy.userOverrideId,
    policySource: policy.source,
    policyLifetime: policy.lifetime,
    policyScope: policy.scope,
    status,
  });

  return { outcome: policy.outcome, invocationId, mode: policy.mode, policyId: policy.orgPolicyId };
}

/**
 * Approve a pending invocation. Uses optimistic locking via expectedStatus
 * to prevent approve-after-expiry races.
 */
export async function approveInvocation(
  db: AppDb,
  invocationId: string,
  approvedBy: string,
): Promise<{ ok: boolean; invocation?: Awaited<ReturnType<typeof getInvocation>> }> {
  const inv = await getInvocation(db, invocationId);
  if (!inv) {
    return { ok: false };
  }

  if (inv.status === 'approved' && inv.resolvedBy === approvedBy) {
    return { ok: true, invocation: inv };
  }
  if (inv.status !== 'pending') {
    return { ok: false, invocation: inv };
  }

  const nowMs = Date.now();
  if (isExpiredTimestamp(inv.expiresAt, nowMs)) {
    await updateInvocationStatus(db, invocationId, {
      status: 'expired',
      expectedStatus: 'pending',
    });
    return { ok: false, invocation: await getInvocation(db, invocationId) };
  }

  const now = new Date(nowMs).toISOString();
  await updateInvocationStatus(db, invocationId, {
    status: 'approved',
    resolvedBy: approvedBy,
    resolvedAt: now,
    expectedStatus: 'pending',
  });

  const updated = await getInvocation(db, invocationId);
  if (updated?.status !== 'approved' || updated.resolvedBy !== approvedBy) {
    return { ok: false, invocation: updated };
  }
  return { ok: true, invocation: updated };
}

/**
 * Deny a pending invocation. Uses optimistic locking via expectedStatus
 * to prevent deny-after-expiry races.
 */
export async function denyInvocation(
  db: AppDb,
  invocationId: string,
  deniedBy: string,
  reason?: string,
): Promise<{ ok: boolean; invocation?: Awaited<ReturnType<typeof getInvocation>> }> {
  const inv = await getInvocation(db, invocationId);
  if (!inv) {
    return { ok: false };
  }

  if (inv.status === 'denied' && inv.resolvedBy === deniedBy) {
    return { ok: true, invocation: inv };
  }
  if (inv.status !== 'pending') {
    return { ok: false, invocation: inv };
  }

  const nowMs = Date.now();
  if (isExpiredTimestamp(inv.expiresAt, nowMs)) {
    await updateInvocationStatus(db, invocationId, {
      status: 'expired',
      expectedStatus: 'pending',
    });
    return { ok: false, invocation: await getInvocation(db, invocationId) };
  }

  const now = new Date(nowMs).toISOString();
  await updateInvocationStatus(db, invocationId, {
    status: 'denied',
    resolvedBy: deniedBy,
    resolvedAt: now,
    error: reason,
    expectedStatus: 'pending',
  });

  const updated = await getInvocation(db, invocationId);
  if (updated?.status !== 'denied' || updated.resolvedBy !== deniedBy) {
    return { ok: false, invocation: updated };
  }
  return { ok: true, invocation: updated };
}

/**
 * Mark an invocation as successfully executed.
 */
export async function markExecuted(
  db: AppDb,
  invocationId: string,
  result?: unknown,
): Promise<void> {
  const now = new Date().toISOString();
  await updateInvocationStatus(db, invocationId, {
    status: 'executed',
    executedAt: now,
    result: result != null ? JSON.stringify(result) : undefined,
  });
}

/**
 * Mark an invocation as failed.
 */
export async function markFailed(
  db: AppDb,
  invocationId: string,
  error: string,
): Promise<void> {
  const now = new Date().toISOString();
  await updateInvocationStatus(db, invocationId, {
    status: 'failed',
    executedAt: now,
    error,
  });
}
