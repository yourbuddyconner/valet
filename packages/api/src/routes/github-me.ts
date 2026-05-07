import { Hono } from 'hono';
import type { Env, Variables } from '../env.js';
import { signJWT } from '../lib/jwt.js';
import { getGitHubConfig, getGitHubMetadata } from '../services/github-config.js';
import { loadGitHubApp } from '../services/github-app.js';
import { deleteCredential } from '../lib/db/credentials.js';
import { listGithubInstallationsByUser } from '../lib/db/github-installations.js';
import * as db from '../lib/db.js';

// ─── Authenticated Router (mounted at /api/me/github) ──────────────────────

export const githubMeRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * GET / — Get user's GitHub status
 */
githubMeRouter.get('/', async (c) => {
  const user = c.get('user');
  const appDb = c.get('db');

  // Check if the GitHub App is configured and load metadata
  const ghConfig = await getGitHubConfig(c.env, appDb);
  const metadata = ghConfig ? await getGitHubMetadata(appDb) : null;

  // Get user's GitHub identity link
  const identityLinks = await db.getUserIdentityLinks(appDb, user.id);
  const githubLink = identityLinks.find((l) => l.provider === 'github');

  // Get user record for GitHub info
  const userRecord = await db.getUserById(appDb, user.id);

  // Get user's GitHub App installations
  const userInstallations = await listGithubInstallationsByUser(appDb, user.id);

  return c.json({
    configured: !!ghConfig,
    appSlug: ghConfig?.appSlug ?? null,
    settings: {
      allowPersonalInstallations: metadata?.allowPersonalInstallations ?? true,
      allowAnonymousGitHubAccess: metadata?.allowAnonymousGitHubAccess ?? true,
    },
    personal: {
      linked: !!githubLink,
      githubUsername: userRecord?.githubUsername ?? githubLink?.externalName ?? null,
      githubId: userRecord?.githubId ?? githubLink?.externalId ?? null,
      email: userRecord?.email ?? null,
      avatarUrl: userRecord?.avatarUrl ?? null,
    },
    installations: userInstallations,
  });
});

/**
 * POST /link — Initiate GitHub OAuth linking via App OAuth
 */
githubMeRouter.post('/link', async (c) => {
  const user = c.get('user');
  const appDb = c.get('db');

  const app = await loadGitHubApp(c.env, appDb);
  if (!app) return c.json({ error: 'GitHub App not configured' }, 400);

  // Create signed JWT state token (10 min expiry)
  const now = Math.floor(Date.now() / 1000);
  const state = await signJWT(
    { sub: user.id, purpose: 'github-link', sid: crypto.randomUUID(), iat: now, exp: now + 10 * 60 } as any,
    c.env.ENCRYPTION_KEY,
  );

  const workerOrigin = c.env.API_PUBLIC_URL || new URL(c.req.url).origin;
  const { url } = app.oauth.getWebFlowAuthorizationUrl({
    state,
    redirectUrl: `${workerOrigin}/auth/github/callback`,
  });

  return c.json({ redirectUrl: url });
});

/**
 * DELETE /link — Unlink GitHub identity
 */
githubMeRouter.delete('/link', async (c) => {
  const user = c.get('user');
  const appDb = c.get('db');

  // Delete identity link
  const identityLinks = await db.getUserIdentityLinks(appDb, user.id);
  const githubLink = identityLinks.find((l) => l.provider === 'github');
  if (githubLink) {
    await db.deleteIdentityLink(appDb, githubLink.id, user.id);
  }

  // Delete the GitHub OAuth credential
  await deleteCredential(appDb, 'user', user.id, 'github', 'oauth2');

  // Clear githubId and githubUsername on user record
  await db.updateUserGitHub(appDb, user.id, {
    githubId: null,
    githubUsername: null,
  });

  return c.json({ success: true });
});
