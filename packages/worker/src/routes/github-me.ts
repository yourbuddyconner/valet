import { Hono } from 'hono';
import type { Env, Variables } from '../env.js';
import { signJWT, verifyJWT } from '../lib/jwt.js';
import { handleLoginOAuthCallback } from './oauth.js';
import { getGitHubConfig, getGitHubMetadata } from '../services/github-config.js';
import { storeCredential } from '../services/credentials.js';
import { getCredentialRow, deleteCredential } from '../lib/db/credentials.js';
import * as db from '../lib/db.js';
import { getDb } from '../lib/drizzle.js';

// ─── Authenticated Router (mounted at /api/me/github) ──────────────────────

export const githubMeRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * GET / — Get user's GitHub status
 */
githubMeRouter.get('/', async (c) => {
  const user = c.get('user');
  const appDb = c.get('db');

  // Get org-level GitHub metadata (accessible owners)
  const ghMeta = await getGitHubMetadata(appDb);

  // Check if OAuth is configured at all
  const ghConfig = await getGitHubConfig(c.env, appDb);
  const oauthConfigured = !!ghConfig;

  // Get user's GitHub identity link
  const identityLinks = await db.getUserIdentityLinks(appDb, user.id);
  const githubLink = identityLinks.find((l) => l.provider === 'github');

  // Get user record for GitHub info
  const userRecord = await db.getUserById(appDb, user.id);

  // Check credential for scopes
  let scopes: string[] | undefined;
  if (githubLink) {
    const credRow = await getCredentialRow(appDb, 'user', user.id, 'github', 'oauth2');
    scopes = credRow?.scopes?.split(/[\s,]+/).filter(Boolean) ?? undefined;
  }

  return c.json({
    oauthConfigured,
    orgApp: {
      installed: !!ghMeta?.appInstallationId,
      accessibleOwners: ghMeta?.accessibleOwners ?? [],
    },
    personal: {
      linked: !!githubLink,
      githubUsername: userRecord?.githubUsername ?? githubLink?.externalName ?? null,
      githubId: userRecord?.githubId ?? githubLink?.externalId ?? null,
      email: userRecord?.email ?? null,
      avatarUrl: userRecord?.avatarUrl ?? null,
      scopes: scopes ?? null,
    },
  });
});

/**
 * POST /link — Initiate GitHub OAuth linking
 * Body: { scopes?: string[] }
 */
githubMeRouter.post('/link', async (c) => {
  const user = c.get('user');
  const body = await c.req.json<{ scopes?: string[] }>().catch(() => ({ scopes: undefined as string[] | undefined }));

  const ghConfig = await getGitHubConfig(c.env, c.get('db'));
  if (!ghConfig) {
    return c.json({ error: 'GitHub OAuth not configured' }, 400);
  }

  // Default scopes: read:user + user:email (identity only)
  // If scopes includes 'repo', add that too
  const requestedScopes = body.scopes || [];
  const scopeSet = new Set(['read:user', 'user:email', 'read:org', ...requestedScopes]);
  const scopeString = [...scopeSet].join(' ');

  // Create signed JWT state token (10 min expiry)
  const now = Math.floor(Date.now() / 1000);
  const state = await signJWT(
    { sub: user.id, sid: scopeString, purpose: 'github-link', iat: now, exp: now + 10 * 60 } as any,
    c.env.ENCRYPTION_KEY,
  );

  // The callback should go to the WORKER, not the frontend
  const workerOrigin = c.env.API_PUBLIC_URL || new URL(c.req.url).origin;
  const redirectUri = `${workerOrigin}/auth/github/callback`;

  const params = new URLSearchParams({
    client_id: ghConfig.oauthClientId,
    redirect_uri: redirectUri,
    scope: scopeString,
    state,
  });

  return c.json({ redirectUrl: `https://github.com/login/oauth/authorize?${params}` });
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

  // Delete only the GitHub OAuth credential (preserve any app_install credential)
  await deleteCredential(appDb, 'user', user.id, 'github', 'oauth2');

  // Clear githubId and githubUsername on user record
  await db.updateUserGitHub(appDb, user.id, {
    githubId: null,
    githubUsername: null,
  });

  return c.json({ success: true });
});

// ─── Public Callback Router (mounted at /auth/github) ───────────────────────

