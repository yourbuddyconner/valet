import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../env.js';

// Hoisted mocks. Each test arranges return values via these handles so a single
// vi.mock factory can wire the whole barrel.
const {
  lookupWebhookTriggerMock,
  checkIdempotencyKeyMock,
  createExecutionMock,
  updateTriggerLastRunMock,
  isUniqueConstraintErrorMock,
  recordTriggerDeliveryMock,
  truncatePayloadPreviewMock,
  checkWorkflowConcurrencyMock,
  enqueueWorkflowExecutionMock,
  sha256HexMock,
  createWorkflowSessionMock,
  getDbMock,
} = vi.hoisted(() => ({
  lookupWebhookTriggerMock: vi.fn(),
  checkIdempotencyKeyMock: vi.fn(),
  createExecutionMock: vi.fn(),
  updateTriggerLastRunMock: vi.fn(),
  isUniqueConstraintErrorMock: vi.fn().mockReturnValue(false),
  recordTriggerDeliveryMock: vi.fn(),
  truncatePayloadPreviewMock: vi.fn().mockReturnValue('<preview>'),
  checkWorkflowConcurrencyMock: vi.fn().mockResolvedValue({ allowed: true, activeUser: 0, activeGlobal: 0 }),
  enqueueWorkflowExecutionMock: vi.fn().mockResolvedValue(true),
  sha256HexMock: vi.fn().mockResolvedValue('hash'),
  createWorkflowSessionMock: vi.fn().mockResolvedValue('session-1'),
  getDbMock: vi.fn().mockReturnValue({}),
}));

vi.mock('../lib/db.js', () => ({
  lookupWebhookTrigger: lookupWebhookTriggerMock,
  checkIdempotencyKey: checkIdempotencyKeyMock,
  createExecution: createExecutionMock,
  updateTriggerLastRun: updateTriggerLastRunMock,
  isUniqueConstraintError: isUniqueConstraintErrorMock,
  // Push/PR helpers — webhook service imports them via the barrel even though
  // these tests only exercise handleGenericWebhook.
  findSessionsByPR: vi.fn().mockResolvedValue({ results: [] }),
  findSessionsByRepoBranch: vi.fn().mockResolvedValue({ results: [] }),
  updateSessionGitState: vi.fn(),
}));

vi.mock('../lib/db/trigger-deliveries.js', () => ({
  recordTriggerDelivery: recordTriggerDeliveryMock,
  truncatePayloadPreview: truncatePayloadPreviewMock,
}));

vi.mock('../services/executions.js', () => ({
  checkWorkflowConcurrency: checkWorkflowConcurrencyMock,
  enqueueWorkflowExecution: enqueueWorkflowExecutionMock,
}));

vi.mock('../lib/workflow-runtime.js', () => ({
  sha256Hex: sha256HexMock,
  createWorkflowSession: createWorkflowSessionMock,
}));

vi.mock('../lib/drizzle.js', () => ({
  getDb: getDbMock,
}));

import { handleGenericWebhook } from '../services/webhooks.js';

// HMAC-SHA256 in hex over a body+secret matching the production verifier.
async function computeHmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// handleGenericWebhook only reads `env.DB` and passes it to mocked DB helpers,
// so the rest of Env (DOs, R2, secrets) is never touched. The bridge is
// localized to a single helper rather than scattered `as Env` casts.
function makeEnv(): Env {
  const subset = { DB: {} as Env['DB'] };
  return subset as Env;
}
const fakeEnv = makeEnv();

function setTrigger(overrides: Record<string, unknown> = {}): void {
  lookupWebhookTriggerMock.mockResolvedValue({
    id: 'trig-1',
    user_id: 'user-1',
    workflow_id: 'wf-1',
    workflow_name: 'Test WF',
    version: '1',
    data: '{"name":"Test WF"}',
    variable_mapping: null,
    config: JSON.stringify({ type: 'webhook', path: 'my-hook', method: 'POST' }),
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // Restore default behaviours that individual tests may override.
  isUniqueConstraintErrorMock.mockReturnValue(false);
  checkIdempotencyKeyMock.mockResolvedValue(null);
  checkWorkflowConcurrencyMock.mockResolvedValue({ allowed: true, activeUser: 0, activeGlobal: 0 });
  enqueueWorkflowExecutionMock.mockResolvedValue(true);
  truncatePayloadPreviewMock.mockReturnValue('<preview>');
  sha256HexMock.mockResolvedValue('hash');
  createWorkflowSessionMock.mockResolvedValue('session-1');
});

describe('handleGenericWebhook — trigger lookup', () => {
  it('returns 404 when no trigger matches the path', async () => {
    lookupWebhookTriggerMock.mockResolvedValue(null);
    const out = await handleGenericWebhook(
      fakeEnv,
      'unknown',
      'POST',
      '{}',
      {},
      {},
      'https://valet.test',
    );
    expect(out?.statusCode).toBe(404);
    expect(out?.result.message).toBe('Webhook not found');
  });
});

describe('handleGenericWebhook — method enforcement', () => {
  it('rejects when configured method does not match', async () => {
    setTrigger({
      config: JSON.stringify({ type: 'webhook', path: 'my-hook', method: 'POST' }),
    });
    const out = await handleGenericWebhook(
      fakeEnv,
      'my-hook',
      'GET',
      '',
      {},
      {},
      'https://valet.test',
    );
    expect(out?.statusCode).toBe(405);
    expect(recordTriggerDeliveryMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ outcome: 'no_match', reason: expect.stringContaining('Method GET not allowed') }),
    );
  });
});

