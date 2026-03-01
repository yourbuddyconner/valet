import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { NotFoundError, ValidationError } from '@agent-ops/shared';
import type { OAuthConfig } from '@agent-ops/sdk';
import type { Env, Variables } from '../env.js';
import * as db from '../lib/db.js';
import * as integrationService from '../services/integrations.js';
import { integrationRegistry } from '../integrations/registry.js';
import { revokeCredential } from '../services/credentials.js';

export const integrationsRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Resolve OAuth client credentials from env vars for a given service. */
function resolveOAuthConfig(service: string, env: Env): OAuthConfig {
  if (service === 'github') {
    return { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET };
  }
  // Gmail, Google Calendar, and Google Drive all use the same Google OAuth app
  if (service === 'gmail' || service === 'google_calendar' || service === 'google_drive') {
    return { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET };
  }
  throw new ValidationError(`OAuth not configured for service: ${service}`);
}

// Validation schemas
const configureIntegrationSchema = z.object({
  service: z.enum(['github', 'gmail', 'google_calendar', 'google_drive', 'notion', 'hubspot', 'ashby', 'discord', 'xero']),
  credentials: z.record(z.string()),
  config: z.object({
    syncFrequency: z.enum(['realtime', 'hourly', 'daily', 'manual']).default('hourly'),
    entities: z.array(z.string()).default([]),
    filters: z.record(z.unknown()).optional(),
  }),
});

const triggerSyncSchema = z.object({
  entities: z.array(z.string()).optional(),
  fullSync: z.boolean().optional(),
});

/**
 * GET /api/integrations
 * List user's integrations + org-scope integrations
 */
integrationsRouter.get('/', async (c) => {
  const user = c.get('user');

  // Get user's own integrations
  const userIntegrations = await db.getUserIntegrations(c.get('db'), user.id);

  // Get org-scope integrations (visible to all members)
  const orgIntegrations = await db.getOrgIntegrations(c.get('db'), user.id);

  // Don't expose sensitive data
  const sanitized = [
    ...userIntegrations.map((i) => ({
      id: i.id,
      service: i.service,
      status: i.status,
      scope: i.scope,
      config: {
        syncFrequency: i.config.syncFrequency,
        entities: i.config.entities,
      },
      lastSyncedAt: i.lastSyncedAt,
      createdAt: i.createdAt,
    })),
    ...orgIntegrations.map((i) => ({
      id: i.id,
      service: i.service,
      status: i.status,
      scope: i.scope,
      config: {
        syncFrequency: (i.config as any).syncFrequency,
        entities: (i.config as any).entities,
      },
      lastSyncedAt: i.lastSyncedAt,
      createdAt: i.createdAt,
    })),
  ];

  return c.json({ integrations: sanitized });
});

/**
 * GET /api/integrations/available
 * List available integration services with rich metadata
 */
integrationsRouter.get('/available', async (c) => {
  const packages = integrationRegistry.listPackages();

  const available = packages.map((pkg) => ({
    service: pkg.service,
    displayName: pkg.provider.displayName,
    authType: pkg.provider.authType,
    supportedEntities: pkg.provider.supportedEntities,
    hasActions: !!pkg.actions,
    hasTriggers: !!pkg.triggers,
    hasSync: !!pkg.sync,
  }));

  return c.json({ services: available });
});

/**
 * POST /api/integrations
 * Configure a new integration
 */
integrationsRouter.post('/', zValidator('json', configureIntegrationSchema), async (c) => {
  const user = c.get('user');
  const body = c.req.valid('json');

  const integration = await integrationService.configureIntegration(c.env, user.id, user.email, body);
  return c.json({ integration }, 201);
});

/**
 * GET /api/integrations/:id
 * Get integration details
 */
integrationsRouter.get('/:id', async (c) => {
  const user = c.get('user');
  const { id } = c.req.param();

  const integration = await db.getIntegration(c.get('db'), id);

  if (!integration) {
    throw new NotFoundError('Integration', id);
  }

  if (integration.userId !== user.id) {
    throw new NotFoundError('Integration', id);
  }

  return c.json({
    integration: {
      id: integration.id,
      service: integration.service,
      status: integration.status,
      config: integration.config,
      lastSyncedAt: integration.lastSyncedAt,
      createdAt: integration.createdAt,
    },
  });
});

/**
 * POST /api/integrations/:id/sync
 * Trigger a sync
 */
integrationsRouter.post('/:id/sync', zValidator('json', triggerSyncSchema), async (c) => {
  const user = c.get('user');
  const { id } = c.req.param();
  const body = c.req.valid('json');

  const result = await integrationService.triggerIntegrationSync(
    c.env, user.id, id, body, c.executionCtx,
  );

  return c.json({ syncId: result.syncId, status: 'started' }, 202);
});

/**
 * GET /api/integrations/:id/sync/:syncId
 * Get sync status
 */
integrationsRouter.get('/:id/sync/:syncId', async (c) => {
  const user = c.get('user');
  const { id, syncId } = c.req.param();

  const integration = await db.getIntegration(c.get('db'), id);

  if (!integration) {
    throw new NotFoundError('Integration', id);
  }

  if (integration.userId !== user.id) {
    throw new NotFoundError('Integration', id);
  }

  const syncLog = await db.getSyncLog(c.get('db'), syncId);

  if (!syncLog || syncLog.integrationId !== id) {
    throw new NotFoundError('Sync', syncId);
  }

  return c.json(syncLog);
});

/**
 * DELETE /api/integrations/:id
 * Remove an integration
 */
integrationsRouter.delete('/:id', async (c) => {
  const user = c.get('user');
  const { id } = c.req.param();

  const integration = await db.getIntegration(c.get('db'), id);

  if (!integration) {
    throw new NotFoundError('Integration', id);
  }

  if (integration.userId !== user.id) {
    throw new NotFoundError('Integration', id);
  }

  // Revoke credentials in unified credentials table
  await revokeCredential(c.env, user.id, integration.service);

  // Delete integration record (cascades to sync_logs)
  await db.deleteIntegration(c.get('db'), id);

  return c.json({ success: true });
});

/**
 * GET /api/integrations/:service/oauth
 * Get OAuth URL for a service
 */
integrationsRouter.get('/:service/oauth', async (c) => {
  const { service } = c.req.param();
  const { redirect_uri } = c.req.query();

  if (!redirect_uri) {
    throw new ValidationError('redirect_uri is required');
  }

  const provider = integrationRegistry.getProvider(service);
  if (!provider?.getOAuthUrl) {
    throw new ValidationError(`OAuth not supported for ${service}`);
  }

  const oauth = resolveOAuthConfig(service, c.env);
  const state = crypto.randomUUID();
  const url = provider.getOAuthUrl(oauth, redirect_uri, state);

  return c.json({ url, state });
});

/**
 * POST /api/integrations/:service/oauth/callback
 * Handle OAuth callback
 */
integrationsRouter.post('/:service/oauth/callback', async (c) => {
  const { service } = c.req.param();
  const { code, redirect_uri } = await c.req.json<{ code: string; redirect_uri: string }>();

  if (!code || !redirect_uri) {
    throw new ValidationError('code and redirect_uri are required');
  }

  const provider = integrationRegistry.getProvider(service);
  if (!provider?.exchangeOAuthCode) {
    throw new ValidationError(`OAuth not supported for ${service}`);
  }

  const oauth = resolveOAuthConfig(service, c.env);
  const credentials = await provider.exchangeOAuthCode(oauth, code, redirect_uri);

  return c.json({ credentials });
});
