import { beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { Env, Variables } from '../env.js';
import { errorHandler } from '../middleware/error-handler.js';
import { createTestDb } from '../test-utils/db.js';
import { users } from '../lib/schema/users.js';
import { actionPolicyOverridesRouter } from './action-policy-overrides.js';
import {
  getActionPolicy,
  listUserDurableActionPolicies,
  upsertActionPolicy,
} from '../lib/db/actions.js';
import { upsertMcpToolCache } from '../lib/db/mcp-tool-cache.js';

const USER_ID = 'route-user';
const OTHER_USER_ID = 'route-other-user';

function buildApp(db: ReturnType<typeof createTestDb>['db']) {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    (c as any).set('user', { id: USER_ID, email: 'route-user@example.com', role: 'member' } as any);
    (c as any).set('db', db as any);
    (c as any).set('requestId', 'req-action-policy-overrides');
    await next();
  });
  app.route('/', actionPolicyOverridesRouter);
  return app;
}

async function upsertUserDurableGrant(
  db: ReturnType<typeof createTestDb>['db'],
  data: {
    id: string;
    userId: string;
    service?: string | null;
    actionId?: string | null;
    riskLevel?: string | null;
    mode: 'allow' | 'require_approval' | 'deny';
  },
) {
  await upsertActionPolicy(db as any, {
    id: data.id,
    service: data.service,
    actionId: data.actionId,
    riskLevel: data.riskLevel,
    mode: data.mode,
    managedBy: 'user',
    principalType: 'user',
    principalId: data.userId,
    subjectType: 'tool_action',
    createdBy: data.userId,
  });
}

