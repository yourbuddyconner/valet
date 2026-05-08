import type { Env } from '../env.js';
import type { RepoCredential } from '@valet/sdk/repos';
import * as db from './db.js';
import type { AppDb } from './drizzle.js';
import { decryptString } from './crypto.js';
import { getCredential } from '../services/credentials.js';
import { repoProviderRegistry, stripProviderSuffix } from '../repos/registry.js';

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
 *
 * ## GitHub App Auth Model
 *
 * All GitHub credentials flow through a single GitHub App — there is no
 * separate classic OAuth App. Two token types exist, both from the same App:
 *
 * 1. **User-to-server OAuth tokens** (credentialType: 'oauth2') — obtained
 *    when a user links their GitHub account via the App's OAuth web flow.
 *    Expire after 8 hours; automatically refreshed by getCredential().
 *    This is the primary path for authenticated users.
 *
 * 2. **Installation tokens** — minted on-demand from App installations
 *    registered to an org/user. 1-hour expiry, never stored in the
 *    credentials table. Used as a fallback when no user OAuth exists.
 *
 * The 'oauth2' credential type name refers to the App's user-to-server
 * OAuth exchange mechanism, NOT a separate (classic) OAuth App.
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

  const credentialProvider = stripProviderSuffix(providers[0].id);
  const repoUrlMatch = opts.repoUrl.match(/github\.com[/:]([^/]+)\//);
  const repoOwner = repoUrlMatch?.[1];

  // 2. Try user OAuth credential with auto-refresh.
  //
  // getCredential() handles the full lifecycle:
  //   - Decrypts the stored credential
  //   - Checks expiry (60-second buffer before actual expiration)
  //   - Automatically refreshes via the GitHub App's OAuth refresh endpoint
  //   - Persists the refreshed token back to D1
  //
  // Previously this path used a raw DB lookup (resolveRepoCredential) +
  // manual decryptStringPBKDF2, which skipped the refresh logic entirely.
  // That caused 403 push errors when the stored token was >8h old (TKAI-56).
  const credResult = await getCredential(env, 'user', userId, credentialProvider);

  if (credResult.ok) {
    // Track the resolved credential — may be updated by force-refresh below.
    let resolved = credResult.credential;

    const selectedProvider = repoProviderRegistry.get(`${credentialProvider}-user`);
    if (!selectedProvider) {
      return { envVars, gitConfig, error: `Repo provider '${credentialProvider}-user' not registered` };
    }

    // Validate repo access AND push permissions before launching a sandbox.
    // A 200 from GET /repos/{owner}/{repo} only proves read access — we must
    // also check the permissions.push field in the response body to verify
    // the token can actually push commits.
    if (repoOwner && opts.repoUrl) {
      const repoMatch = opts.repoUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
      if (repoMatch) {
        const [, owner, repo] = repoMatch;
        try {
          let checkRes = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
            headers: {
              Authorization: `Bearer ${resolved.accessToken}`,
              Accept: 'application/vnd.github+json',
              'User-Agent': 'valet-app',
            },
          });
          // 401 = expired/invalid token. This can happen if getCredential()
          // returned a stale token without expiresAt (legacy credentials stored
          // before TKAI-56 fix). Attempt a force refresh before giving up.
          if (checkRes.status === 401) {
            const retryResult = await getCredential(env, 'user', userId, credentialProvider, { forceRefresh: true });
            if (retryResult.ok) {
              // Re-validate with the refreshed token
              const retryRes = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
                headers: {
                  Authorization: `Bearer ${retryResult.credential.accessToken}`,
                  Accept: 'application/vnd.github+json',
                  'User-Agent': 'valet-app',
                },
              });
              if (retryRes.ok) {
                // Force refresh succeeded — use the fresh credential.
                resolved = retryResult.credential;
                checkRes = retryRes;
              } else {
                return {
                  envVars,
                  gitConfig,
                  error: `Your GitHub token has expired and could not be refreshed. Please re-link your GitHub account.`,
                };
              }
            } else {
              return {
                envVars,
                gitConfig,
                error: `Your GitHub token has expired and could not be refreshed. Please re-link your GitHub account.`,
              };
            }
          }
          // 403 = token valid but lacks access to this resource.
          // 404 = repo doesn't exist or token can't see it (GitHub hides private repos).
          if (checkRes.status === 403 || checkRes.status === 404) {
            return {
              envVars,
              gitConfig,
              error: `Your GitHub token does not have access to ${owner}/${repo} (HTTP ${checkRes.status}). Re-authorize or check repo permissions.`,
            };
          }
          if (checkRes.ok) {
            const repoData = (await checkRes.json()) as { permissions?: { push?: boolean } };
            if (repoData.permissions && !repoData.permissions.push) {
              return {
                envVars,
                gitConfig,
                error: `Your GitHub token has read-only access to ${owner}/${repo}. Push permission is required — check repo or org permissions.`,
              };
            }
          }
        } catch {
          // Network error — don't block session creation, let the clone attempt handle it
        }
      }
    }

    const userRow = await db.getUserById(appDb, userId);
    const gitUser = {
      name: userRow?.gitName || userRow?.name || 'Valet User',
      email: userRow?.gitEmail || userRow?.email || '',
    };

    // Guard against malformed expiresAt from D1 — an invalid Date would
    // throw on toISOString().
    const expiresAtIso = resolved.expiresAt instanceof Date && !isNaN(resolved.expiresAt.getTime())
      ? resolved.expiresAt.toISOString()
      : undefined;

    const repoCredential: RepoCredential = {
      type: 'token',
      accessToken: resolved.accessToken,
      expiresAt: expiresAtIso,
      metadata: {},
    };

    const sessionEnv = await selectedProvider.assembleSessionEnv(repoCredential, {
      repoUrl: opts.repoUrl,
      branch: opts.branch,
      ref: opts.ref,
      gitUser,
    });

    sessionEnv.envVars.REPO_PROVIDER_ID = selectedProvider.id;

    return {
      envVars: sessionEnv.envVars,
      gitConfig: sessionEnv.gitConfig,
      token: resolved.accessToken,
      expiresAt: expiresAtIso,
    };
  }

  // User credential not found or broken. If the credential exists but
  // refresh failed, surface the error — don't silently fall through.
  if (credResult.error.reason !== 'not_found') {
    return { envVars, gitConfig, error: credResult.error.message };
  }

  // 3. No user OAuth credential — try installation token fallback.
  // Org-level GitHub App installations can mint short-lived (1-hour) tokens
  // scoped to the installation's configured permissions.
  if (credentialProvider === 'github' && repoOwner) {
    try {
      const { loadGitHubApp, mintInstallationToken } = await import('../services/github-app.js');
      const { getGithubInstallationByLogin } = await import('./db/github-installations.js');
      const installation = await getGithubInstallationByLogin(appDb, repoOwner);
      if (installation) {
        const app = await loadGitHubApp(env, appDb);
        if (app) {
          const { token, expiresAt } = await mintInstallationToken(app, installation.githubInstallationId);
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
    }
  }

  return {
    envVars,
    gitConfig,
    error: `No ${credentialProvider} credentials found. Link your account or ask an org admin to install the app.`,
  };
}
