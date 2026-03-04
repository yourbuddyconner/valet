import type { AppDb } from '../lib/drizzle.js';
import {
  createInvocation,
  getInvocation,
  updateInvocationStatus,
} from '../lib/db.js';
import { resolveMode } from './action-policy.js';
import type { ActionMode } from '@valet/shared';

const APPROVAL_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes

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

/**
 * Create an invocation record and resolve the action mode.
 * Does NOT execute the action — the caller must handle execution based on outcome.
 */
export async function invokeAction(
  db: AppDb,
  input: InvokeActionParams,
): Promise<InvokeActionResult> {
  const { mode, policyId } = await resolveMode(db, input.service, input.actionId, input.riskLevel);
  const invocationId = crypto.randomUUID();

  const expiresAt = mode === 'require_approval'
    ? new Date(Date.now() + APPROVAL_EXPIRY_MS).toISOString()
    : undefined;

  const status = mode === 'deny' ? 'denied' : mode === 'allow' ? 'executed' : 'pending';

  await createInvocation(db, {
    id: invocationId,
    sessionId: input.sessionId,
    userId: input.userId,
    service: input.service,
    actionId: input.actionId,
    riskLevel: input.riskLevel,
    resolvedMode: mode,
    params: input.params ? JSON.stringify(input.params) : undefined,
    expiresAt,
    policyId,
    status,
  });

  const outcome = mode === 'allow' ? 'allowed' : mode === 'deny' ? 'denied' : 'pending_approval';
  return { outcome, invocationId, mode, policyId };
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
  if (!inv || inv.status !== 'pending') {
    return { ok: false };
  }

  const now = new Date().toISOString();
  await updateInvocationStatus(db, invocationId, {
    status: 'approved',
    resolvedBy: approvedBy,
    resolvedAt: now,
    expectedStatus: 'pending',
  });

  // Re-fetch to return fresh state
  const updated = await getInvocation(db, invocationId);
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
): Promise<{ ok: boolean }> {
  const inv = await getInvocation(db, invocationId);
  if (!inv || inv.status !== 'pending') {
    return { ok: false };
  }

  const now = new Date().toISOString();
  await updateInvocationStatus(db, invocationId, {
    status: 'denied',
    resolvedBy: deniedBy,
    resolvedAt: now,
    error: reason,
    expectedStatus: 'pending',
  });

  return { ok: true };
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
