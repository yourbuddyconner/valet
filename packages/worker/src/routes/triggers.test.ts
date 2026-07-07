import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env, Variables } from '../env.js';
import { errorHandler } from '../middleware/error-handler.js';

const {
  listTriggersMock,
  getTriggerMock,
  getWorkflowForTriggerMock,
  checkWebhookPathUniquenessMock,
  createTriggerMock,
  getTriggerForUpdateMock,
  updateTriggerMock,
  getWebhookTriggerByIdMock,
  bumpWebhookRateCountMock,
  dispatchWebhookForTriggerMock,
} = vi.hoisted(() => ({
  listTriggersMock: vi.fn(),
  getTriggerMock: vi.fn(),
  getWorkflowForTriggerMock: vi.fn(),
  checkWebhookPathUniquenessMock: vi.fn(),
  createTriggerMock: vi.fn(),
  getTriggerForUpdateMock: vi.fn(),
  updateTriggerMock: vi.fn(),
  getWebhookTriggerByIdMock: vi.fn(),
  bumpWebhookRateCountMock: vi.fn(),
  dispatchWebhookForTriggerMock: vi.fn(),
}));

vi.mock('../lib/db.js', () => ({
  scheduleTarget: () => 'workflow',
  requiresWorkflow: (cfg: any) => cfg?.type !== 'schedule',
  listTriggers: listTriggersMock,
  getTrigger: getTriggerMock,
  getWorkflowForTrigger: getWorkflowForTriggerMock,
  checkWebhookPathUniqueness: checkWebhookPathUniquenessMock,
  createTrigger: createTriggerMock,
  generateWebhookToken: () => 'test-token-1234567890abcdef1234567890ab',
  getTriggerForUpdate: getTriggerForUpdateMock,
  updateTrigger: updateTriggerMock,
  deleteTrigger: vi.fn(),
  enableTrigger: vi.fn(),
  disableTrigger: vi.fn(),
  getWebhookTriggerById: getWebhookTriggerByIdMock,
  bumpWebhookRateCount: bumpWebhookRateCountMock,
  WEBHOOK_RATE_LIMIT_DEFAULT: 60,
}));

vi.mock('../services/triggers.js', () => ({
  runWorkflowManually: vi.fn(),
  runTrigger: vi.fn(),
}));

vi.mock('../services/webhooks.js', async () => {
  // Re-implement the small helpers; mock the dispatch.
  return {
    verifyTriggerToken: (row: { webhook_token?: string | null }, header: string | undefined) => {
      if (!row.webhook_token || !header) return false;
      if (row.webhook_token.length !== header.length) return false;
      let r = 0;
      for (let i = 0; i < header.length; i++) r |= row.webhook_token.charCodeAt(i) ^ header.charCodeAt(i);
      return r === 0;
    },
    checkWebhookRateLimit: async (_env: Env, triggerId: string, config: { rateLimit?: number }) => {
      const limit = config.rateLimit ?? 60;
      const count = await bumpWebhookRateCountMock(triggerId);
      return { allowed: count <= limit, count, limit, retryAfter: 60 };
    },
    dispatchWebhookForTrigger: dispatchWebhookForTriggerMock,
  };
});

import { triggersRouter } from './triggers.js';

function buildApp() {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    (c as any).set('user', { id: 'user-1', email: 'user@example.com', role: 'user' });
    (c as any).set('db', {} as any);
    (c as any).set('requestId', 'req-test');
    await next();
  });
  app.route('/', triggersRouter);
  return app;
}

const baseEnv = { DB: {} } as any;

