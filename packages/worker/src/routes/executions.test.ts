import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env, Variables } from '../env.js';
import { errorHandler } from '../middleware/error-handler.js';

// All DB and service mocks are hoisted so the vi.mock factories can wire them
// before the SUT is imported.
const {
  handleApprovalMock,
  cancelExecutionMock,
  retryExecutionFromStepMock,
  getExecutionMock,
  listExecutionsMock,
  getDbMock,
} = vi.hoisted(() => ({
  handleApprovalMock: vi.fn(),
  cancelExecutionMock: vi.fn(),
  retryExecutionFromStepMock: vi.fn(),
  getExecutionMock: vi.fn(),
  listExecutionsMock: vi.fn(),
  getDbMock: vi.fn().mockReturnValue({}),
}));

vi.mock('../services/executions.js', () => ({
  handleApproval: handleApprovalMock,
  cancelExecution: cancelExecutionMock,
  // Unused-but-imported by the router; provide a stub so importing doesn't fail.
  completeExecution: vi.fn(),
  updateExecutionStatusChecked: vi.fn(),
  getExecutionStepsWithOrder: vi.fn().mockResolvedValue([]),
}));

vi.mock('../services/session-workflows.js', () => ({
  retryExecutionFromStep: retryExecutionFromStepMock,
}));

vi.mock('../lib/db.js', () => ({
  listExecutions: listExecutionsMock,
  getExecution: getExecutionMock,
}));

vi.mock('../lib/drizzle.js', () => ({
  getDb: getDbMock,
}));

import { executionsRouter } from './executions.js';

type TestUser = { id: string; email: string; role: 'admin' | 'member' };

// Cloudflare bindings are deep types; the routes under test only touch DB and
// rely on mocked services. The single-arrow Env bridge is localized to one
// helper rather than scattering `as Env` casts across every call site.
function makeEnv(): Env {
  const subset = { DB: {} as Env['DB'] };
  return subset as Env;
}
const fakeEnv = makeEnv();

function buildApp(user: TestUser = { id: 'user-1', email: 'u@example.com', role: 'member' }) {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    c.set('user', user);
    c.set('db', {} as Variables['db']);
    c.set('requestId', 'req-test');
    await next();
  });
  app.route('/', executionsRouter);
  return app;
}

function jsonPost(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /executions/:id/approve', () => {
  it('returns 200 and the new status when the approval is accepted', async () => {
    handleApprovalMock.mockResolvedValue({ status: 'running' });
    const app = buildApp();
    const res = await app.request('http://localhost/exec-1/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approve: true, resumeToken: 'tok-good' }),
    }, fakeEnv);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, status: 'running' });
    expect(handleApprovalMock).toHaveBeenCalledWith(
      expect.anything(),
      'exec-1',
      'user-1',
      { approve: true, resumeToken: 'tok-good' },
    );
  });

  it('returns 200 with cancelled status when approve=false flips the workflow', async () => {
    handleApprovalMock.mockResolvedValue({ status: 'cancelled' });
    const app = buildApp();
    const res = await app.request('http://localhost/exec-1/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approve: false, resumeToken: 'tok-good', reason: 'no thanks' }),
    }, fakeEnv);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, status: 'cancelled' });
  });

  it('returns 401 when the underlying service rejects with UnauthorizedError', async () => {
    // The route delegates auth to handleApproval; propagating UnauthorizedError must
    // surface as a 401 via the global error handler so wrong-token attempts can't fish.
    const { UnauthorizedError } = await import('@valet/shared');
    handleApprovalMock.mockRejectedValue(new UnauthorizedError('Unauthorized to update this execution'));
    const app = buildApp();
    const res = await app.request('http://localhost/exec-1/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approve: true, resumeToken: 'tok-wrong' }),
    }, fakeEnv);
    expect(res.status).toBe(401);
  });

  it('returns 400 when the body is missing resumeToken', async () => {
    const app = buildApp();
    const res = await app.request('http://localhost/exec-1/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approve: true }),
    }, fakeEnv);
    expect(res.status).toBe(400);
    expect(handleApprovalMock).not.toHaveBeenCalled();
  });
});

