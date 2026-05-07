import { Hono } from 'hono';
import { Octokit } from 'octokit';
import type { Env, Variables } from '../env.js';
import { signJWT, verifyJWT } from '../lib/jwt.js';
import { loadGitHubApp } from '../services/github-app.js';
import { storeCredential } from '../services/credentials.js';
import * as oauthService from '../services/oauth.js';
import { reconcileUserInstallations } from '../services/github-installations.js';
import * as db from '../lib/db.js';
import { getDb } from '../lib/drizzle.js';

export const githubAuthRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

const LOGIN_STATE_TTL = 5 * 60; // 5 minutes for login
const LINK_STATE_TTL = 10 * 60; // 10 minutes for link (matches existing github-me.ts)

// ─── GET / — Login initiation ───────────────────────────────────────────────

githubAuthRouter.get('/', async (c) => {
  const frontendUrl = c.env.FRONTEND_URL || 'http://localhost:5173';
  const appDb = getDb(c.env.DB);
  const app = await loadGitHubApp(c.env, appDb);
  if (!app) return c.redirect(`${frontendUrl}/login?error=github_not_configured`);

  const inviteCode = c.req.query('invite_code');
  const now = Math.floor(Date.now() / 1000);
  const state = await signJWT(
    {
      sub: 'github',
      sid: crypto.randomUUID(),
      iat: now,
      exp: now + LOGIN_STATE_TTL,
      ...(inviteCode ? { invite_code: inviteCode } : {}),
    },
    c.env.ENCRYPTION_KEY,
  );

  const workerUrl = new URL(c.req.url);
  const { url } = app.oauth.getWebFlowAuthorizationUrl({
    state,
    redirectUrl: `${workerUrl.origin}/auth/github/callback`,
  });

  return c.redirect(url);
});

// ─── GET /callback — Login + Link callback ──────────────────────────────────

