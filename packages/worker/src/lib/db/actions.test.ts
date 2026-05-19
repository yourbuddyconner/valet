import { beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from '../../test-utils/db.js';
import { sessions } from '../schema/sessions.js';
import { users } from '../schema/users.js';
import {
  createInvocation,
  getInvocation,
  getUserActionPolicyOverride,
  resolveEffectiveActionPolicy,
  resolveOrgPolicyMatch,
  resolvePolicy,
  resolveUserActionPolicyOverride,
  upsertActionPolicy,
  upsertUserActionPolicyOverride,
} from './actions.js';
import { updateSessionStatus } from './sessions.js';
import { invokeAction } from '../../services/actions.js';

const USER_ID = 'user-action-policy';
const OTHER_USER_ID = 'user-action-policy-other';
const SESSION_ID = 'session-action-policy';
const OTHER_SESSION_ID = 'session-action-policy-other';

describe('action policy DB helpers', () => {
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

  it('distinguishes explicit org matches from system defaults', async () => {
    await expect(resolveOrgPolicyMatch(db as any, 'gmail', 'draft.create', 'medium')).resolves.toBeNull();

    await upsertActionPolicy(db as any, {
      id: 'org-gmail-service',
      service: 'gmail',
      mode: 'require_approval',
      createdBy: USER_ID,
    });

    const explicit = await resolveOrgPolicyMatch(db as any, 'gmail', 'draft.create', 'medium');
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

  it('treats explicit org exact deny as a hard ceiling over user exact allow', async () => {
    await upsertActionPolicy(db as any, {
      id: 'org-exact-deny',
      service: 'gmail',
      actionId: 'draft.create',
      mode: 'deny',
      createdBy: USER_ID,
    });
    await upsertUserActionPolicyOverride(db as any, {
      id: 'user-exact-allow',
      userId: USER_ID,
      service: 'gmail',
      actionId: 'draft.create',
      mode: 'allow',
      lifetime: 'persistent',
      source: 'settings',
    });

    const result = await resolveEffectiveActionPolicy(db as any, {
      userId: USER_ID,
      sessionId: SESSION_ID,
      service: 'gmail',
      actionId: 'draft.create',
      riskLevel: 'medium',
    });

    expect(result).toMatchObject({
      mode: 'deny',
      outcome: 'denied',
      baseMode: 'deny',
      baseSource: 'org_policy',
      orgPolicyId: 'org-exact-deny',
      userOverrideId: null,
      source: 'org_policy',
      lifetime: null,
      scope: 'action',
    });
  });

  it('treats explicit org service deny as a hard ceiling over user exact allow', async () => {
    await upsertActionPolicy(db as any, {
      id: 'org-service-deny',
      service: 'gmail',
      mode: 'deny',
      createdBy: USER_ID,
    });
    await upsertUserActionPolicyOverride(db as any, {
      id: 'user-exact-allow',
      userId: USER_ID,
      service: 'gmail',
      actionId: 'draft.create',
      mode: 'allow',
      lifetime: 'persistent',
      source: 'settings',
    });

    const result = await resolveEffectiveActionPolicy(db as any, {
      userId: USER_ID,
      sessionId: SESSION_ID,
      service: 'gmail',
      actionId: 'draft.create',
      riskLevel: 'medium',
    });

    expect(result).toMatchObject({
      mode: 'deny',
      outcome: 'denied',
      orgPolicyId: 'org-service-deny',
      userOverrideId: null,
      source: 'org_policy',
      scope: 'service',
    });
  });

  it('treats explicit org risk deny as a hard ceiling over user service allow', async () => {
    await upsertActionPolicy(db as any, {
      id: 'org-risk-deny',
      riskLevel: 'medium',
      mode: 'deny',
      createdBy: USER_ID,
    });
    await upsertUserActionPolicyOverride(db as any, {
      id: 'user-service-allow',
      userId: USER_ID,
      service: 'gmail',
      mode: 'allow',
      lifetime: 'persistent',
      source: 'settings',
    });

    const result = await resolveEffectiveActionPolicy(db as any, {
      userId: USER_ID,
      sessionId: SESSION_ID,
      service: 'gmail',
      actionId: 'draft.create',
      riskLevel: 'medium',
    });

    expect(result).toMatchObject({
      mode: 'deny',
      outcome: 'denied',
      orgPolicyId: 'org-risk-deny',
      userOverrideId: null,
      source: 'org_policy',
      scope: 'risk_level',
    });
  });

  it('allows a user exact override to loosen critical system default deny', async () => {
    await upsertUserActionPolicyOverride(db as any, {
      id: 'user-critical-allow',
      userId: USER_ID,
      service: 'linear',
      actionId: 'issue.delete',
      mode: 'allow',
      lifetime: 'persistent',
      source: 'settings',
    });

    const result = await resolveEffectiveActionPolicy(db as any, {
      userId: USER_ID,
      sessionId: SESSION_ID,
      service: 'linear',
      actionId: 'issue.delete',
      riskLevel: 'critical',
    });

    expect(result).toMatchObject({
      mode: 'allow',
      outcome: 'allowed',
      baseMode: 'deny',
      baseSource: 'system_default',
      orgPolicyId: null,
      userOverrideId: 'user-critical-allow',
      source: 'user_override',
      lifetime: 'persistent',
      scope: 'action',
    });
  });

  it('prefers user exact override over service and risk overrides', async () => {
    await upsertUserActionPolicyOverride(db as any, {
      id: 'user-risk-deny',
      userId: USER_ID,
      riskLevel: 'medium',
      mode: 'deny',
      lifetime: 'persistent',
      source: 'settings',
    });
    await upsertUserActionPolicyOverride(db as any, {
      id: 'user-service-ask',
      userId: USER_ID,
      service: 'gmail',
      mode: 'require_approval',
      lifetime: 'persistent',
      source: 'settings',
    });
    await upsertUserActionPolicyOverride(db as any, {
      id: 'user-exact-allow',
      userId: USER_ID,
      service: 'gmail',
      actionId: 'draft.create',
      mode: 'allow',
      lifetime: 'persistent',
      source: 'settings',
    });

    const result = await resolveEffectiveActionPolicy(db as any, {
      userId: USER_ID,
      sessionId: SESSION_ID,
      service: 'gmail',
      actionId: 'draft.create',
      riskLevel: 'medium',
    });

    expect(result).toMatchObject({
      mode: 'allow',
      outcome: 'allowed',
      userOverrideId: 'user-exact-allow',
      source: 'user_override',
      scope: 'action',
    });
  });

  it('prefers user service override over risk override', async () => {
    await upsertUserActionPolicyOverride(db as any, {
      id: 'user-risk-allow',
      userId: USER_ID,
      riskLevel: 'medium',
      mode: 'allow',
      lifetime: 'persistent',
      source: 'settings',
    });
    await upsertUserActionPolicyOverride(db as any, {
      id: 'user-service-deny',
      userId: USER_ID,
      service: 'gmail',
      mode: 'deny',
      lifetime: 'persistent',
      source: 'settings',
    });

    const result = await resolveEffectiveActionPolicy(db as any, {
      userId: USER_ID,
      sessionId: SESSION_ID,
      service: 'gmail',
      actionId: 'draft.create',
      riskLevel: 'medium',
    });

    expect(result).toMatchObject({
      mode: 'deny',
      outcome: 'denied',
      userOverrideId: 'user-service-deny',
      source: 'user_override',
      scope: 'service',
    });
  });

  it('only applies session overrides to the matching session', async () => {
    await upsertUserActionPolicyOverride(db as any, {
      id: 'user-session-allow',
      userId: USER_ID,
      service: 'gmail',
      actionId: 'draft.create',
      mode: 'allow',
      lifetime: 'session',
      sessionId: SESSION_ID,
      source: 'approval_prompt',
    });

    const matchingSession = await resolveEffectiveActionPolicy(db as any, {
      userId: USER_ID,
      sessionId: SESSION_ID,
      service: 'gmail',
      actionId: 'draft.create',
      riskLevel: 'medium',
    });
    const otherSession = await resolveEffectiveActionPolicy(db as any, {
      userId: USER_ID,
      sessionId: OTHER_SESSION_ID,
      service: 'gmail',
      actionId: 'draft.create',
      riskLevel: 'medium',
    });

    expect(matchingSession).toMatchObject({
      mode: 'allow',
      outcome: 'allowed',
      userOverrideId: 'user-session-allow',
      source: 'session_override',
      lifetime: 'session',
      scope: 'action',
    });
    expect(otherSession).toMatchObject({
      mode: 'require_approval',
      outcome: 'pending_approval',
      userOverrideId: null,
      source: 'system_default',
      lifetime: null,
      scope: 'none',
    });
  });

  it('ignores expired timed overrides', async () => {
    await upsertUserActionPolicyOverride(db as any, {
      id: 'user-expired-allow',
      userId: USER_ID,
      service: 'linear',
      actionId: 'issue.delete',
      mode: 'allow',
      lifetime: 'timed',
      expiresAt: '2020-01-01T00:00:00.000Z',
      source: 'settings',
    });

    const activeOverride = await resolveUserActionPolicyOverride(db as any, {
      userId: USER_ID,
      sessionId: SESSION_ID,
      service: 'linear',
      actionId: 'issue.delete',
      riskLevel: 'critical',
    });
    const result = await resolveEffectiveActionPolicy(db as any, {
      userId: USER_ID,
      sessionId: SESSION_ID,
      service: 'linear',
      actionId: 'issue.delete',
      riskLevel: 'critical',
    });

    expect(activeOverride).toBeNull();
    expect(result).toMatchObject({
      mode: 'deny',
      outcome: 'denied',
      baseMode: 'deny',
      baseSource: 'system_default',
      userOverrideId: null,
      source: 'system_default',
      lifetime: null,
      scope: 'none',
    });
  });

  it('allows persistent user deny to tighten org allow', async () => {
    await upsertActionPolicy(db as any, {
      id: 'org-service-allow',
      service: 'gmail',
      mode: 'allow',
      createdBy: USER_ID,
    });
    await upsertUserActionPolicyOverride(db as any, {
      id: 'user-exact-deny',
      userId: USER_ID,
      service: 'gmail',
      actionId: 'draft.create',
      mode: 'deny',
      lifetime: 'persistent',
      source: 'settings',
    });

    const result = await resolveEffectiveActionPolicy(db as any, {
      userId: USER_ID,
      sessionId: SESSION_ID,
      service: 'gmail',
      actionId: 'draft.create',
      riskLevel: 'low',
    });

    expect(result).toMatchObject({
      mode: 'deny',
      outcome: 'denied',
      baseMode: 'allow',
      baseSource: 'org_policy',
      orgPolicyId: 'org-service-allow',
      userOverrideId: 'user-exact-deny',
      source: 'user_override',
      lifetime: 'persistent',
      scope: 'action',
    });
  });

  it('stores effective policy audit fields on invocations', async () => {
    await upsertActionPolicy(db as any, {
      id: 'org-service-allow',
      service: 'gmail',
      mode: 'allow',
      createdBy: USER_ID,
    });

    await createInvocation(db as any, {
      id: 'invocation-with-audit',
      sessionId: SESSION_ID,
      userId: USER_ID,
      service: 'gmail',
      actionId: 'draft.create',
      riskLevel: 'medium',
      resolvedMode: 'allow',
      status: 'executed',
      orgPolicyId: 'org-service-allow',
      policyId: 'org-service-allow',
      baseMode: 'require_approval',
      baseSource: 'org_policy',
      userOverrideId: null,
      policySource: 'user_override',
      policyLifetime: 'persistent',
      policyScope: 'service',
    });

    const invocation = await getInvocation(db as any, 'invocation-with-audit');

    expect(invocation).toMatchObject({
      id: 'invocation-with-audit',
      orgPolicyId: 'org-service-allow',
      policyId: 'org-service-allow',
      baseMode: 'require_approval',
      baseSource: 'org_policy',
      userOverrideId: null,
      policySource: 'user_override',
      policyLifetime: 'persistent',
      policyScope: 'service',
    });
  });

  describe('invokeAction effective policy integration', () => {
    it('auto-allows from a user override and stores base policy audit fields', async () => {
      await upsertUserActionPolicyOverride(db as any, {
        id: 'user-exact-allow',
        userId: USER_ID,
        service: 'gmail',
        actionId: 'draft.create',
        mode: 'allow',
        lifetime: 'persistent',
        source: 'settings',
      });

      const result = await invokeAction(db as any, {
        sessionId: SESSION_ID,
        userId: USER_ID,
        service: 'gmail',
        actionId: 'draft.create',
        riskLevel: 'medium',
        params: { to: 'customer@example.com' },
      });
      const invocation = await getInvocation(db as any, result.invocationId);

      expect(result).toMatchObject({
        outcome: 'allowed',
        mode: 'allow',
        policyId: null,
      });
      expect(invocation).toMatchObject({
        status: 'executed',
        resolvedMode: 'allow',
        baseMode: 'require_approval',
        baseSource: 'system_default',
        orgPolicyId: null,
        userOverrideId: 'user-exact-allow',
        policySource: 'user_override',
        policyLifetime: 'persistent',
        policyScope: 'action',
      });
    });

    it('keeps explicit org deny effective even when user allow exists', async () => {
      await upsertActionPolicy(db as any, {
        id: 'org-exact-deny',
        service: 'gmail',
        actionId: 'draft.create',
        mode: 'deny',
        createdBy: USER_ID,
      });
      await upsertUserActionPolicyOverride(db as any, {
        id: 'user-exact-allow',
        userId: USER_ID,
        service: 'gmail',
        actionId: 'draft.create',
        mode: 'allow',
        lifetime: 'persistent',
        source: 'settings',
      });

      const result = await invokeAction(db as any, {
        sessionId: SESSION_ID,
        userId: USER_ID,
        service: 'gmail',
        actionId: 'draft.create',
        riskLevel: 'medium',
      });
      const invocation = await getInvocation(db as any, result.invocationId);

      expect(result).toMatchObject({
        outcome: 'denied',
        mode: 'deny',
        policyId: 'org-exact-deny',
      });
      expect(invocation).toMatchObject({
        status: 'denied',
        resolvedMode: 'deny',
        baseMode: 'deny',
        baseSource: 'org_policy',
        orgPolicyId: 'org-exact-deny',
        userOverrideId: null,
        policySource: 'org_policy',
        policyLifetime: null,
        policyScope: 'action',
      });
    });

    it('records session override source and lifetime on auto-allowed invocations', async () => {
      await upsertUserActionPolicyOverride(db as any, {
        id: 'user-session-allow',
        userId: USER_ID,
        service: 'gmail',
        actionId: 'draft.create',
        mode: 'allow',
        lifetime: 'session',
        sessionId: SESSION_ID,
        source: 'approval_prompt',
      });

      const result = await invokeAction(db as any, {
        sessionId: SESSION_ID,
        userId: USER_ID,
        service: 'gmail',
        actionId: 'draft.create',
        riskLevel: 'high',
      });
      const invocation = await getInvocation(db as any, result.invocationId);

      expect(result).toMatchObject({
        outcome: 'allowed',
        mode: 'allow',
      });
      expect(invocation).toMatchObject({
        status: 'executed',
        resolvedMode: 'allow',
        baseMode: 'require_approval',
        baseSource: 'system_default',
        userOverrideId: 'user-session-allow',
        policySource: 'session_override',
        policyLifetime: 'session',
        policyScope: 'action',
      });
    });
  });

  describe('session override expiry', () => {
    it('expires only matching session-scoped overrides when a session reaches terminal status', async () => {
      await upsertUserActionPolicyOverride(db as any, {
        id: 'session-override',
        userId: USER_ID,
        service: 'gmail',
        actionId: 'draft.create',
        mode: 'allow',
        lifetime: 'session',
        sessionId: SESSION_ID,
        source: 'approval_prompt',
      });
      await upsertUserActionPolicyOverride(db as any, {
        id: 'other-session-override',
        userId: USER_ID,
        service: 'linear',
        actionId: 'issue.create',
        mode: 'allow',
        lifetime: 'session',
        sessionId: OTHER_SESSION_ID,
        source: 'approval_prompt',
      });
      await upsertUserActionPolicyOverride(db as any, {
        id: 'persistent-override',
        userId: USER_ID,
        service: 'gmail',
        mode: 'deny',
        lifetime: 'persistent',
        source: 'settings',
      });

      const before = Date.now();
      await updateSessionStatus(db as any, SESSION_ID, 'terminated');

      const expired = await getUserActionPolicyOverride(db as any, 'session-override');
      const otherSession = await getUserActionPolicyOverride(db as any, 'other-session-override');
      const persistent = await getUserActionPolicyOverride(db as any, 'persistent-override');

      expect(expired?.expiresAt).toBeTruthy();
      expect(Date.parse(expired!.expiresAt!)).toBeGreaterThanOrEqual(before - 1000);
      expect(Date.parse(expired!.expiresAt!)).toBeLessThanOrEqual(Date.now() + 1000);
      expect(otherSession?.expiresAt).toBeNull();
      expect(persistent?.expiresAt).toBeNull();
    });

    it('does not expire session-scoped overrides when a session hibernates', async () => {
      await upsertUserActionPolicyOverride(db as any, {
        id: 'hibernating-session-override',
        userId: USER_ID,
        service: 'gmail',
        actionId: 'draft.create',
        mode: 'allow',
        lifetime: 'session',
        sessionId: SESSION_ID,
        source: 'approval_prompt',
      });

      await updateSessionStatus(db as any, SESSION_ID, 'hibernated');

      const override = await getUserActionPolicyOverride(db as any, 'hibernating-session-override');
      expect(override?.expiresAt).toBeNull();
    });
  });
});
