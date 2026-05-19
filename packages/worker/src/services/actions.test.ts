import { describe, expect, it, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { approveInvocation, denyInvocation } from './actions.js';
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
});
