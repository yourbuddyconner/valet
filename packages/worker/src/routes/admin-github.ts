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
import { getGitHubMetadata } from '../services/github-config.js';
import { loadGitHubApp } from '../services/github-app.js';
import { refreshAllInstallations } from '../services/github-installations.js';
import { listGithubInstallationsByAccountType } from '../lib/db/github-installations.js';
import { deleteCredentialsByProvider } from '../lib/db/credentials.js';
import { signJWT, verifyJWT } from '../lib/jwt.js';
import { getDb } from '../lib/drizzle.js';
import * as db from '../lib/db.js';
import { getServiceMetadata } from '../lib/db/service-configs.js';
import { githubInstallations } from '../lib/schema/github-installations.js';
import { userIdentityLinks } from '../lib/schema/channels.js';
import { users } from '../lib/schema/users.js';
import { eq, isNotNull } from 'drizzle-orm';

interface ManifestJWTPayload {
  sub: string;
  purpose: 'app-manifest';
  orgId?: string;
  jti: string;
  exp: number;
  iat: number;
}

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

  if (!svc || !svc.config.appId) {
    return c.json({
      appStatus: 'not_configured' as const,
      app: null,
      settings: {
        allowPersonalInstallations: true,
        allowAnonymousGitHubAccess: true,
      },
      installations: {
        organizations: [],
        personal: [],
      },
    });
  }

  const appDb = c.get('db');
  const orgs = await listGithubInstallationsByAccountType(appDb, 'Organization');
  const personal = await listGithubInstallationsByAccountType(appDb, 'User');

  return c.json({
    appStatus: 'configured' as const,
    app: {
      appId: svc.config.appId,
      appSlug: svc.config.appSlug,
      appOwner: svc.metadata.appOwner,
      appOwnerType: svc.metadata.appOwnerType,
      appName: svc.metadata.appName,
    },
    settings: {
      allowPersonalInstallations: svc.metadata.allowPersonalInstallations ?? true,
      allowAnonymousGitHubAccess: svc.metadata.allowAnonymousGitHubAccess ?? true,
    },
    installations: {
      organizations: orgs,
      personal,
    },
  });
});

/**
 * POST /api/admin/github/app/manifest — Generate manifest + form URL for GitHub App creation
 */
adminGitHubRouter.post('/app/manifest', async (c) => {
  const user = c.get('user');
  const body = await c.req.json<{
    githubOrg: string;
    permissions?: Record<string, string>;
    events?: string[];
  }>();

  if (!body.githubOrg?.trim()) {
    return c.json({ error: 'githubOrg is required' }, 400);
  }

  if (!/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(body.githubOrg.trim())) {
    return c.json({ error: 'Invalid GitHub organization name' }, 400);
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
    // signJWT expects SandboxJWTPayload but this is a manifest-flow JWT with different fields
    { sub: user.id, purpose: 'app-manifest', jti, iat: now, exp: now + 10 * 60 } as any,
    c.env.ENCRYPTION_KEY,
  );

  // Store jti for one-time consumption (10 min TTL) — use setServiceConfig (upsert) since the row may not exist yet
  await setServiceConfig(c.get('db'), c.env.ENCRYPTION_KEY, 'github_manifest_nonce', {}, { jti, exp: now + 600 }, user.id);

  const githubOrg = body.githubOrg.trim();

  // Default permissions — can be overridden by the caller
  const defaultPermissions: Record<string, string> = {
    contents: 'write',
    metadata: 'read',
    pull_requests: 'write',
    issues: 'write',
    actions: 'read',
    checks: 'read',
  };
  const defaultEvents = ['push', 'pull_request'];

  // Merge caller-provided permissions/events with defaults
  const permissions = body.permissions
    ? { ...defaultPermissions, ...body.permissions }
    : defaultPermissions;
  const events = body.events || defaultEvents;

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
    request_oauth_on_install: false,
    public: true,
    default_permissions: permissions,
    default_events: events,
  };

  const url = `https://github.com/organizations/${encodeURIComponent(githubOrg)}/settings/apps/new?state=${encodeURIComponent(state)}`;

  return c.json({ url, manifest });
});

/**
 * POST /api/admin/github/app/refresh — Re-sync installations from GitHub
 */
adminGitHubRouter.post('/app/refresh', async (c) => {
  const appDb = c.get('db');
  const app = await loadGitHubApp(c.env, appDb);
  if (!app) return c.json({ error: 'App not configured' }, 400);

  const { count } = await refreshAllInstallations(app, appDb);
  return c.json({ refreshed: true, installationCount: count });
});

