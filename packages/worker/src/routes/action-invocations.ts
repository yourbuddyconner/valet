import { Hono } from 'hono';
import type { Env, Variables } from '../env.js';
import {
  getInvocation,
  listInvocationsBySession,
  listPendingInvocationsByUser,
} from '../lib/db.js';
import { ErrorCodes, ForbiddenError, NotFoundError, ValidationError, ValetError } from '@valet/shared';

export const actionInvocationsRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

async function sessionAgentError(response: Response): Promise<string> {
  try {
    const body = await response.json() as { error?: unknown };
    if (typeof body.error === 'string' && body.error.trim()) {
      return body.error;
    }
  } catch {
    // Fall through to status text.
  }
  return response.statusText || 'Session agent rejected prompt resolution';
}

async function notifyPromptResolved(
  env: Env,
  sessionId: string,
  payload: { promptId: string; actionId: string; value?: string; resolvedBy: string },
) {
  const doId = env.SESSIONS.idFromName(sessionId);
  const stub = env.SESSIONS.get(doId);
  let response: Response;
  try {
    response = await stub.fetch(new Request('https://session/prompt-resolved', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }));
  } catch (err) {
    console.error('[action-invocations] Failed to notify DO of prompt resolution:', err);
    throw err;
  }

  if (!response.ok) {
    const error = await sessionAgentError(response);
    if (response.status === 403) {
      throw new ForbiddenError(error);
    }
    if (response.status === 404) {
      throw new NotFoundError(error);
    }
    if (response.status === 410) {
      throw new ValetError(error, ErrorCodes.INVALID_REQUEST, 410);
    }
    if (response.status === 409) {
      throw new ValetError(error, ErrorCodes.INVALID_REQUEST, 409);
    }
    if (response.status === 400) {
      throw new ValidationError(error);
    }
    throw new Error(error);
  }
}

function normalizeApprovalAction(actionId: string): 'allow_once' | 'allow_session' | 'allow_always' | 'cancel' | null {
  switch (actionId) {
    case 'approve':
    case 'allow_once':
      return 'allow_once';
    case 'allow_session':
      return 'allow_session';
    case 'allow_always':
      return 'allow_always';
    case 'deny':
    case 'cancel':
      return 'cancel';
    default:
      return null;
  }
}

function assertApproveTransportAction(actionId: string) {
  const normalized = normalizeApprovalAction(actionId);
  if (!normalized) {
    throw new ValidationError(`Unknown approval action: ${actionId}`);
  }
  if (normalized === 'cancel') {
    throw new ValidationError(`approve endpoint does not accept cancel action: ${actionId}`);
  }
}

function assertDenyTransportAction(actionId: string) {
  const normalized = normalizeApprovalAction(actionId);
  if (!normalized) {
    throw new ValidationError(`Unknown approval action: ${actionId}`);
  }
  if (normalized !== 'cancel') {
    throw new ValidationError(`deny endpoint does not accept approval action: ${actionId}`);
  }
}

// GET /api/action-invocations — list invocations with optional filters
actionInvocationsRouter.get('/', async (c) => {
  const user = c.get('user');
  const sessionId = c.req.query('sessionId');
  const status = c.req.query('status');
  const limitStr = c.req.query('limit');
  const limit = limitStr ? parseInt(limitStr, 10) : 50;

  if (sessionId) {
    // Only return invocations belonging to the current user within this session
    const invocations = await listInvocationsBySession(c.get('db'), sessionId, { limit, status: status || undefined });
    const filtered = invocations.filter((inv: { userId: string }) => inv.userId === user.id);
    return c.json(filtered);
  }

  // Without sessionId, list pending for current user
  const invocations = await listPendingInvocationsByUser(c.get('db'), user.id);
  return c.json(invocations);
});

// GET /api/action-invocations/pending — list pending approvals for current user
actionInvocationsRouter.get('/pending', async (c) => {
  const user = c.get('user');
  const invocations = await listPendingInvocationsByUser(c.get('db'), user.id);
  return c.json(invocations);
});

// GET /api/action-invocations/:id — get single invocation
actionInvocationsRouter.get('/:id', async (c) => {
  const id = c.req.param('id');
  const user = c.get('user');
  const inv = await getInvocation(c.get('db'), id);
  if (!inv) {
    throw new NotFoundError('Invocation not found');
  }
  if (inv.userId !== user.id) {
    throw new ForbiddenError('Not authorized to view this invocation');
  }
  return c.json(inv);
});

// POST /api/action-invocations/:id/approve — approve pending invocation
actionInvocationsRouter.post('/:id/approve', async (c) => {
  const id = c.req.param('id');
  const user = c.get('user');
  const db = c.get('db');
  const body = await c.req.json<{ actionId?: string }>().catch(() => ({ actionId: undefined as string | undefined }));

  // Verify ownership before approving
  const inv = await getInvocation(db, id);
  if (!inv) {
    throw new NotFoundError('Invocation not found');
  }
  if (inv.userId !== user.id) {
    throw new ForbiddenError('Not authorized to approve this invocation');
  }
  if (inv.status !== 'pending') {
    throw new NotFoundError('Invocation not found or not pending');
  }

  const actionId = typeof body.actionId === 'string' ? body.actionId : 'approve';
  assertApproveTransportAction(actionId);

  await notifyPromptResolved(c.env, inv.sessionId, {
    promptId: id,
    actionId,
    resolvedBy: user.id,
  });

  return c.json({ ok: true });
});

// POST /api/action-invocations/:id/deny — deny pending invocation
actionInvocationsRouter.post('/:id/deny', async (c) => {
  const id = c.req.param('id');
  const user = c.get('user');
  const db = c.get('db');
  const body = await c.req.json<{ reason?: string; actionId?: string }>().catch(() => ({
    reason: undefined as string | undefined,
    actionId: undefined as string | undefined,
  }));

  const inv = await getInvocation(db, id);
  if (!inv) {
    throw new NotFoundError('Invocation not found');
  }
  if (inv.userId !== user.id) {
    throw new ForbiddenError('Not authorized to deny this invocation');
  }
  if (inv.status !== 'pending') {
    throw new NotFoundError('Invocation not found or not pending');
  }

  const reason = typeof body.reason === 'string' ? body.reason : undefined;
  const actionId = typeof body.actionId === 'string' ? body.actionId : 'deny';
  assertDenyTransportAction(actionId);

  await notifyPromptResolved(c.env, inv.sessionId, {
    promptId: id,
    actionId,
    value: reason,
    resolvedBy: user.id,
  });

  return c.json({ ok: true });
});
