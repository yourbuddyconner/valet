import { Hono } from 'hono';
import type { Env, Variables } from '../env.js';
import { adminMiddleware } from '../middleware/admin.js';
import { ValidationError } from '@valet/shared';
import { listActionPolicies, upsertActionPolicy, deleteActionPolicy } from '../lib/db.js';

export const actionPoliciesRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

// All action policy routes require admin role
actionPoliciesRouter.use('*', adminMiddleware);

// GET /api/admin/action-policies — list all policies
actionPoliciesRouter.get('/', async (c) => {
  const policies = await listActionPolicies(c.get('db'));
  return c.json(policies);
});

// PUT /api/admin/action-policies/:id — upsert a policy
actionPoliciesRouter.put('/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{
    service?: string | null;
    actionId?: string | null;
    riskLevel?: string | null;
    mode: string;
  }>();

  // Validate mode
  const validModes = ['allow', 'require_approval', 'deny'];
  if (!body.mode || !validModes.includes(body.mode)) {
    throw new ValidationError(`Invalid mode: ${body.mode}. Must be one of: ${validModes.join(', ')}`);
  }

  // Validate risk level if provided
  const validRiskLevels = ['low', 'medium', 'high', 'critical'];
  if (body.riskLevel && !validRiskLevels.includes(body.riskLevel)) {
    throw new ValidationError(`Invalid risk level: ${body.riskLevel}. Must be one of: ${validRiskLevels.join(', ')}`);
  }

  // Must have at least one targeting field
  if (!body.service && !body.actionId && !body.riskLevel) {
    throw new ValidationError('Policy must target at least one of: service, actionId, or riskLevel');
  }

  // actionId requires service
  if (body.actionId && !body.service) {
    throw new ValidationError('actionId requires a service to be specified');
  }

  const user = c.get('user');
  await upsertActionPolicy(c.get('db'), {
    id,
    service: body.service,
    actionId: body.actionId,
    riskLevel: body.riskLevel,
    mode: body.mode as 'allow' | 'require_approval' | 'deny',
    createdBy: user.id,
  });

  return c.json({ ok: true, id });
});

// DELETE /api/admin/action-policies/:id — delete a policy
actionPoliciesRouter.delete('/:id', async (c) => {
  const id = c.req.param('id');
  await deleteActionPolicy(c.get('db'), id);
  return c.json({ ok: true });
});
