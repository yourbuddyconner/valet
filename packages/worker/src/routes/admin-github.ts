import { Hono } from 'hono';
import type { Env, Variables } from '../env.js';
import { adminMiddleware } from '../middleware/admin.js';
import {
  getServiceConfig,
  setServiceConfig,
  deleteServiceConfig,
  updateServiceMetadata,
} from '../lib/db/service-configs.js';
import type { GitHubServiceConfig, GitHubServiceMetadata } from '../services/github-config.js';
import { storeCredential } from '../services/credentials.js';
import { mintGitHubAppJWT } from '../services/github-app-jwt.js';
import { signJWT, verifyJWT } from '../lib/jwt.js';
import { getDb } from '../lib/drizzle.js';
import { getServiceMetadata } from '../lib/db/service-configs.js';
import * as db from '../lib/db.js';

export const adminGitHubRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

adminGitHubRouter.use('*', adminMiddleware);

/**
 * GET /api/admin/github — Get current GitHub config (secrets redacted)
 */
adminGitHubRouter.get('/', async (c) => {
  let svc: Awaited<ReturnType<typeof getServiceConfig<GitHubServiceConfig, GitHubServiceMetadata>>> = null;
  try {
    svc = await getServiceConfig<GitHubServiceConfig, GitHubServiceMetadata>(
      c.get('db'), c.env.ENCRYPTION_KEY, 'github',
    );
  } catch {
    // Table may not exist yet if migration hasn't been applied
  }

  if (!svc) {
    // Check env var fallback
    const hasEnvVars = !!c.env.GITHUB_CLIENT_ID;
    return c.json({
      source: hasEnvVars ? 'env' : 'none',
      oauth: hasEnvVars ? { configured: true, clientId: c.env.GITHUB_CLIENT_ID } : null,
      app: c.env.GITHUB_APP_ID
        ? { configured: true, appId: c.env.GITHUB_APP_ID, appSlug: c.env.GITHUB_APP_SLUG }
        : null,
    });
  }

  return c.json({
    source: 'database',
    oauth: {
      configured: true,
      clientId: svc.config.oauthClientId,
    },
    app: svc.config.appId
      ? {
          configured: true,
          appId: svc.config.appId,
          appSlug: svc.config.appSlug,
          installationId: svc.metadata.appInstallationId,
          accessibleOwners: svc.metadata.accessibleOwners,
          accessibleOwnersRefreshedAt: svc.metadata.accessibleOwnersRefreshedAt,
        }
      : null,
    configuredBy: svc.configuredBy,
    updatedAt: svc.updatedAt,
  });
});

/**
 * POST /api/admin/github/app/manifest — Generate manifest + form URL for GitHub App creation
 */
