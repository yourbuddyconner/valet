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
 * PUT /api/admin/github/app — Set GitHub App credentials
 */
adminGitHubRouter.put('/app', async (c) => {
  const user = c.get('user');
  const body = await c.req.json<{
    appId: string;
    appPrivateKey: string;
    appSlug?: string;
    appWebhookSecret?: string;
  }>();

  if (!body.appId || !body.appPrivateKey) {
    return c.json({ error: 'appId and appPrivateKey are required' }, 400);
  }

  // Read existing config to preserve OAuth fields
  const existing = await getServiceConfig<GitHubServiceConfig, GitHubServiceMetadata>(
    c.get('db'), c.env.ENCRYPTION_KEY, 'github',
  );

  if (!existing?.config.oauthClientId) {
    return c.json({ error: 'OAuth must be configured before adding App credentials' }, 400);
  }

  const config: GitHubServiceConfig = {
    oauthClientId: existing.config.oauthClientId,
    oauthClientSecret: existing.config.oauthClientSecret,
    appId: body.appId,
    appPrivateKey: body.appPrivateKey,
    appSlug: body.appSlug,
    appWebhookSecret: body.appWebhookSecret,
  };

  await setServiceConfig(c.get('db'), c.env.ENCRYPTION_KEY, 'github', config, existing.metadata || {}, user.id);
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
 * DELETE /api/admin/github/app — Remove just the App credentials, keep OAuth
 */
adminGitHubRouter.delete('/app', async (c) => {
  const user = c.get('user');
  const existing = await getServiceConfig<GitHubServiceConfig, GitHubServiceMetadata>(
    c.get('db'), c.env.ENCRYPTION_KEY, 'github',
  );

  if (!existing) {
    return c.json({ error: 'GitHub is not configured' }, 404);
  }

  const config: GitHubServiceConfig = {
    oauthClientId: existing.config.oauthClientId,
    oauthClientSecret: existing.config.oauthClientSecret,
    // App fields removed
  };

  await setServiceConfig(c.get('db'), c.env.ENCRYPTION_KEY, 'github', config, {}, user.id);
  return c.json({ success: true });
});

/**
 * POST /api/admin/github/app/verify — Test App config, store installation and accessible owners
 */
adminGitHubRouter.post('/app/verify', async (c) => {
  const existing = await getServiceConfig<GitHubServiceConfig, GitHubServiceMetadata>(
    c.get('db'), c.env.ENCRYPTION_KEY, 'github',
  );

  if (!existing?.config.appId || !existing?.config.appPrivateKey) {
    return c.json({ error: 'GitHub App not configured' }, 400);
  }

  // Mint a JWT from App credentials
  const now = Math.floor(Date.now() / 1000);
  const b64url = (s: string) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({
    iat: now - 60,
    exp: now + (10 * 60),
    iss: existing.config.appId,
  }));

  // Import private key and sign
  let appJwt: string;
  try {
    const pemBody = existing.config.appPrivateKey
      .replace(/-----BEGIN RSA PRIVATE KEY-----/, '')
      .replace(/-----END RSA PRIVATE KEY-----/, '')
      .replace(/\s/g, '');
    const keyData = Uint8Array.from(atob(pemBody), (ch) => ch.charCodeAt(0));
    const key = await crypto.subtle.importKey(
      'pkcs8',
      keyData,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const signature = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      key,
      new TextEncoder().encode(`${header}.${payload}`),
    );
    const sig = btoa(String.fromCharCode(...new Uint8Array(signature)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    appJwt = `${header}.${payload}.${sig}`;
  } catch {
    return c.json({ error: 'Failed to sign JWT with private key — check that the key is valid' }, 400);
  }

  // Get installations
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
  if (installations.length === 0) {
    return c.json({ error: 'No installations found for this GitHub App' }, 400);
  }

  // Use first installation
  const installation = installations[0];
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

  // List accessible repositories to get owner set
  const reposRes = await fetch('https://api.github.com/installation/repositories?per_page=100', {
    headers: {
      Authorization: `Bearer ${tokenData.token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'valet-app',
    },
  });

  const reposData = await reposRes.json() as {
    repositories: Array<{ owner: { login: string } }>;
  };

  const accessibleOwners = [...new Set(reposData.repositories.map((r) => r.owner.login))];

  // Update metadata with installation info
  const metadata: GitHubServiceMetadata = {
    ...existing.metadata,
    appInstallationId: installationId,
    accessibleOwners,
    accessibleOwnersRefreshedAt: new Date().toISOString(),
  };

  await updateServiceMetadata(c.get('db'), 'github', metadata);

  // Store org-level app_install credential so resolveRepoCredential can find it
  const orgSettings = await db.getOrgSettings(c.get('db'));
  if (orgSettings?.id) {
    await storeCredential(c.env, 'org', orgSettings.id, 'github', {
      installation_id: installationId,
      app_id: existing.config.appId!,
      private_key: existing.config.appPrivateKey!,
    }, {
      credentialType: 'app_install',
      metadata: { installationId },
    });
  }

  return c.json({
    success: true,
    installationId,
    accessibleOwners,
    repositoryCount: reposData.repositories.length,
  });
});
