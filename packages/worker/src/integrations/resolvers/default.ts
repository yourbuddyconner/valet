import { getCredential } from '../../services/credentials.js';
import type { CredentialResolver } from '../registry.js';

/**
 * Default credential resolver — looks up credentials from D1.
 * For user scope: looks up per-user credentials (ownerType='user', ownerId=userId).
 * For org scope: looks up org-level credentials (ownerType='org', ownerId='default').
 * Used for all services that don't register a custom resolver.
 */
export const defaultCredentialResolver: CredentialResolver = (
  service,
  env,
  userId,
  scope,
  options,
) => {
  const ownerType = scope === 'org' ? 'org' : 'user';
  const ownerId = scope === 'org' ? 'default' : userId;
  // For org-scoped GitHub, use 'app_install' credential type (not the default 'oauth2')
  const effectiveOptions = scope === 'org' && service === 'github'
    ? { ...options, credentialType: 'app_install' }
    : options;
  return getCredential(env, ownerType, ownerId, service, effectiveOptions);
};
