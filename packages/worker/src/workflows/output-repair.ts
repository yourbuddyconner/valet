import type { Env } from '../env.js';
import { getDb } from '../lib/drizzle.js';
import { getOrgSettings } from '../lib/db/org.js';
import { getUserById } from '../lib/db/users.js';
import { assembleLlmProviderEnv } from '../lib/llm/provider-env.js';

export async function resolveWorkflowOutputRepairModel(params: {
  env: Env;
  userId: string;
  explicitModel?: string;
}): Promise<string | undefined> {
  if (params.explicitModel) return normalizeWorkflowModelId(params.explicitModel);

  const db = getDb(params.env.DB);
  const user = await getUserById(db, params.userId);
  const userModel = user?.modelPreferences?.[0];
  if (userModel) return normalizeWorkflowModelId(userModel);

  const org = await getOrgSettings(db);
  const orgModel = org.modelPreferences?.[0];
  return orgModel ? normalizeWorkflowModelId(orgModel) : undefined;
}

export async function assembleWorkflowOutputRepairEnv(env: Env): Promise<Env> {
  const providerEnv = await assembleLlmProviderEnv(getDb(env.DB), env);
  return { ...env, ...providerEnv };
}

export function normalizeWorkflowModelId(modelId: string): string {
  const trimmed = modelId.trim();
  const colon = trimmed.indexOf(':');
  if (colon > 0) return trimmed;

  const slash = trimmed.indexOf('/');
  if (slash > 0) {
    return `${trimmed.slice(0, slash)}:${trimmed.slice(slash + 1)}`;
  }

  return trimmed;
}
