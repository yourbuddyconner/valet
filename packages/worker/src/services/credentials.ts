import { type OAuthConfig, refreshTokenPkce, refreshTokenWithClientCredentials } from '@valet/sdk';
import { type Env, getEnvString } from '../env.js';
import { encryptStringPBKDF2, decryptStringPBKDF2 } from '../lib/crypto.js';
import * as credentialDb from '../lib/db/credentials.js';
import * as mcpOAuthDb from '../lib/db/mcp-oauth.js';
import { getDb } from '../lib/drizzle.js';
import { log } from '../lib/log.js';
import { integrationRegistry } from '../integrations/registry.js';
import { getCustomMcpOAuthConfig, getCustomMcpOAuthConnector } from './custom-mcp-connectors.js';
import { createSafeFetchOutbound } from './safe-fetch-outbound.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export type CredentialType = 'oauth2' | 'api_key' | 'bot_token' | 'service_account' | 'app_install';

export interface ResolvedCredential {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
  scopes?: string[];
  credentialType: CredentialType;
  refreshed: boolean;
  /** Present when this credential is a bot token being used on behalf of a user. */
  attribution?: { name: string; email: string };
}

export interface CredentialResolutionError {
  service: string;
  reason: 'not_found' | 'expired' | 'refresh_failed' | 'decryption_failed' | 'revoked';
  message: string;
}

export type CredentialResult =
  | { ok: true; credential: ResolvedCredential }
  | { ok: false; error: CredentialResolutionError };

// ─── Internal Helpers ───────────────────────────────────────────────────────

interface CredentialData {
  access_token?: string;
  refresh_token?: string;
  api_key?: string;
  bot_token?: string;
  token?: string;
  [key: string]: unknown;
}

async function encryptCredentialData(data: Record<string, unknown>, secret: string): Promise<string> {
  return encryptStringPBKDF2(JSON.stringify(data), secret);
}

async function decryptCredentialData(encrypted: string, secret: string): Promise<CredentialData> {
  const json = await decryptStringPBKDF2(encrypted, secret);
  return JSON.parse(json) as CredentialData;
}

function extractAccessToken(data: CredentialData): string | undefined {
  return data.access_token || data.api_key || data.bot_token || data.token;
}

// ─── Google OAuth Refresh ───────────────────────────────────────────────────

async function refreshGoogleToken(
  env: Env,
  ownerType: string,
  ownerId: string,
  provider: string,
  data: CredentialData,
): Promise<CredentialResult> {
  if (!data.refresh_token) {
    return {
      ok: false,
      error: { service: provider, reason: 'refresh_failed', message: 'No refresh token available' },
    };
  }

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: data.refresh_token,
      grant_type: 'refresh_token',
    }),
  });

  if (!res.ok) {
    return {
      ok: false,
      error: { service: provider, reason: 'refresh_failed', message: `Google refresh failed: ${res.status}` },
    };
  }

  const refreshed = (await res.json()) as {
    access_token: string;
    expires_in: number;
    token_type: string;
  };

  const newData: CredentialData = {
    access_token: refreshed.access_token,
    refresh_token: data.refresh_token, // refresh token doesn't change
  };

  const expiresAt = new Date(Date.now() + refreshed.expires_in * 1000).toISOString();
  const encrypted = await encryptCredentialData(newData, env.ENCRYPTION_KEY);

  const db = getDb(env.DB);
  await credentialDb.upsertCredential(db, {
    id: crypto.randomUUID(),
    ownerType,
    ownerId,
    provider,
    credentialType: 'oauth2',
    encryptedData: encrypted,
    expiresAt,
  });

  return {
    ok: true,
    credential: {
      accessToken: refreshed.access_token,
      refreshToken: data.refresh_token,
      expiresAt: new Date(expiresAt),
      credentialType: 'oauth2',
      refreshed: true,
    },
  };
}

// ─── GitHub OAuth Refresh ───────────────────────────────────────────────────