describe('triggersRouter create + read (webhook token handling)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getWorkflowForTriggerMock.mockResolvedValue({ id: 'wf-1' });
    checkWebhookPathUniquenessMock.mockResolvedValue(null);
    createTriggerMock.mockResolvedValue(undefined);
  });

  it('POST /api/triggers returns the webhook token exactly once on create', async () => {
    const res = await buildApp().fetch(
      new Request('http://localhost/', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workflowId: 'wf-1',
          name: 'hook-1',
          enabled: true,
          config: { type: 'webhook', path: 'hook-1' },
        }),
      }),
      baseEnv,
    );

    expect(res.status).toBe(201);
    const body = await res.json() as Record<string, unknown>;
    expect(body.webhookToken).toBe('test-token-1234567890abcdef1234567890ab');
    expect(body.webhookUrl).toMatch(/\/api\/triggers\/[^/]+\/webhook$/);
    // /api/triggers/:id/webhook is the surfaced URL; the API does not
    // include a path-based fallback URL in its response.
    expect(body.legacyWebhookUrl).toBeUndefined();

    expect(createTriggerMock).toHaveBeenCalledTimes(1);
    const call = createTriggerMock.mock.calls[0][1];
    expect(call.webhookToken).toBe('test-token-1234567890abcdef1234567890ab');
  });

  it('GET /api/triggers does NOT echo webhook_token', async () => {
    listTriggersMock.mockResolvedValue({
      results: [{
        id: 'tr-1',
        workflow_id: 'wf-1',
        workflow_name: 'hooks',
        name: 'hook-1',
        enabled: 1,
        type: 'webhook',
        config: JSON.stringify({ type: 'webhook', path: 'p' }),
        variable_mapping: null,
        last_run_at: null,
        created_at: '2026-06-15T00:00:00Z',
        updated_at: '2026-06-15T00:00:00Z',
        webhook_token: 'secret-should-not-leak',
      }],
    });

    const res = await buildApp().fetch(new Request('http://localhost/'), baseEnv);
    expect(res.status).toBe(200);
    const body = await res.json() as { triggers: Record<string, unknown>[] };
    expect(JSON.stringify(body)).not.toContain('secret-should-not-leak');
    expect(body.triggers[0].webhookToken).toBeUndefined();
  });

  it('GET /api/triggers/:id does NOT echo webhook_token', async () => {
    getTriggerMock.mockResolvedValue({
      id: 'tr-1',
      workflow_id: 'wf-1',
      workflow_name: 'hooks',
      name: 'hook-1',
      enabled: 1,
      type: 'webhook',
      config: JSON.stringify({ type: 'webhook', path: 'p' }),
      variable_mapping: null,
      last_run_at: null,
      created_at: '2026-06-15T00:00:00Z',
      updated_at: '2026-06-15T00:00:00Z',
      webhook_token: 'secret-should-not-leak',
    });

    const res = await buildApp().fetch(new Request('http://localhost/tr-1'), baseEnv);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('secret-should-not-leak');
    const body = JSON.parse(text);
    expect(body.trigger.webhookToken).toBeUndefined();
    expect(body.trigger.webhookUrl).toMatch(/\/api\/triggers\/tr-1\/webhook$/);
    expect(body.trigger.legacyWebhookUrl).toBeUndefined();
  });
});

