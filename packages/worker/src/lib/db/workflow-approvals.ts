/**
 * Database helpers for workflow_approvals. One row per approval gate
 * hit during a workflow execution (explicit `approval` node or
 * `tool` node whose policy resolved to require_approval).
 */

import { and, eq, gt, or, isNull } from 'drizzle-orm';
import type { AppDb } from '../drizzle.js';
import { workflowApprovals } from '../schema/workflow-approvals.js';

export type ApprovalKind = 'explicit' | 'tool_policy';
export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled';

export interface CreateWorkflowApprovalInput {
  id: string;
  executionId: string;
  nodeId: string;
  kind: ApprovalKind;
  workflowInstanceId: string;
  eventType: string;
  prompt: string;
  summary?: string;
  details?: string;
  timeoutAt?: string;
}

export async function createWorkflowApproval(db: AppDb, input: CreateWorkflowApprovalInput): Promise<void> {
  // onConflictDoNothing handles the step.do replay race: D1 commits the
  // insert, then the Cloudflare Workflow step result fails to cache
  // (network blip, hibernate timing). On replay, requestApproval calls
  // this helper again with the same deterministic approval id; without
  // the conflict guard we'd hit a UNIQUE violation and crash the
  // execution. session.ts:upsertSpawnedSession uses the same pattern.
  await db.insert(workflowApprovals).values({
    id: input.id,
    executionId: input.executionId,
    nodeId: input.nodeId,
    kind: input.kind,
    workflowInstanceId: input.workflowInstanceId,
    eventType: input.eventType,
    prompt: input.prompt,
    summary: input.summary,
    details: input.details,
    timeoutAt: input.timeoutAt,
    status: 'pending',
  }).onConflictDoNothing().run();
}

export async function getWorkflowApproval(db: AppDb, id: string) {
  return db.select().from(workflowApprovals).where(eq(workflowApprovals.id, id)).get();
}

export interface WorkflowApprovalRow {
  id: string;
  executionId: string | null;
  nodeId: string;
  kind: ApprovalKind;
  workflowInstanceId: string;
  eventType: string;
  prompt: string;
  summary: string | null;
  details: string | null;
  status: ApprovalStatus;
  timeoutAt: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  cancelledAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export async function listWorkflowApprovalsForExecution(
  db: AppDb,
  executionId: string,
): Promise<WorkflowApprovalRow[]> {
  return db.select()
    .from(workflowApprovals)
    .where(eq(workflowApprovals.executionId, executionId))
    .all();
}

export async function resolveWorkflowApproval(
  db: AppDb,
  id: string,
  data: { status: 'approved' | 'denied'; resolvedBy: string },
): Promise<boolean> {
  // Optimistic-lock on `pending` so a denied row can't be flipped to
  // approved (or vice versa) after the fact. Also CAS on the per-row
  // timeout so the API check-then-write race (timeoutAt may have
  // elapsed between the route's pre-check and this UPDATE) cannot
  // resolve a stale approval: the WHERE clause refuses the write once
  // the deadline passes.
  const nowIso = new Date().toISOString();
  const result = await db.update(workflowApprovals)
    .set({
      status: data.status,
      resolvedBy: data.resolvedBy,
      resolvedAt: nowIso,
      updatedAt: nowIso,
    })
    .where(and(
      eq(workflowApprovals.id, id),
      eq(workflowApprovals.status, 'pending'),
      or(isNull(workflowApprovals.timeoutAt), gt(workflowApprovals.timeoutAt, nowIso)),
    ))
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

/**
 * Mark a still-pending approval row as expired. Called by:
 *   - the runtime when step.waitForEvent times out (workflow has moved
 *     on; without this the row stays 'pending' forever);
 *   - the approve/deny route when the user races a deadline (the CAS
 *     in resolveWorkflowApproval refused the write because timeoutAt
 *     elapsed — we still need to drive the row to terminal).
 * Idempotent: CAS on status='pending' so a denial or approval that
 * already won the race is preserved.
 */
export async function expireWorkflowApproval(db: AppDb, id: string): Promise<boolean> {
  const nowIso = new Date().toISOString();
  const result = await db.update(workflowApprovals)
    .set({
      status: 'expired',
      resolvedAt: nowIso,
      updatedAt: nowIso,
    })
    .where(and(eq(workflowApprovals.id, id), eq(workflowApprovals.status, 'pending')))
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function cancelAllPendingApprovalsForExecution(
  db: AppDb,
  executionId: string,
): Promise<number> {
  const result = await db.update(workflowApprovals)
    .set({
      status: 'cancelled',
      cancelledAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .where(and(
      eq(workflowApprovals.executionId, executionId),
      eq(workflowApprovals.status, 'pending'),
    ))
    .run();
  return result.meta?.changes ?? 0;
}
