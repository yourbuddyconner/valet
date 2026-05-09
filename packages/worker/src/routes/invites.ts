import { Hono } from 'hono';
import type { Env, Variables } from '../env.js';
import { getInviteByCode, getInviteByCodeAny, getOrgSettings, markInviteAccepted, updateUserRole } from '../lib/db.js';
import { NotFoundError, ValidationError } from '@valet/shared';

export const invitesRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * GET /invites/:code — Public endpoint to validate an invite code
 * Returns invite info (role, org name) for the invite landing page
 */
invitesRouter.get('/:code', async (c) => {
  const code = c.req.param('code');

  const invite = await getInviteByCodeAny(c.get('db'), code);
  if (!invite) {
    throw new NotFoundError('Invite not found');
  }

  const isExpired = new Date(invite.expiresAt) < new Date();
  const isAccepted = !!invite.acceptedAt;

  const orgSettings = await getOrgSettings(c.get('db'));

  return c.json({
    code: invite.code,
    role: invite.role,
    orgName: orgSettings.name,
    status: isAccepted ? 'accepted' : isExpired ? 'expired' : 'valid',
  });
});

/**
 * Authenticated invite accept router — mounted under /api/invites
 * POST /api/invites/:code/accept — Accept an invite for the currently logged-in user
 */
export const invitesApiRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

invitesApiRouter.post('/:code/accept', async (c) => {
  const code = c.req.param('code');
  const user = c.get('user');

  const invite = await getInviteByCode(c.get('db'), code);
  if (!invite) {
    throw new NotFoundError('Invite not found or already used');
  }

  await markInviteAccepted(c.get('db'), invite.id, user.id);
  await updateUserRole(c.get('db'), user.id, invite.role);

  return c.json({ ok: true, role: invite.role });
});
