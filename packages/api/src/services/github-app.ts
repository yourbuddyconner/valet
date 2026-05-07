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
 * Convert a PKCS#1 RSA private key PEM to PKCS#8 format.
 *
 * GitHub's manifest flow returns PKCS#1 (`BEGIN RSA PRIVATE KEY`), but
 * `universal-github-app-jwt` (used by Octokit under Web Crypto / Workers)
 * only supports PKCS#8 (`BEGIN PRIVATE KEY`).
 *
 * The conversion wraps the raw PKCS#1 DER bytes in the PKCS#8
 * PrivateKeyInfo ASN.1 structure with an RSA AlgorithmIdentifier.
 */
function ensurePkcs8(pem: string): string {
  if (!pem.includes('BEGIN RSA PRIVATE KEY')) return pem;

  // Decode PKCS#1 PEM to DER bytes
  const b64 = pem
    .replace(/-----BEGIN RSA PRIVATE KEY-----/, '')
    .replace(/-----END RSA PRIVATE KEY-----/, '')
    .replace(/\s/g, '');
  const pkcs1 = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

  // PKCS#8 PrivateKeyInfo wraps PKCS#1 with:
  //   SEQUENCE { INTEGER 0, SEQUENCE { OID rsaEncryption, NULL }, OCTET STRING { <pkcs1> } }
  // Fixed overhead: 22 bytes before the PKCS#1 data
  const pkcs1Len = pkcs1.length;
  const totalLen = pkcs1Len + 22;
  const pkcs8 = new Uint8Array(4 + totalLen);

  // Outer SEQUENCE tag + 2-byte length
  pkcs8[0] = 0x30;
  pkcs8[1] = 0x82;
  pkcs8[2] = (totalLen >> 8) & 0xff;
  pkcs8[3] = totalLen & 0xff;

  // Version INTEGER 0
  pkcs8[4] = 0x02;
  pkcs8[5] = 0x01;
  pkcs8[6] = 0x00;

  // AlgorithmIdentifier SEQUENCE
  pkcs8[7] = 0x30;
  pkcs8[8] = 0x0d;
  // OID 1.2.840.113549.1.1.1 (rsaEncryption)
  pkcs8.set([0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01], 9);
  // NULL
  pkcs8[20] = 0x05;
  pkcs8[21] = 0x00;

  // OCTET STRING tag + 2-byte length
  pkcs8[22] = 0x04;
  pkcs8[23] = 0x82;
  pkcs8[24] = (pkcs1Len >> 8) & 0xff;
  pkcs8[25] = pkcs1Len & 0xff;

  // PKCS#1 payload
  pkcs8.set(pkcs1, 26);

  // Encode back to PEM
  const pkcs8B64 = btoa(String.fromCharCode(...pkcs8));
  const lines = pkcs8B64.match(/.{1,64}/g) || [];
  return `-----BEGIN PRIVATE KEY-----\n${lines.join('\n')}\n-----END PRIVATE KEY-----`;
}

/**
 * Create an Octokit `App` instance from explicit credentials.
 */
export function createGitHubApp(input: CreateGitHubAppInput): App {
  return new App({
    appId: input.appId,
    privateKey: ensurePkcs8(input.privateKey),
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
