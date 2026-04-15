import { Hono } from 'hono';
import type { Env, Variables } from '../env.js';
import { signJWT, verifyJWT } from '../lib/jwt.js';
import { repoProviderRegistry } from '../repos/registry.js';
import { storeCredential } from '../services/credentials.js';
import { getDb } from '../lib/drizzle.js';
import * as credentialDb from '../lib/db/credentials.js';
import * as db from '../lib/db.js';
import { getGitHubConfig } from '../services/github-config.js';
import { adminMiddleware } from '../middleware/admin.js';

export const repoProviderRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

// List available repo providers
repoProviderRouter.get('/', async (c) => {
  const providers = repoProviderRegistry.list();
  return c.json(providers.map(p => ({
    id: p.id,
    displayName: p.displayName,
    icon: p.icon,
    supportsOrgLevel: p.supportsOrgLevel,
    supportsPersonalLevel: p.supportsPersonalLevel,
  })));
});

// Initiate GitHub OAuth repo-link flow (separate from identity login)
repoProviderRouter.get('/github-oauth/link', async (c) => {
  const user = c.get('user');

  const ghConfig = await getGitHubConfig(c.env, c.get('db'));
  if (!ghConfig) {
    return c.json({ error: 'GitHub OAuth not configured' }, 500);
  }

  const now = Math.floor(Date.now() / 1000);
  const state = await signJWT(
    { sub: user.id, purpose: 'repo-link', iat: now, exp: now + 10 * 60 } as any,
    c.env.ENCRYPTION_KEY,
  );

  const frontendUrl = c.env.FRONTEND_URL || 'http://localhost:5173';
  const redirectUri = `${frontendUrl.replace(/\/$/, '')}/auth/github/repo-callback`;

  const params = new URLSearchParams({
    client_id: ghConfig.appOauthClientId,
    redirect_uri: redirectUri,
    state,
  });

  return c.json({ url: `https://github.com/login/oauth/authorize?${params}` });
});

// Get GitHub App installation URL (org-level only, admin required)
repoProviderRouter.get('/:provider/install', adminMiddleware, async (c) => {
  const providerId = c.req.param('provider');
  const level = c.req.query('level') || 'org';
  const user = c.get('user');

  if (providerId !== 'github') {
    return c.json({ error: 'Only GitHub App installation is supported' }, 400);
  }

  if (level === 'personal') {
    return c.json({ error: 'Personal GitHub App installs are not supported. Use OAuth to link your personal GitHub account.' }, 400);
  }

  const ghConfig = await getGitHubConfig(c.env, c.get('db'));
  if (!ghConfig?.appSlug) {
    return c.json({ error: 'GitHub App not configured' }, 500);
  }

  const appDb = getDb(c.env.DB);
  const orgSettings = await db.getOrgSettings(appDb);
  const orgId = orgSettings?.id;
  if (!orgId) {
    return c.json({ error: 'Org context required for app installation' }, 400);
  }

  // State is a signed JWT to prevent forgery
  const now = Math.floor(Date.now() / 1000);
  const state = await signJWT(
    { sub: user.id, sid: 'org', orgId, iat: now, exp: now + 10 * 60 } as any,
    c.env.ENCRYPTION_KEY,
  );
  const installUrl = `https://github.com/apps/${ghConfig.appSlug}/installations/new?state=${encodeURIComponent(state)}`;

  return c.json({ url: installUrl });
});

// List installations for a repo provider
repoProviderRouter.get('/:provider/installations', async (c) => {
  const providerId = c.req.param('provider');
  const appDb = getDb(c.env.DB);

  const orgSettings = await db.getOrgSettings(appDb);
  const orgInstalls = orgSettings?.id
    ? (await credentialDb.listCredentialsByOwner(appDb, 'org', orgSettings.id))
        .filter(cred => cred.provider === providerId && cred.credentialType === 'app_install')
    : [];

  return c.json({
    installations: orgInstalls.map(i => ({
      level: 'org',
      provider: i.provider,
      createdAt: i.createdAt,
    })),
  });
});

/**
 * GitHub App installation callback — mounted outside /api/* (no auth middleware).
 * User identity is derived from the signed state JWT, not session auth.
 */
export const repoProviderCallbackRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

// GitHub OAuth repo-link callback (no auth middleware)
repoProviderCallbackRouter.get('/github-oauth/callback', async (c) => {
  const code = c.req.query('code');
  const stateParam = c.req.query('state');
  const frontendUrl = c.env.FRONTEND_URL || 'http://localhost:5173';

  if (!code || !stateParam) {
    return c.redirect(`${frontendUrl}/settings/admin?error=missing_params`);
  }

  const payload = await verifyJWT(stateParam, c.env.ENCRYPTION_KEY);
  if (!payload || !payload.sub || (payload as any).purpose !== 'repo-link') {
    return c.redirect(`${frontendUrl}/settings/admin?error=invalid_state`);
  }
  const userId = payload.sub as string;

  // Exchange code for token
  const appDb = getDb(c.env.DB);
  const ghConfig = await getGitHubConfig(c.env, appDb);
  if (!ghConfig) {
    return c.redirect(`${frontendUrl}/settings/admin?error=github_not_configured`);
  }

  // TODO(github-app-unified): Convert to Octokit app.oauth.createToken({ code }) for consistency
  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_id: ghConfig.appOauthClientId,
      client_secret: ghConfig.appOauthClientSecret,
      code,
    }),
  });

  const tokenData = (await tokenRes.json()) as { access_token?: string; error?: string };
  if (!tokenData.access_token) {
    return c.redirect(`${frontendUrl}/settings/admin?error=token_exchange_failed`);
  }

  // Store as user-level oauth2 credential for the 'github' provider
  await storeCredential(c.env, 'user', userId, 'github', {
    access_token: tokenData.access_token,
  }, {
    credentialType: 'oauth2',
  });

  return c.redirect(`${frontendUrl}/settings/admin?linked=true`);
});
