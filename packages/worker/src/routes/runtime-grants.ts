import { Hono } from 'hono';
import type { Env, Variables } from '../env.js';
import { NotFoundError } from '@valet/shared';
import {
  getRuntimeGrant,
  listActiveRuntimeGrantsForUser,
  revokeRuntimeGrant,
} from '../lib/db/actions.js';

/**
 * Surfaces the ephemeral runtime_grants table to the user-facing
 * settings UI. These are the "Allow for Session" / "Approve for this
 * run" grants — they're not durable like action_policies and they
 * vanish when their parent session/execution terminates, but while
 * they exist a user should be able to see them and revoke them.
 */
export const runtimeGrantsRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

runtimeGrantsRouter.get('/', async (c) => {
  const user = c.get('user');
  const rows = await listActiveRuntimeGrantsForUser(c.get('db'), user.id);
  return c.json(rows.map((row: typeof rows[number]) => ({
    id: row.id,
    sessionId: row.sessionId,
    workflowExecutionId: row.workflowExecutionId,
    subjectType: row.subjectType,
    service: row.service,
    actionId: row.actionId,
    riskLevel: row.riskLevel,
    nodeId: row.nodeId,
    policyKey: row.policyKey,
    createdAt: row.createdAt,
  })));
});

runtimeGrantsRouter.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const user = c.get('user');
  const existing = await getRuntimeGrant(c.get('db'), id);
  if (!existing || existing.userId !== user.id) {
    throw new NotFoundError('Runtime grant', id);
  }
  await revokeRuntimeGrant(c.get('db'), id, user.id);
  return c.json({ ok: true });
});