adminGitHubRouter.post('/app/manifest', async (c) => {
  const user = c.get('user');
  const body = await c.req.json<{ githubOrg: string }>();

  if (!body.githubOrg?.trim()) {
    return c.json({ error: 'githubOrg is required' }, 400);
  }

  // Check if app is already configured
  const existing = await getServiceConfig<GitHubServiceConfig, GitHubServiceMetadata>(
    c.get('db'), c.env.ENCRYPTION_KEY, 'github',
  ).catch(() => null);

  if (existing?.config.appId) {
    return c.json({ error: 'GitHub App is already configured. Delete it first to create a new one.' }, 400);
  }

  const orgSettings = await db.getOrgSettings(c.get('db'));
  const orgName = orgSettings?.name || 'Valet';
  const frontendUrl = (c.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');
  const workerUrl = (c.env.API_PUBLIC_URL || new URL(c.req.url).origin).replace(/\/$/, '');

  // Signed state JWT with jti for replay protection
  const now = Math.floor(Date.now() / 1000);
  const jti = crypto.randomUUID();
  const state = await signJWT(
    { sub: user.id, purpose: 'app-manifest', jti, iat: now, exp: now + 10 * 60 } as any,
    c.env.ENCRYPTION_KEY,
  );

  // Store jti for one-time consumption (10 min TTL)
  await updateServiceMetadata(c.get('db'), 'github_manifest_nonce', { jti, exp: now + 600 });

  const githubOrg = body.githubOrg.trim();
  const manifest = {
    name: `Valet (${orgName})`,
    url: frontendUrl,
    hook_attributes: {
      url: `${workerUrl}/api/webhooks/github`,
      active: true,
    },
    redirect_url: `${workerUrl}/github/app/setup`,
    callback_urls: [
      `${workerUrl}/auth/github/callback`,
      `${frontendUrl}/auth/github/repo-callback`,
    ],
    setup_url: `${workerUrl}/repo-providers/github/install/callback`,
    setup_events_enabled: true,
    public: false,
    default_permissions: {
      contents: 'read',
      metadata: 'read',
    },
    default_events: ['push', 'pull_request'],
  };

  const url = `https://github.com/organizations/${encodeURIComponent(githubOrg)}/settings/apps/new?state=${encodeURIComponent(state)}`;

  return c.json({ url, manifest });
});

/**
 * PUT /api/admin/github/oauth — Set OAuth App credentials
 */
adminGitHubRouter.put('/oauth', async (c) => {
  const user = c.get('user');
  const body = await c.req.json<{ clientId: string; clientSecret: string }>();

  if (!body.clientId || !body.clientSecret) {
    return c.json({ error: 'clientId and clientSecret are required' }, 400);
  }

  // Read existing config to preserve app fields
  const existing = await getServiceConfig<GitHubServiceConfig, GitHubServiceMetadata>(
    c.get('db'), c.env.ENCRYPTION_KEY, 'github',
  );

  const config: GitHubServiceConfig = {
    oauthClientId: body.clientId,
    oauthClientSecret: body.clientSecret,
    // Preserve existing app config if any
    ...(existing?.config.appId && {
      appId: existing.config.appId,
      appPrivateKey: existing.config.appPrivateKey,
      appSlug: existing.config.appSlug,
      appWebhookSecret: existing.config.appWebhookSecret,
    }),
  };

  const metadata: GitHubServiceMetadata = existing?.metadata || {};

  await setServiceConfig(c.get('db'), c.env.ENCRYPTION_KEY, 'github', config, metadata, user.id);
  return c.json({ success: true });
});

/**
 * DELETE /api/admin/github/oauth — Remove OAuth config (removes entire GitHub config)
 */
adminGitHubRouter.delete('/oauth', async (c) => {
  await deleteServiceConfig(c.get('db'), 'github');
  return c.json({ success: true });
});

/**
 * POST /api/admin/github/app/refresh — Re-sync installation metadata from GitHub
 */
adminGitHubRouter.post('/app/refresh', async (c) => {
  const existing = await getServiceConfig<GitHubServiceConfig, GitHubServiceMetadata>(
    c.get('db'), c.env.ENCRYPTION_KEY, 'github',
  );

  if (!existing?.config.appId || !existing?.config.appPrivateKey) {
    return c.json({ error: 'GitHub App not configured' }, 400);
  }

  let appJwt: string;
  try {
    appJwt = await mintGitHubAppJWT(existing.config.appId, existing.config.appPrivateKey);
  } catch {
    return c.json({ error: 'Failed to sign JWT with private key — check that the key is valid' }, 400);
  }

  // List installations
  const installsRes = await fetch('https://api.github.com/app/installations', {
    headers: {
      Authorization: `Bearer ${appJwt}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'valet-app',
    },
  });

  if (!installsRes.ok) {
    const errBody = await installsRes.text();
    return c.json({ error: `GitHub API error: ${installsRes.status} ${errBody}` }, 400);
  }

  const installations = await installsRes.json() as Array<{ id: number; account?: { login?: string } }>;

  // Enforce single-installation model
  let installation: (typeof installations)[0];
  const storedId = existing.metadata.appInstallationId;

  if (storedId) {
    const match = installations.find((i) => String(i.id) === storedId);
    if (!match) {
      return c.json({ error: `Stored installation ${storedId} not found. It may have been removed from GitHub.` }, 400);
    }
    installation = match;
  } else if (installations.length === 1) {
    installation = installations[0];
  } else if (installations.length === 0) {
    return c.json({ error: 'No installations found. Install the app on a GitHub organization first.' }, 400);
  } else {
    return c.json({
      error: `Found ${installations.length} installations but expected exactly one. Remove extra installations on GitHub and retry.`,
    }, 400);
  }

  const installationId = String(installation.id);

  // Get installation access token to list repositories
  const tokenRes = await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${appJwt}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'valet-app',
    },
  });

  if (!tokenRes.ok) {
    return c.json({ error: 'Failed to create installation access token' }, 400);
  }

  const tokenData = await tokenRes.json() as { token: string };

  // List accessible repositories
  const reposRes = await fetch('https://api.github.com/installation/repositories?per_page=100', {
    headers: {
      Authorization: `Bearer ${tokenData.token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'valet-app',
    },
  });

  const reposData = await reposRes.json() as {
    total_count: number;
    repositories: Array<{ owner: { login: string } }>;
  };

  const accessibleOwners = [...new Set(reposData.repositories.map((r) => r.owner.login))];

  // Update metadata
  const metadata: GitHubServiceMetadata = {
    ...existing.metadata,
    appInstallationId: installationId,
    accessibleOwners,
    accessibleOwnersRefreshedAt: new Date().toISOString(),
    repositoryCount: reposData.total_count,
  };

  await updateServiceMetadata(c.get('db'), 'github', metadata);

  // Update org-level app_install credential
  const orgSettings = await db.getOrgSettings(c.get('db'));
  if (orgSettings?.id) {
    await storeCredential(c.env, 'org', orgSettings.id, 'github', {
      installation_id: installationId,
      app_id: existing.config.appId,
      private_key: existing.config.appPrivateKey,
    }, {
      credentialType: 'app_install',
      metadata: { installationId },
    });
  }

  return c.json({
    installationId,
    accessibleOwners,
    repositoryCount: reposData.total_count,
  });
});

/**
 * GitHub App manifest callback — mounted outside /api/* (no auth middleware).
 * User identity is derived from the signed state JWT.
 */
export const githubAppSetupCallbackRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

githubAppSetupCallbackRouter.get('/app/setup', async (c) => {
  const code = c.req.query('code');
  const stateParam = c.req.query('state');
  const frontendUrl = (c.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');

  if (!code || !stateParam) {
    return c.redirect(`${frontendUrl}/settings?tab=github&error=missing_params`);
  }

  // Verify state JWT
  const payload = await verifyJWT(stateParam, c.env.ENCRYPTION_KEY);
  if (!payload || !payload.sub || (payload as any).purpose !== 'app-manifest') {
    return c.redirect(`${frontendUrl}/settings?tab=github&error=invalid_state`);
  }

  // Check jti for replay protection
  const appDb = getDb(c.env.DB);
  const nonceStore = await getServiceMetadata<{ jti: string; exp: number }>(appDb, 'github_manifest_nonce').catch(() => null);
  if (!nonceStore || nonceStore.jti !== (payload as any).jti) {
    return c.redirect(`${frontendUrl}/settings?tab=github&error=invalid_or_replayed_state`);
  }
  // Consume the nonce
  await updateServiceMetadata(appDb, 'github_manifest_nonce', { jti: '', exp: 0 });

  // Exchange code for app credentials
  const conversionRes = await fetch(`https://api.github.com/app-manifests/${code}/conversions`, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'valet-app',
    },
  });

  if (!conversionRes.ok) {
    const errText = await conversionRes.text();
    console.error('GitHub manifest conversion failed:', conversionRes.status, errText);
    return c.redirect(`${frontendUrl}/settings?tab=github&error=conversion_failed`);
  }

  const appData = await conversionRes.json() as {
    id: number;
    slug: string;
    name: string;
    client_id: string;
    client_secret: string;
    pem: string;
    webhook_secret: string;
    owner: { login: string; type: string };
  };

  // Store everything in org_service_configs
  const config: GitHubServiceConfig = {
    oauthClientId: appData.client_id,
    oauthClientSecret: appData.client_secret,
    appId: String(appData.id),
    appPrivateKey: appData.pem,
    appSlug: appData.slug,
    appWebhookSecret: appData.webhook_secret,
  };

  const metadata: GitHubServiceMetadata = {
    appOwner: appData.owner.login,
    appOwnerType: appData.owner.type,
    appName: appData.name,
  };

  const userId = payload.sub as string;
  await setServiceConfig(appDb, c.env.ENCRYPTION_KEY, 'github', config, metadata, userId);

  return c.redirect(`${frontendUrl}/settings?tab=github&created=true`);
});
