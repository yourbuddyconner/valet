import type { AppDb } from '../lib/drizzle.js';
import type { Env } from '../env.js';
import { getServiceConfig, getServiceMetadata } from '../lib/db/service-configs.js';

export interface GitHubServiceConfig {
  /** Classic OAuth App credentials (set via PUT /api/admin/github/oauth). */
  oauthClientId: string;
  oauthClientSecret: string;
  /** GitHub App's auto-generated OAuth credentials (set by manifest callback). */
  appOauthClientId?: string;
  appOauthClientSecret?: string;
  appId?: string;
  appPrivateKey?: string;
  appSlug?: string;
  appWebhookSecret?: string;
}

export interface GitHubServiceMetadata {
  appInstallationId?: string;
  accessibleOwners?: string[];
  accessibleOwnersRefreshedAt?: string;
  appOwner?: string;
  appOwnerType?: string;
  appName?: string;
  repositoryCount?: number;
}

export interface GitHubConfig {
  /** OAuth credentials for personal auth (classic OAuth App preferred, App OAuth as fallback). */
  oauthClientId: string;
  oauthClientSecret: string;
  /** GitHub App's auto-generated OAuth credentials (from manifest). */
  appOauthClientId?: string;
  appOauthClientSecret?: string;
  appId?: string;
  appPrivateKey?: string;
  appSlug?: string;
  appWebhookSecret?: string;
  appInstallationId?: string;
  appAccessibleOwners?: string[];
}

/**
 * Resolve GitHub config from D1 first, fall back to env vars.
 */
export async function getGitHubConfig(env: Env, db: AppDb): Promise<GitHubConfig | null> {
  // Try D1 first (catch table-not-found if migration hasn't run yet)
  try {
    const svc = await getServiceConfig<GitHubServiceConfig, GitHubServiceMetadata>(
      db, env.ENCRYPTION_KEY, 'github',
    );

    if (svc) {
      // Prefer classic OAuth credentials; fall back to App OAuth if no classic creds configured
      const oauthClientId = svc.config.oauthClientId || svc.config.appOauthClientId || '';
      const oauthClientSecret = svc.config.oauthClientSecret || svc.config.appOauthClientSecret || '';
      return {
        oauthClientId,
        oauthClientSecret,
        appOauthClientId: svc.config.appOauthClientId,
        appOauthClientSecret: svc.config.appOauthClientSecret,
        appId: svc.config.appId,
        appPrivateKey: svc.config.appPrivateKey,
        appSlug: svc.config.appSlug,
        appWebhookSecret: svc.config.appWebhookSecret,
        appInstallationId: svc.metadata.appInstallationId,
        appAccessibleOwners: svc.metadata.accessibleOwners,
      };
    }
  } catch {
    // D1 table may not exist yet — fall through to env vars
  }

  // Fall back to env vars
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) return null;

  return {
    oauthClientId: env.GITHUB_CLIENT_ID,
    oauthClientSecret: env.GITHUB_CLIENT_SECRET,
    appId: env.GITHUB_APP_ID,
    appPrivateKey: env.GITHUB_APP_PRIVATE_KEY,
    appSlug: env.GITHUB_APP_SLUG,
    appWebhookSecret: env.GITHUB_APP_WEBHOOK_SECRET,
  };
}

/**
 * Get just the GitHub metadata (accessible owners) without decrypting secrets.
 */
export async function getGitHubMetadata(db: AppDb): Promise<GitHubServiceMetadata | null> {
  try {
    return await getServiceMetadata<GitHubServiceMetadata>(db, 'github');
  } catch {
    // Table may not exist yet if migration hasn't been applied
    return null;
  }
}
