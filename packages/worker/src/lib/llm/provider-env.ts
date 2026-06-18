import type { Env } from '../../env.js';
import type { AppDb } from '../drizzle.js';
import * as db from '../db.js';
import { decryptString } from '../crypto.js';

const PROVIDER_ENV_MAP = [
  { provider: 'anthropic', envKey: 'ANTHROPIC_API_KEY' },
  { provider: 'openai', envKey: 'OPENAI_API_KEY' },
  { provider: 'google', envKey: 'GOOGLE_API_KEY' },
] as const;

/**
 * Resolve built-in LLM provider API keys from org DB keys, falling back
 * to Worker env vars. DB keys intentionally win so admin UI updates
 * affect workflows and sessions consistently.
 */
export async function assembleLlmProviderEnv(
  database: AppDb,
  env: Env,
): Promise<Record<string, string>> {
  const envVars: Record<string, string> = {};

  for (const { provider, envKey } of PROVIDER_ENV_MAP) {
    try {
      const orgKey = await db.getOrgApiKey(database, provider);
      if (orgKey) {
        envVars[envKey] = await decryptString(orgKey.encryptedKey, env.ENCRYPTION_KEY);
        continue;
      }
    } catch {
      // DB table may not exist yet, or a key may be undecryptable during
      // local/dev setup. Fall back to Worker env var below.
    }
    if (env[envKey]) envVars[envKey] = env[envKey];
  }

  return envVars;
}
