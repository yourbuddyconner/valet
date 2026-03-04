import { Hono } from 'hono';
import type { Env, Variables } from '../env.js';
import { adminMiddleware } from '../middleware/admin.js';
import { ValidationError } from '@agent-ops/shared';
import { listDisabledActions, setServiceDisabledState } from '../lib/db.js';

export const disabledActionsRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

// All disabled-actions routes require admin role
disabledActionsRouter.use('*', adminMiddleware);

// GET /api/admin/disabled-actions — list all disabled entries
disabledActionsRouter.get('/', async (c) => {
  const rows = await listDisabledActions(c.get('db'));
  return c.json(rows);
});

// PUT /api/admin/disabled-actions/:service — set disabled state for a service
disabledActionsRouter.put('/:service', async (c) => {
  const service = c.req.param('service');
  const body = await c.req.json<{
    serviceDisabled: boolean;
    disabledActionIds: string[];
  }>();

  if (typeof body.serviceDisabled !== 'boolean') {
    throw new ValidationError('serviceDisabled must be a boolean');
  }
  if (!Array.isArray(body.disabledActionIds) ||
      body.disabledActionIds.some((id) => typeof id !== 'string' || id.length === 0 || id.includes(':'))) {
    throw new ValidationError('disabledActionIds must be an array of non-empty strings without colons');
  }

  const user = c.get('user');
  await setServiceDisabledState(
    c.env.DB,
    service,
    body.serviceDisabled,
    body.disabledActionIds,
    user.id,
  );

  return c.json({ ok: true });
});