describe('triggersRouter POST /:triggerId/webhook (auth + rate limit)', () => {
  const webhookRow = {
    id: 'tr-1',
    workflow_id: 'wf-1',
    workflow_name: 'hooks',
    user_id: 'user-1',
    version: '1.0.0',
    data: '{}',
    config: JSON.stringify({ type: 'webhook', path: 'hook-1', method: 'POST' }),
    variable_mapping: null,
    webhook_token: 'good-token',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    getWebhookTriggerByIdMock.mockResolvedValue(webhookRow);
    bumpWebhookRateCountMock.mockResolvedValue(1);
    dispatchWebhookForTriggerMock.mockResolvedValue({
      result: { received: true, dispatched: true, executionId: 'exec-1', message: 'ok' },
      statusCode: 200,
    });
  });

  it('rejects with 401 when token is missing', async () => {
    const res = await buildApp().fetch(
      new Request('http://localhost/tr-1/webhook', { method: 'POST', body: '{}' }),
      baseEnv,
    );
    expect(res.status).toBe(401);
    expect(dispatchWebhookForTriggerMock).not.toHaveBeenCalled();
  });

  it('rejects with 401 when token is wrong', async () => {
    const res = await buildApp().fetch(
      new Request('http://localhost/tr-1/webhook', {
        method: 'POST',
        headers: { 'X-Valet-Trigger-Token': 'wrong-token' },
        body: '{}',
      }),
      baseEnv,
    );
    expect(res.status).toBe(401);
    expect(dispatchWebhookForTriggerMock).not.toHaveBeenCalled();
  });

  it('accepts with valid token + headers and dispatches', async () => {
    const res = await buildApp().fetch(
      new Request('http://localhost/tr-1/webhook', {
        method: 'POST',
        headers: { 'X-Valet-Trigger-Token': 'good-token', 'content-type': 'application/json' },
        body: JSON.stringify({ hello: 'world' }),
      }),
      baseEnv,
    );
    expect(res.status).toBe(200);
    expect(dispatchWebhookForTriggerMock).toHaveBeenCalledTimes(1);
  });

  it('returns 429 with Retry-After when over rate limit', async () => {
    bumpWebhookRateCountMock.mockResolvedValue(61); // > default 60
    const res = await buildApp().fetch(
      new Request('http://localhost/tr-1/webhook', {
        method: 'POST',
        headers: { 'X-Valet-Trigger-Token': 'good-token' },
        body: '{}',
      }),
      baseEnv,
    );
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBeDefined();
    expect(dispatchWebhookForTriggerMock).not.toHaveBeenCalled();
  });

  it('returns 404 for unknown trigger', async () => {
    getWebhookTriggerByIdMock.mockResolvedValue(null);
    const res = await buildApp().fetch(
      new Request('http://localhost/missing/webhook', {
        method: 'POST',
        headers: { 'X-Valet-Trigger-Token': 'good-token' },
        body: '{}',
      }),
      baseEnv,
    );
    expect(res.status).toBe(404);
  });

  it('forwards full request headers (not just the five x-* signature/delivery ones)', async () => {
    const res = await buildApp().fetch(
      new Request('http://localhost/tr-1/webhook', {
        method: 'POST',
        headers: {
          'X-Valet-Trigger-Token': 'good-token',
          'content-type': 'application/json',
          'x-custom-trace': 'abc-123',
        },
        body: JSON.stringify({ hi: 1 }),
      }),
      baseEnv,
    );
    expect(res.status).toBe(200);
    expect(dispatchWebhookForTriggerMock).toHaveBeenCalledTimes(1);
    const headersArg = dispatchWebhookForTriggerMock.mock.calls[0][5] as Record<string, string>;
    // Workflows reference headers via {{trigger.data.headers.X}} — they
    // need the full request, not just signature/delivery selectors.
    expect(headersArg['content-type']).toBe('application/json');
    expect(headersArg['x-custom-trace']).toBe('abc-123');
  });

  it('forwards distinct query strings so GET deliveries do not collapse into one idempotency key', async () => {
    // The route just passes `query` through to the service; the service
    // hashes (method, signature, body, canonicalQuery) into the
    // idempotency fallback. This guards the route side: different
    // ?id=N values reach the service as distinct query maps.
    const a = await buildApp().fetch(
      new Request('http://localhost/tr-1/webhook?id=1', {
        method: 'POST',
        headers: { 'X-Valet-Trigger-Token': 'good-token' },
        body: '{}',
      }),
      baseEnv,
    );
    const b = await buildApp().fetch(
      new Request('http://localhost/tr-1/webhook?id=2', {
        method: 'POST',
        headers: { 'X-Valet-Trigger-Token': 'good-token' },
        body: '{}',
      }),
      baseEnv,
    );
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(dispatchWebhookForTriggerMock).toHaveBeenCalledTimes(2);
    const qa = dispatchWebhookForTriggerMock.mock.calls[0][6] as Record<string, string>;
    const qb = dispatchWebhookForTriggerMock.mock.calls[1][6] as Record<string, string>;
    expect(qa).toEqual({ id: '1' });
    expect(qb).toEqual({ id: '2' });
  });
});

