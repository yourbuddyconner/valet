import { IntegrationError, ValidationError, ErrorCodes } from '@valet/shared';
import type { Env } from '../env.js';
import * as db from '../lib/db.js';
import * as credentialRows from '../lib/db/credentials.js';
import { getDb } from '../lib/drizzle.js';
import type { AppDb } from '../lib/drizzle.js';
import { integrationRegistry } from '../integrations/registry.js';
import { storeCredential } from '../services/credentials.js';
import { loadCustomMcpConnectorContext } from './custom-mcp-connectors.js';

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
  const existingIntegration = existing.find((i) => i.service === params.service);

  // Get the integration provider
  const customContext = integrationRegistry.isBuiltinService(params.service)
    ? undefined
    : await loadCustomMcpConnectorContext(env, appDb, 'default');
  const provider = integrationRegistry.getProvider(params.service, customContext);
  if (!provider) {
    throw new ValidationError(`Unsupported integration: ${params.service}`);
  }

  // Test credentials (stateless — no setCredentials)
  if (!provider.validateCredentials(params.credentials)) {
    throw new IntegrationError('Invalid credentials provided', ErrorCodes.INVALID_CREDENTIALS);
  }

  const credentialType = provider.isCustomConnector && provider.authType === 'api_key'
    ? 'api_key'
    : 'oauth2';
  const credentialData = credentialType === 'api_key'
    ? { access_token: params.credentials.access_token || params.credentials.api_key || params.credentials.token || '' }
    : params.credentials;

  if (provider.isCustomConnector && provider.authType === 'api_key' && provider.credentialScope === 'user') {
    await testCustomMcpUserCredential(params.service, provider.displayName, customContext, credentialData.access_token);
  }

  // MCP OAuth services issue tokens scoped to the MCP server, not the provider's
  // standard API. Skip testConnection for these — the successful OAuth token
  // exchange already proves the connection is valid.
  if (!provider.mcpServerUrl) {
    let connectionValid: boolean;
    try {
      connectionValid = await provider.testConnection(params.credentials);
    } catch (err) {
      console.error(`[Integrations] testConnection for ${params.service} threw:`, err);
      throw new IntegrationError(
        `Failed to connect to ${provider.displayName}: ${err instanceof Error ? err.message : String(err)}`,
        ErrorCodes.INTEGRATION_AUTH_FAILED,
      );
    }
    if (!connectionValid) {
      console.error(`[Integrations] testConnection for ${params.service} returned false (credentials present: ${Object.keys(params.credentials).join(', ')})`);
      throw new IntegrationError(
        `Failed to connect to ${provider.displayName}. Ensure the API is enabled in your provider's console.`,
        ErrorCodes.INTEGRATION_AUTH_FAILED,
      );
    }
  }

  // Ensure user exists
  await db.getOrCreateUser(appDb, { id: userId, email: userEmail });

  // Compute expiresAt from credential data.
  // MCP OAuth passes expires_in (seconds); traditional OAuth providers (e.g. Google
  // Workspace) pass expires_at (ISO string) from their exchangeOAuthCode.
  let expiresAt: string | undefined;
  const expiresInRaw = params.credentials.expires_in;
  if (expiresInRaw) {
    const expiresInSec = parseInt(expiresInRaw, 10);
    if (!Number.isNaN(expiresInSec) && expiresInSec > 0) {
      expiresAt = new Date(Date.now() + expiresInSec * 1000).toISOString();
    }
  } else if (params.credentials.expires_at) {
    // Traditional OAuth providers return an ISO timestamp directly
    const parsed = Date.parse(params.credentials.expires_at);
    if (!Number.isNaN(parsed)) {
      expiresAt = new Date(parsed).toISOString();
    }
  }

  if (provider.isCustomConnector) {
    await deleteIncompatibleCustomCredentialRows(appDb, userId, params.service, credentialType);
  }

  // Store credentials in unified credentials table
  await storeCredential(env, 'user', userId, params.service, credentialData, {
    credentialType,
    scopes: params.config.entities.join(' '),
    expiresAt,
  });

  if (existingIntegration) {
    const updated = await db.updateIntegration(appDb, existingIntegration.id, {
      config: params.config,
      status: 'active',
      errorMessage: null,
    });
    if (!updated) {
      throw new IntegrationError(
        `Integration for ${params.service} disappeared during update`,
        ErrorCodes.INTEGRATION_NOT_FOUND,
      );
    }
    return {
      id: updated.id,
      service: updated.service,
      status: 'active',
      config: updated.config as unknown as Record<string, unknown>,
      createdAt: updated.createdAt,
    };
  }

  const integrationId = crypto.randomUUID();
  const created = await db.createIntegration(appDb, {
    id: integrationId,
    userId,
    service: params.service,
    config: params.config,
  });

  await db.updateIntegrationStatus(appDb, integrationId, 'active');

  return {
    id: created.id,
    service: created.service,
    status: 'active',
    config: created.config as unknown as Record<string, unknown>,
    createdAt: created.createdAt,
  };
}

async function testCustomMcpUserCredential(
  service: string,
  displayName: string,
  customContext: Awaited<ReturnType<typeof loadCustomMcpConnectorContext>> | undefined,
  token: string,
): Promise<void> {
  if (!customContext) {
    throw new IntegrationError(`Failed to connect to ${displayName}: custom connector context unavailable`, ErrorCodes.INTEGRATION_AUTH_FAILED);
  }
  const actionSource = integrationRegistry.getActions(service, customContext);
  if (!actionSource) {
    throw new IntegrationError(`Failed to connect to ${displayName}: no action source configured`, ErrorCodes.INTEGRATION_AUTH_FAILED);
  }

  await actionSource.listActions({ credentials: { access_token: token } });
  const listError = getActionSourceListError(actionSource);
  if (listError) {
    throw new IntegrationError(`Failed to connect to ${displayName}: ${listError}`, ErrorCodes.INTEGRATION_AUTH_FAILED);
  }
}

function getActionSourceListError(actionSource: unknown): string | null {
  if (
    typeof actionSource === 'object'
    && actionSource !== null
    && 'getLastListError' in actionSource
    && typeof actionSource.getLastListError === 'function'
  ) {
    return (actionSource as { getLastListError: () => string | null }).getLastListError();
  }
  return null;
}

async function deleteIncompatibleCustomCredentialRows(
  appDb: AppDb,
  userId: string,
  service: string,
  credentialType: 'oauth2' | 'api_key',
): Promise<void> {
  const staleType = credentialType === 'api_key' ? 'oauth2' : 'api_key';
  await credentialRows.deleteCredential(appDb, 'user', userId, service, staleType);
}