describe('POST /executions/:id/cancel', () => {
  it('returns 200 with the new status', async () => {
    cancelExecutionMock.mockResolvedValue({ status: 'cancelled' });
    const app = buildApp();
    const res = await app.request('http://localhost/exec-1/cancel', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'user cancelled' }),
    }, fakeEnv);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, status: 'cancelled' });
    expect(cancelExecutionMock).toHaveBeenCalledWith(expect.anything(), 'exec-1', 'user-1', 'user cancelled');
  });

  it('returns 404 when the underlying service raises NotFoundError', async () => {
    const { NotFoundError } = await import('@valet/shared');
    cancelExecutionMock.mockRejectedValue(new NotFoundError('Execution', 'exec-missing'));
    const app = buildApp();
    const res = await app.request('http://localhost/exec-missing/cancel', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }, fakeEnv);
    expect(res.status).toBe(404);
  });
});

describe('POST /executions/:id/retry-from', () => {
  it('returns 200 with the new execution data when retry succeeds', async () => {
    retryExecutionFromStepMock.mockResolvedValue({
      data: {
        execution: {
          executionId: 'exec-new',
          workflowId: 'wf-1',
          workflowName: 'My Workflow',
          status: 'pending',
          sessionId: 'session-new',
          sourceExecutionId: 'exec-prev',
          retryFromStepId: 'step-3',
          dispatched: true,
        },
      },
    });
    const app = buildApp();
    const res = await app.request('http://localhost/exec-prev/retry-from', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stepId: 'step-3' }),
    }, fakeEnv);
    expect(res.status).toBe(200);
    const body = await res.json() as { execution: { executionId: string; sourceExecutionId: string; retryFromStepId: string; status: string } };
    expect(body.execution.executionId).toBe('exec-new');
    // The retry execution must reference the source and the target stepId.
    expect(body.execution.sourceExecutionId).toBe('exec-prev');
    expect(body.execution.retryFromStepId).toBe('step-3');
    expect(body.execution.status).toBe('pending');
    expect(retryExecutionFromStepMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      'user-1',
      { sourceExecutionId: 'exec-prev', stepId: 'step-3' },
    );
  });

  it('returns 404 when the service signals the source execution does not exist', async () => {
    retryExecutionFromStepMock.mockResolvedValue({ error: 'Execution not found: exec-prev' });
    const app = buildApp();
    const res = await app.request('http://localhost/exec-prev/retry-from', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stepId: 'step-3' }),
    }, fakeEnv);
    expect(res.status).toBe(404);
  });

  it('returns 400 ValidationError when the service rejects a nested step target', async () => {
    retryExecutionFromStepMock.mockResolvedValue({ error: 'retry_from_nested_step_not_supported' });
    const app = buildApp();
    const res = await app.request('http://localhost/exec-prev/retry-from', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stepId: 'inner-step' }),
    }, fakeEnv);
    expect(res.status).toBe(400);
  });

  it('returns 400 when stepId is missing from the body', async () => {
    const app = buildApp();
    const res = await app.request('http://localhost/exec-prev/retry-from', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }, fakeEnv);
    expect(res.status).toBe(400);
    expect(retryExecutionFromStepMock).not.toHaveBeenCalled();
  });
});

describe('GET /executions/:id', () => {
  it('returns 404 when getExecution returns null', async () => {
    getExecutionMock.mockResolvedValue(null);
    const app = buildApp();
    const res = await app.request('http://localhost/exec-missing', {}, fakeEnv);
    expect(res.status).toBe(404);
  });

  it('parses workflow_snapshot and falls back to its name when workflow_name is null', async () => {
    // The detail page relies on this fallback when the source workflow has been deleted.
    getExecutionMock.mockResolvedValue({
      id: 'exec-1',
      workflow_id: 'wf-1',
      workflow_name: null,
      workflow_snapshot: JSON.stringify({ name: 'Snapshot Name' }),
      session_id: 'session-1',
      trigger_id: null,
      trigger_name: null,
      status: 'completed',
      trigger_type: 'manual',
      trigger_metadata: null,
      variables: null,
      resume_token: null,
      outputs: null,
      steps: null,
      error: null,
      started_at: '2026-05-22T00:00:00Z',
      completed_at: '2026-05-22T00:01:00Z',
    });
    const app = buildApp();
    const res = await app.request('http://localhost/exec-1', {}, fakeEnv);
    expect(res.status).toBe(200);
    const body = await res.json() as { execution: { workflowName: string | null; workflowSnapshot: { name: string } | null } };
    expect(body.execution.workflowName).toBe('Snapshot Name');
    expect(body.execution.workflowSnapshot).toEqual({ name: 'Snapshot Name' });
  });
});