githubAuthRouter.get('/callback', async (c) => {
  const frontendUrl = c.env.FRONTEND_URL || 'http://localhost:5173';
  const code = c.req.query('code');
  const stateParam = c.req.query('state');

  if (!code || !stateParam) {
    return c.redirect(`${frontendUrl}/login?error=missing_params`);
  }

  // Verify state JWT
  const payload = await verifyJWT(stateParam, c.env.ENCRYPTION_KEY);
  if (!payload || !payload.sub) {
    return c.redirect(`${frontendUrl}/login?error=invalid_state`);
  }

  const appDb = getDb(c.env.DB);
  const app = await loadGitHubApp(c.env, appDb);
  if (!app) {
    return c.redirect(`${frontendUrl}/login?error=github_not_configured`);
  }

  // Exchange code for token via GitHub App OAuth
  let authentication: {
    token: string;
    refreshToken?: string;
    expiresAt?: string;
    refreshTokenExpiresAt?: string;
  };
  try {
    const result = await app.oauth.createToken({ code });
    authentication = result.authentication;
  } catch (err) {
    console.error('[github-auth] Token exchange failed:', err);
    return c.redirect(`${frontendUrl}/login?error=token_exchange_failed`);
  }

  // Log token type for debugging attribution badge
  const tokenPrefix = authentication.token.substring(0, 4);
  console.log(`[github-auth] Token exchanged: prefix=${tokenPrefix}..., hasRefreshToken=${!!authentication.refreshToken}, expiresAt=${authentication.expiresAt || 'none'}`);

  // Fetch user profile
  const userOctokit = new Octokit({ auth: authentication.token });
  let profile: { id: number; login: string; email: string | null; name: string | null; avatar_url: string };
  try {
    const { data } = await userOctokit.rest.users.getAuthenticated();
    profile = data;
  } catch (err) {
    console.error('[github-auth] Profile fetch failed:', err);
    return c.redirect(`${frontendUrl}/login?error=profile_fetch_failed`);
  }

  const githubId = String(profile.id);

  // Fetch primary verified email if not in profile
  let email = profile.email;
  if (!email) {
    try {
      const { data: emails } = await userOctokit.rest.users.listEmailsForAuthenticatedUser();
      const primary = emails.find((e) => e.primary && e.verified);
      email = primary?.email ?? null;
    } catch {
      // Not critical — email may not be available
    }
  }

  // ─── Branch: link flow ──────────────────────────────────────────────────

  if ((payload as any).purpose === 'github-link') {
    const userId = payload.sub as string;

    // Upsert identity link — remove any existing link for this GitHub account
    await db.deleteIdentityLinkByExternalId(appDb, 'github', githubId);

    // Also delete any other GitHub link for this user (re-link scenario)
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

    // Store credential
    const credentialData: Record<string, string> = { access_token: authentication.token };
    if (authentication.refreshToken) {
      credentialData.refresh_token = authentication.refreshToken;
    }
    await storeCredential(c.env, 'user', userId, 'github', credentialData, {
      credentialType: 'oauth2',
      expiresAt: authentication.expiresAt,
    });

    // Ensure GitHub integration is provisioned for tool discovery
    await db.ensureIntegration(appDb, userId, 'github');

    // Update user record with GitHub info — catch unique constraint on github_id
    try {
      await db.updateUserGitHub(appDb, userId, {
        githubId,
        githubUsername: profile.login,
        name: profile.name ?? undefined,
        avatarUrl: profile.avatar_url,
      });
    } catch (err: any) {
      if (err?.message?.includes('UNIQUE constraint failed') || err?.message?.includes('idx_users_github_id')) {
        return c.redirect(`${frontendUrl}/integrations?github=error&reason=account_already_linked`);
      }
      throw err;
    }

    // Reconcile personal installations
    try {
      await reconcileUserInstallations(userOctokit, appDb, userId, githubId);
    } catch (err) {
      console.warn('[github-auth] Installation reconciliation failed:', err);
    }

    return c.redirect(`${frontendUrl}/integrations?github=linked`);
  }

  // ─── Branch: login flow ─────────────────────────────────────────────────

  if (!email) {
    return c.redirect(`${frontendUrl}/login?error=no_email`);
  }

  const inviteCode = (payload as any).invite_code as string | undefined;

  // Finalize login via the standard identity flow
  const loginResult = await oauthService.finalizeIdentityLogin(
    c.env,
    {
      email,
      name: profile.name ?? undefined,
      username: profile.login,
      avatarUrl: profile.avatar_url,
      externalId: githubId,
      accessToken: authentication.token,
      refreshToken: authentication.refreshToken,
      scopes: undefined, // App-based OAuth doesn't use scopes the same way
      tokenExpiresAt: authentication.expiresAt,
    },
    'github',
    inviteCode,
  );

  if (!loginResult.ok) {
    return c.redirect(`${frontendUrl}/login?error=${loginResult.error}`);
  }

  // Login implicitly links: store credential for the newly logged-in user
  // Look up user by email to get the userId
  const user = await db.findUserByEmail(appDb, email);
  if (user) {
    // finalizeIdentityLogin stores a basic credential from the identity result,
    // but may not include the refresh token. We overwrite with the full token pair
    // (including refreshToken and expiresAt) to ensure token refresh works.
    const credentialData: Record<string, string> = { access_token: authentication.token };
    if (authentication.refreshToken) {
      credentialData.refresh_token = authentication.refreshToken;
    }
    await storeCredential(c.env, 'user', user.id, 'github', credentialData, {
      credentialType: 'oauth2',
      expiresAt: authentication.expiresAt,
    });

    // Reconcile personal installations
    try {
      await reconcileUserInstallations(userOctokit, appDb, user.id, githubId);
    } catch (err) {
      console.warn('[github-auth] Installation reconciliation failed:', err);
    }
  }

  return c.redirect(
    `${frontendUrl}/auth/callback?token=${encodeURIComponent(loginResult.sessionToken)}&provider=github`,
  );
});
