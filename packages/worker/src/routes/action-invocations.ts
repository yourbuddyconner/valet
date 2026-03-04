import { Hono } from 'hono';
import type { Env, Variables } from '../env.js';
import {
  getInvocation,
  listInvocationsBySession,
  listPendingInvocationsByUser,
} from '../lib/db.js';
import {
  approveInvocation,
  denyInvocation,
} from '../services/actions.js';
import { NotFoundError, ForbiddenError } from '@valet/shared';

export const actionInvocationsRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

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

  // Verify ownership before approving
  const inv = await getInvocation(db, id);
  if (!inv) {
    throw new NotFoundError('Invocation not found');
  }
  if (inv.userId !== user.id) {
    throw new ForbiddenError('Not authorized to approve this invocation');
  }

  const result = await approveInvocation(db, id, user.id);
  if (!result.ok) {
    throw new NotFoundError('Invocation not found or not pending');
  }

  // Notify SessionAgentDO
  try {
    const doId = c.env.SESSIONS.idFromName(inv.sessionId);
    const stub = c.env.SESSIONS.get(doId);
    await stub.fetch(new Request('https://session/action-approved', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ invocationId: id }),
    }));
  } catch (err) {
    console.error('[action-invocations] Failed to notify DO of approval:', err);
  }

  return c.json({ ok: true });
});

// POST /api/action-invocations/:id/deny — deny pending invocation
actionInvocationsRouter.post('/:id/deny', async (c) => {
  const id = c.req.param('id');
  const user = c.get('user');
  const db = c.get('db');
  const body = await c.req.json<{ reason?: string }>().catch(() => ({ reason: undefined as string | undefined }));

  const inv = await getInvocation(db, id);
  if (!inv) {
    throw new NotFoundError('Invocation not found');
  }
  if (inv.userId !== user.id) {
    throw new ForbiddenError('Not authorized to deny this invocation');
  }

  const reason = body.reason;
  const result = await denyInvocation(db, id, user.id, reason);
  if (!result.ok) {
    throw new NotFoundError('Invocation not found or not pending');
  }

  // Notify SessionAgentDO
  try {
    const doId = c.env.SESSIONS.idFromName(inv.sessionId);
    const stub = c.env.SESSIONS.get(doId);
    await stub.fetch(new Request('https://session/action-denied', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ invocationId: id, reason }),
    }));
  } catch (err) {
    console.error('[action-invocations] Failed to notify DO of denial:', err);
  }

  return c.json({ ok: true });
});