/**
 * PUT /api/admin/github/settings — Update GitHub App settings
 */
adminGitHubRouter.put('/settings', async (c) => {
  const body = await c.req.json<{ allowPersonalInstallations?: boolean; allowAnonymousGitHubAccess?: boolean }>();
  const meta = await getGitHubMetadata(c.get('db')) ?? {};
  const updated = { ...meta };
  if (body.allowPersonalInstallations !== undefined) updated.allowPersonalInstallations = body.allowPersonalInstallations;
  if (body.allowAnonymousGitHubAccess !== undefined) updated.allowAnonymousGitHubAccess = body.allowAnonymousGitHubAccess;
  await updateServiceMetadata(c.get('db'), 'github', updated);
  return c.json({ success: true, settings: updated });
});

/**
 * GET /api/admin/github/installations — List installations by type
 */
adminGitHubRouter.get('/installations', async (c) => {
  const appDb = c.get('db');
  const orgs = await listGithubInstallationsByAccountType(appDb, 'Organization');
  const personal = await listGithubInstallationsByAccountType(appDb, 'User');
  return c.json({ organizations: orgs, personal });
});

/**
 * DELETE /api/admin/github — Danger zone: remove entire GitHub config
 */
adminGitHubRouter.delete('/', async (c) => {
  const appDb = c.get('db');

  // Delete all github_installations rows
  await appDb.delete(githubInstallations);

  // Delete all github credentials from the credentials table
  await deleteCredentialsByProvider(appDb, 'github');

  // Delete the service config row
  await deleteServiceConfig(appDb, 'github');

  // Clean up manifest nonce
  await deleteServiceConfig(appDb, 'github_manifest_nonce').catch(() => {});

  // Clear GitHub identity links and user GitHub fields
  await appDb.delete(userIdentityLinks).where(eq(userIdentityLinks.provider, 'github'));
  await appDb.update(users).set({ githubId: null, githubUsername: null }).where(isNotNull(users.githubId));

  return c.json({ success: true });
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
    return c.redirect(`${frontendUrl}/settings/admin?error=missing_params`);
  }

  // Verify state JWT
  const payload = await verifyJWT(stateParam, c.env.ENCRYPTION_KEY);
  const manifestPayload = payload as unknown as ManifestJWTPayload;
  if (!payload || !payload.sub || manifestPayload.purpose !== 'app-manifest') {
    return c.redirect(`${frontendUrl}/settings/admin?error=invalid_state`);
  }

  // Check jti for replay protection
  const appDb = getDb(c.env.DB);
  const nonceStore = await getServiceMetadata<{ jti: string; exp: number }>(appDb, 'github_manifest_nonce').catch(() => null);
  if (!nonceStore || nonceStore.jti !== manifestPayload.jti) {
    return c.redirect(`${frontendUrl}/settings/admin?error=invalid_or_replayed_state`);
  }
  if (nonceStore.exp && Date.now() / 1000 > nonceStore.exp) {
    // Nonce expired — user took too long
    return c.redirect(`${frontendUrl}/settings/admin?error=${encodeURIComponent('Manifest flow expired. Please try again.')}`);
  }
  // Exchange code for app credentials
  const conversionRes = await fetch(`https://api.github.com/app-manifests/${code}/conversions`, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'valet-app',
    },
  });

  if (!conversionRes.ok) {
    const errText = await conversionRes.text();
    console.error('GitHub manifest conversion failed:', conversionRes.status, errText);
    // Don't consume nonce — GitHub's code is one-time use so retry won't work,
    // but leaving the nonce unconsumed is harmless and avoids masking the real error.
    return c.redirect(`${frontendUrl}/settings/admin?error=conversion_failed`);
  }

  // Consume the nonce after successful conversion
  await updateServiceMetadata(appDb, 'github_manifest_nonce', { jti: '', exp: 0 });

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

  const config: GitHubServiceConfig = {
    appOauthClientId: appData.client_id,
    appOauthClientSecret: appData.client_secret,
    appId: String(appData.id),
    appPrivateKey: appData.pem,
    appSlug: appData.slug,
    appWebhookSecret: appData.webhook_secret,
  };

  const metadata: GitHubServiceMetadata = {
    appOwner: appData.owner.login,
    appOwnerType: appData.owner.type,
    appName: appData.name,
    allowPersonalInstallations: true,
    allowAnonymousGitHubAccess: true,
  };

  const userId = payload.sub as string;
  await setServiceConfig(appDb, c.env.ENCRYPTION_KEY, 'github', config, metadata, userId);

  return c.redirect(`${frontendUrl}/settings/admin?created=true`);
});
