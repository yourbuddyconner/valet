import type { Env } from '../env.js';
import * as db from '../lib/db.js';
import { getDb } from '../lib/drizzle.js';
import { storeCredential } from '../services/credentials.js';

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
  provider: 'github' | 'google',
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

// ─── GitHub Callback ────────────────────────────────────────────────────────

export type OAuthCallbackResult =
  | { ok: true; sessionToken: string }
  | { ok: false; error: string };

export async function handleGitHubCallback(
  env: Env,
  params: { code: string; inviteCode?: string; workerUrl: string },
): Promise<OAuthCallbackResult> {
  // Exchange code for access token
  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code: params.code,
      redirect_uri: `${params.workerUrl}/auth/github/callback`,
    }),
  });

  const tokenData = (await tokenRes.json()) as {
    access_token?: string;
    error?: string;
    scope?: string;
  };

  if (!tokenData.access_token) {
    console.error('GitHub token exchange failed:', tokenData.error);
    return { ok: false, error: 'token_exchange_failed' };
  }

  // Fetch GitHub user profile
  const profileRes = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${tokenData.access_token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Valet',
    },
  });

  if (!profileRes.ok) {
    return { ok: false, error: 'github_profile_failed' };
  }

  const profile = (await profileRes.json()) as {
    id: number;
    login: string;
    name: string | null;
    email: string | null;
    avatar_url: string;
  };

  // If email is null (private), fetch from /user/emails
  let email = profile.email;
  let primaryVisibility: 'public' | 'private' | null | undefined;
  if (!email) {
    const emailsRes = await fetch('https://api.github.com/user/emails', {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'Valet',
      },
    });

    if (emailsRes.ok) {
      const emails = (await emailsRes.json()) as Array<{
        email: string;
        primary: boolean;
        verified: boolean;
        visibility?: 'public' | 'private' | null;
      }>;
      const primary = emails.find((e) => e.primary && e.verified);
      const fallback = emails.find((e) => e.verified);
      primaryVisibility = primary?.visibility ?? fallback?.visibility;
      email = primary?.email || fallback?.email || null;
    }
  }

  if (!email) {
    return { ok: false, error: 'no_email' };
  }

  if (!(await isEmailAllowed(env, email, params.inviteCode))) {
    return { ok: false, error: 'not_allowed' };
  }

  const githubId = String(profile.id);

  const appDb = getDb(env.DB);
  // Find user by github_id, then by email, or create new
  let user = await db.findUserByGitHubId(appDb, githubId);
  let isNewUser = false;

  if (!user) {
    user = await db.findUserByEmail(appDb, email);
  }

  if (!user) {
    user = await db.getOrCreateUser(appDb, {
      id: crypto.randomUUID(),
      email,
      name: profile.name || profile.login,
      avatarUrl: profile.avatar_url,
    });
    isNewUser = true;

    const userCount = await db.getUserCount(appDb);
    if (userCount === 1) {
      await db.updateUserRole(appDb, user.id, 'admin');
    }
  }

  // Update GitHub-specific fields
  await db.updateUserGitHub(appDb, user.id, {
    githubId,
    githubUsername: profile.login,
    name: profile.name || undefined,
    avatarUrl: profile.avatar_url,
  });

  // Auto-populate git config if not already set
  const shouldUseNoReply = profile.email === null || (primaryVisibility && primaryVisibility !== 'public');
  const inferredGitName = profile.name || profile.login;
  const inferredGitEmail = shouldUseNoReply
    ? `${profile.id}+${profile.login}@users.noreply.github.com`
    : email;
  const shouldUpdateGitName = !user.gitName;
  const shouldUpdateGitEmail = !user.gitEmail
    || (shouldUseNoReply && (user.gitEmail === user.email || user.gitEmail === email));
  if (shouldUpdateGitName || shouldUpdateGitEmail) {
    await db.updateUserProfile(appDb, user.id, {
      gitName: shouldUpdateGitName ? inferredGitName : user.gitName,
      gitEmail: shouldUpdateGitEmail ? inferredGitEmail : user.gitEmail,
    });
  }

  // Store OAuth credential
  await storeCredential(env, 'user', user.id, 'github', {
    access_token: tokenData.access_token,
  }, {
    credentialType: 'oauth2',
    scopes: tokenData.scope || 'repo read:user user:email',
  });

  // Auto-provision GitHub integration so tools are available immediately
  await db.ensureIntegration(appDb, user.id, 'github');

  const sessionToken = await finalizeUserLogin(env, user, isNewUser, params.inviteCode, email, 'github');
  return { ok: true, sessionToken };
}

// ─── Google Callback ────────────────────────────────────────────────────────

export async function handleGoogleCallback(
  env: Env,
  params: { code: string; inviteCode?: string; workerUrl: string },
): Promise<OAuthCallbackResult> {
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

  // Decode id_token JWT
  const idTokenParts = tokenData.id_token.split('.');
  const payload = JSON.parse(atob(idTokenParts[1])) as {
    sub: string;
    email: string;
    email_verified: boolean;
    name?: string;
    picture?: string;
  };

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

    const userCount = await db.getUserCount(appDb);
    if (userCount === 1) {
      await db.updateUserRole(appDb, user.id, 'admin');
    }
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