describe('handleGenericWebhook — HMAC signature verification', () => {
  it('returns 401 when a secret is configured but no signature header is present', async () => {
    setTrigger({
      config: JSON.stringify({ type: 'webhook', path: 'my-hook', method: 'POST', secret: 'shh' }),
    });
    const out = await handleGenericWebhook(fakeEnv, 'my-hook', 'POST', '{}', {}, {}, 'https://valet.test');
    expect(out?.statusCode).toBe(401);
    expect(out?.result.message).toBe('Missing webhook signature');
  });

  it('returns 401 when the signature does not match the body', async () => {
    setTrigger({
      config: JSON.stringify({ type: 'webhook', path: 'my-hook', method: 'POST', secret: 'shh' }),
    });
    const out = await handleGenericWebhook(
      fakeEnv,
      'my-hook',
      'POST',
      '{"a":1}',
      { 'x-webhook-signature': 'sha256=deadbeef' },
      {},
      'https://valet.test',
    );
    expect(out?.statusCode).toBe(401);
    expect(out?.result.error).toBe('invalid signature');
  });

  it('accepts a correct sha256= signature and proceeds to enqueue', async () => {
    const body = '{"hello":"world"}';
    const sig = 'sha256=' + (await computeHmacHex('shh', body));
    setTrigger({
      config: JSON.stringify({ type: 'webhook', path: 'my-hook', method: 'POST', secret: 'shh' }),
    });
    const out = await handleGenericWebhook(
      fakeEnv,
      'my-hook',
      'POST',
      body,
      { 'x-webhook-signature': sig },
      {},
      'https://valet.test',
    );
    expect(out?.statusCode).toBe(202);
    expect(createExecutionMock).toHaveBeenCalledTimes(1);
    expect(enqueueWorkflowExecutionMock).toHaveBeenCalledTimes(1);
  });

  it('accepts a bare hex signature (no sha256= prefix)', async () => {
    const body = '{}';
    const sig = await computeHmacHex('shh', body);
    setTrigger({
      config: JSON.stringify({ type: 'webhook', path: 'my-hook', method: 'POST', secret: 'shh' }),
    });
    const out = await handleGenericWebhook(
      fakeEnv,
      'my-hook',
      'POST',
      body,
      { 'x-webhook-signature': sig },
      {},
      'https://valet.test',
    );
    expect(out?.statusCode).toBe(202);
  });
});

describe('handleGenericWebhook — variable extraction', () => {
  it('extracts variables via $. JSONPath subset from the JSON body', async () => {
    setTrigger({
      variable_mapping: JSON.stringify({
        prNumber: '$.pull_request.number',
        repo: '$.repository.full_name',
      }),
    });
    const body = JSON.stringify({
      pull_request: { number: 42 },
      repository: { full_name: 'acme/web' },
    });
    const out = await handleGenericWebhook(fakeEnv, 'my-hook', 'POST', body, {}, {}, 'https://valet.test');
    expect(out?.statusCode).toBe(202);

    const callArg = createExecutionMock.mock.calls[0]?.[1] as { variables: string } | undefined;
    expect(callArg).toBeDefined();
    const vars = JSON.parse(callArg!.variables) as Record<string, unknown>;
    expect(vars.prNumber).toBe(42);
    expect(vars.repo).toBe('acme/web');
    // The full payload is preserved under `_payload` for downstream steps.
    expect(vars._payload).toEqual({
      pull_request: { number: 42 },
      repository: { full_name: 'acme/web' },
    });
  });

  it('merges query params into payload before extraction', async () => {
    setTrigger({
      variable_mapping: JSON.stringify({ q: '$.query.tag' }),
    });
    const out = await handleGenericWebhook(
      fakeEnv,
      'my-hook',
      'POST',
      '{}',
      {},
      { tag: 'release' },
      'https://valet.test',
    );
    expect(out?.statusCode).toBe(202);
    const vars = JSON.parse(createExecutionMock.mock.calls[0]![1].variables) as Record<string, unknown>;
    expect(vars.q).toBe('release');
  });

  it('omits variables whose path does not resolve', async () => {
    setTrigger({
      variable_mapping: JSON.stringify({ missing: '$.nope.here' }),
    });
    const out = await handleGenericWebhook(fakeEnv, 'my-hook', 'POST', '{}', {}, {}, 'https://valet.test');
    expect(out?.statusCode).toBe(202);
    const vars = JSON.parse(createExecutionMock.mock.calls[0]![1].variables) as Record<string, unknown>;
    expect(vars.missing).toBeUndefined();
  });
});

