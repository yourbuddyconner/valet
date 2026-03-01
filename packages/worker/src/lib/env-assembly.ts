import type { D1Database } from '@cloudflare/workers-types';
import type { Env } from '../env.js';
import * as db from './db.js';
import type { AppDb } from './drizzle.js';
import { decryptString } from './crypto.js';
import { getCredential } from '../services/credentials.js';

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
      const result = await getCredential(env, userId, provider);
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
 * Assemble GitHub env vars (token + repo/branch config) for a session.
 */
export async function assembleGitHubEnv(
  database: D1Database,
  env: Env,
  userId: string,
  opts: { repoUrl?: string; branch?: string; ref?: string }
): Promise<{ envVars: Record<string, string>; error?: string }> {
  const envVars: Record<string, string> = {};

  if (!opts.repoUrl) {
    return { envVars };
  }

  const result = await getCredential(env, userId, 'github');
  if (!result.ok) {
    return { envVars, error: 'GitHub account not connected. Sign in with GitHub first.' };
  }
  const githubToken = result.credential.accessToken;

  // Fetch git user info from the users table
  const userRow = await database.prepare('SELECT name, email, github_username, git_name, git_email FROM users WHERE id = ?')
    .bind(userId)
    .first<{ name: string | null; email: string | null; github_username: string | null; git_name: string | null; git_email: string | null }>();

  envVars.GITHUB_TOKEN = githubToken;
  envVars.REPO_URL = opts.repoUrl;
  if (opts.branch) {
    envVars.REPO_BRANCH = opts.branch;
  }
  if (opts.ref) {
    envVars.REPO_REF = opts.ref;
  }
  envVars.GIT_USER_NAME = userRow?.git_name || userRow?.name || userRow?.github_username || 'Agent Ops User';
  envVars.GIT_USER_EMAIL = userRow?.git_email || userRow?.email || '';

  return { envVars };
}
