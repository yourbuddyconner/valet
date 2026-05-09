import { Hono } from 'hono';
import type { Env, Variables } from '../env.js';
import { signJWT, verifyJWT } from '../lib/jwt.js';
import { identityRegistry } from '../identity/registry.js';
import { getEnvString } from '../env.js';
import * as oauthService from '../services/oauth.js';
import type { ProviderConfig } from '@valet/sdk/identity';
import { getOrgSettings } from '../lib/db.js';
import { getDb } from '../lib/drizzle.js';

export const oauthRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

// ─── Login Attempt Tracking ──────────────────────────────────────────────────

const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const MAX_TRACKED_EMAILS = 10_000;

const loginAttempts = new Map<string, { count: number; firstAttempt: number }>();

/** Evict expired entries when the map exceeds the size cap. */
function evictExpiredAttempts(): void {
  if (loginAttempts.size <= MAX_TRACKED_EMAILS) return;
  const now = Date.now();
  for (const [key, entry] of loginAttempts) {
    if (now - entry.firstAttempt > LOCKOUT_WINDOW_MS) loginAttempts.delete(key);
  }
  // If still over limit after evicting expired, drop oldest entries
  if (loginAttempts.size > MAX_TRACKED_EMAILS) {
    const excess = loginAttempts.size - MAX_TRACKED_EMAILS;
    const keys = loginAttempts.keys();
    for (let i = 0; i < excess; i++) keys.next().value && loginAttempts.delete(keys.next().value!);
  }
}

function checkLoginAttempts(email: string): { allowed: boolean; retryAfterSeconds?: number } {
  const key = email.toLowerCase();
  const entry = loginAttempts.get(key);
  if (!entry) return { allowed: true };

  const elapsed = Date.now() - entry.firstAttempt;
  if (elapsed > LOCKOUT_WINDOW_MS) {
    loginAttempts.delete(key);
    return { allowed: true };
  }

  if (entry.count >= MAX_LOGIN_ATTEMPTS) {
    return { allowed: false, retryAfterSeconds: Math.ceil((LOCKOUT_WINDOW_MS - elapsed) / 1000) };
  }
  return { allowed: true };
}

function recordFailedLogin(email: string): void {
  const key = email.toLowerCase();
  const entry = loginAttempts.get(key);
  if (!entry || Date.now() - entry.firstAttempt > LOCKOUT_WINDOW_MS) {
    loginAttempts.set(key, { count: 1, firstAttempt: Date.now() });
  } else {
    entry.count++;
  }
  evictExpiredAttempts();
}

