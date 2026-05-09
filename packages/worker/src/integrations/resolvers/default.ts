import { getCredential } from '../../services/credentials.js';
import type { CredentialResolver } from '../registry.js';

/**
 * Default credential resolver — looks up user-scoped credentials from D1.
 */
export const defaultCredentialResolver: CredentialResolver = (
  service,
  env,
  userId,
  context,
) => {
  return getCredential(env, 'user', userId, service, { forceRefresh: context.forceRefresh });
};