async function refreshGitHubToken(
  env: Env,
  ownerType: string,
  ownerId: string,
  provider: string,
  data: CredentialData,
): Promise<CredentialResult> {
  if (!data.refresh_token) {
    return {
      ok: false,
      error: { service: provider, reason: 'refresh_failed', message: 'No refresh token available' },
    };
  }

  // Dynamic import to avoid circular dependency: credentials.ts → github-app.ts → credentials.ts
  const { loadGitHubApp } = await import('./github-app.js');
  const db = getDb(env.DB);
  const app = await loadGitHubApp(env, db);
  if (!app) {
    return {
      ok: false,
      error: { service: provider, reason: 'refresh_failed', message: 'GitHub App not configured' },
    };
  }

  try {
    const { authentication } = await app.oauth.refreshToken({
      refreshToken: data.refresh_token as string,
    });

    const newData: CredentialData = {
      access_token: authentication.token,
      refresh_token: authentication.refreshToken,
    };
    const expiresAt = authentication.expiresAt;
    const encrypted = await encryptCredentialData(newData, env.ENCRYPTION_KEY);

    await credentialDb.upsertCredential(db, {
      id: crypto.randomUUID(),
      ownerType,
      ownerId,
      provider,
      credentialType: 'oauth2',
      encryptedData: encrypted,
      expiresAt,
    });

    return {
      ok: true,
      credential: {
        accessToken: authentication.token,
        refreshToken: authentication.refreshToken,
        expiresAt: expiresAt ? new Date(expiresAt) : undefined,
        credentialType: 'oauth2',
        refreshed: true,
      },
    };
  } catch (err) {
    // Refresh failed — delete credential row so the user is forced to reconnect
    await credentialDb.deleteCredential(db, ownerType, ownerId, provider, 'oauth2');
    return {
      ok: false,
      error: {
        service: provider,
        reason: 'refresh_failed',
        message: 'GitHub connection expired, please reconnect',
      },
    };
  }
}

