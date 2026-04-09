import { getCredential } from '../../services/credentials.js';
import type { CredentialResolver } from '../registry.js';

/**
 * Default credential resolver — looks up credentials from D1.
 * Picks the first available source (user-scoped preferred), respecting skipScope.
 */
export const defaultCredentialResolver: CredentialResolver = (
  service,
  env,
  userId,
  context,
) => {
  const { credentialSources, forceRefresh, skipScope } = context;

  // Pick the first available source, respecting skipScope and preferring user-scoped
  const source = credentialSources
    .filter((s) => !skipScope || s.scope !== skipScope)
    .sort((a, b) => (a.scope === 'user' ? 0 : 1) - (b.scope === 'user' ? 0 : 1))
    .at(0);

  if (!source) {
    return Promise.resolve({
      ok: false as const,
      error: { service, reason: 'not_found' as const, message: `No credentials for ${service}` },
    });
  }

  const ownerType = source.scope === 'org' ? 'org' : 'user';
  const ownerId = source.scope === 'org' ? 'default' : userId;
  const effectiveOptions = source.scope === 'org' && service === 'github'
    ? { forceRefresh, credentialType: 'app_install' }
    : { forceRefresh };
  return getCredential(env, ownerType, ownerId, service, effectiveOptions);
};
