import { getCredential } from '../../services/credentials.js';
import { getDb } from '../../lib/drizzle.js';
import { getServiceMetadata } from '../../lib/db/service-configs.js';
import type { CredentialResolver } from '../registry.js';
import type { GitHubServiceMetadata } from '../../services/github-config.js';

/**
 * GitHub credential resolver — supports multi-credential routing.
 *
 * Resolution order:
 * 1. Explicit `source` param → use that scope directly
 * 2. `owner` param + accessibleOwners → prefer org if owner is covered
 * 3. Precedence: org → personal
 *
 * Respects `skipScope` for fallthrough retries.
 */
export const githubCredentialResolver: CredentialResolver = async (
  service,
  env,
  userId,
  context,
) => {
  const { credentialSources, forceRefresh, skipScope, params } = context;

  const hasUser = credentialSources.some((s) => s.scope === 'user' && (!skipScope || skipScope !== 'user'));
  const hasOrg = credentialSources.some((s) => s.scope === 'org' && (!skipScope || skipScope !== 'org'));

  // 1. Explicit source override
  const explicitSource = params?.source as 'personal' | 'org' | undefined;
  if (explicitSource === 'personal') {
    if (!hasUser) {
      return { ok: false as const, error: { service, reason: 'not_found' as const, message: 'No personal GitHub credentials. Connect GitHub in Settings > Integrations.' } };
    }
    return getCredential(env, 'user', userId, service, { forceRefresh });
  }
  if (explicitSource === 'org') {
    if (!hasOrg) {
      return { ok: false as const, error: { service, reason: 'not_found' as const, message: 'No org GitHub App installed. Install the GitHub App in Settings > Admin.' } };
    }
    return getCredential(env, 'org', 'default', service, { forceRefresh, credentialType: 'app_install' });
  }

  // 2. Owner-based inference
  const owner = params?.owner as string | undefined;
  if (owner && hasOrg) {
    // Use pre-fetched accessibleOwners from DO cache when available, fall back to D1
    let owners = context.accessibleOwners;
    if (!owners) {
      const db = getDb(env.DB);
      const meta = await getServiceMetadata<GitHubServiceMetadata>(db, 'github').catch(() => null);
      owners = meta?.accessibleOwners;
    }
    if (owners?.includes(owner)) {
      return getCredential(env, 'org', 'default', service, { forceRefresh, credentialType: 'app_install' });
    }
  }

  // 3. Precedence: org → personal
  if (hasOrg) {
    return getCredential(env, 'org', 'default', service, { forceRefresh, credentialType: 'app_install' });
  }
  if (hasUser) {
    return getCredential(env, 'user', userId, service, { forceRefresh });
  }

  return { ok: false as const, error: { service, reason: 'not_found' as const, message: 'No GitHub credentials found.' } };
};