describe('actionPolicyOverridesRouter', () => {
  let db: ReturnType<typeof createTestDb>['db'];
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    ({ db } = createTestDb());
    db.insert(users).values([
      { id: USER_ID, email: 'route-user@example.com' },
      { id: OTHER_USER_ID, email: 'route-other@example.com' },
    ]).run();
    app = buildApp(db);
  });

  it('lists only the current user’s grants', async () => {
    await upsertUserDurableGrant(db, {
      id: 'mine',
      userId: USER_ID,
      service: 'gmail',
      mode: 'allow',
    });
    await upsertUserDurableGrant(db, {
      id: 'theirs',
      userId: OTHER_USER_ID,
      service: 'linear',
      mode: 'deny',
    });

    const res = await app.fetch(new Request('http://localhost/'), { DB: {} } as any);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject([
      { id: 'mine', userId: USER_ID, service: 'gmail' },
    ]);
  });

  it('creates action, service, and risk-level user allow grants', async () => {
    const actionRes = await app.fetch(new Request('http://localhost/action-override', {
      method: 'PUT',
      body: JSON.stringify({ service: 'gmail', actionId: 'draft.create', mode: 'allow' }),
      headers: { 'content-type': 'application/json' },
    }), { DB: {} } as any);
    const serviceRes = await app.fetch(new Request('http://localhost/service-override', {
      method: 'PUT',
      body: JSON.stringify({ service: 'linear', mode: 'allow' }),
      headers: { 'content-type': 'application/json' },
    }), { DB: {} } as any);
    const riskRes = await app.fetch(new Request('http://localhost/risk-override', {
      method: 'PUT',
      body: JSON.stringify({ riskLevel: 'critical', mode: 'allow' }),
      headers: { 'content-type': 'application/json' },
    }), { DB: {} } as any);

    expect(actionRes.status).toBe(200);
    expect(serviceRes.status).toBe(200);
    expect(riskRes.status).toBe(200);

    const rows = await listUserDurableActionPolicies(db as any, USER_ID);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'action-override', service: 'gmail', actionId: 'draft.create', mode: 'allow', managedBy: 'user' }),
      expect.objectContaining({ id: 'service-override', service: 'linear', actionId: null, mode: 'allow', managedBy: 'user' }),
      expect.objectContaining({ id: 'risk-override', riskLevel: 'critical', mode: 'allow', managedBy: 'user' }),
    ]));
  });

  it('rejects user policies with non-allow modes per spec safety rule', async () => {
    const denyRes = await app.fetch(new Request('http://localhost/user-deny', {
      method: 'PUT',
      body: JSON.stringify({ service: 'linear', mode: 'deny' }),
      headers: { 'content-type': 'application/json' },
    }), { DB: {} } as any);
    const requireRes = await app.fetch(new Request('http://localhost/user-require', {
      method: 'PUT',
      body: JSON.stringify({ service: 'gmail', mode: 'require_approval' }),
      headers: { 'content-type': 'application/json' },
    }), { DB: {} } as any);

    expect(denyRes.status).toBe(400);
    expect(requireRes.status).toBe(400);
    expect(await getActionPolicy(db as any, 'user-deny')).toBeUndefined();
    expect(await getActionPolicy(db as any, 'user-require')).toBeUndefined();
  });

  it('rejects invalid target combinations', async () => {
    const actionWithoutService = await app.fetch(new Request('http://localhost/bad-action', {
      method: 'PUT',
      body: JSON.stringify({ actionId: 'draft.create', mode: 'allow' }),
      headers: { 'content-type': 'application/json' },
    }), { DB: {} } as any);
    const serviceAndRisk = await app.fetch(new Request('http://localhost/bad-combo', {
      method: 'PUT',
      body: JSON.stringify({ service: 'gmail', riskLevel: 'medium', mode: 'allow' }),
      headers: { 'content-type': 'application/json' },
    }), { DB: {} } as any);
    const noTarget = await app.fetch(new Request('http://localhost/bad-empty', {
      method: 'PUT',
      body: JSON.stringify({ mode: 'allow' }),
      headers: { 'content-type': 'application/json' },
    }), { DB: {} } as any);

    expect(actionWithoutService.status).toBe(400);
    expect(serviceAndRisk.status).toBe(400);
    expect(noTarget.status).toBe(400);
  });

  it('rejects exact-action allow when an admin policy denies the action', async () => {
    await upsertActionPolicy(db as any, {
      id: 'org-deny-gmail-draft',
      service: 'gmail',
      actionId: 'draft.create',
      mode: 'deny',
      createdBy: USER_ID,
    });

    const res = await app.fetch(new Request('http://localhost/rejected', {
      method: 'PUT',
      body: JSON.stringify({ service: 'gmail', actionId: 'draft.create', mode: 'allow' }),
      headers: { 'content-type': 'application/json' },
    }), { DB: {} } as any);

    expect(res.status).toBe(400);
    expect(await getActionPolicy(db as any, 'rejected')).toBeUndefined();
  });

  it('allows service-scope allow even when admin policy denies the service', async () => {
    await upsertActionPolicy(db as any, {
      id: 'org-deny-gmail',
      service: 'gmail',
      mode: 'deny',
      createdBy: USER_ID,
    });

    const res = await app.fetch(new Request('http://localhost/rejected-service', {
      method: 'PUT',
      body: JSON.stringify({ service: 'gmail', mode: 'allow' }),
      headers: { 'content-type': 'application/json' },
    }), { DB: {} } as any);

    expect(res.status).toBe(200);
    expect(await getActionPolicy(db as any, 'rejected-service')).toMatchObject({
      id: 'rejected-service',
      principalId: USER_ID,
      managedBy: 'user',
      service: 'gmail',
      actionId: null,
      riskLevel: null,
      mode: 'allow',
    });
  });

  it('allows risk-scope allow even when admin policy denies the risk level', async () => {
    await upsertActionPolicy(db as any, {
      id: 'org-deny-critical',
      riskLevel: 'critical',
      mode: 'deny',
      createdBy: USER_ID,
    });

    const res = await app.fetch(new Request('http://localhost/rejected-risk', {
      method: 'PUT',
      body: JSON.stringify({ riskLevel: 'critical', mode: 'allow' }),
      headers: { 'content-type': 'application/json' },
    }), { DB: {} } as any);

    expect(res.status).toBe(200);
    expect(await getActionPolicy(db as any, 'rejected-risk')).toMatchObject({
      id: 'rejected-risk',
      principalId: USER_ID,
      managedBy: 'user',
      service: null,
      actionId: null,
      riskLevel: 'critical',
      mode: 'allow',
    });
  });

  it('rejects exact-action allow when admin policy denies the action risk level', async () => {
    await upsertActionPolicy(db as any, {
      id: 'org-deny-high',
      riskLevel: 'high',
      mode: 'deny',
      createdBy: USER_ID,
    });

    const res = await app.fetch(new Request('http://localhost/rejected-high-action', {
      method: 'PUT',
      body: JSON.stringify({ service: 'github', actionId: 'github.create_repository', mode: 'allow' }),
      headers: { 'content-type': 'application/json' },
    }), { DB: {} } as any);

    expect(res.status).toBe(400);
    expect(await getActionPolicy(db as any, 'rejected-high-action')).toBeUndefined();
  });

  it('rejects exact-action allow when cached MCP metadata puts it under an admin risk deny', async () => {
    await upsertActionPolicy(db as any, {
      id: 'org-deny-critical',
      riskLevel: 'critical',
      mode: 'deny',
      createdBy: USER_ID,
    });
    await upsertMcpToolCache(db as any, [{
      service: 'linear',
      actionId: 'linear.mcp_delete_issue',
      name: 'Delete issue',
      description: 'Delete a Linear issue',
      riskLevel: 'critical',
    }]);

    const res = await app.fetch(new Request('http://localhost/rejected-cached-action', {
      method: 'PUT',
      body: JSON.stringify({ service: 'linear', actionId: 'linear.mcp_delete_issue', mode: 'allow' }),
      headers: { 'content-type': 'application/json' },
    }), { DB: {} } as any);

    expect(res.status).toBe(400);
    expect(await getActionPolicy(db as any, 'rejected-cached-action')).toBeUndefined();
  });

  it('allows exact-action allow when only system default would deny', async () => {
    const res = await app.fetch(new Request('http://localhost/critical-allow', {
      method: 'PUT',
      body: JSON.stringify({ service: 'linear', actionId: 'issue.delete', mode: 'allow' }),
      headers: { 'content-type': 'application/json' },
    }), { DB: {} } as any);

    expect(res.status).toBe(200);
    expect(await getActionPolicy(db as any, 'critical-allow')).toMatchObject({
      id: 'critical-allow',
      principalId: USER_ID,
      managedBy: 'user',
      service: 'linear',
      actionId: 'issue.delete',
      mode: 'allow',
    });
  });

  it('does not delete another user’s grant', async () => {
    await upsertUserDurableGrant(db, {
      id: 'theirs',
      userId: OTHER_USER_ID,
      service: 'gmail',
      mode: 'deny',
    });

    const res = await app.fetch(new Request('http://localhost/theirs', {
      method: 'DELETE',
    }), { DB: {} } as any);

    expect(res.status).toBe(404);
    expect(await getActionPolicy(db as any, 'theirs')).toMatchObject({
      id: 'theirs',
      principalId: OTHER_USER_ID,
    });
  });

  it('does not update another user’s grant via id collision', async () => {
    await upsertUserDurableGrant(db, {
      id: 'theirs',
      userId: OTHER_USER_ID,
      service: 'gmail',
      mode: 'deny',
    });

    const res = await app.fetch(new Request('http://localhost/theirs', {
      method: 'PUT',
      body: JSON.stringify({ service: 'linear', mode: 'allow' }),
      headers: { 'content-type': 'application/json' },
    }), { DB: {} } as any);

    expect(res.status).toBe(404);
    expect(await getActionPolicy(db as any, 'theirs')).toMatchObject({
      id: 'theirs',
      principalId: OTHER_USER_ID,
      service: 'gmail',
      mode: 'deny',
    });
  });

  it('returns the existing grant id when upserting a duplicate target', async () => {
    await upsertUserDurableGrant(db, {
      id: 'existing-service-override',
      userId: USER_ID,
      service: 'gmail',
      mode: 'require_approval',
    });

    const res = await app.fetch(new Request('http://localhost/new-service-override-id', {
      method: 'PUT',
      body: JSON.stringify({ service: 'gmail', mode: 'allow' }),
      headers: { 'content-type': 'application/json' },
    }), { DB: {} } as any);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, id: 'existing-service-override' });
    expect(await getActionPolicy(db as any, 'new-service-override-id')).toBeUndefined();
    expect(await getActionPolicy(db as any, 'existing-service-override')).toMatchObject({
      mode: 'allow',
    });
  });
});
