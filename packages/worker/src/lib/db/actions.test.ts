import { beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from '../../test-utils/db.js';
import { sessions } from '../schema/sessions.js';
import { users } from '../schema/users.js';
import { workflows, workflowExecutions } from '../schema/workflows.js';
import {
  createInvocation,
  expandSessionLineage,
  getActionPolicy,
  getInvocation,
  getRuntimeGrant,
  listUserDurableActionPolicies,
  resolveAdminPolicyMatch,
  resolveEffectiveActionPolicy,
  resolvePolicy,
  upsertActionPolicy,
  upsertRuntimeGrant,
} from './actions.js';
import { updateSessionStatus } from './sessions.js';
import { invokeAction } from '../../services/actions.js';

const USER_ID = 'user-action-policy';
const OTHER_USER_ID = 'user-action-policy-other';
const SESSION_ID = 'session-action-policy';
const OTHER_SESSION_ID = 'session-action-policy-other';

describe('unified action policy resolver', () => {
  let db: ReturnType<typeof createTestDb>['db'];

  beforeEach(() => {
    ({ db } = createTestDb());

    db.insert(users).values([
      { id: USER_ID, email: 'policy-user@example.com' },
      { id: OTHER_USER_ID, email: 'policy-other@example.com' },
    ]).run();

    db.insert(sessions).values([
      { id: SESSION_ID, userId: USER_ID, workspace: '/tmp/policy-session', status: 'running' },
      { id: OTHER_SESSION_ID, userId: USER_ID, workspace: '/tmp/policy-other-session', status: 'running' },
    ]).run();
  });

  // ── Admin policy resolution ─────────────────────────────────────────────

  it('distinguishes explicit admin matches from system defaults', async () => {
    await expect(resolveAdminPolicyMatch(db as any, 'gmail', 'draft.create', 'medium')).resolves.toBeNull();

    await upsertActionPolicy(db as any, {
      id: 'org-gmail-service',
      service: 'gmail',
      mode: 'require_approval',
      createdBy: USER_ID,
    });

    const explicit = await resolveAdminPolicyMatch(db as any, 'gmail', 'draft.create', 'medium');
    expect(explicit).toMatchObject({
      mode: 'require_approval',
      policyId: 'org-gmail-service',
      scope: 'service',
    });

    await expect(resolvePolicy(db as any, 'linear', 'issue.delete', 'critical')).resolves.toEqual({
      mode: 'deny',
      policyId: null,
    });
  });

  it('admin exact deny beats a user exact-allow grant (deny wins)', async () => {
    await upsertActionPolicy(db as any, {
      id: 'org-exact-deny',
      service: 'gmail',
      actionId: 'draft.create',
      mode: 'deny',
      createdBy: USER_ID,
    });
    await upsertActionPolicy(db as any, {
      id: 'user-exact-allow',
      service: 'gmail',
      actionId: 'draft.create',
      mode: 'allow',
      managedBy: 'user',
      principalType: 'user',
      principalId: USER_ID,
      subjectType: 'tool_action',
      createdBy: USER_ID,
    });

    const policy = await resolveEffectiveActionPolicy(db as any, {
      userId: USER_ID,
      sessionId: SESSION_ID,
      service: 'gmail',
      actionId: 'draft.create',
      riskLevel: 'medium',
    });

    expect(policy.outcome).toBe('denied');
    expect(policy.matchedPolicyId).toBe('org-exact-deny');
    expect(policy.source).toBe('admin_policy');
  });

  it('admin service deny beats a user exact-allow grant', async () => {
    await upsertActionPolicy(db as any, {
      id: 'org-service-deny',
      service: 'gmail',
      mode: 'deny',
      createdBy: USER_ID,
    });
    await upsertActionPolicy(db as any, {
      id: 'user-exact-allow',
      service: 'gmail',
      actionId: 'draft.create',
      mode: 'allow',
      managedBy: 'user',
      principalType: 'user',
      principalId: USER_ID,
      subjectType: 'tool_action',
      createdBy: USER_ID,
    });

    const policy = await resolveEffectiveActionPolicy(db as any, {
      userId: USER_ID,
      sessionId: SESSION_ID,
      service: 'gmail',
      actionId: 'draft.create',
      riskLevel: 'medium',
    });

    expect(policy.outcome).toBe('denied');
    expect(policy.matchedPolicyId).toBe('org-service-deny');
  });

  it('admin risk deny beats a user service-allow grant', async () => {
    await upsertActionPolicy(db as any, {
      id: 'org-risk-deny',
      riskLevel: 'high',
      mode: 'deny',
      createdBy: USER_ID,
    });
    await upsertActionPolicy(db as any, {
      id: 'user-service-allow',
      service: 'github',
      mode: 'allow',
      managedBy: 'user',
      principalType: 'user',
      principalId: USER_ID,
      subjectType: 'tool_action',
      createdBy: USER_ID,
    });

    const policy = await resolveEffectiveActionPolicy(db as any, {
      userId: USER_ID,
      sessionId: SESSION_ID,
      service: 'github',
      actionId: 'create_repository',
      riskLevel: 'high',
    });

    expect(policy.outcome).toBe('denied');
    expect(policy.matchedPolicyId).toBe('org-risk-deny');
  });

  it('admin/system allow returns allow without consulting grants', async () => {
    await upsertActionPolicy(db as any, {
      id: 'org-service-allow',
      service: 'gmail',
      mode: 'allow',
      createdBy: USER_ID,
    });

    const policy = await resolveEffectiveActionPolicy(db as any, {
      userId: USER_ID,
      sessionId: SESSION_ID,
      service: 'gmail',
      actionId: 'send_email',
      riskLevel: 'medium',
    });

    expect(policy.outcome).toBe('allowed');
    expect(policy.source).toBe('admin_policy');
    expect(policy.matchedPolicyId).toBe('org-service-allow');
    expect(policy.matchedGrantId).toBeNull();
  });

  // ── Durable user grants ────────────────────────────────────────────────

  it('user exact grant loosens a critical system default deny', async () => {
    await upsertActionPolicy(db as any, {
      id: 'user-critical-allow',
      service: 'linear',
      actionId: 'issue.delete',
      mode: 'allow',
      managedBy: 'user',
      principalType: 'user',
      principalId: USER_ID,
      subjectType: 'tool_action',
      createdBy: USER_ID,
    });

    const policy = await resolveEffectiveActionPolicy(db as any, {
      userId: USER_ID,
      sessionId: SESSION_ID,
      service: 'linear',
      actionId: 'issue.delete',
      riskLevel: 'critical',
    });

    expect(policy.outcome).toBe('allowed');
    expect(policy.source).toBe('user_policy');
    expect(policy.matchedPolicyId).toBe('user-critical-allow');
    expect(policy.scope).toBe('action');
  });

  it('prefers a user exact grant over service and risk grants', async () => {
    await upsertActionPolicy(db as any, {
      id: 'user-action-allow',
      service: 'linear',
      actionId: 'issue.delete',
      mode: 'allow',
      managedBy: 'user',
      principalType: 'user',
      principalId: USER_ID,
      subjectType: 'tool_action',
      createdBy: USER_ID,
    });
    await upsertActionPolicy(db as any, {
      id: 'user-service-allow',
      service: 'linear',
      mode: 'allow',
      managedBy: 'user',
      principalType: 'user',
      principalId: USER_ID,
      subjectType: 'tool_action',
      createdBy: USER_ID,
    });
    await upsertActionPolicy(db as any, {
      id: 'user-risk-allow',
      riskLevel: 'critical',
      mode: 'allow',
      managedBy: 'user',
      principalType: 'user',
      principalId: USER_ID,
      subjectType: 'tool_action',
      createdBy: USER_ID,
    });

    const policy = await resolveEffectiveActionPolicy(db as any, {
      userId: USER_ID,
      sessionId: SESSION_ID,
      service: 'linear',
      actionId: 'issue.delete',
      riskLevel: 'critical',
    });

    expect(policy.matchedPolicyId).toBe('user-action-allow');
    expect(policy.scope).toBe('action');
  });

  it('a user durable grant from one user does not apply to another user', async () => {
    await upsertActionPolicy(db as any, {
      id: 'other-user-allow',
      service: 'linear',
      actionId: 'issue.delete',
      mode: 'allow',
      managedBy: 'user',
      principalType: 'user',
      principalId: OTHER_USER_ID,
      subjectType: 'tool_action',
      createdBy: OTHER_USER_ID,
    });

    const policy = await resolveEffectiveActionPolicy(db as any, {
      userId: USER_ID,
      sessionId: SESSION_ID,
      service: 'linear',
      actionId: 'issue.delete',
      riskLevel: 'critical',
    });

    expect(policy.outcome).toBe('denied');
  });

  it('ignores expired durable user grants', async () => {
    await upsertActionPolicy(db as any, {
      id: 'expired-allow',
      service: 'linear',
      actionId: 'issue.delete',
      mode: 'allow',
      managedBy: 'user',
      principalType: 'user',
      principalId: USER_ID,
      subjectType: 'tool_action',
      createdBy: USER_ID,
      expiresAt: '2000-01-01T00:00:00Z',
    });

    const policy = await resolveEffectiveActionPolicy(db as any, {
      userId: USER_ID,
      sessionId: SESSION_ID,
      service: 'linear',
      actionId: 'issue.delete',
      riskLevel: 'critical',
    });

    expect(policy.outcome).toBe('denied');
  });

  // ── Runtime grants ─────────────────────────────────────────────────────

  it('auto-approves matching calls on the session a runtime grant is bound to', async () => {
    await upsertRuntimeGrant(db as any, {
      id: 'session-grant',
      userId: USER_ID,
      sessionId: SESSION_ID,
      subjectType: 'tool_action',
      service: 'gmail',
      actionId: 'draft.create',
      policyKey: `session:${SESSION_ID}:gmail.draft.create:`,
    });

    const policy = await resolveEffectiveActionPolicy(db as any, {
      userId: USER_ID,
      sessionId: SESSION_ID,
      service: 'gmail',
      actionId: 'draft.create',
      riskLevel: 'medium',
    });

    expect(policy.outcome).toBe('allowed');
    expect(policy.source).toBe('runtime_grant');
    expect(policy.matchedGrantId).toBe('session-grant');
  });

  it('a session-scoped runtime grant does not leak to a sibling session', async () => {
    await upsertRuntimeGrant(db as any, {
      id: 'session-grant',
      userId: USER_ID,
      sessionId: SESSION_ID,
      subjectType: 'tool_action',
      service: 'gmail',
      actionId: 'draft.create',
      policyKey: `session:${SESSION_ID}:gmail.draft.create:`,
    });

    const policy = await resolveEffectiveActionPolicy(db as any, {
      userId: USER_ID,
      sessionId: OTHER_SESSION_ID,
      service: 'gmail',
      actionId: 'draft.create',
      riskLevel: 'medium',
    });

    expect(policy.outcome).toBe('pending_approval');
    expect(policy.matchedGrantId).toBeNull();
  });

  // ── Lineage inheritance ────────────────────────────────────────────────

  it('runtime grant on a parent session auto-approves a child session call', async () => {
    const CHILD_SESSION_ID = 'session-child';
    db.insert(sessions).values({
      id: CHILD_SESSION_ID,
      userId: USER_ID,
      workspace: '/tmp/child',
      status: 'running',
      parentSessionId: SESSION_ID,
    }).run();

    await upsertRuntimeGrant(db as any, {
      id: 'parent-grant',
      userId: USER_ID,
      sessionId: SESSION_ID,
      subjectType: 'tool_action',
      service: 'gmail',
      actionId: 'draft.create',
      policyKey: `session:${SESSION_ID}:gmail.draft.create:`,
    });

    const policy = await resolveEffectiveActionPolicy(db as any, {
      userId: USER_ID,
      sessionId: CHILD_SESSION_ID,
      service: 'gmail',
      actionId: 'draft.create',
      riskLevel: 'medium',
    });

    expect(policy.outcome).toBe('allowed');
    expect(policy.matchedGrantId).toBe('parent-grant');
  });

  it('expandSessionLineage walks parentSessionId, capped and cycle-guarded', async () => {
    const A = 'lineage-a';
    const B = 'lineage-b';
    const C = 'lineage-c';
    db.insert(sessions).values([
      { id: A, userId: USER_ID, workspace: '/a', status: 'running' },
      { id: B, userId: USER_ID, workspace: '/b', status: 'running', parentSessionId: A },
      { id: C, userId: USER_ID, workspace: '/c', status: 'running', parentSessionId: B },
    ]).run();

    const lineage = await expandSessionLineage(db as any, C);
    expect(lineage.sessionIds).toEqual([C, B, A]);
  });

  // ── Workflow execution recovery ────────────────────────────────────────
  // (Per-lineage-member workflow_spawned_sessions recovery is exercised in
  // the workflow integration tests; here we cover the direct
  // workflowExecutionId scope path.)

  it('runtime grant scoped to a workflow execution auto-approves the same execution', async () => {
    db.insert(workflows).values({
      id: 'wf-1',
      userId: USER_ID,
      name: 'wf',
      data: JSON.stringify({ version: 'dag/v1' }),
    }).run();
    db.insert(workflowExecutions).values({
      id: 'exec-abc',
      workflowId: 'wf-1',
      userId: USER_ID,
      status: 'running',
      triggerType: 'manual',
      startedAt: new Date().toISOString(),
    }).run();

    await upsertRuntimeGrant(db as any, {
      id: 'exec-grant',
      userId: USER_ID,
      workflowExecutionId: 'exec-abc',
      subjectType: 'tool_action',
      service: 'gmail',
      actionId: 'send_email',
      policyKey: 'exec-abc:gmail.send_email',
    });

    const policy = await resolveEffectiveActionPolicy(db as any, {
      userId: USER_ID,
      workflowExecutionId: 'exec-abc',
      service: 'gmail',
      actionId: 'send_email',
      riskLevel: 'medium',
    });

    expect(policy.outcome).toBe('allowed');
    expect(policy.source).toBe('runtime_grant');
    expect(policy.matchedGrantId).toBe('exec-grant');
  });

  // ── Audit metadata ─────────────────────────────────────────────────────

  it('stores matched_policy_id / matched_grant_id and audit fields on invocations', async () => {
    await upsertActionPolicy(db as any, {
      id: 'org-require',
      service: 'gmail',
      mode: 'require_approval',
      createdBy: USER_ID,
    });
    await upsertRuntimeGrant(db as any, {
      id: 'session-grant',
      userId: USER_ID,
      sessionId: SESSION_ID,
      subjectType: 'tool_action',
      service: 'gmail',
      actionId: 'draft.create',
      policyKey: `session:${SESSION_ID}:gmail.draft.create:`,
    });

    const result = await invokeAction(db as any, {
      sessionId: SESSION_ID,
      userId: USER_ID,
      service: 'gmail',
      actionId: 'draft.create',
      riskLevel: 'medium',
    });

    expect(result.outcome).toBe('allowed');
    expect(result.matchedGrantId).toBe('session-grant');

    const invocation = await getInvocation(db as any, result.invocationId);
    expect(invocation).toMatchObject({
      matchedPolicyId: 'org-require',
      matchedGrantId: 'session-grant',
      baseMode: 'require_approval',
      baseSource: 'admin_policy',
      policySource: 'runtime_grant',
      policyScope: 'action',
      resolvedMode: 'allow',
      status: 'executed',
    });
  });

  it('invokeAction surfaces system-default require_approval as pending_approval when no grant matches', async () => {
    const result = await invokeAction(db as any, {
      sessionId: SESSION_ID,
      userId: USER_ID,
      service: 'gmail',
      actionId: 'draft.create',
      riskLevel: 'medium',
    });

    expect(result.outcome).toBe('pending_approval');
    expect(result.matchedGrantId).toBeNull();

    const invocation = await getInvocation(db as any, result.invocationId);
    expect(invocation).toMatchObject({
      baseMode: 'require_approval',
      baseSource: 'system_default',
      policySource: 'system_default',
      status: 'pending',
    });
  });

  // ── Terminal cleanup ───────────────────────────────────────────────────

  describe('runtime grant cleanup on session terminal transition', () => {
    it('removes only the matching session’s grants', async () => {
      await upsertRuntimeGrant(db as any, {
        id: 'session-grant',
        userId: USER_ID,
        sessionId: SESSION_ID,
        subjectType: 'tool_action',
        service: 'gmail',
        actionId: 'draft.create',
        policyKey: `session:${SESSION_ID}:gmail.draft.create:`,
      });
      await upsertRuntimeGrant(db as any, {
        id: 'other-session-grant',
        userId: USER_ID,
        sessionId: OTHER_SESSION_ID,
        subjectType: 'tool_action',
        service: 'linear',
        actionId: 'issue.create',
        policyKey: `session:${OTHER_SESSION_ID}:linear.issue.create:`,
      });
      await upsertActionPolicy(db as any, {
        id: 'persistent-grant',
        service: 'gmail',
        mode: 'allow',
        managedBy: 'user',
        principalType: 'user',
        principalId: USER_ID,
        subjectType: 'tool_action',
        createdBy: USER_ID,
      });

      await updateSessionStatus(db as any, SESSION_ID, 'terminated');

      expect(await getRuntimeGrant(db as any, 'session-grant')).toBeUndefined();
      expect(await getRuntimeGrant(db as any, 'other-session-grant')).toBeDefined();
      expect(await getActionPolicy(db as any, 'persistent-grant')).toBeDefined();
    });

    it('removes runtime grants when a session hibernates', async () => {
      await upsertRuntimeGrant(db as any, {
        id: 'hibernating-session-grant',
        userId: USER_ID,
        sessionId: SESSION_ID,
        subjectType: 'tool_action',
        service: 'gmail',
        actionId: 'draft.create',
        policyKey: `session:${SESSION_ID}:gmail.draft.create:`,
      });

      await updateSessionStatus(db as any, SESSION_ID, 'hibernated');

      expect(await getRuntimeGrant(db as any, 'hibernating-session-grant')).toBeUndefined();
    });
  });

  // ── Listing ────────────────────────────────────────────────────────────

  it('listUserDurableActionPolicies returns only this user’s durable grants', async () => {
    await upsertActionPolicy(db as any, {
      id: 'mine',
      service: 'gmail',
      mode: 'allow',
      managedBy: 'user',
      principalType: 'user',
      principalId: USER_ID,
      subjectType: 'tool_action',
      createdBy: USER_ID,
    });
    await upsertActionPolicy(db as any, {
      id: 'theirs',
      service: 'linear',
      mode: 'allow',
      managedBy: 'user',
      principalType: 'user',
      principalId: OTHER_USER_ID,
      subjectType: 'tool_action',
      createdBy: OTHER_USER_ID,
    });
    await upsertActionPolicy(db as any, {
      id: 'admin-row',
      service: 'gmail',
      mode: 'require_approval',
      createdBy: USER_ID,
    });

    const rows = await listUserDurableActionPolicies(db as any, USER_ID);
    const ids = rows.map((r: { id: string }) => r.id);
    expect(ids).toContain('mine');
    expect(ids).not.toContain('theirs');
    expect(ids).not.toContain('admin-row');
  });
});
