import { type OAuthConfig, refreshTokenPkce } from '@agent-ops/sdk';
import { type Env, getEnvString } from '../env.js';
import { encryptStringPBKDF2, decryptStringPBKDF2 } from '../lib/crypto.js';
import * as credentialDb from '../lib/db/credentials.js';
import * as mcpOAuthDb from '../lib/db/mcp-oauth.js';
import { getDb } from '../lib/drizzle.js';
import { integrationRegistry } from '../integrations/registry.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export type CredentialType = 'oauth2' | 'api_key' | 'bot_token' | 'service_account';

export interface ResolvedCredential {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
  scopes?: string[];
  credentialType: CredentialType;
  refreshed: boolean;
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
  userId: string,
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
    userId,
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
  userId: string,
  provider: string,
  data: CredentialData,
): Promise<CredentialResult> {
  // Hardcoded paths for providers that existed before the generic mechanism
  switch (provider) {
    case 'google':
    case 'gmail':
    case 'google_calendar':
      return refreshGoogleToken(env, userId, provider, data);
    case 'github':
      return {
        ok: false,
        error: { service: provider, reason: 'refresh_failed', message: 'GitHub tokens do not support refresh' },
      };
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
          userId,
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
      userId,
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

export async function getCredential(
  env: Env,
  userId: string,
  provider: string,
  options?: { forceRefresh?: boolean },
): Promise<CredentialResult> {
  const db = getDb(env.DB);
  const row = await credentialDb.getCredentialRow(db, userId, provider);
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

  // Force refresh if requested (e.g. after a 401 from the API indicates the token is invalid)
  if (options?.forceRefresh && data.refresh_token) {
    const refreshed = await attemptRefresh(env, userId, provider, data);
    if (refreshed.ok) return refreshed;
    return {
      ok: false,
      error: { service: provider, reason: 'refresh_failed', message: 'Force refresh failed' },
    };
  }

  // Check expiration (with 60-second buffer)
  if (row.expiresAt && new Date(row.expiresAt).getTime() - Date.now() < 60_000) {
    if (data.refresh_token) {
      const refreshed = await attemptRefresh(env, userId, provider, data);
      if (refreshed.ok) return refreshed;
    }
    // Return potentially expired credential — caller can decide
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
  userId: string,
  provider: string,
  credentialData: Record<string, string>,
  options?: {
    credentialType?: CredentialType;
    scopes?: string;
    expiresAt?: string;
  },
): Promise<void> {
  const encrypted = await encryptCredentialData(credentialData, env.ENCRYPTION_KEY);
  const db = getDb(env.DB);

  await credentialDb.upsertCredential(db, {
    id: crypto.randomUUID(),
    userId,
    provider,
    credentialType: options?.credentialType ?? 'api_key',
    encryptedData: encrypted,
    scopes: options?.scopes,
    expiresAt: options?.expiresAt,
  });
}

export async function revokeCredential(
  env: Env,
  userId: string,
  provider: string,
): Promise<void> {
  const db = getDb(env.DB);
  await credentialDb.deleteCredential(db, userId, provider);
}

export async function listCredentials(
  env: Env,
  userId: string,
): Promise<Array<{
  provider: string;
  credentialType: string;
  scopes?: string;
  expiresAt?: string;
  createdAt: string;
}>> {
  const db = getDb(env.DB);
  const rows = await credentialDb.listCredentialsByUser(db, userId);
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
  userId: string,
  providers: string[],
): Promise<Map<string, CredentialResult>> {
  const results = new Map<string, CredentialResult>();
  await Promise.all(
    providers.map(async (provider) => {
      results.set(provider, await getCredential(env, userId, provider));
    }),
  );
  return results;
}

export async function hasCredential(
  env: Env,
  userId: string,
  provider: string,
): Promise<boolean> {
  const db = getDb(env.DB);
  return credentialDb.hasCredential(db, userId, provider);
}