describe('triggersRouter webhook auth-middleware bypass', () => {
  // Lock in that POST /api/triggers/:triggerId/webhook is reachable
  // WITHOUT a bearer token when mounted behind the production auth
  // middleware. The middleware has an explicit path bypass at
  // middleware/auth.ts; removing it would silently break every
  // external webhook caller (no logged-in user → 401). Regression
  // catch: a tokenized webhook MUST authenticate via X-Valet-Trigger-Token
  // alone.

  beforeEach(() => {
    vi.clearAllMocks();
    getWebhookTriggerByIdMock.mockResolvedValue({
      id: 'tr-1',
      workflow_id: 'wf-1',
      workflow_name: 'hooks',
      user_id: 'user-1',
      version: '1.0.0',
      data: '{}',
      config: JSON.stringify({ type: 'webhook', path: 'hook-1', method: 'POST' }),
      variable_mapping: null,
      webhook_token: 'good-token',
    });
    bumpWebhookRateCountMock.mockResolvedValue(1);
    dispatchWebhookForTriggerMock.mockResolvedValue({
      result: { received: true, dispatched: true, executionId: 'exec-1', message: 'ok' },
      statusCode: 200,
    });
  });

  async function buildAppWithRealAuth() {
    const { authMiddleware } = await import('../middleware/auth.js');
    const app = new Hono<{ Bindings: Env; Variables: Variables }>();
    app.onError(errorHandler);
    app.use('/api/*', authMiddleware);
    app.route('/api/triggers', triggersRouter);
    return app;
  }

  it('passes auth middleware with token only (no Authorization header)', async () => {
    const app = await buildAppWithRealAuth();
    const res = await app.fetch(
      new Request('http://localhost/api/triggers/tr-1/webhook', {
        method: 'POST',
        headers: { 'X-Valet-Trigger-Token': 'good-token' },
        body: '{}',
      }),
      baseEnv,
    );
    expect(res.status).toBe(200);
    expect(dispatchWebhookForTriggerMock).toHaveBeenCalledTimes(1);
  });

  it('returns 401 from the handler (not middleware) when token is wrong', async () => {
    const app = await buildAppWithRealAuth();
    const res = await app.fetch(
      new Request('http://localhost/api/triggers/tr-1/webhook', {
        method: 'POST',
        headers: { 'X-Valet-Trigger-Token': 'wrong-token' },
        body: '{}',
      }),
      baseEnv,
    );
    expect(res.status).toBe(401);
    expect(dispatchWebhookForTriggerMock).not.toHaveBeenCalled();
  });
});

