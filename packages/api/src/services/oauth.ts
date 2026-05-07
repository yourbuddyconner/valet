import type { Env } from '../env.js';
import type { IdentityResult } from '@valet/sdk/identity';
import * as db from '../lib/db.js';
import { getDb } from '../lib/drizzle.js';
import { storeCredential } from './credentials.js';
import { hashPassword, verifyPassword } from '@valet/plugin-email-auth/identity';
import { verifyGoogleIdToken } from '@valet/plugin-google-auth/identity';
import { getGitHubConfig } from './github-config.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function generateSessionToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function hashToken(token: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(token);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ─── Email Gating ───────────────────────────────────────────────────────────

export async function isEmailAllowed(
  env: Env,
  email: string,
  inviteCode?: string,
): Promise<boolean> {
  const appDb = getDb(env.DB);
  const emailLower = email.toLowerCase();

  // Existing users always bypass signup gating
  const existingUser = await db.findUserByEmail(appDb, emailLower);
  if (existingUser) return true;

  // If a valid invite code is provided, always allow
  if (inviteCode) {
    const invite = await db.getValidInviteByCode(appDb, inviteCode);
    if (invite) return true;
  }

  try {
    const orgSettings = await db.getOrgSettings(appDb);
    const domainGating = orgSettings.domainGatingEnabled;
    const emailAllowlist = orgSettings.emailAllowlistEnabled;

    if (domainGating && orgSettings.allowedEmailDomain) {
      const domain = emailLower.split('@')[1];
      if (domain === orgSettings.allowedEmailDomain.toLowerCase()) return true;
      if (!emailAllowlist) return false;
    }

    if (emailAllowlist && orgSettings.allowedEmails) {
      const allowed = orgSettings.allowedEmails.split(',').map((e) => e.trim().toLowerCase());
      if (allowed.includes(emailLower)) return true;
      if (domainGating) return false;
      return false;
    }

    if (domainGating || emailAllowlist) {
      return false;
    }

    // Check for a valid invite by email
    const invite = await db.getValidInviteByEmail(appDb, emailLower);
    if (invite) return true;
  } catch {
    // DB not available or table doesn't exist yet — fall through to env var
  }

  // Backward compat: env var fallback
  const allowed = env.ALLOWED_EMAILS;
  if (!allowed) return true;
  return allowed.split(',').map((e) => e.trim().toLowerCase()).includes(emailLower);
}

// ─── Finalize User Login ────────────────────────────────────────────────────

async function finalizeUserLogin(
  env: Env,
  user: NonNullable<Awaited<ReturnType<typeof db.findUserByEmail>>>,
  isNewUser: boolean,
  inviteCode: string | undefined,
  email: string,
  provider: string,
): Promise<string> {
  const appDb = getDb(env.DB);
  // Accept invite by code (if provided), or fall back to email-based invite
  if (inviteCode) {
    const invite = await db.getInviteByCode(appDb, inviteCode);
    if (invite) {
      await db.markInviteAccepted(appDb, invite.id, user.id);
      await db.updateUserRole(appDb, user.id, invite.role);
    }
  } else if (isNewUser) {
    const invite = await db.getInviteByEmail(appDb, email);
    if (invite) {
      await db.markInviteAccepted(appDb, invite.id, user.id);
      await db.updateUserRole(appDb, user.id, invite.role);
    }
  }

  // Generate session token
  const sessionToken = generateSessionToken();
  const tokenHash = await hashToken(sessionToken);
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  await db.createAuthSession(appDb, {
    id: crypto.randomUUID(),
    userId: user.id,
    tokenHash,
    provider,
    expiresAt,
  });

  return sessionToken;
}

// ─── Generic Identity Login ─────────────────────────────────────────────────

export type OAuthCallbackResult =
  | { ok: true; sessionToken: string }
  | { ok: false; error: string };

export async function finalizeIdentityLogin(
  env: Env,
  identity: IdentityResult,
  providerId: string,
  inviteCode?: string,
): Promise<OAuthCallbackResult> {
  if (!(await isEmailAllowed(env, identity.email, inviteCode))) {
    return { ok: false, error: 'not_allowed' };
  }

  const appDb = getDb(env.DB);
  let user: NonNullable<Awaited<ReturnType<typeof db.findUserByEmail>>> | null = null;
  let isNewUser = false;

  // Provider-specific lookup first (e.g., GitHub by github_id)
  if (providerId === 'github' && identity.externalId) {
    user = await db.findUserByGitHubId(appDb, identity.externalId);
  }

  // Then try by email
  if (!user) {
    user = await db.findUserByEmail(appDb, identity.email);
  }

  // Create if not found
  if (!user) {
    user = await db.getOrCreateUser(appDb, {
      id: crypto.randomUUID(),
      email: identity.email,
      name: identity.name,
      avatarUrl: identity.avatarUrl,
    });
    isNewUser = true;

    await db.promoteIfOnlyUser(appDb, user.id);
  }

  // Update provider-specific fields
  if (providerId === 'github' && identity.username) {
    await db.updateUserGitHub(appDb, user.id, {
      githubId: identity.externalId,
      githubUsername: identity.username,
      name: identity.name || undefined,
      avatarUrl: identity.avatarUrl,
    });
  }

  // Auto-populate git config if not already set
  if (!user.gitName || !user.gitEmail) {
    await db.updateUserProfile(appDb, user.id, {
      gitName: user.gitName || identity.name || identity.username || undefined,
      gitEmail: user.gitEmail || identity.email,
    });
  }

  // Store OAuth credential if the provider returned an access token
  if (identity.accessToken) {
    const credentialData: Record<string, string> = {
      access_token: identity.accessToken,
    };
    if (identity.refreshToken) {
      credentialData.refresh_token = identity.refreshToken;
    }
    await storeCredential(env, 'user', user.id, providerId, credentialData, {
      credentialType: 'oauth2',
      scopes: identity.scopes,
      expiresAt: identity.tokenExpiresAt,
    });
  }

  // Auto-provision GitHub integration so tools are available immediately
  if (providerId === 'github') {
    await db.ensureIntegration(appDb, user.id, 'github');
  }

  const sessionToken = await finalizeUserLogin(env, user, isNewUser, inviteCode, identity.email, providerId);
  return { ok: true, sessionToken };
}

