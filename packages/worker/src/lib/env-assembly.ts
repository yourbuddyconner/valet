import type { Env } from '../env.js';
import type { RepoCredential } from '@valet/sdk/repos';
import * as db from './db.js';
import * as credentialDb from './db/credentials.js';
import type { AppDb } from './drizzle.js';
import { decryptString, decryptStringPBKDF2 } from './crypto.js';
import { getCredential } from '../services/credentials.js';
import { repoProviderRegistry, stripProviderSuffix } from '../repos/registry.js';
import { getGitHubConfig } from '../services/github-config.js';

/**
 * Generate a 256-bit hex token for runner authentication.
 */
export function generateRunnerToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Assemble LLM provider API keys from org DB keys, falling back to env vars.
 */
export async function assembleProviderEnv(
  database: AppDb,
  env: Env
): Promise<Record<string, string>> {
  const envVars: Record<string, string> = {};

  const providerEnvMap = [
    { provider: 'anthropic', envKey: 'ANTHROPIC_API_KEY' },
    { provider: 'openai', envKey: 'OPENAI_API_KEY' },
    { provider: 'google', envKey: 'GOOGLE_API_KEY' },
    { provider: 'parallel', envKey: 'PARALLEL_API_KEY' },
  ] as const;

  for (const { provider, envKey } of providerEnvMap) {
    try {
      const orgKey = await db.getOrgApiKey(database, provider);
      if (orgKey) {
        envVars[envKey] = await decryptString(orgKey.encryptedKey, env.ENCRYPTION_KEY);
        continue;
      }
    } catch {
      // DB table may not exist yet — fall through to env var
    }
    if (env[envKey]) envVars[envKey] = env[envKey]!;
  }

  return envVars;
}

/**
 * Assemble user-level credential env vars (1Password, etc.).
 */
export async function assembleCredentialEnv(
  database: AppDb,
  env: Env,
  userId: string
): Promise<Record<string, string>> {
  const envVars: Record<string, string> = {};

  const credentialEnvMap = [
    { provider: '1password', envKey: 'OP_SERVICE_ACCOUNT_TOKEN' },
  ] as const;

  for (const { provider, envKey } of credentialEnvMap) {
    try {
      const result = await getCredential(env, 'user', userId, provider);
      if (result.ok) {
        envVars[envKey] = result.credential.accessToken;
      }
    } catch {
      // skip
    }
  }

  return envVars;
}

/**
 * Fetch all custom LLM providers with decrypted keys.
 */
export async function assembleCustomProviders(
  database: AppDb,
  encryptionKey: string
): Promise<Array<{
  providerId: string;
  displayName: string;
  baseUrl: string;
  apiKey?: string;
  models: Array<{ id: string; name?: string; contextLimit?: number; outputLimit?: number }>;
  showAllModels: boolean;
}>> {
  try {
    const rawProviders = await db.getAllCustomProvidersWithKeys(database);
    const result: Array<{
      providerId: string;
      displayName: string;
      baseUrl: string;
      apiKey?: string;
      models: Array<{ id: string; name?: string; contextLimit?: number; outputLimit?: number }>;
      showAllModels: boolean;
    }> = [];

    for (const p of rawProviders) {
      let apiKey: string | undefined;
      if (p.encryptedKey) {
        apiKey = await decryptString(p.encryptedKey, encryptionKey);
      }
      result.push({
        providerId: p.providerId,
        displayName: p.displayName,
        baseUrl: p.baseUrl,
        apiKey,
        models: p.models,
        showAllModels: p.showAllModels,
      });
    }

    return result;
  } catch {
    // Table may not exist yet — skip
    return [];
  }
}

/**
 * Fetch built-in provider model allowlists from org_api_keys.
 * Returns only providers that have model restrictions configured.
 */
