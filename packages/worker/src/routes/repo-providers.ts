import { Hono } from 'hono';
import type { Env, Variables } from '../env.js';
import { signJWT } from '../lib/jwt.js';
import { repoProviderRegistry } from '../repos/registry.js';
import { getDb } from '../lib/drizzle.js';
import * as db from '../lib/db.js';
import { getGitHubConfig } from '../services/github-config.js';
import { listAllActiveInstallations } from '../lib/db/github-installations.js';
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

// GitHub OAuth repo-link flow was removed (TKAI-56) — it was dead code.
// The redirect_uri pointed to a non-existent client route and the callback
// never stored refresh_token or expiresAt. All GitHub linking now goes
// through github-auth.ts (/auth/github/callback) which uses the GitHub App's
// app.oauth.createToken() and properly stores the full token pair.

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

// List installations for a repo provider.
// Uses the github_installations table (unified App model), not the old
// app_install credentials in the credentials table.
repoProviderRouter.get('/:provider/installations', async (c) => {
  const providerId = c.req.param('provider');

  if (providerId !== 'github') {
    return c.json({ installations: [] });
  }

  const appDb = getDb(c.env.DB);
  const installations = await listAllActiveInstallations(appDb);

  return c.json({
    installations: installations.map(i => ({
      level: i.accountType === 'Organization' ? 'org' : 'personal',
      provider: providerId,
      accountLogin: i.accountLogin,
      accountType: i.accountType,
      createdAt: i.createdAt,
    })),
  });
});