// ─── Email/Password Login ───────────────────────────────────────────────────

export async function handleEmailLogin(
  env: Env,
  params: { email: string; password: string },
): Promise<OAuthCallbackResult> {
  const appDb = getDb(env.DB);
  const user = await db.findUserWithPasswordHash(appDb, params.email.toLowerCase());
  if (!user || !user.passwordHash) {
    return { ok: false, error: 'invalid_credentials' };
  }

  let valid: boolean;
  try {
    valid = await verifyPassword(params.password, user.passwordHash);
  } catch {
    return { ok: false, error: 'invalid_credentials' };
  }
  if (!valid) {
    return { ok: false, error: 'invalid_credentials' };
  }

  const sessionToken = await finalizeUserLogin(env, user, false, undefined, user.email, 'email');
  return { ok: true, sessionToken };
}

// ─── Email/Password Registration ────────────────────────────────────────────

export async function handleEmailRegister(
  env: Env,
  params: { email: string; password: string; name?: string; inviteCode?: string },
): Promise<OAuthCallbackResult> {
  const email = params.email.toLowerCase();

  if (!(await isEmailAllowed(env, email, params.inviteCode))) {
    return { ok: false, error: 'not_allowed' };
  }

  const appDb = getDb(env.DB);
  const existingUser = await db.findUserByEmail(appDb, email);
  if (existingUser) {
    return { ok: false, error: 'email_already_registered' };
  }

  const passwordHash = await hashPassword(params.password);

  const user = await db.getOrCreateUser(appDb, {
    id: crypto.randomUUID(),
    email,
    name: params.name,
  });

  // Store password hash and identity provider
  await db.updateUserPasswordHash(appDb, user.id, passwordHash, 'email');

  await db.promoteIfOnlyUser(appDb, user.id);

  // Handle invite
  if (params.inviteCode) {
    const invite = await db.getInviteByCode(appDb, params.inviteCode);
    if (invite) {
      await db.markInviteAccepted(appDb, invite.id, user.id);
      await db.updateUserRole(appDb, user.id, invite.role);
    }
  }

  const sessionToken = await finalizeUserLogin(env, user, true, params.inviteCode, email, 'email');
  return { ok: true, sessionToken };
}

export async function handleGoogleCallback(
  env: Env,
  params: { code: string; inviteCode?: string; workerUrl: string },
): Promise<OAuthCallbackResult> {
  const { storeCredential } = await import('../services/credentials.js');

  // Exchange code for tokens
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      code: params.code,
      grant_type: 'authorization_code',
      redirect_uri: `${params.workerUrl}/auth/google/callback`,
    }),
  });

  const tokenData = (await tokenRes.json()) as {
    access_token?: string;
    refresh_token?: string;
    id_token?: string;
    expires_in?: number;
    error?: string;
  };

  if (!tokenData.id_token) {
    console.error('Google token exchange failed:', tokenData.error);
    return { ok: false, error: 'token_exchange_failed' };
  }

  // Verify id_token signature and validate iss/aud/exp claims
  let payload: { sub: string; email: string; email_verified: boolean; name?: string; picture?: string };
  try {
    payload = await verifyGoogleIdToken(tokenData.id_token, env.GOOGLE_CLIENT_ID);
  } catch (err) {
    console.error('Google id_token verification failed:', err);
    return { ok: false, error: 'token_verification_failed' };
  }

  if (!payload.email || !payload.email_verified) {
    return { ok: false, error: 'email_not_verified' };
  }

  if (!(await isEmailAllowed(env, payload.email, params.inviteCode))) {
    return { ok: false, error: 'not_allowed' };
  }

  const appDb = getDb(env.DB);
  // Find user by email or create new
  let user = await db.findUserByEmail(appDb, payload.email);
  let isNewUser = false;

  if (!user) {
    user = await db.getOrCreateUser(appDb, {
      id: crypto.randomUUID(),
      email: payload.email,
      name: payload.name,
      avatarUrl: payload.picture,
    });
    isNewUser = true;

    await db.promoteIfOnlyUser(appDb, user.id);
  }

  // Auto-populate git config if not already set
  if (!user.gitName || !user.gitEmail) {
    await db.updateUserProfile(appDb, user.id, {
      gitName: user.gitName || payload.name || undefined,
      gitEmail: user.gitEmail || payload.email || undefined,
    });
  }

  // Store Google OAuth credential
  if (tokenData.access_token) {
    const credentialData: Record<string, string> = {
      access_token: tokenData.access_token,
    };
    if (tokenData.refresh_token) {
      credentialData.refresh_token = tokenData.refresh_token;
    }

    const expiresAt = tokenData.expires_in
      ? new Date(Date.now() + tokenData.expires_in * 1000).toISOString()
      : undefined;

    await storeCredential(env, 'user', user.id, 'google', credentialData, {
      credentialType: 'oauth2',
      scopes: 'openid email profile',
      expiresAt,
    });
  }

  const sessionToken = await finalizeUserLogin(env, user, isNewUser, params.inviteCode, payload.email, 'google');
  return { ok: true, sessionToken };
}
