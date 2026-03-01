import { IntegrationError, ValidationError, NotFoundError, ErrorCodes } from '@agent-ops/shared';
import type { Env } from '../env.js';
import * as db from '../lib/db.js';
import { getDb } from '../lib/drizzle.js';
import { integrationRegistry } from '../integrations/registry.js';
import { storeCredential, getCredential } from '../services/credentials.js';

// ─── Configure Integration ──────────────────────────────────────────────────

export interface ConfigureIntegrationParams {
  service: string;
  credentials: Record<string, string>;
  config: {
    syncFrequency: string;
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

// ─── Trigger Integration Sync ───────────────────────────────────────────────

export interface TriggerSyncParams {
  entities?: string[];
  fullSync?: boolean;
}

export async function triggerIntegrationSync(
  env: Env,
  userId: string,
  integrationId: string,
  params: TriggerSyncParams,
  ctx: { waitUntil: (promise: Promise<unknown>) => void },
): Promise<{ syncId: string }> {
  const appDb = getDb(env.DB);
  const integration = await db.getIntegration(appDb, integrationId);
  if (!integration) {
    throw new NotFoundError('Integration', integrationId);
  }
  if (integration.userId !== userId) {
    throw new NotFoundError('Integration', integrationId);
  }
  if (integration.status !== 'active') {
    throw new IntegrationError('Integration is not active', ErrorCodes.INTEGRATION_AUTH_FAILED);
  }

  // Get the sync source
  const syncSource = integrationRegistry.getSync(integration.service);
  if (!syncSource) {
    throw new ValidationError(`Sync not supported for: ${integration.service}`);
  }

  // Retrieve credentials from unified credentials table
  const credResult = await getCredential(env, userId, integration.service);
  if (!credResult.ok) {
    throw new IntegrationError('Failed to retrieve credentials', ErrorCodes.INTEGRATION_AUTH_FAILED);
  }
  const credentials = { access_token: credResult.credential.accessToken };

  // Create sync log
  const syncId = crypto.randomUUID();
  await db.createSyncLog(appDb, { id: syncId, integrationId });

  // Run sync in background
  ctx.waitUntil(
    (async () => {
      try {
        await db.updateSyncLog(appDb, syncId, { status: 'running' });

        const result = await syncSource.sync(credentials, {
          entities: params.entities || integration.config.entities,
          fullSync: params.fullSync,
        });

        await db.updateSyncLog(appDb, syncId, {
          status: result.success ? 'completed' : 'failed',
          recordsSynced: result.recordsSynced,
          errors: result.errors,
        });

        if (result.success) {
          await db.updateIntegrationSyncTime(appDb, integrationId);
        } else {
          await db.updateIntegrationStatus(appDb, integrationId, 'error', result.errors[0]?.message);
        }
      } catch (error) {
        console.error('Sync error:', error);
        await db.updateSyncLog(appDb, syncId, {
          status: 'failed',
          errors: [{ entity: 'unknown', message: String(error), code: 'SYNC_ERROR' }],
        });
        await db.updateIntegrationStatus(appDb, integrationId, 'error', String(error));
      }
    })()
  );

  return { syncId };
}
