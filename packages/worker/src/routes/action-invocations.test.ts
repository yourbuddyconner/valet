import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env, Variables } from '../env.js';
import { errorHandler } from '../middleware/error-handler.js';
import { createTestDb } from '../test-utils/db.js';
import { users } from '../lib/schema/users.js';
import { sessions } from '../lib/schema/sessions.js';
import { createInvocation, getInvocation } from '../lib/db/actions.js';
import { actionInvocationsRouter } from './action-invocations.js';

const USER_ID = 'route-user';
const SESSION_ID = 'session-approval';

function buildApp(db: ReturnType<typeof createTestDb>['db']) {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    (c as any).set('user', { id: USER_ID, email: 'route-user@example.com', role: 'member' } as any);
    (c as any).set('db', db as any);
    (c as any).set('requestId', 'req-action-invocations');
    await next();
  });
  app.route('/', actionInvocationsRouter);
  return app;
}

function buildEnv(fetch: ReturnType<typeof vi.fn>) {
  return {
    SESSIONS: {
      idFromName: vi.fn(() => 'session-do-id'),
      get: vi.fn(() => ({ fetch })),
    },
  } as unknown as Env;
}

describe('actionInvocationsRouter approval resolution', () => {
  let db: ReturnType<typeof createTestDb>['db'];
  let app: ReturnType<typeof buildApp>;

  beforeEach(async () => {
    ({ db } = createTestDb());
    db.insert(users).values({ id: USER_ID, email: 'route-user@example.com' }).run();
    db.insert(sessions).values({
      id: SESSION_ID,
      userId: USER_ID,
      workspace: '/tmp/action-invocations-route-test',
      status: 'running',
    }).run();
    await createInvocation(db as any, {
      id: 'inv-route',
      sessionId: SESSION_ID,
      userId: USER_ID,
      service: 'gmail',
      actionId: 'draft.create',
      riskLevel: 'medium',
      resolvedMode: 'require_approval',
      status: 'pending',
    });
    app = buildApp(db);
  });

  it('does not mutate D1 when the session agent rejects an approval', async () => {
    const env = buildEnv(vi.fn(async () => new Response(
      JSON.stringify({ error: 'No pending prompt found' }),
      { status: 404, headers: { 'content-type': 'application/json' } },
    )));

    const res = await app.fetch(new Request('http://localhost/inv-route/approve', {
      method: 'POST',
    }), env);

    const invocation = await getInvocation(db as any, 'inv-route');

    expect(res.status).toBe(404);
    expect(invocation).toMatchObject({ status: 'pending', resolvedBy: null });
  });

  it('returns conflict when the session agent reports a stale approval resolution', async () => {
    const env = buildEnv(vi.fn(async () => new Response(
      JSON.stringify({ error: 'This action approval is no longer pending.' }),
      { status: 409, headers: { 'content-type': 'application/json' } },
    )));

    const res = await app.fetch(new Request('http://localhost/inv-route/approve', {
      method: 'POST',
    }), env);

    const invocation = await getInvocation(db as any, 'inv-route');

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: 'This action approval is no longer pending.',
    });
    expect(invocation).toMatchObject({ status: 'pending', resolvedBy: null });
  });

  it('preserves expired prompt status from the session agent', async () => {
    const env = buildEnv(vi.fn(async () => new Response(
      JSON.stringify({ error: 'This prompt has expired.' }),
      { status: 410, headers: { 'content-type': 'application/json' } },
    )));

    const res = await app.fetch(new Request('http://localhost/inv-route/approve', {
      method: 'POST',
    }), env);

    expect(res.status).toBe(410);
    expect(await res.json()).toMatchObject({
      error: 'This prompt has expired.',
    });
  });

  it('preserves invalid approval action status from the session agent', async () => {
    const env = buildEnv(vi.fn(async () => new Response(
      JSON.stringify({ error: 'Unknown approval action: bogus' }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    )));

    const res = await app.fetch(new Request('http://localhost/inv-route/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actionId: 'bogus' }),
    }), env);

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: 'Unknown approval action: bogus',
    });
  });

  it('delegates the selected approval action to the session agent', async () => {
    let body: Record<string, unknown> | undefined;
    const fetch = vi.fn(async (request: Request) => {
      body = await request.json();
      return Response.json({ success: true });
    });

    const res = await app.fetch(new Request('http://localhost/inv-route/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actionId: 'allow_session' }),
    }), buildEnv(fetch));

    const invocation = await getInvocation(db as any, 'inv-route');

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      promptId: 'inv-route',
      actionId: 'allow_session',
      resolvedBy: USER_ID,
    });
    expect(invocation).toMatchObject({ status: 'pending', resolvedBy: null });
  });

  it('rejects cancel actions sent through the approve endpoint', async () => {
    const fetch = vi.fn(async () => Response.json({ success: true }));

    const res = await app.fetch(new Request('http://localhost/inv-route/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actionId: 'cancel' }),
    }), buildEnv(fetch));

    expect(res.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
    expect(await res.json()).toMatchObject({
      error: expect.stringContaining('approve endpoint does not accept cancel action'),
    });
  });

  it('does not mutate D1 when the session agent rejects a denial', async () => {
    const env = buildEnv(vi.fn(async () => new Response(
      JSON.stringify({ error: 'No pending prompt found' }),
      { status: 404, headers: { 'content-type': 'application/json' } },
    )));

    const res = await app.fetch(new Request('http://localhost/inv-route/deny', {
      method: 'POST',
    }), env);

    const invocation = await getInvocation(db as any, 'inv-route');

    expect(res.status).toBe(404);
    expect(invocation).toMatchObject({ status: 'pending', resolvedBy: null });
  });

  it('delegates the selected deny action and reason to the session agent', async () => {
    let body: Record<string, unknown> | undefined;
    const fetch = vi.fn(async (request: Request) => {
      body = await request.json();
      return Response.json({ success: true });
    });

    const res = await app.fetch(new Request('http://localhost/inv-route/deny', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actionId: 'cancel', reason: 'Not right now' }),
    }), buildEnv(fetch));

    const invocation = await getInvocation(db as any, 'inv-route');

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      promptId: 'inv-route',
      actionId: 'cancel',
      value: 'Not right now',
      resolvedBy: USER_ID,
    });
    expect(invocation).toMatchObject({ status: 'pending', resolvedBy: null });
  });

  it('rejects approval actions sent through the deny endpoint', async () => {
    const fetch = vi.fn(async () => Response.json({ success: true }));

    const res = await app.fetch(new Request('http://localhost/inv-route/deny', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actionId: 'allow_session' }),
    }), buildEnv(fetch));

    expect(res.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
    expect(await res.json()).toMatchObject({
      error: expect.stringContaining('deny endpoint does not accept approval action'),
    });
  });
});
