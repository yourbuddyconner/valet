import { Hono } from 'hono';
import type { Env, Variables } from '../env.js';
import { signJWT, verifyJWT } from '../lib/jwt.js';
import { repoProviderRegistry } from '../repos/registry.js';
import { storeCredential } from '../services/credentials.js';
import { getDb } from '../lib/drizzle.js';
import * as credentialDb from '../lib/db/credentials.js';
import * as db from '../lib/db.js';
import { getGitHubConfig } from '../services/github-config.js';

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
    client_id: ghConfig.oauthClientId,
    redirect_uri: redirectUri,
    scope: 'repo',
    state,
  });

  return c.json({ url: `https://github.com/login/oauth/authorize?${params}` });
});

// Get GitHub App installation URL (org or personal)
repoProviderRouter.get('/:provider/install', async (c) => {
  const providerId = c.req.param('provider');
  const level = c.req.query('level') || 'personal';
  const user = c.get('user');

  if (providerId !== 'github') {
    return c.json({ error: 'Only GitHub App installation is supported' }, 400);
  }

  const ghConfig = await getGitHubConfig(c.env, c.get('db'));
  if (!ghConfig?.appSlug) {
    return c.json({ error: 'GitHub App not configured' }, 500);
  }

  // For org-level installs, resolve org from DB (not client-supplied)
  let orgId: string | undefined;
  if (level === 'org') {
    const appDb = getDb(c.env.DB);
    const orgSettings = await db.getOrgSettings(appDb);
    orgId = orgSettings?.id;
    if (!orgId) {
      return c.json({ error: 'Org context required for org-level install' }, 400);
    }
  }

  // State is a signed JWT to prevent forgery
  const now = Math.floor(Date.now() / 1000);
  const state = await signJWT(
    { sub: user.id, sid: level, orgId, iat: now, exp: now + 10 * 60 } as any,
    c.env.ENCRYPTION_KEY,
  );
  const installUrl = `https://github.com/apps/${ghConfig.appSlug}/installations/new?state=${encodeURIComponent(state)}`;

  return c.json({ url: installUrl });
});

// List installations for a repo provider
repoProviderRouter.get('/:provider/installations', async (c) => {
  const providerId = c.req.param('provider');
  const user = c.get('user');
  const appDb = getDb(c.env.DB);

  // Get user-level installations
  const userCreds = await credentialDb.listCredentialsByOwner(appDb, 'user', user.id);
  const userInstalls = userCreds.filter(cred => cred.provider === providerId && cred.credentialType === 'app_install');

  // Get org-level installations
  const orgSettings = await db.getOrgSettings(appDb);
  const orgInstalls = orgSettings?.id
    ? (await credentialDb.listCredentialsByOwner(appDb, 'org', orgSettings.id))
        .filter(cred => cred.provider === providerId && cred.credentialType === 'app_install')
    : [];

  return c.json({
    installations: [
      ...orgInstalls.map(i => ({
        level: 'org',
        provider: i.provider,
        createdAt: i.createdAt,
      })),
      ...userInstalls.map(i => ({
        level: 'personal',
        provider: i.provider,
        createdAt: i.createdAt,
      })),
    ],
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
    return c.redirect(`${frontendUrl}/settings?tab=repositories&error=missing_params`);
  }

  const payload = await verifyJWT(stateParam, c.env.ENCRYPTION_KEY);
  if (!payload || !payload.sub || (payload as any).purpose !== 'repo-link') {
    return c.redirect(`${frontendUrl}/settings?tab=repositories&error=invalid_state`);
  }
  const userId = payload.sub as string;

  // Exchange code for token
  const appDb = getDb(c.env.DB);
  const ghConfig = await getGitHubConfig(c.env, appDb);
  if (!ghConfig) {
    return c.redirect(`${frontendUrl}/settings?tab=repositories&error=github_not_configured`);
  }

  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_id: ghConfig.oauthClientId,
      client_secret: ghConfig.oauthClientSecret,
      code,
    }),
  });

  const tokenData = (await tokenRes.json()) as { access_token?: string; error?: string };
  if (!tokenData.access_token) {
    return c.redirect(`${frontendUrl}/settings?tab=repositories&error=token_exchange_failed`);
  }

  // Store as user-level oauth2 credential for the 'github' provider
  await storeCredential(c.env, 'user', userId, 'github', {
    access_token: tokenData.access_token,
  }, {
    credentialType: 'oauth2',
  });

  return c.redirect(`${frontendUrl}/settings?tab=repositories&linked=true`);
});

// GitHub App installation callback (no auth middleware)
repoProviderCallbackRouter.get('/:provider/install/callback', async (c) => {
  const providerId = c.req.param('provider');
  const installationId = c.req.query('installation_id');
  const setupAction = c.req.query('setup_action');
  const stateParam = c.req.query('state');
  const frontendUrl = c.env.FRONTEND_URL || 'http://localhost:5173';

  // Only GitHub App installations are supported — reject other provider IDs
  // to prevent storing GitHub App credentials under arbitrary provider names
  if (providerId !== 'github') {
    return c.redirect(`${frontendUrl}/settings?tab=repositories&error=unsupported_provider`);
  }

  if (!installationId || !stateParam) {
    return c.redirect(`${frontendUrl}/settings?tab=repositories&error=missing_params`);
  }

  // Verify signed state JWT — this is how we identify the user without session auth
  const payload = await verifyJWT(stateParam, c.env.ENCRYPTION_KEY);
  if (!payload || !payload.sub) {
    return c.redirect(`${frontendUrl}/settings?tab=repositories&error=invalid_state`);
  }
  const userId = payload.sub as string;
  const level = (payload as any).sid || 'personal';
  const orgId = (payload as any).orgId;

  const ownerType = level === 'org' && orgId ? 'org' as const : 'user' as const;
  const ownerId = level === 'org' && orgId ? orgId : userId;

  // Validate required GitHub App config before storing
  const appDb = getDb(c.env.DB);
  const ghConfig = await getGitHubConfig(c.env, appDb);
  if (!ghConfig?.appId || !ghConfig?.appPrivateKey) {
    return c.redirect(`${frontendUrl}/settings?tab=repositories&error=app_not_configured`);
  }

  // Store the installation credential
  const metadata: Record<string, string> = { installationId };

  if (setupAction === 'install') {
    await storeCredential(c.env, ownerType, ownerId, providerId, {
      installation_id: installationId,
      app_id: ghConfig.appId,
      private_key: ghConfig.appPrivateKey,
    }, {
      credentialType: 'app_install',
      metadata,
    });
  }

  return c.redirect(`${frontendUrl}/settings?tab=repositories&installed=true`);
});
