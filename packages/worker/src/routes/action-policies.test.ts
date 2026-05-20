import { beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { Env, Variables } from '../env.js';
import { errorHandler } from '../middleware/error-handler.js';
import { createTestDb } from '../test-utils/db.js';
import { users } from '../lib/schema/users.js';
import { listActionPolicies } from '../lib/db/actions.js';
import { actionPoliciesRouter } from './action-policies.js';

const ADMIN_ID = 'admin-user';

function buildApp(db: ReturnType<typeof createTestDb>['db']) {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    (c as any).set('user', { id: ADMIN_ID, email: 'admin@example.com', role: 'admin' } as any);
    (c as any).set('db', db as any);
    (c as any).set('requestId', 'req-action-policies');
    await next();
  });
  app.route('/', actionPoliciesRouter);
  return app;
}

describe('actionPoliciesRouter', () => {
  let db: ReturnType<typeof createTestDb>['db'];
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    ({ db } = createTestDb());
    db.insert(users).values({ id: ADMIN_ID, email: 'admin@example.com' }).run();
    app = buildApp(db);
  });

  it('rejects org policy targets that runtime policy resolution cannot match', async () => {
    const serviceAndRisk = await app.fetch(new Request('http://localhost/bad-service-risk', {
      method: 'PUT',
      body: JSON.stringify({ service: 'gmail', riskLevel: 'critical', mode: 'deny' }),
      headers: { 'content-type': 'application/json' },
    }), { DB: {} } as any);
    const actionAndRisk = await app.fetch(new Request('http://localhost/bad-action-risk', {
      method: 'PUT',
      body: JSON.stringify({ service: 'gmail', actionId: 'draft.create', riskLevel: 'critical', mode: 'deny' }),
      headers: { 'content-type': 'application/json' },
    }), { DB: {} } as any);

    expect(serviceAndRisk.status).toBe(400);
    expect(actionAndRisk.status).toBe(400);
    expect(await listActionPolicies(db as any)).toEqual([]);
  });

  it('allows exact action, service, and risk-only org policy targets', async () => {
    const action = await app.fetch(new Request('http://localhost/action', {
      method: 'PUT',
      body: JSON.stringify({ service: 'gmail', actionId: 'draft.create', mode: 'deny' }),
      headers: { 'content-type': 'application/json' },
    }), { DB: {} } as any);
    const service = await app.fetch(new Request('http://localhost/service', {
      method: 'PUT',
      body: JSON.stringify({ service: 'linear', mode: 'require_approval' }),
      headers: { 'content-type': 'application/json' },
    }), { DB: {} } as any);
    const risk = await app.fetch(new Request('http://localhost/risk', {
      method: 'PUT',
      body: JSON.stringify({ riskLevel: 'critical', mode: 'deny' }),
      headers: { 'content-type': 'application/json' },
    }), { DB: {} } as any);

    expect(action.status).toBe(200);
    expect(service.status).toBe(200);
    expect(risk.status).toBe(200);
    expect(await listActionPolicies(db as any)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'action', service: 'gmail', actionId: 'draft.create' }),
      expect.objectContaining({ id: 'service', service: 'linear', actionId: null, riskLevel: null }),
      expect.objectContaining({ id: 'risk', service: null, actionId: null, riskLevel: 'critical' }),
    ]));
  });
});
