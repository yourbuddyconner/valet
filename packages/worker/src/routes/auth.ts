import { Hono } from 'hono';
import { z } from 'zod';
import type { Env, Variables } from '../env.js';
import * as db from '../lib/db.js';
import { ValidationError } from '@valet/shared';
import { storeCredential, listCredentials, revokeCredential, hasCredential } from '../services/credentials.js';

export const authRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * GET /api/auth/me
 * Returns the authenticated user's information and connected providers
 */
authRouter.get('/me', async (c) => {
  const authUser = c.get('user');

  const [fullUser, hasGitHub, hasGoogle, orgSettings] = await Promise.all([
    db.getUserById(c.get('db'), authUser.id),
    hasCredential(c.env, 'user', authUser.id, 'github'),
    hasCredential(c.env, 'user', authUser.id, 'google'),
    db.getOrgSettings(c.get('db')),
  ]);

  let user = fullUser ?? authUser;

  // Backfill git config defaults from profile data if not already set
  if (fullUser && (!fullUser.gitName || !fullUser.gitEmail)) {
    const inferredGitName = fullUser.name || fullUser.githubUsername || undefined;
    const inferredGitEmail = fullUser.githubId && fullUser.githubUsername
      ? `${fullUser.githubId}+${fullUser.githubUsername}@users.noreply.github.com`
      : fullUser.email || undefined;

    const backfill: { gitName?: string; gitEmail?: string } = {};
    if (!fullUser.gitName && inferredGitName) backfill.gitName = inferredGitName;
    if (!fullUser.gitEmail && inferredGitEmail) backfill.gitEmail = inferredGitEmail;

    if (backfill.gitName || backfill.gitEmail) {
      const updated = await db.backfillGitConfig(c.get('db'), fullUser.id, backfill);
      if (updated) user = updated;
    }
  }

  return c.json({
    user,
    providers: {
      github: hasGitHub,
      google: hasGoogle,
    },
    orgModelPreferences: orgSettings.modelPreferences,
  });
});

const updateProfileSchema = z.object({
  name: z.string().max(255).optional(),
  gitName: z.string().max(255).optional(),
  gitEmail: z.string().email().max(255).optional(),
  onboardingCompleted: z.boolean().optional(),
  idleTimeoutSeconds: z.number().int().min(300).max(3600).optional(),
  sandboxCpuCores: z.number().min(0.5).max(8).optional(),
  sandboxMemoryMib: z.number().int().min(256).max(8192).optional(),
  modelPreferences: z.array(z.string().max(255)).max(20).optional(),
  uiQueueMode: z.enum(['followup', 'collect', 'steer']).optional(),
  timezone: z.string().max(50).optional(),
});

/**
 * PATCH /api/auth/me
 * Update the authenticated user's profile (git config, etc.)
 */
authRouter.patch('/me', async (c) => {
  const authUser = c.get('user');
  const body = await c.req.json();

  const result = updateProfileSchema.safeParse(body);
  if (!result.success) {
    throw new ValidationError(result.error.issues[0]?.message ?? 'Invalid input');
  }

  const updated = await db.updateUserProfile(c.get('db'), authUser.id, result.data);

  return c.json({ user: updated });
});

// --- User Credentials (per-user integration secrets) ---

const VALID_CREDENTIAL_PROVIDERS = ['1password'] as const;

/**
 * GET /api/auth/me/credentials
 * List the authenticated user's configured credentials (no values returned)
 */
authRouter.get('/me/credentials', async (c) => {
  const user = c.get('user');
  const creds = await listCredentials(c.env, 'user', user.id);
  return c.json(creds);
});

/**
 * PUT /api/auth/me/credentials/:provider
 * Set or update a credential for the authenticated user
 */
authRouter.put('/me/credentials/:provider', async (c) => {
  const provider = c.req.param('provider');
  if (!VALID_CREDENTIAL_PROVIDERS.includes(provider as any)) {
    throw new ValidationError(`Invalid provider: ${provider}. Must be one of: ${VALID_CREDENTIAL_PROVIDERS.join(', ')}`);
  }

  const { key } = await c.req.json<{ key: string }>();
  if (!key || typeof key !== 'string' || key.trim().length === 0) {
    throw new ValidationError('Credential value is required');
  }

  const user = c.get('user');

  await storeCredential(c.env, 'user', user.id, provider, { token: key }, {
    credentialType: 'service_account',
  });

  return c.json({ ok: true });
});

/**
 * DELETE /api/auth/me/credentials/:provider
 * Remove a credential for the authenticated user
 */
authRouter.delete('/me/credentials/:provider', async (c) => {
  const provider = c.req.param('provider');
  const user = c.get('user');
  await revokeCredential(c.env, 'user', user.id, provider);
  return c.json({ ok: true });
});

/**
 * POST /api/auth/logout
 * Invalidate the current session token
 */
authRouter.post('/logout', async (c) => {
  const authHeader = c.req.header('Authorization');
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (token) {
    const encoder = new TextEncoder();
    const data = encoder.encode(token);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const tokenHash = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');

    await db.deleteAuthSession(c.get('db'), tokenHash);
  }

  return c.json({ success: true });
});