function clearLoginAttempts(email: string): void {
  loginAttempts.delete(email.toLowerCase());
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function createStateJWT(env: Env, provider: string, inviteCode?: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const payload: any = { sub: provider, sid: crypto.randomUUID(), iat: now, exp: now + 5 * 60 };
  if (inviteCode) {
    payload.invite_code = inviteCode;
  }
  return signJWT(payload, env.ENCRYPTION_KEY);
}

async function parseStateJWT(state: string, env: Env): Promise<{ valid: boolean; inviteCode?: string; provider?: string }> {
  const payload = await verifyJWT(state, env.ENCRYPTION_KEY);
  if (!payload) return { valid: false };
  return {
    valid: true,
    inviteCode: (payload as any).invite_code,
    provider: (payload as any).sub,
  };
}

function getFrontendUrl(env: Env): string {
  return env.FRONTEND_URL || 'http://localhost:5173';
}

function getWorkerUrl(_env: Env, req: Request): string {
  const url = new URL(req.url);
  return `${url.protocol}//${url.host}`;
}

function resolveProviderConfig(env: Env, provider: { configKeys: string[] }): ProviderConfig {
  const config: ProviderConfig = {};
  for (const key of provider.configKeys) {
    const value = getEnvString(env, key);
    if (value) {
      if (key.endsWith('_CLIENT_ID')) config.clientId = value;
      else if (key.endsWith('_CLIENT_SECRET')) config.clientSecret = value;
      else config[key] = value;
    }
  }
  return config;
}

// ─── Public Routes ───────────────────────────────────────────────────────────

// GET /auth/providers — list enabled identity providers (no auth required)
oauthRouter.get('/providers', async (c) => {
  let providers = identityRegistry.listEnabled();

  // Filter by org-level enabled login providers if configured
  try {
    const appDb = getDb(c.env.DB);
    const settings = await getOrgSettings(appDb);
    if (settings.enabledLoginProviders && settings.enabledLoginProviders.length > 0) {
      const allowed = new Set(settings.enabledLoginProviders);
      providers = providers.filter(p => allowed.has(p.id));
    }
  } catch (err) {
    console.warn('[auth/providers] Failed to load org login provider config, showing all:', err);
  }

  return c.json(providers.map(p => ({
    id: p.id,
    displayName: p.displayName,
    icon: p.icon,
    brandColor: p.brandColor,
    protocol: p.protocol,
  })));
});

// POST /auth/email/login — email/password login
oauthRouter.post('/email/login', async (c) => {
  const { email, password } = await c.req.json<{ email: string; password: string }>();

  if (!email || !password) {
    return c.json({ error: 'Email and password are required' }, 400);
  }

  const attemptCheck = checkLoginAttempts(email);
  if (!attemptCheck.allowed) {
    return c.json({ error: 'too_many_attempts', retryAfterSeconds: attemptCheck.retryAfterSeconds }, 429);
  }

  try {
    const result = await oauthService.handleEmailLogin(c.env, { email, password });
    if (!result.ok) {
      recordFailedLogin(email);
      return c.json({ error: result.error }, 401);
    }
    clearLoginAttempts(email);
    return c.json({ sessionToken: result.sessionToken });
  } catch (err) {
    console.error('Email login error:', err);
    recordFailedLogin(email);
    return c.json({ error: 'login_failed' }, 500);
  }
});

// POST /auth/email/register — email/password registration
oauthRouter.post('/email/register', async (c) => {
  const { email, password, name, inviteCode } = await c.req.json<{
    email: string;
    password: string;
    name?: string;
    inviteCode?: string;
  }>();

  if (!email || !password) {
    return c.json({ error: 'Email and password are required' }, 400);
  }

  // Password strength: minimum 8 chars and at least one special character
  if (password.length < 8) {
    return c.json({ error: 'Password must be at least 8 characters' }, 400);
  }
  if (!/[^a-zA-Z0-9]/.test(password)) {
    return c.json({ error: 'Password must contain at least one special character' }, 400);
  }

  try {
    const result = await oauthService.handleEmailRegister(c.env, { email, password, name, inviteCode });
    if (!result.ok) return c.json({ error: result.error }, 400);
    return c.json({ sessionToken: result.sessionToken });
  } catch (err) {
    console.error('Email register error:', err);
    return c.json({ error: 'registration_failed' }, 500);
  }
});

// Check if a login provider is enabled at the org level
async function isLoginProviderEnabled(env: Env, providerId: string): Promise<boolean> {
  try {
    const appDb = getDb(env.DB);
    const settings = await getOrgSettings(appDb);
    if (settings.enabledLoginProviders && settings.enabledLoginProviders.length > 0) {
      return settings.enabledLoginProviders.includes(providerId);
    }
  } catch {
    // Fall through — if we can't check, allow it
  }
  return true; // null/empty = all enabled
}

// GET /auth/:provider — redirect to identity provider (OAuth/OIDC/SAML)
oauthRouter.get('/:provider', async (c) => {
  const providerId = c.req.param('provider');
  const provider = identityRegistry.get(providerId);
  if (!provider) return c.redirect(`${getFrontendUrl(c.env)}/login?error=unknown_provider`);
  if (provider.protocol === 'credentials') return c.redirect(`${getFrontendUrl(c.env)}/login?error=use_form`);
  if (!provider.getAuthUrl) return c.redirect(`${getFrontendUrl(c.env)}/login?error=no_redirect`);

  if (!(await isLoginProviderEnabled(c.env, providerId))) {
    return c.redirect(`${getFrontendUrl(c.env)}/login?error=provider_disabled`);
  }

  const inviteCode = c.req.query('invite_code');
  const state = await createStateJWT(c.env, providerId, inviteCode);
  const workerUrl = getWorkerUrl(c.env, c.req.raw);
  const callbackUrl = `${workerUrl}/auth/${providerId}/callback`;
  const config = resolveProviderConfig(c.env, provider);
  const authUrl = provider.getAuthUrl(config, callbackUrl, state);

  return c.redirect(authUrl);
});

/**
 * Handle an OAuth/OIDC login callback for a given provider.
 * Extracted so it can be called from the oauthRouter for non-GitHub providers.
 * GitHub login is handled directly by githubAuthRouter.
 */
export async function handleLoginOAuthCallback(
  env: Env,
  req: Request,
  providerId: string,
  code: string,
  state: string,
): Promise<Response> {
  const frontendUrl = getFrontendUrl(env);

  const stateResult = await parseStateJWT(state, env);
  if (!stateResult.valid) return Response.redirect(`${frontendUrl}/login?error=invalid_state`, 302);

  // Verify state was issued for this provider (prevents cross-provider state confusion)
  if (stateResult.provider !== providerId) {
    return Response.redirect(`${frontendUrl}/login?error=invalid_state`, 302);
  }

  const provider = identityRegistry.get(providerId);
  if (!provider) return Response.redirect(`${frontendUrl}/login?error=unknown_provider`, 302);

  if (!(await isLoginProviderEnabled(env, providerId))) {
    return Response.redirect(`${frontendUrl}/login?error=provider_disabled`, 302);
  }

  try {
    const workerUrl = getWorkerUrl(env, req);
    const config = resolveProviderConfig(env, provider);
    const identity = await provider.handleCallback(config, {
      code,
      state,
      redirectUri: `${workerUrl}/auth/${providerId}/callback`,
    });

    const result = await oauthService.finalizeIdentityLogin(env, identity, providerId, stateResult.inviteCode);
    if (!result.ok) return Response.redirect(`${frontendUrl}/login?error=${result.error}`, 302);

    return Response.redirect(
      `${frontendUrl}/auth/callback?token=${encodeURIComponent(result.sessionToken)}&provider=${providerId}`,
      302,
    );
  } catch (err) {
    console.error(`${providerId} OAuth error:`, err);
    return Response.redirect(`${frontendUrl}/login?error=oauth_error`, 302);
  }
}

// GET /auth/:provider/callback — handle OAuth/OIDC callback
oauthRouter.get('/:provider/callback', async (c) => {
  const providerId = c.req.param('provider');
  const code = c.req.query('code');
  const state = c.req.query('state');
  const frontendUrl = getFrontendUrl(c.env);

  if (!code || !state) return c.redirect(`${frontendUrl}/login?error=missing_params`);

  return handleLoginOAuthCallback(c.env, c.req.raw, providerId, code, state);
});

// POST /auth/:provider/callback — handle SAML POST callback
oauthRouter.post('/:provider/callback', async (c) => {
  const frontendUrl = getFrontendUrl(c.env);
  const providerId = c.req.param('provider');
  const provider = identityRegistry.get(providerId);
  if (!provider) return c.redirect(`${frontendUrl}/login?error=unknown_provider`);

  try {
    const body = await c.req.parseBody();

    // Validate RelayState (same signed JWT used for OAuth state)
    const relayState = body.RelayState as string | undefined;
    if (!relayState) return c.redirect(`${frontendUrl}/login?error=missing_state`);
    const stateResult = await parseStateJWT(relayState, c.env);
    if (!stateResult.valid) return c.redirect(`${frontendUrl}/login?error=invalid_state`);
    if (stateResult.provider !== providerId) return c.redirect(`${frontendUrl}/login?error=invalid_state`);

    const config = resolveProviderConfig(c.env, provider);
    const identity = await provider.handleCallback(config, {
      samlResponse: body.SAMLResponse as string,
    });

    const result = await oauthService.finalizeIdentityLogin(c.env, identity, providerId, stateResult.inviteCode);
    if (!result.ok) return c.redirect(`${frontendUrl}/login?error=${result.error}`);

    return c.redirect(
      `${frontendUrl}/auth/callback?token=${encodeURIComponent(result.sessionToken)}&provider=${providerId}`
    );
  } catch (err) {
    console.error(`${providerId} SAML error:`, err);
    return c.redirect(`${frontendUrl}/login?error=auth_error`);
  }
});
