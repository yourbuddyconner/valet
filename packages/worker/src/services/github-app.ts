import { App } from 'octokit';
import { eq } from 'drizzle-orm';
import type { Env } from '../env.js';
import type { AppDb } from '../lib/drizzle.js';
import { getServiceConfig } from '../lib/db/service-configs.js';
import { encryptStringPBKDF2, decryptStringPBKDF2 } from '../lib/crypto.js';
import { githubInstallations } from '../lib/schema/github-installations.js';
import type { GitHubServiceConfig } from './github-config.js';

export interface CreateGitHubAppInput {
  appId: string;
  privateKey: string;
  oauthClientId: string;
  oauthClientSecret: string;
  webhookSecret: string;
}

/**
 * Create an Octokit `App` instance from explicit credentials.
 */
export function createGitHubApp(input: CreateGitHubAppInput): App {
  return new App({
    appId: input.appId,
    privateKey: input.privateKey,
    oauth: {
      clientId: input.oauthClientId,
      clientSecret: input.oauthClientSecret,
    },
    webhooks: {
      secret: input.webhookSecret,
    },
  });
}

/**
 * Load the org-level GitHub App config from D1 and create an `App` instance.
 * Returns null if the App fields are not yet configured.
 */
export async function loadGitHubApp(env: Env, db: AppDb): Promise<App | null> {
  const svc = await getServiceConfig<GitHubServiceConfig>(db, env.ENCRYPTION_KEY, 'github');
  if (!svc) return null;

  const c = svc.config;
  if (!c.appId || !c.appPrivateKey || !c.appOauthClientId || !c.appOauthClientSecret || !c.appWebhookSecret) {
    return null;
  }

  return createGitHubApp({
    appId: c.appId,
    privateKey: c.appPrivateKey,
    oauthClientId: c.appOauthClientId,
    oauthClientSecret: c.appOauthClientSecret,
    webhookSecret: c.appWebhookSecret,
  });
}

export interface InstallationTokenResult {
  token: string;
  /** Milliseconds since epoch when the token expires. */
  expiresAt: number;
}

/**
 * Mint a fresh installation access token via the GitHub API.
 * No caching — always hits the API.
 */
export async function mintInstallationToken(
  app: App,
  githubInstallationId: string,
): Promise<InstallationTokenResult> {
  const installationId = Number(githubInstallationId);
  if (!Number.isFinite(installationId)) {
    throw new Error(`Invalid installation ID: ${githubInstallationId}`);
  }

  const response = await app.octokit.request(
    'POST /app/installations/{installation_id}/access_tokens',
    { installation_id: installationId },
  );

  return {
    token: response.data.token,
    expiresAt: new Date(response.data.expires_at).getTime(),
  };
}

/** Re-mint 5 minutes before expiry to avoid clock-skew failures. */
const CACHE_SAFETY_MARGIN_MS = 5 * 60 * 1000;

/**
 * Return a cached installation token if still fresh, otherwise mint a new one
 * via the GitHub API and write the encrypted result back to D1.
 */
export async function getOrMintInstallationToken(
  app: App,
  db: AppDb,
  encryptionKey: string,
  installation: {
    id: string;
    githubInstallationId: string;
    cachedTokenEncrypted: string | null;
    cachedTokenExpiresAt: string | null;
  },
): Promise<InstallationTokenResult> {
  // Try the cache first
  if (installation.cachedTokenEncrypted && installation.cachedTokenExpiresAt) {
    const expiresAt = new Date(installation.cachedTokenExpiresAt).getTime();
    if (Date.now() < expiresAt - CACHE_SAFETY_MARGIN_MS) {
      try {
        const token = await decryptStringPBKDF2(installation.cachedTokenEncrypted, encryptionKey);
        return { token, expiresAt };
      } catch {
        // Corrupt cache — fall through and mint fresh
      }
    }
  }

  // Mint a fresh token
  const result = await mintInstallationToken(app, installation.githubInstallationId);

  // Write back to D1
  const encrypted = await encryptStringPBKDF2(result.token, encryptionKey);
  await db
    .update(githubInstallations)
    .set({
      cachedTokenEncrypted: encrypted,
      cachedTokenExpiresAt: new Date(result.expiresAt).toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(githubInstallations.id, installation.id));

  return result;
}
