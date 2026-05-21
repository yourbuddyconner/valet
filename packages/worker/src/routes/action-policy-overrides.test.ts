import { beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { Env, Variables } from '../env.js';
import { errorHandler } from '../middleware/error-handler.js';
import { createTestDb } from '../test-utils/db.js';
import { users } from '../lib/schema/users.js';
import { actionPolicyOverridesRouter } from './action-policy-overrides.js';
import {
  getUserActionPolicyOverride,
  listUserActionPolicyOverrides,
  upsertActionPolicy,
  upsertUserActionPolicyOverride,
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

  it('lists only current user overrides', async () => {
    await upsertUserActionPolicyOverride(db as any, {
      id: 'mine',
      userId: USER_ID,
      service: 'gmail',
      mode: 'allow',
      source: 'settings',
    });
    await upsertUserActionPolicyOverride(db as any, {
      id: 'theirs',
      userId: OTHER_USER_ID,
      service: 'linear',
      mode: 'deny',
      source: 'settings',
    });

    const res = await app.fetch(new Request('http://localhost/'), { DB: {} } as any);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject([
      { id: 'mine', userId: USER_ID, service: 'gmail' },
    ]);
  });

  it('creates persistent action, service, and risk-level overrides', async () => {
    const actionRes = await app.fetch(new Request('http://localhost/action-override', {
      method: 'PUT',
      body: JSON.stringify({ service: 'gmail', actionId: 'draft.create', mode: 'allow' }),
      headers: { 'content-type': 'application/json' },
    }), { DB: {} } as any);
    const serviceRes = await app.fetch(new Request('http://localhost/service-override', {
      method: 'PUT',
      body: JSON.stringify({ service: 'linear', mode: 'require_approval' }),
      headers: { 'content-type': 'application/json' },
    }), { DB: {} } as any);
    const riskRes = await app.fetch(new Request('http://localhost/risk-override', {
      method: 'PUT',
      body: JSON.stringify({ riskLevel: 'critical', mode: 'deny' }),
      headers: { 'content-type': 'application/json' },
    }), { DB: {} } as any);

    expect(actionRes.status).toBe(200);
    expect(serviceRes.status).toBe(200);
    expect(riskRes.status).toBe(200);

    const rows = await listUserActionPolicyOverrides(db as any, USER_ID);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'action-override', service: 'gmail', actionId: 'draft.create', mode: 'allow', lifetime: 'persistent' }),
      expect.objectContaining({ id: 'service-override', service: 'linear', actionId: null, mode: 'require_approval', lifetime: 'persistent' }),
      expect.objectContaining({ id: 'risk-override', riskLevel: 'critical', mode: 'deny', lifetime: 'persistent' }),
    ]));
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

  it('rejects exact-action allow when explicit org policy denies the action', async () => {
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
    expect(await getUserActionPolicyOverride(db as any, 'rejected')).toBeUndefined();
  });

  it('allows service-scope allow even when organization policy denies the service', async () => {
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
    expect(await getUserActionPolicyOverride(db as any, 'rejected-service')).toMatchObject({
      id: 'rejected-service',
      userId: USER_ID,
      service: 'gmail',
      actionId: null,
      riskLevel: null,
      mode: 'allow',
    });
  });

  it('allows risk-scope allow even when organization policy denies the risk level', async () => {
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
    expect(await getUserActionPolicyOverride(db as any, 'rejected-risk')).toMatchObject({
      id: 'rejected-risk',
      userId: USER_ID,
      service: null,
      actionId: null,
      riskLevel: 'critical',
      mode: 'allow',
    });
  });

  it('rejects exact-action allow when organization policy denies the action risk level', async () => {
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
    expect(await getUserActionPolicyOverride(db as any, 'rejected-high-action')).toBeUndefined();
  });

  it('rejects exact-action allow when cached MCP metadata puts it under an organization risk deny', async () => {
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
    expect(await getUserActionPolicyOverride(db as any, 'rejected-cached-action')).toBeUndefined();
  });

  it('allows exact-action allow when only system default would deny', async () => {
    const res = await app.fetch(new Request('http://localhost/critical-allow', {
      method: 'PUT',
      body: JSON.stringify({ service: 'linear', actionId: 'issue.delete', mode: 'allow' }),
      headers: { 'content-type': 'application/json' },
    }), { DB: {} } as any);

    expect(res.status).toBe(200);
    expect(await getUserActionPolicyOverride(db as any, 'critical-allow')).toMatchObject({
      id: 'critical-allow',
      userId: USER_ID,
      service: 'linear',
      actionId: 'issue.delete',
      mode: 'allow',
      lifetime: 'persistent',
    });
  });

  it('does not delete another user override', async () => {
    await upsertUserActionPolicyOverride(db as any, {
      id: 'theirs',
      userId: OTHER_USER_ID,
      service: 'gmail',
      mode: 'deny',
      source: 'settings',
    });

    const res = await app.fetch(new Request('http://localhost/theirs', {
      method: 'DELETE',
    }), { DB: {} } as any);

    expect(res.status).toBe(404);
    expect(await getUserActionPolicyOverride(db as any, 'theirs')).toMatchObject({
      id: 'theirs',
      userId: OTHER_USER_ID,
    });
  });

  it('does not update another user override by id collision', async () => {
    await upsertUserActionPolicyOverride(db as any, {
      id: 'theirs',
      userId: OTHER_USER_ID,
      service: 'gmail',
      mode: 'deny',
      source: 'settings',
    });

    const res = await app.fetch(new Request('http://localhost/theirs', {
      method: 'PUT',
      body: JSON.stringify({ service: 'linear', mode: 'allow' }),
      headers: { 'content-type': 'application/json' },
    }), { DB: {} } as any);

    expect(res.status).toBe(404);
    expect(await getUserActionPolicyOverride(db as any, 'theirs')).toMatchObject({
      id: 'theirs',
      userId: OTHER_USER_ID,
      service: 'gmail',
      mode: 'deny',
    });
  });

  it('returns the existing override id when upserting a duplicate target', async () => {
    await upsertUserActionPolicyOverride(db as any, {
      id: 'existing-service-override',
      userId: USER_ID,
      service: 'gmail',
      mode: 'require_approval',
      source: 'settings',
    });

    const res = await app.fetch(new Request('http://localhost/new-service-override-id', {
      method: 'PUT',
      body: JSON.stringify({ service: 'gmail', mode: 'allow' }),
      headers: { 'content-type': 'application/json' },
    }), { DB: {} } as any);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, id: 'existing-service-override' });
    expect(await getUserActionPolicyOverride(db as any, 'new-service-override-id')).toBeUndefined();
    expect(await getUserActionPolicyOverride(db as any, 'existing-service-override')).toMatchObject({
      mode: 'allow',
    });
  });
});
