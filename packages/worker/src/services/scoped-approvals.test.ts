import { beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from '../test-utils/db.js';
import { users } from '../lib/schema/users.js';
import { sessions } from '../lib/schema/sessions.js';
import { workflows, workflowExecutions } from '../lib/schema/workflows.js';
import {
  actionInvocations,
  actionPolicies,
  runtimeGrants,
} from '../lib/schema/actions.js';
import { eq } from 'drizzle-orm';
import { resolveInvocationWithScope } from './scoped-approvals.js';

const USER_ID = 'u1';
const SESSION_ID = 's1';
const OTHER_SESSION_ID = 's2';
const EXEC_ID = 'exec1';

function insertPendingSessionInvocation(
  db: ReturnType<typeof createTestDb>['db'],
  data: { id: string; sessionId: string; service: string; actionId: string; status?: string },
) {
  db.insert(actionInvocations).values({
    id: data.id,
    sessionId: data.sessionId,
    userId: USER_ID,
    service: data.service,
    actionId: data.actionId,
    riskLevel: 'medium',
    resolvedMode: 'require_approval',
    status: data.status ?? 'pending',
  }).run();
}

function insertPendingWorkflowInvocation(
  db: ReturnType<typeof createTestDb>['db'],
  data: { id: string; nodeId?: string; iterationIndex?: number; service?: string; actionId?: string; status?: string },
) {
  db.insert(actionInvocations).values({
    id: data.id,
    workflowExecutionId: EXEC_ID,
    userId: USER_ID,
    service: data.service ?? 'gmail',
    actionId: data.actionId ?? 'send_email',
    riskLevel: 'medium',
    resolvedMode: 'require_approval',
    status: data.status ?? 'pending',
    nodeId: data.nodeId ?? null,
    iterationIndex: typeof data.iterationIndex === 'number' ? data.iterationIndex : null,
  }).run();
}

describe('resolveInvocationWithScope', () => {
  let db: ReturnType<typeof createTestDb>['db'];

  beforeEach(() => {
    ({ db } = createTestDb());
    db.insert(users).values([{ id: USER_ID, email: 'u1@example.com' }]).run();
    db.insert(sessions).values([
      { id: SESSION_ID, userId: USER_ID, workspace: '/tmp/s1', status: 'running' },
      { id: OTHER_SESSION_ID, userId: USER_ID, workspace: '/tmp/s2', status: 'running' },
    ]).run();
    db.insert(workflows).values([
      { id: 'wf1', userId: USER_ID, name: 'wf', data: JSON.stringify({ version: 'dag/v1' }) },
    ]).run();
    db.insert(workflowExecutions).values([
      { id: EXEC_ID, workflowId: 'wf1', userId: USER_ID, status: 'running', triggerType: 'manual', startedAt: new Date().toISOString() },
    ]).run();
  });

  // ── scope='once' ───────────────────────────────────────────────────────

  it("scope='once' resolves only the original and writes no grant", async () => {
    insertPendingSessionInvocation(db, { id: 'inv-orig', sessionId: SESSION_ID, service: 'gmail', actionId: 'send_email' });
    insertPendingSessionInvocation(db, { id: 'inv-sib', sessionId: SESSION_ID, service: 'gmail', actionId: 'send_email' });

    const result = await resolveInvocationWithScope(db as any, {
      invocationId: 'inv-orig',
      decision: 'approved',
      userId: USER_ID,
      scope: 'once',
    });

    expect(result.kind).toBe('resolved');
    if (result.kind !== 'resolved') return;
    expect(result.grantId).toBeNull();
    expect(result.resolved).toHaveLength(1);
    expect(result.resolved[0].id).toBe('inv-orig');

    // Sibling still pending.
    const sib = await db.select().from(actionInvocations).where(eq(actionInvocations.id, 'inv-sib')).get();
    expect(sib?.status).toBe('pending');
    // No grant rows.
    expect(await db.select().from(runtimeGrants).all()).toHaveLength(0);
    expect(await db.select().from(actionPolicies).all()).toHaveLength(0);
  });

  // ── scope='session' sweep ─────────────────────────────────────────────

  it("scope='session' creates a runtime_grant AND sweeps a matching pending sibling in the same session", async () => {
    insertPendingSessionInvocation(db, { id: 'inv-orig', sessionId: SESSION_ID, service: 'gmail', actionId: 'send_email' });
    insertPendingSessionInvocation(db, { id: 'inv-sib', sessionId: SESSION_ID, service: 'gmail', actionId: 'send_email' });

    const result = await resolveInvocationWithScope(db as any, {
      invocationId: 'inv-orig',
      decision: 'approved',
      userId: USER_ID,
      scope: 'session',
    });

    expect(result.kind).toBe('resolved');
    if (result.kind !== 'resolved') return;
    expect(result.grantId).not.toBeNull();
    expect(result.resolved).toHaveLength(2);
    expect(result.resolved.map((r) => r.id).sort()).toEqual(['inv-orig', 'inv-sib']);

    const sib = await db.select().from(actionInvocations).where(eq(actionInvocations.id, 'inv-sib')).get();
    expect(sib?.status).toBe('approved');
    expect(sib?.resolvedBy).toBe(USER_ID);

    const grants = await db.select().from(runtimeGrants).all();
    expect(grants).toHaveLength(1);
    expect(grants[0].sessionId).toBe(SESSION_ID);
  });

  it("scope='session' does NOT sweep a sibling with a different target", async () => {
    insertPendingSessionInvocation(db, { id: 'inv-orig', sessionId: SESSION_ID, service: 'gmail', actionId: 'send_email' });
    insertPendingSessionInvocation(db, { id: 'inv-different', sessionId: SESSION_ID, service: 'github', actionId: 'create_issue' });

    await resolveInvocationWithScope(db as any, {
      invocationId: 'inv-orig',
      decision: 'approved',
      userId: USER_ID,
      scope: 'session',
    });

    const sib = await db.select().from(actionInvocations).where(eq(actionInvocations.id, 'inv-different')).get();
    expect(sib?.status).toBe('pending');
  });

  it("scope='session' does NOT sweep a sibling in a different session", async () => {
    insertPendingSessionInvocation(db, { id: 'inv-orig', sessionId: SESSION_ID, service: 'gmail', actionId: 'send_email' });
    insertPendingSessionInvocation(db, { id: 'inv-other-sess', sessionId: OTHER_SESSION_ID, service: 'gmail', actionId: 'send_email' });

    await resolveInvocationWithScope(db as any, {
      invocationId: 'inv-orig',
      decision: 'approved',
      userId: USER_ID,
      scope: 'session',
    });

    const sib = await db.select().from(actionInvocations).where(eq(actionInvocations.id, 'inv-other-sess')).get();
    expect(sib?.status).toBe('pending');
  });

  // ── scope='workflow_execution' sweep (foreach) ────────────────────────

  it("scope='workflow_execution' + nodeId sweeps every pending iteration of the same node", async () => {
    insertPendingWorkflowInvocation(db, { id: 'inv-iter-0', nodeId: 'foreach_body', iterationIndex: 0 });
    insertPendingWorkflowInvocation(db, { id: 'inv-iter-1', nodeId: 'foreach_body', iterationIndex: 1 });
    insertPendingWorkflowInvocation(db, { id: 'inv-iter-2', nodeId: 'foreach_body', iterationIndex: 2 });

    const result = await resolveInvocationWithScope(db as any, {
      invocationId: 'inv-iter-0',
      decision: 'approved',
      userId: USER_ID,
      scope: 'workflow_execution',
      nodeId: 'foreach_body',
    });

    expect(result.kind).toBe('resolved');
    if (result.kind !== 'resolved') return;
    expect(result.resolved.map((r) => r.id).sort()).toEqual(['inv-iter-0', 'inv-iter-1', 'inv-iter-2']);
  });

  it("scope='workflow_execution' + nodeId does NOT sweep a different node's pending invocations", async () => {
    insertPendingWorkflowInvocation(db, { id: 'inv-iter-0', nodeId: 'foreach_body', iterationIndex: 0 });
    insertPendingWorkflowInvocation(db, { id: 'inv-other-node', nodeId: 'other_approval' });

    const result = await resolveInvocationWithScope(db as any, {
      invocationId: 'inv-iter-0',
      decision: 'approved',
      userId: USER_ID,
      scope: 'workflow_execution',
      nodeId: 'foreach_body',
    });

    expect(result.kind).toBe('resolved');
    if (result.kind !== 'resolved') return;
    expect(result.resolved.map((r) => r.id)).toEqual(['inv-iter-0']);

    const other = await db.select().from(actionInvocations).where(eq(actionInvocations.id, 'inv-other-node')).get();
    expect(other?.status).toBe('pending');
  });

  it("scope='workflow_execution' WITHOUT nodeId sweeps every pending invocation in the execution sharing the target", async () => {
    insertPendingWorkflowInvocation(db, { id: 'inv-a', nodeId: 'node_a' });
    insertPendingWorkflowInvocation(db, { id: 'inv-b', nodeId: 'node_b' });

    const result = await resolveInvocationWithScope(db as any, {
      invocationId: 'inv-a',
      decision: 'approved',
      userId: USER_ID,
      scope: 'workflow_execution',
    });

    expect(result.kind).toBe('resolved');
    if (result.kind !== 'resolved') return;
    expect(result.resolved.map((r) => r.id).sort()).toEqual(['inv-a', 'inv-b']);
  });

  // ── scope='durable_policy' ─────────────────────────────────────────────

  it("scope='durable_policy' writes a user action_policies grant and sweeps matching same-session siblings", async () => {
    insertPendingSessionInvocation(db, { id: 'inv-orig', sessionId: SESSION_ID, service: 'gmail', actionId: 'send_email' });
    insertPendingSessionInvocation(db, { id: 'inv-sib', sessionId: SESSION_ID, service: 'gmail', actionId: 'send_email' });

    const result = await resolveInvocationWithScope(db as any, {
      invocationId: 'inv-orig',
      decision: 'approved',
      userId: USER_ID,
      scope: 'durable_policy',
    });

    expect(result.kind).toBe('resolved');
    if (result.kind !== 'resolved') return;
    expect(result.resolved).toHaveLength(2);

    const policies = await db.select().from(actionPolicies).all();
    expect(policies).toHaveLength(1);
    expect(policies[0].managedBy).toBe('user');
    expect(policies[0].principalId).toBe(USER_ID);
    expect(policies[0].mode).toBe('allow');
  });

  // ── denial path ─────────────────────────────────────────────────────────

  it('denial resolves only the original — no grant, no sweep', async () => {
    insertPendingSessionInvocation(db, { id: 'inv-orig', sessionId: SESSION_ID, service: 'gmail', actionId: 'send_email' });
    insertPendingSessionInvocation(db, { id: 'inv-sib', sessionId: SESSION_ID, service: 'gmail', actionId: 'send_email' });

    const result = await resolveInvocationWithScope(db as any, {
      invocationId: 'inv-orig',
      decision: 'denied',
      userId: USER_ID,
      scope: 'session',
      reason: 'nope',
    });

    expect(result.kind).toBe('resolved');
    if (result.kind !== 'resolved') return;
    expect(result.grantId).toBeNull();
    expect(result.resolved).toHaveLength(1);

    const sib = await db.select().from(actionInvocations).where(eq(actionInvocations.id, 'inv-sib')).get();
    expect(sib?.status).toBe('pending');
    expect(await db.select().from(runtimeGrants).all()).toHaveLength(0);
  });

  // ── already-resolved / not-found ──────────────────────────────────────

  it('returns already_resolved for a non-pending invocation', async () => {
    insertPendingSessionInvocation(db, { id: 'inv-done', sessionId: SESSION_ID, service: 'gmail', actionId: 'send_email', status: 'approved' });

    const result = await resolveInvocationWithScope(db as any, {
      invocationId: 'inv-done',
      decision: 'approved',
      userId: USER_ID,
      scope: 'session',
    });

    expect(result.kind).toBe('already_resolved');
  });

  it('returns not_found for an unknown invocation', async () => {
    const result = await resolveInvocationWithScope(db as any, {
      invocationId: 'missing',
      decision: 'approved',
      userId: USER_ID,
      scope: 'once',
    });

    expect(result.kind).toBe('not_found');
  });

  it('does not sweep an already-resolved sibling', async () => {
    insertPendingSessionInvocation(db, { id: 'inv-orig', sessionId: SESSION_ID, service: 'gmail', actionId: 'send_email' });
    insertPendingSessionInvocation(db, { id: 'inv-done', sessionId: SESSION_ID, service: 'gmail', actionId: 'send_email', status: 'denied' });

    const result = await resolveInvocationWithScope(db as any, {
      invocationId: 'inv-orig',
      decision: 'approved',
      userId: USER_ID,
      scope: 'session',
    });

    expect(result.kind).toBe('resolved');
    if (result.kind !== 'resolved') return;
    expect(result.resolved.map((r) => r.id)).toEqual(['inv-orig']);

    const stillDenied = await db.select().from(actionInvocations).where(eq(actionInvocations.id, 'inv-done')).get();
    expect(stillDenied?.status).toBe('denied');
  });
});
