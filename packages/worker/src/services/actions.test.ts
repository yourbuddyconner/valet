import { describe, expect, it, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { approveInvocation, denyInvocation, markExecuted, markFailed } from './actions.js';
import { createInvocation, getInvocation } from '../lib/db/actions.js';
import { actionInvocations, sessions, users } from '../lib/schema/index.js';
import { createTestDb } from '../test-utils/db.js';

const USER_ID = 'approval-user';
const SESSION_ID = 'approval-session';

describe('action invocation approval helpers', () => {
  let db: ReturnType<typeof createTestDb>['db'];

  beforeEach(() => {
    ({ db } = createTestDb());
    db.insert(users).values({ id: USER_ID, email: 'approval-user@example.com' }).run();
    db.insert(sessions).values({
      id: SESSION_ID,
      userId: USER_ID,
      workspace: '/tmp/action-approval-helper',
      status: 'running',
    }).run();
  });

  async function createPendingInvocation(id: string, expiresAt?: string) {
    await createInvocation(db as any, {
      id,
      sessionId: SESSION_ID,
      userId: USER_ID,
      service: 'gmail',
      actionId: 'draft.create',
      riskLevel: 'medium',
      resolvedMode: 'require_approval',
      status: 'pending',
      expiresAt,
    });
  }

  it('marks expired pending approvals expired instead of approving them', async () => {
    await createPendingInvocation('expired-approval', '2020-01-01T00:00:00.000Z');

    const result = await approveInvocation(db as any, 'expired-approval', USER_ID);
    const invocation = await getInvocation(db as any, 'expired-approval');

    expect(result.ok).toBe(false);
    expect(invocation).toMatchObject({ status: 'expired', resolvedBy: null });
  });

  it('keeps same-user approval idempotent after a REST-to-DO handoff delay', async () => {
    await createPendingInvocation('pre-approved', '2999-01-01T00:00:00.000Z');
    expect((await approveInvocation(db as any, 'pre-approved', USER_ID)).ok).toBe(true);

    db.update(actionInvocations)
      .set({ expiresAt: '2020-01-01T00:00:00.000Z' })
      .where(eq(actionInvocations.id, 'pre-approved'))
      .run();

    const result = await approveInvocation(db as any, 'pre-approved', USER_ID);
    const invocation = await getInvocation(db as any, 'pre-approved');

    expect(result.ok).toBe(true);
    expect(invocation).toMatchObject({ status: 'approved', resolvedBy: USER_ID });
  });

  it('keeps same-user denial idempotent after a REST-to-DO handoff delay', async () => {
    await createPendingInvocation('pre-denied', '2999-01-01T00:00:00.000Z');
    expect((await denyInvocation(db as any, 'pre-denied', USER_ID, 'nope')).ok).toBe(true);

    db.update(actionInvocations)
      .set({ expiresAt: '2020-01-01T00:00:00.000Z' })
      .where(eq(actionInvocations.id, 'pre-denied'))
      .run();

    const result = await denyInvocation(db as any, 'pre-denied', USER_ID, 'nope');
    const invocation = await getInvocation(db as any, 'pre-denied');

    expect(result.ok).toBe(true);
    expect(invocation).toMatchObject({ status: 'denied', resolvedBy: USER_ID });
  });

  it('markExecuted only flips pending/approved rows; cancel-set "failed" is preserved', async () => {
    // The cancel cleanup pipeline transitions pending invocations to
    // 'failed' before the action runs. If the workflow then races to
    // call markExecuted (replay, slow network), the audit row MUST
    // stay 'failed' — otherwise we'd lie about an action being
    // executed for a workflow the user cancelled.
    await createInvocation(db as any, {
      id: 'cancelled-mid-flight',
      sessionId: SESSION_ID,
      userId: USER_ID,
      service: 'gmail',
      actionId: 'send',
      riskLevel: 'medium',
      resolvedMode: 'allow',
      status: 'pending',
    });
    // Simulate cancel cleanup running first.
    db.update(actionInvocations)
      .set({ status: 'failed', error: 'workflow_cancelled' })
      .where(eq(actionInvocations.id, 'cancelled-mid-flight'))
      .run();
    // Late markExecuted from a step.do replay must NOT overwrite.
    await markExecuted(db as any, 'cancelled-mid-flight', { ok: true });
    const inv = await getInvocation(db as any, 'cancelled-mid-flight');
    expect(inv?.status).toBe('failed');
    expect(inv?.error).toBe('workflow_cancelled');
  });

  it('markExecuted flips a pending allow-mode row to executed', async () => {
    await createInvocation(db as any, {
      id: 'allow-pending',
      sessionId: SESSION_ID,
      userId: USER_ID,
      service: 'gmail',
      actionId: 'send',
      riskLevel: 'medium',
      resolvedMode: 'allow',
      status: 'pending',
    });
    await markExecuted(db as any, 'allow-pending', { ok: true });
    const inv = await getInvocation(db as any, 'allow-pending');
    expect(inv?.status).toBe('executed');
  });

  it('markFailed preserves a cancel-set failed row (idempotent)', async () => {
    await createInvocation(db as any, {
      id: 'allow-fail-race',
      sessionId: SESSION_ID,
      userId: USER_ID,
      service: 'gmail',
      actionId: 'send',
      riskLevel: 'medium',
      resolvedMode: 'allow',
      status: 'pending',
    });
    db.update(actionInvocations)
      .set({ status: 'failed', error: 'workflow_cancelled' })
      .where(eq(actionInvocations.id, 'allow-fail-race'))
      .run();
    await markFailed(db as any, 'allow-fail-race', 'oh no');
    const inv = await getInvocation(db as any, 'allow-fail-race');
    expect(inv?.status).toBe('failed');
    expect(inv?.error).toBe('workflow_cancelled');
  });
});