describe('handleGenericWebhook — idempotency', () => {
  it('reuses the existing execution when the delivery key is already recorded', async () => {
    setTrigger();
    checkIdempotencyKeyMock.mockResolvedValue({
      id: 'exec-prev',
      status: 'completed',
      session_id: 'session-prev',
    });
    const out = await handleGenericWebhook(
      fakeEnv,
      'my-hook',
      'POST',
      '{}',
      { 'x-github-delivery': 'delivery-123' },
      {},
      'https://valet.test',
    );
    expect(out?.statusCode).toBe(200);
    expect(out?.result.deduplicated).toBe(true);
    expect(out?.result.executionId).toBe('exec-prev');
    // The execution must NOT be re-created.
    expect(createExecutionMock).not.toHaveBeenCalled();
    expect(enqueueWorkflowExecutionMock).not.toHaveBeenCalled();
  });

  it('builds the idempotency key from the delivery header when present', async () => {
    setTrigger();
    await handleGenericWebhook(
      fakeEnv,
      'my-hook',
      'POST',
      '{}',
      { 'x-webhook-id': 'wb-xyz' },
      {},
      'https://valet.test',
    );
    // The second arg to checkIdempotencyKey is the idempotency key string.
    const key = checkIdempotencyKeyMock.mock.calls[0]?.[2];
    expect(key).toBe('webhook:trig-1:wb-xyz');
  });

  it('returns 200 deduplicated when a concurrent insert collides on the unique key', async () => {
    setTrigger();
    isUniqueConstraintErrorMock.mockReturnValue(true);
    createExecutionMock.mockRejectedValueOnce(new Error('UNIQUE constraint failed'));
    const out = await handleGenericWebhook(
      fakeEnv,
      'my-hook',
      'POST',
      '{}',
      { 'x-webhook-id': 'wb-race' },
      {},
      'https://valet.test',
    );
    expect(out?.statusCode).toBe(200);
    expect(out?.result.deduplicated).toBe(true);
    expect(enqueueWorkflowExecutionMock).not.toHaveBeenCalled();
  });
});

describe('handleGenericWebhook — concurrency cap', () => {
  it('returns 429 when checkWorkflowConcurrency disallows', async () => {
    setTrigger();
    checkWorkflowConcurrencyMock.mockResolvedValueOnce({
      allowed: false,
      reason: 'per_user_limit_exceeded:5',
      activeUser: 5,
      activeGlobal: 10,
    });
    const out = await handleGenericWebhook(fakeEnv, 'my-hook', 'POST', '{}', {}, {}, 'https://valet.test');
    expect(out?.statusCode).toBe(429);
    expect(out?.result.activeUser).toBe(5);
    expect(out?.result.activeGlobal).toBe(10);
    expect(createExecutionMock).not.toHaveBeenCalled();
  });
});

describe('handleGenericWebhook — test-fire', () => {
  it('uses a `test:` idempotency-key prefix and tags execution as trigger_type=test', async () => {
    setTrigger({
      config: JSON.stringify({ type: 'webhook', path: 'my-hook', method: 'POST', secret: 'shh' }),
    });
    const out = await handleGenericWebhook(
      fakeEnv,
      'my-hook',
      'POST',
      '{}',
      // No signature header; testFire passes skipSecretCheck so this should still proceed.
      { 'x-webhook-id': 'tf-1' },
      {},
      'https://valet.test',
      { skipSecretCheck: true, testFire: true },
    );
    expect(out?.statusCode).toBe(202);
    expect(checkIdempotencyKeyMock.mock.calls[0]?.[2]).toBe('test:trig-1:tf-1');
    const created = createExecutionMock.mock.calls[0]?.[1] as { triggerType: string; triggerMetadata: string };
    expect(created.triggerType).toBe('test');
    const meta = JSON.parse(created.triggerMetadata) as Record<string, unknown>;
    expect(meta.originalTriggerType).toBe('webhook');
    expect(meta.testFire).toBe(true);
  });
});