export const githubMeCallbackRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * GET /callback — GitHub OAuth callback
 * Handles both identity linking (purpose=github-link) and login OAuth.
 * If the state JWT is not for github-link, falls through to the login OAuth handler.
 */
githubMeCallbackRouter.get('/callback', async (c) => {
  const code = c.req.query('code');
  const stateParam = c.req.query('state');
  const frontendUrl = c.env.FRONTEND_URL || 'http://localhost:5173';

  if (!code || !stateParam) {
    return c.redirect(`${frontendUrl}/integrations?github=error&reason=missing_params`);
  }

  // Verify JWT state token
  const payload = await verifyJWT(stateParam, c.env.ENCRYPTION_KEY);
  if (!payload || !payload.sub) {
    return c.redirect(`${frontendUrl}/integrations?github=error&reason=invalid_state`);
  }

  // If this isn't a github-link flow, delegate to the login OAuth callback handler
  if ((payload as any).purpose !== 'github-link') {
    return handleLoginOAuthCallback(c.env, c.req.raw, 'github', code, stateParam);
  }

  const userId = payload.sub as string;
  const requestedScopes = (payload as any).sid as string; // scopes stored in sid field

  // Resolve GitHub config
  const appDb = getDb(c.env.DB);
  const ghConfig = await getGitHubConfig(c.env, appDb);
  if (!ghConfig) {
    return c.redirect(`${frontendUrl}/integrations?github=error&reason=not_configured`);
  }

  // Exchange code for access token
  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_id: ghConfig.oauthClientId,
      client_secret: ghConfig.oauthClientSecret,
      code,
    }),
  });

  const tokenData = (await tokenRes.json()) as {
    access_token?: string;
    error?: string;
    scope?: string;
  };

  if (!tokenData.access_token) {
    return c.redirect(`${frontendUrl}/integrations?github=error&reason=token_exchange_failed`);
  }

  // Store the actual granted scopes (not requested) — GitHub may grant more/fewer
  const grantedScopes = tokenData.scope || requestedScopes;

  // Fetch user profile
  const profileRes = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${tokenData.access_token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'valet-app',
    },
  });

  if (!profileRes.ok) {
    return c.redirect(`${frontendUrl}/integrations?github=error&reason=profile_fetch_failed`);
  }

  const profile = (await profileRes.json()) as {
    id: number;
    login: string;
    email?: string;
    name?: string;
    avatar_url?: string;
  };

  const githubId = String(profile.id);

  // Fetch emails if not in profile
  let email = profile.email;
  if (!email) {
    try {
      const emailsRes = await fetch('https://api.github.com/user/emails', {
        headers: {
          Authorization: `Bearer ${tokenData.access_token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'valet-app',
        },
      });
      if (emailsRes.ok) {
        const emails = (await emailsRes.json()) as Array<{
          email: string;
          primary: boolean;
          verified: boolean;
        }>;
        const primary = emails.find((e) => e.primary && e.verified);
        email = primary?.email;
      }
    } catch {
      // Not critical
    }
  }

  // Upsert identity link — delete any existing link for this GitHub account
  // (handles both re-linking by same user and transferring from another user)
  await db.deleteIdentityLinkByExternalId(appDb, 'github', githubId);

  // Also delete any other GitHub link for this user (e.g., previously linked a different account)
  const existingLinks = await db.getUserIdentityLinks(appDb, userId);
  const existingGithubLink = existingLinks.find((l) => l.provider === 'github');
  if (existingGithubLink) {
    await db.deleteIdentityLink(appDb, existingGithubLink.id, userId);
  }

  await db.createIdentityLink(appDb, {
    id: crypto.randomUUID(),
    userId,
    provider: 'github',
    externalId: githubId,
    externalName: profile.login,
  });

  // Store credential with scopes
  await storeCredential(c.env, 'user', userId, 'github', {
    access_token: tokenData.access_token,
  }, {
    credentialType: 'oauth2',
    scopes: grantedScopes,
  });

  // Keep tool discovery in sync with the dedicated GitHub link flow.
  await db.ensureIntegration(appDb, userId, 'github');

  // Update user record with GitHub info
  await db.updateUserGitHub(appDb, userId, {
    githubId,
    githubUsername: profile.login,
    name: profile.name,
    avatarUrl: profile.avatar_url,
  });

  return c.redirect(`${frontendUrl}/integrations?github=linked`);
});