describe('triggersRouter PATCH /:id — webhook_token lifecycle on type transitions', () => {
  // The /api/triggers/:id/webhook handler rejects any row with a null
  // webhook_token. Editing a manual/schedule trigger INTO a webhook via
  // PATCH must mint a token here, otherwise the new endpoint returns 401
  // forever and the only recovery is delete-and-recreate.

  beforeEach(() => {
    vi.clearAllMocks();
    getWorkflowForTriggerMock.mockResolvedValue({ id: 'wf-1' });
    checkWebhookPathUniquenessMock.mockResolvedValue(null);
    updateTriggerMock.mockResolvedValue(undefined);
  });

  it('mints a webhook_token + returns it in the response when manual → webhook', async () => {
    getTriggerForUpdateMock.mockResolvedValue({
      type: 'manual',
      config: JSON.stringify({ type: 'manual' }),
      workflow_id: 'wf-1',
      webhook_token: null,
    });

    const res = await buildApp().fetch(
      new Request('http://localhost/tr-1', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workflowId: 'wf-1',
          config: { type: 'webhook', path: 'incoming/foo', method: 'POST' },
        }),
      }),
      baseEnv,
    );

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.webhookToken).toBe('test-token-1234567890abcdef1234567890ab');
    expect(body.webhookUrl).toMatch(/\/api\/triggers\/tr-1\/webhook$/);
    expect(body.legacyWebhookUrl).toBeUndefined();

    // updateTrigger receives the SET clause + values arrays. Verify the
    // webhook_token column is in the SET clause and the minted value is
    // bound (not null).
    expect(updateTriggerMock).toHaveBeenCalledTimes(1);
    const [, , , updates, values] = updateTriggerMock.mock.calls[0] as [unknown, unknown, unknown, string[], unknown[]];
    expect(updates).toContain('webhook_token = ?');
    const tokenValue = values[updates.indexOf('webhook_token = ?')];
    expect(tokenValue).toBe('test-token-1234567890abcdef1234567890ab');
  });

  it('clears webhook_token when webhook → manual (reverse transition)', async () => {
    getTriggerForUpdateMock.mockResolvedValue({
      type: 'webhook',
      config: JSON.stringify({ type: 'webhook', path: 'incoming/foo' }),
      workflow_id: 'wf-1',
      webhook_token: 'existing-token-value',
    });

    const res = await buildApp().fetch(
      new Request('http://localhost/tr-1', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workflowId: 'wf-1',
          config: { type: 'manual' },
        }),
      }),
      baseEnv,
    );

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    // No token in the response on the clear path.
    expect(body.webhookToken).toBeUndefined();

    expect(updateTriggerMock).toHaveBeenCalledTimes(1);
    const [, , , updates, values] = updateTriggerMock.mock.calls[0] as [unknown, unknown, unknown, string[], unknown[]];
    expect(updates).toContain('webhook_token = ?');
    const tokenValue = values[updates.indexOf('webhook_token = ?')];
    expect(tokenValue).toBeNull();
  });

  it('does NOT touch webhook_token when type is unchanged', async () => {
    getTriggerForUpdateMock.mockResolvedValue({
      type: 'webhook',
      config: JSON.stringify({ type: 'webhook', path: 'incoming/foo' }),
      workflow_id: 'wf-1',
      webhook_token: 'existing-token-value',
    });

    const res = await buildApp().fetch(
      new Request('http://localhost/tr-1', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          // Same type, just a path tweak. Don't mint, don't clear.
          config: { type: 'webhook', path: 'incoming/foo-renamed' },
        }),
      }),
      baseEnv,
    );

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.webhookToken).toBeUndefined();

    expect(updateTriggerMock).toHaveBeenCalledTimes(1);
    const [, , , updates] = updateTriggerMock.mock.calls[0] as [unknown, unknown, unknown, string[], unknown[]];
    expect(updates).not.toContain('webhook_token = ?');
  });
});

describe('triggersRouter rejects legacy repo* run fields', () => {
  it('POST /manual/run rejects repoUrl as an unrecognized key', async () => {
    const res = await buildApp().fetch(
      new Request('http://localhost/manual/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workflowId: 'wf-1',
          repoUrl: 'https://github.com/foo/bar',
        }),
      }),
      baseEnv,
    );
    expect(res.status).toBe(400);
  });

  it.each(['branch', 'ref', 'sourceRepoFullName'] as const)(
    'POST /manual/run rejects %s as an unrecognized key',
    async (field) => {
      const res = await buildApp().fetch(
        new Request('http://localhost/manual/run', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ workflowId: 'wf-1', [field]: 'value' }),
        }),
        baseEnv,
      );
      expect(res.status).toBe(400);
    },
  );

  it.each(['repoUrl', 'branch', 'ref', 'sourceRepoFullName'] as const)(
    'POST /:id/run rejects %s while still allowing passthrough fields used by variableMapping',
    async (field) => {
      const res = await buildApp().fetch(
        new Request('http://localhost/tr-1/run', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ [field]: 'value' }),
        }),
        baseEnv,
      );
      expect(res.status).toBe(400);
    },
  );
});