export async function assembleBuiltInProviderModelConfigs(
  database: AppDb
): Promise<Array<{ providerId: string; models: Array<{ id: string; name?: string }>; showAllModels: boolean }>> {
  try {
    return await db.getBuiltInProviderModelConfigs(database);
  } catch {
    // Table may not have new columns yet — skip
    return [];
  }
}

/**
 * Assemble repo env vars (token + repo/branch config) for a session,
 * using the repo provider registry to resolve the correct provider.
 */
export async function assembleRepoEnv(
  appDb: AppDb,
  env: Env,
  userId: string,
  orgId: string | undefined,
  opts: { repoUrl?: string; branch?: string; ref?: string },
): Promise<{ envVars: Record<string, string>; gitConfig: Record<string, string>; token?: string; expiresAt?: string; error?: string }> {
  const envVars: Record<string, string> = {};
  const gitConfig: Record<string, string> = {};

  if (!opts.repoUrl) {
    return { envVars, gitConfig };
  }

  // 1. Find all providers that handle this URL
  const providers = repoProviderRegistry.resolveAllByUrl(opts.repoUrl);
  if (providers.length === 0) {
    return { envVars, gitConfig, error: `No repo provider found for URL: ${opts.repoUrl}` };
  }

  // 2. Resolve the credential (user-first priority)
  // Credentials are stored under a shared provider name (e.g. 'github'),
  // not per-provider IDs like 'github-oauth' / 'github-app'.
  const credentialProvider = stripProviderSuffix(providers[0].id);
  const repoUrlMatch = opts.repoUrl.match(/github\.com[/:]([^/]+)\//);
  const repoOwner = repoUrlMatch?.[1];
  let resolved = await credentialDb.resolveRepoCredential(appDb, credentialProvider, repoOwner, orgId, userId);

  // If no user OAuth credential, try to mint an installation token for the repo owner.
  // Under the unified GitHub App model, installation tokens are minted on-demand
  // from the github_installations table rather than stored as app_install credentials.
  if (!resolved && credentialProvider === 'github' && repoOwner) {
    try {
      const { loadGitHubApp, mintInstallationToken } = await import('../services/github-app.js');
      const { getGithubInstallationByLogin } = await import('./db/github-installations.js');
      const installation = await getGithubInstallationByLogin(appDb, repoOwner);
      if (installation) {
        const app = await loadGitHubApp(env, appDb);
        if (app) {
          const { token, expiresAt } = await mintInstallationToken(app, installation.githubInstallationId);
          // Short-circuit: we have a fresh token, skip the normal credential flow
          // and go directly to assembling env vars.
          const userRow = await db.getUserById(appDb, userId);
          const gitUser = {
            name: userRow?.gitName || userRow?.name || 'Valet User',
            email: userRow?.gitEmail || userRow?.email || '',
          };

          const selectedProvider = repoProviderRegistry.get(`${credentialProvider}-app`);
          if (selectedProvider) {
            const repoCredential: RepoCredential = {
              type: 'installation',
              installationId: installation.githubInstallationId,
              accessToken: token,
              metadata: {},
            };
            const sessionEnv = await selectedProvider.assembleSessionEnv(repoCredential, {
              repoUrl: opts.repoUrl!,
              branch: opts.branch,
              ref: opts.ref,
              gitUser,
            });
            return {
              envVars: { ...envVars, ...sessionEnv.envVars },
              gitConfig: { ...gitConfig, ...sessionEnv.gitConfig },
              token,
              expiresAt: new Date(expiresAt).toISOString(),
            };
          }
        }
      }
    } catch (err) {
      console.warn('[env-assembly] Installation token fallback failed:', err);
      // Fall through to the error below
    }
  }

  if (!resolved) {
    return {
      envVars,
      gitConfig,
      error: `No ${credentialProvider} credentials found. Link your account or ask an org admin to install the app.`,
    };
  }

  // 3. Pick the right provider based on credential type
  const providerId = resolved.credentialType === 'oauth2'
    ? `${credentialProvider}-user`
    : `${credentialProvider}-app`;
  const selectedProvider = repoProviderRegistry.get(providerId);
  if (!selectedProvider) {
    return { envVars, gitConfig, error: `Repo provider '${providerId}' not registered` };
  }

  const credRow = resolved.credential;

  // 4. Decrypt credential data and build RepoCredential
  let credData: Record<string, unknown>;
  try {
    const json = await decryptStringPBKDF2(credRow.encryptedData, env.ENCRYPTION_KEY);
    credData = JSON.parse(json);
  } catch {
    return {
      envVars,
      gitConfig,
      error: `Failed to decrypt ${credentialProvider} credentials`,
    };
  }

  const metadata: Record<string, string> = credRow.metadata ? JSON.parse(credRow.metadata) : {};
  for (const [k, v] of Object.entries(credData)) {
    if (typeof v === 'string') metadata[k] = v;
  }

  // For App installations, supplement appId/privateKey from service config
  if (resolved.credentialType === 'app_install' && !metadata.appId && !metadata.app_id) {
    const ghConfig = await getGitHubConfig(env, appDb);
    if (ghConfig?.appId) metadata.appId = ghConfig.appId;
    if (ghConfig?.appPrivateKey) metadata.privateKey = ghConfig.appPrivateKey;
  }

  const repoCredential: RepoCredential = {
    type: credRow.credentialType === 'app_install' ? 'installation' : 'token',
    installationId: metadata.installationId || metadata.installation_id,
    accessToken: (credData.access_token || credData.token) as string | undefined,
    expiresAt: credRow.expiresAt ?? undefined,
    metadata,
  };

  // 5. Mint a fresh token
  let freshToken: { accessToken: string; expiresAt?: string };
  try {
    freshToken = await selectedProvider.mintToken(repoCredential);
  } catch (err) {
    return {
      envVars,
      gitConfig,
      error: `Failed to mint ${credentialProvider} token: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // 5b. Validate the token actually has access to the repo before launching a sandbox
  if (repoOwner && opts.repoUrl) {
    const repoMatch = opts.repoUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
    if (repoMatch) {
      const [, owner, repo] = repoMatch;
      try {
        const checkRes = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
          headers: {
            Authorization: `Bearer ${freshToken.accessToken}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'valet-app',
          },
        });
        if (checkRes.status === 404 || checkRes.status === 403) {
          const credLabel = resolved.credentialType === 'app_install' ? 'org GitHub App' : 'personal OAuth';
          return {
            envVars,
            gitConfig,
            error: `The ${credLabel} token does not have access to ${owner}/${repo} (HTTP ${checkRes.status}). Check repo permissions or re-authorize.`,
          };
        }
      } catch {
        // Network error — don't block session creation, let the clone attempt handle it
      }
    }
  }

  // 6. Get git user info from users table
  const userRow = await db.getUserById(appDb, userId);
  const gitUser = {
    name: userRow?.gitName || userRow?.name || 'Valet User',
    email: userRow?.gitEmail || userRow?.email || '',
  };

  // 7. Build a credential with the fresh token for assembleSessionEnv
  const freshCredential: RepoCredential = {
    ...repoCredential,
    accessToken: freshToken.accessToken,
    expiresAt: freshToken.expiresAt,
  };

  // 8. Call provider.assembleSessionEnv()
  // Note: App provider ignores gitUser and uses valet[bot] identity
  const sessionEnv = await selectedProvider.assembleSessionEnv(freshCredential, {
    repoUrl: opts.repoUrl,
    branch: opts.branch,
    ref: opts.ref,
    gitUser,
  });

  sessionEnv.envVars.REPO_PROVIDER_ID = selectedProvider.id;

  return {
    envVars: sessionEnv.envVars,
    gitConfig: sessionEnv.gitConfig,
    token: freshToken.accessToken,
    expiresAt: freshToken.expiresAt,
  };
}
