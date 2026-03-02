import { IntegrationError, ValidationError, ErrorCodes } from '@agent-ops/shared';
import type { Env } from '../env.js';
import * as db from '../lib/db.js';
import { getDb } from '../lib/drizzle.js';
import { integrationRegistry } from '../integrations/registry.js';
import { storeCredential } from '../services/credentials.js';

// ─── Configure Integration ──────────────────────────────────────────────────

export interface ConfigureIntegrationParams {
  service: string;
  credentials: Record<string, string>;
  config: {
    entities: string[];
    filters?: Record<string, unknown>;
  };
}

export interface ConfiguredIntegration {
  id: string;
  service: string;
  status: string;
  config: Record<string, unknown>;
  createdAt: Date;
}

export async function configureIntegration(
  env: Env,
  userId: string,
  userEmail: string,
  params: ConfigureIntegrationParams,
): Promise<ConfiguredIntegration> {
  const appDb = getDb(env.DB);
  // Check if integration already exists
  const existing = await db.getUserIntegrations(appDb, userId);
  if (existing.some((i) => i.service === params.service)) {
    throw new IntegrationError(
      `Integration for ${params.service} already exists`,
      ErrorCodes.INTEGRATION_ALREADY_EXISTS
    );
  }

  // Get the integration provider
  const provider = integrationRegistry.getProvider(params.service);
  if (!provider) {
    throw new ValidationError(`Unsupported integration: ${params.service}`);
  }

  // Test credentials (stateless — no setCredentials)
  if (!provider.validateCredentials(params.credentials)) {
    throw new IntegrationError('Invalid credentials provided', ErrorCodes.INVALID_CREDENTIALS);
  }

  const connectionValid = await provider.testConnection(params.credentials);
  if (!connectionValid) {
    throw new IntegrationError('Failed to connect to service', ErrorCodes.INTEGRATION_AUTH_FAILED);
  }

  // Ensure user exists
  await db.getOrCreateUser(appDb, { id: userId, email: userEmail });

  // Store credentials in unified credentials table
  await storeCredential(env, userId, params.service, params.credentials, {
    credentialType: 'oauth2',
    scopes: params.config.entities.join(' '),
  });

  // Create integration record (without credentials)
  const integrationId = crypto.randomUUID();
  const created = await db.createIntegration(appDb, {
    id: integrationId,
    userId,
    service: params.service,
    config: params.config,
  });

  // Update status to active
  await db.updateIntegrationStatus(appDb, integrationId, 'active');

  return {
    id: created.id,
    service: created.service,
    status: 'active',
    config: created.config as unknown as Record<string, unknown>,
    createdAt: created.createdAt,
  };
}
