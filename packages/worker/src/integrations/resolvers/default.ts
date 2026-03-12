import { getCredential } from '../../services/credentials.js';
import type { CredentialResolver } from '../registry.js';

/**
 * Default credential resolver — looks up per-user credentials from D1.
 * Used for all services that don't register a custom resolver.
 */
export const defaultCredentialResolver: CredentialResolver = (
  service,
  env,
  userId,
  _scope,
  options,
) => getCredential(env, 'user', userId, service, options);