/** Try to resolve OAuthConfig from the provider's declared env key names. */
function resolveOAuthConfigForProvider(provider: string, env: Env): OAuthConfig | null {
  const prov = integrationRegistry.getProvider(provider);
  const keys = prov?.oauthEnvKeys;
  if (!keys) return null;
  const clientId = getEnvString(env, keys.clientId);
  const clientSecret = getEnvString(env, keys.clientSecret);
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

async function attemptRefresh(
  env: Env,
  ownerType: string,
  ownerId: string,
  provider: string,
  data: CredentialData,
): Promise<CredentialResult> {
  // Hardcoded paths for providers that existed before the generic mechanism
  switch (provider) {
    case 'google':
    case 'gmail':
    case 'google_calendar':
      return refreshGoogleToken(env, ownerType, ownerId, provider, data);
    case 'github':
      return refreshGitHubToken(env, ownerType, ownerId, provider, data);
  }

  // Generic path: use the provider's refreshOAuthTokens if available
  if (!data.refresh_token) {
    return {
      ok: false,
      error: { service: provider, reason: 'refresh_failed', message: 'No refresh token available' },
    };
  }

  // MCP OAuth path: use PKCE refresh with dynamically registered client
  const integrationProvider = integrationRegistry.getProvider(provider);
  if (integrationProvider?.mcpServerUrl) {
    const db = getDb(env.DB);
    const client = await mcpOAuthDb.getMcpOAuthClient(db, provider);
    if (client) {
      try {
        const tokens = await refreshTokenPkce({
          tokenEndpoint: client.tokenEndpoint,
          clientId: client.clientId,
          refreshToken: data.refresh_token,
          resource: integrationProvider.mcpServerUrl,
          fetch: createSafeFetchOutbound({ mode: 'oauth-token' }),
        });
        const newData: CredentialData = {
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token || data.refresh_token,
        };
        const expiresAt = tokens.expires_in
          ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
          : undefined;
        const encrypted = await encryptCredentialData(newData, env.ENCRYPTION_KEY);
        await credentialDb.upsertCredential(db, {
          id: crypto.randomUUID(),
          ownerType,
          ownerId,
          provider,
          credentialType: 'oauth2',
          encryptedData: encrypted,
          expiresAt,
        });
        return {
          ok: true,
          credential: {
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token || data.refresh_token,
            expiresAt: expiresAt ? new Date(expiresAt) : undefined,
            credentialType: 'oauth2',
            refreshed: true,
          },
        };
      } catch (err) {
        return {
          ok: false,
          error: {
            service: provider,
            reason: 'refresh_failed',
            message: `MCP PKCE refresh failed: ${err instanceof Error ? err.message : String(err)}`,
          },
        };
      }
    }
  }

  const db = getDb(env.DB);
  const customOAuthConnector = await getCustomMcpOAuthConnector(env, db, provider, 'default');
  if (customOAuthConnector && !customOAuthConnector.oauthClientId) {
    const client = await mcpOAuthDb.getMcpOAuthClient(db, provider);
    if (client) {
      try {
        const tokens = await refreshTokenPkce({
          tokenEndpoint: client.tokenEndpoint,
          clientId: client.clientId,
          refreshToken: data.refresh_token,
          resource: customOAuthConnector.serverUrl,
          fetch: createSafeFetchOutbound({ mode: 'oauth-token' }),
        });
        const newData: CredentialData = {
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token || data.refresh_token,
        };
        const expiresAt = tokens.expires_in
          ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
          : undefined;
        const encrypted = await encryptCredentialData(newData, env.ENCRYPTION_KEY);
        await credentialDb.upsertCredential(db, {
          id: crypto.randomUUID(),
          ownerType,
          ownerId,
          provider,
          credentialType: 'oauth2',
          encryptedData: encrypted,
          expiresAt,
        });
        return {
          ok: true,
          credential: {
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token || data.refresh_token,
            expiresAt: expiresAt ? new Date(expiresAt) : undefined,
            credentialType: 'oauth2',
            refreshed: true,
          },
        };
      } catch (err) {
        return {
          ok: false,
          error: {
            service: provider,
            reason: 'refresh_failed',
            message: `Custom MCP PKCE refresh failed: ${err instanceof Error ? err.message : String(err)}`,
          },
        };
      }
    }
  }

  const customOAuth = await getCustomMcpOAuthConfig(env, db, provider, 'default');
  if (customOAuth) {
    try {
      const tokens = await refreshTokenWithClientCredentials({
        tokenEndpoint: customOAuth.tokenEndpoint,
        clientId: customOAuth.clientId,
        clientSecret: customOAuth.clientSecret,
        tokenEndpointAuthMethod: customOAuth.tokenEndpointAuthMethod,
        refreshToken: data.refresh_token,
        resource: customOAuth.serverUrl,
        fetch: createSafeFetchOutbound({ mode: 'oauth-token' }),
      });
      const newData: CredentialData = {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token || data.refresh_token,
      };
      const expiresAt = tokens.expires_in
        ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
        : undefined;
      const encrypted = await encryptCredentialData(newData, env.ENCRYPTION_KEY);
      await credentialDb.upsertCredential(db, {
        id: crypto.randomUUID(),
        ownerType,
        ownerId,
        provider,
        credentialType: 'oauth2',
        encryptedData: encrypted,
        expiresAt,
      });
      return {
        ok: true,
        credential: {
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token || data.refresh_token,
          expiresAt: expiresAt ? new Date(expiresAt) : undefined,
          credentialType: 'oauth2',
          refreshed: true,
        },
      };
    } catch (err) {
      return {
        ok: false,
        error: {
          service: provider,
          reason: 'refresh_failed',
          message: `Custom MCP OAuth refresh failed: ${err instanceof Error ? err.message : String(err)}`,
        },
      };
    }
  }

  if (!integrationProvider?.refreshOAuthTokens) {
    return {
      ok: false,
      error: { service: provider, reason: 'refresh_failed', message: `No refresh handler for ${provider}` },
    };
  }

  const oauthConfig = resolveOAuthConfigForProvider(provider, env);
  if (!oauthConfig) {
    return {
      ok: false,
      error: { service: provider, reason: 'refresh_failed', message: `OAuth env vars missing for ${provider}` },
    };
  }

  try {
    const newCreds = await integrationProvider.refreshOAuthTokens(oauthConfig, data.refresh_token);
    const newData: CredentialData = {
      access_token: newCreds.access_token,
      refresh_token: newCreds.refresh_token || data.refresh_token,
    };

    const encrypted = await encryptCredentialData(newData, env.ENCRYPTION_KEY);
    const db = getDb(env.DB);
    await credentialDb.upsertCredential(db, {
      id: crypto.randomUUID(),
      ownerType,
      ownerId,
      provider,
      credentialType: 'oauth2',
      encryptedData: encrypted,
    });

    return {
      ok: true,
      credential: {
        accessToken: newCreds.access_token,
        refreshToken: newCreds.refresh_token || data.refresh_token,
        credentialType: 'oauth2',
        refreshed: true,
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: {
        service: provider,
        reason: 'refresh_failed',
        message: `Refresh failed: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Resolve a credential with automatic token refresh.
 *
 * This is the canonical way to get a usable token for any provider. It:
 *   1. Loads the encrypted credential row from D1
 *   2. Decrypts it
 *   3. Checks expiry (60-second buffer before actual expiration)
 *   4. Auto-refreshes if expiring (provider-specific: GitHub App OAuth,
 *      Google OAuth, MCP PKCE, or generic provider refresh)
 *   5. Persists the refreshed token back to D1
 *
 * For GitHub specifically: the stored 'oauth2' credential is a user-to-server
 * token from our GitHub App (NOT a classic OAuth App). These expire after 8h
 * and are refreshed via app.oauth.refreshToken().
 *
 * Callers that need a raw token for sandbox/git operations (e.g. assembleRepoEnv)
 * MUST use this function rather than reading credentials directly from the DB,
 * to ensure expired tokens are refreshed before use.
 */
export async function getCredential(
  env: Env,
  ownerType: string,
  ownerId: string,
  provider: string,
  options?: { forceRefresh?: boolean },
): Promise<CredentialResult> {
  const db = getDb(env.DB);
  // Default to 'oauth2' for GitHub as a safety net — only oauth2 rows exist now.
  const effectiveType = provider === 'github' ? 'oauth2' : undefined;
  const row = await credentialDb.getCredentialRow(db, ownerType, ownerId, provider, effectiveType);
  const result = await getCredentialInner(env, ownerType, ownerId, provider, row, options);

  // Edge-triggered failure logging at the one chokepoint all callers share, so a
  // broken integration (expired/revoked token, failed refresh, undecryptable row)
  // surfaces wherever it bites: tool calls, env assembly, webhooks, DOs. Logs only
  // on state TRANSITIONS — first failure, reason change, recovery — so a stuck
  // credential retried by the refresh cron sweep warns once, not once per pass.
  // 'not_found' is just "never connected" (and has no row to track), so it stays
  // quiet, as before.
  const priorFailure = row?.lastFailureReason ?? null;
  if (!result.ok && result.error.reason !== 'not_found') {
    if (row && priorFailure !== result.error.reason) {
      log.warn('integration auth/refresh failed', {
        service: provider,
        ownerType,
        ownerId,
        reason: result.error.reason,
        detail: result.error.message,
        ...(priorFailure ? { previousReason: priorFailure } : {}),
      });
      // Best-effort bookkeeping: a transient D1 write error must not turn a
      // resolution result into a throw at ~20 call sites. Worst case the state
      // doesn't persist and the next attempt re-warns (at-least-once).
      await credentialDb.setCredentialFailureState(db, row.id, result.error.reason).catch((err) => {
        log.warn('failed to persist credential failure state', { service: provider, error: String(err) });
      });
    }
  } else if (result.ok && row && priorFailure) {
    log.info('integration auth recovered', {
      service: provider,
      ownerType,
      ownerId,
      previousReason: priorFailure,
    });
    await credentialDb.setCredentialFailureState(db, row.id, null).catch((err) => {
      log.warn('failed to persist credential failure state', { service: provider, error: String(err) });
    });
  }
  return result;
}

async function getCredentialInner(
  env: Env,
  ownerType: string,
  ownerId: string,
  provider: string,
  row: credentialDb.CredentialRow | null,
  options?: { forceRefresh?: boolean },
): Promise<CredentialResult> {
  if (!row) {
    return {
      ok: false,
      error: { service: provider, reason: 'not_found', message: `No credentials for ${provider}` },
    };
  }

  let data: CredentialData;
  try {
    data = await decryptCredentialData(row.encryptedData, env.ENCRYPTION_KEY);
  } catch {
    return {
      ok: false,
      error: { service: provider, reason: 'decryption_failed', message: `Failed to decrypt credentials for ${provider}` },
    };
  }

  const expiresSoon = row.expiresAt && new Date(row.expiresAt).getTime() - Date.now() < 60_000;

  // Force refresh if requested (e.g. after a 401 from the API indicates the token is invalid)
  if (options?.forceRefresh) {
    if (data.refresh_token) {
      const refreshed = await attemptRefresh(env, ownerType, ownerId, provider, data);
      if (refreshed.ok) return refreshed;
    }
    return {
      ok: false,
      error: {
        service: provider,
        reason: expiresSoon ? 'expired' : 'refresh_failed',
        message: data.refresh_token ? 'Force refresh failed' : `Credential for ${provider} cannot be refreshed because it has no refresh token`,
      },
    };
  }

  // Check expiration (with 60-second buffer)
  if (expiresSoon) {
    if (data.refresh_token) {
      const refreshed = await attemptRefresh(env, ownerType, ownerId, provider, data);
      if (refreshed.ok) return refreshed;
      return refreshed;
    }
    return {
      ok: false,
      error: { service: provider, reason: 'expired', message: `Credential for ${provider} has expired and cannot be refreshed` },
    };
  }

  const accessToken = extractAccessToken(data);
  if (!accessToken) {
    return {
      ok: false,
      error: { service: provider, reason: 'decryption_failed', message: `Credential data missing token field for ${provider}` },
    };
  }

  return {
    ok: true,
    credential: {
      accessToken,
      refreshToken: data.refresh_token,
      expiresAt: row.expiresAt ? new Date(row.expiresAt) : undefined,
      scopes: row.scopes?.split(' ') ?? undefined,
      credentialType: row.credentialType as CredentialType,
      refreshed: false,
    },
  };
}

export async function storeCredential(
  env: Env,
  ownerType: string,
  ownerId: string,
  provider: string,
  credentialData: Record<string, string>,
  options?: {
    credentialType?: CredentialType;
    scopes?: string;
    expiresAt?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  const encrypted = await encryptCredentialData(credentialData, env.ENCRYPTION_KEY);
  const db = getDb(env.DB);

  await credentialDb.upsertCredential(db, {
    id: crypto.randomUUID(),
    ownerType,
    ownerId,
    provider,
    credentialType: options?.credentialType ?? 'api_key',
    encryptedData: encrypted,
    metadata: options?.metadata ? JSON.stringify(options.metadata) : undefined,
    scopes: options?.scopes,
    expiresAt: options?.expiresAt,
  });
}

export async function revokeCredential(
  env: Env,
  ownerType: string,
  ownerId: string,
  provider: string,
): Promise<void> {
  const db = getDb(env.DB);
  await credentialDb.deleteCredential(db, ownerType, ownerId, provider);
}

export async function listCredentials(
  env: Env,
  ownerType: string,
  ownerId: string,
): Promise<Array<{
  provider: string;
  credentialType: string;
  scopes?: string;
  expiresAt?: string;
  createdAt: string;
}>> {
  const db = getDb(env.DB);
  const rows = await credentialDb.listCredentialsByOwner(db, ownerType, ownerId);
  return rows.map((row) => ({
    provider: row.provider,
    credentialType: row.credentialType,
    scopes: row.scopes ?? undefined,
    expiresAt: row.expiresAt ?? undefined,
    createdAt: row.createdAt,
  }));
}

export async function resolveCredentials(
  env: Env,
  ownerType: string,
  ownerId: string,
  providers: string[],
): Promise<Map<string, CredentialResult>> {
  const results = new Map<string, CredentialResult>();
  await Promise.all(
    providers.map(async (provider) => {
      results.set(provider, await getCredential(env, ownerType, ownerId, provider));
    }),
  );
  return results;
}

export async function hasCredential(
  env: Env,
  ownerType: string,
  ownerId: string,
  provider: string,
): Promise<boolean> {
  const db = getDb(env.DB);
  return credentialDb.hasCredential(db, ownerType, ownerId, provider);
}

/**
 * Proactively refresh credentials that are expiring soon.
 * Called from the scheduled cron to keep tokens alive even when no user interaction occurs.
 * Returns the number of credentials successfully refreshed.
 */
export async function refreshExpiringCredentials(
  env: Env,
  windowSeconds: number = 15 * 60, // default: refresh anything expiring within 15 minutes
): Promise<{ refreshed: number; failed: number }> {
  const db = getDb(env.DB);
  const expiring = await credentialDb.getExpiringCredentials(db, windowSeconds);
  if (expiring.length === 0) return { refreshed: 0, failed: 0 };

  let refreshed = 0;
  let failed = 0;

  for (const row of expiring) {
    try {
      const result = await getCredential(env, row.ownerType, row.ownerId, row.provider, { forceRefresh: true });
      if (result.ok && result.credential.refreshed) {
        refreshed++;
      } else {
        failed++;
      }
    } catch (err) {
      console.warn(`[CredentialRefresh] Failed to refresh ${row.provider} for ${row.ownerType}:${row.ownerId}:`, err);
      failed++;
    }
  }

  return { refreshed, failed };
}
