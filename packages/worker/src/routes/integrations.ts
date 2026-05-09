import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { NotFoundError, ValidationError } from '@valet/shared';
import {
  type OAuthConfig,
  discoverAuthServer,
  registerClient,
  generatePkceChallenge,
  buildAuthorizationUrl,
  exchangeCodePkce,
} from '@valet/sdk';
import { type Env, type Variables, getEnvString } from '../env.js';
import * as db from '../lib/db.js';
import * as mcpOAuthDb from '../lib/db/mcp-oauth.js';
import * as integrationService from '../services/integrations.js';
import { integrationRegistry } from '../integrations/registry.js';
import { revokeCredential } from '../services/credentials.js';
import { getDb } from '../lib/drizzle.js';
import { listMcpToolCache } from '../lib/db/mcp-tool-cache.js';
import { getDisabledPluginServices } from '../lib/db/plugins.js';

export const integrationsRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Resolve OAuth client credentials from env vars using provider-declared key names. */
function resolveOAuthConfig(service: string, env: Env): OAuthConfig {
  const provider = integrationRegistry.getProvider(service);
  const keys = provider?.oauthEnvKeys;
  if (!keys) {
    throw new ValidationError(`OAuth not configured for service: ${service}`);
  }
  const clientId = getEnvString(env, keys.clientId);
  const clientSecret = getEnvString(env, keys.clientSecret);
  if (!clientId || !clientSecret) {
    throw new ValidationError(`OAuth env vars missing for service: ${service} (need ${keys.clientId}, ${keys.clientSecret})`);
  }
  return { clientId, clientSecret };
}

/**
 * Ensure we have a registered MCP OAuth client for a service.
 * Discovers metadata + registers a dynamic client if not already cached in D1.
 */
async function ensureMcpOAuthClient(
  env: Env,
  service: string,
  mcpServerUrl: string,
  redirectUri: string,
) {
  const d1 = getDb(env.DB);
  const existing = await mcpOAuthDb.getMcpOAuthClient(d1, service);
  if (existing) return existing;

  // Discover authorization server metadata
  const metadata = await discoverAuthServer(mcpServerUrl);
  if (!metadata.registration_endpoint) {
    throw new ValidationError(`MCP server ${mcpServerUrl} does not support dynamic client registration`);
  }

  // Register a new client
  let registered;
  try {
    registered = await registerClient(metadata.registration_endpoint, {
      clientName: 'Valet',
      redirectUris: [redirectUri],
    });
  } catch (err) {
    throw new ValidationError(
      `MCP OAuth client registration failed for ${service}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const row: mcpOAuthDb.McpOAuthClientRow = {
    service,
    clientId: registered.client_id,
    clientSecret: registered.client_secret ?? null,
    authorizationEndpoint: metadata.authorization_endpoint,
    tokenEndpoint: metadata.token_endpoint,
    registrationEndpoint: metadata.registration_endpoint,
    scopesSupported: metadata.scopes_supported ? JSON.stringify(metadata.scopes_supported) : null,
    metadataJson: JSON.stringify(metadata),
  };

  return mcpOAuthDb.insertMcpOAuthClientIfNotExists(d1, row);
}

// Validation schemas
const configureIntegrationSchema = z.object({
  service: z.string().min(1).refine(
    (s) => integrationRegistry.getPackage(s) !== undefined,
    (s) => ({ message: `Unknown integration service: ${s}` }),
  ),
  credentials: z.record(z.string()),
  config: z.object({
    entities: z.array(z.string()).default([]),
    filters: z.record(z.unknown()).optional(),
  }),
});

/**
 * GET /api/integrations
 * List user's integrations + org-scope integrations
 */
integrationsRouter.get('/', async (c) => {
  const user = c.get('user');
  const disabledPlugins = await getDisabledPluginServices(c.env.DB);

  // Get user's own integrations
  const userIntegrations = await db.getUserIntegrations(c.get('db'), user.id);

  // Get org-scope integrations (visible to all members)
  const orgIntegrations = await db.getOrgIntegrations(c.get('db'));

  // Don't expose sensitive data; filter out disabled plugins
  const sanitized = [
    ...userIntegrations.map((i) => ({
      id: i.id,
      service: i.service,
      status: i.status,
      scope: i.scope,
      config: {
        entities: i.config.entities,
      },
      createdAt: i.createdAt,
    })),
    ...orgIntegrations.map((i) => ({
      id: i.id,
      service: i.service,
      status: i.status,
      scope: i.scope,
      config: {
        entities: (i.config as any).entities,
      },
      createdAt: i.createdAt,
    })),
  ].filter((i) => !disabledPlugins.has(i.service));

  return c.json({ integrations: sanitized });
});

/**
 * GET /api/integrations/available
 * List integration services that are actually configured (OAuth env vars present).
 * MCP OAuth services (with mcpServerUrl) are always available — no env vars needed.
 */
integrationsRouter.get('/available', async (c) => {
  const packages = integrationRegistry.listPackages();
  const disabledPlugins = await getDisabledPluginServices(c.env.DB);

  const available = packages
    .filter((pkg) => {
      // Skip plugins disabled by admin
      if (disabledPlugins.has(pkg.service)) return false;
      // MCP OAuth services — always available (dynamic client registration)
      if (pkg.provider.mcpServerUrl) return true;
      // Traditional OAuth services — need env vars configured
      if (pkg.provider.authType === 'oauth2' && pkg.provider.oauthEnvKeys) {
        const clientId = getEnvString(c.env, pkg.provider.oauthEnvKeys.clientId);
        const clientSecret = getEnvString(c.env, pkg.provider.oauthEnvKeys.clientSecret);
        if (!clientId || !clientSecret) return false;
      }
      return true;
    })
    .map((pkg) => ({
      service: pkg.service,
      displayName: pkg.provider.displayName,
      authType: pkg.provider.authType,
      supportedEntities: pkg.provider.supportedEntities,
      hasActions: !!pkg.actions,
      hasTriggers: !!pkg.triggers,
    }));

  return c.json({ services: available, disabledServices: [...disabledPlugins] });
});

/**
 * GET /api/integrations/actions
 * List all actions from the integration registry (for policy editor autocomplete)
 */
integrationsRouter.get('/actions', async (c) => {
  const serviceFilter = c.req.query('service');
  const packages = integrationRegistry.listPackages();

  // Build a lookup of provider display names by service for cache entries
  const displayNameMap = new Map<string, string>();
  for (const pkg of packages) {
    displayNameMap.set(pkg.service, pkg.provider.displayName);
  }

  const catalog: Array<{
    service: string;
    serviceDisplayName: string;
    actionId: string;
    name: string;
    description: string;
    riskLevel: string;
  }> = [];

  // Track which service:actionId combos we've already added from static sources
  const seen = new Set<string>();

  for (const pkg of packages) {
    if (serviceFilter && pkg.service !== serviceFilter) continue;
    // listActions may be async (e.g. MCP-backed sources). Without credentials
    // MCP sources return [] gracefully, which is fine for the catalog endpoint.
    const actions = await (pkg.actions?.listActions() ?? []);
    for (const a of actions) {
      const key = `${pkg.service}:${a.id}`;
      seen.add(key);
      catalog.push({
        service: pkg.service,
        serviceDisplayName: pkg.provider.displayName,
        actionId: a.id,
        name: a.name,
        description: a.description,
        riskLevel: a.riskLevel,
      });
    }
  }

  // Merge cached MCP tool metadata (discovered at runtime by SessionAgentDO).
  // This surfaces MCP-backed tools that can't be listed without credentials.
  try {
    const appDb = getDb(c.env.DB);
    const cached = await listMcpToolCache(appDb, serviceFilter ?? undefined);
    for (const entry of cached) {
      const key = `${entry.service}:${entry.actionId}`;
      if (seen.has(key)) continue; // static source already provided this tool
      seen.add(key);
      catalog.push({
        service: entry.service,
        serviceDisplayName: displayNameMap.get(entry.service) ?? entry.service,
        actionId: entry.actionId,
        name: entry.name,
        description: entry.description,
        riskLevel: entry.riskLevel,
      });
    }
  } catch (err) {
    // Cache read failure is non-fatal — static catalog still works
    console.warn('[integrations/actions] mcp tool cache read failed:', err instanceof Error ? err.message : String(err));
  }

  return c.json({ actions: catalog });
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
 * GET /api/integrations/google_workspace/labels
 * List available Drive labels for guard config
 */
integrationsRouter.get('/google_workspace/labels', async (c) => {
  const user = c.get('user');
  const env = c.env;

  const credResult = await integrationRegistry.resolveCredentials(
    'google_workspace', env, user.id, {}
  );

  if (!credResult.ok) {
    return c.json({ available: false, reason: 'Google Workspace integration not connected' });
  }

  const token = credResult.credential.accessToken;

  try {
    const allLabels: Array<{ id: string; name: string; labelType: string; properties?: { title: string } }> = [];
    let pageToken: string | undefined;

    do {
      const params = new URLSearchParams({ view: 'LABEL_VIEW_FULL', pageSize: '200' });
      if (pageToken) params.set('pageToken', pageToken);

      const res = await fetch(
        `https://drivelabels.googleapis.com/v2/labels?${params}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );

      if (!res.ok) {
        // If the first page fails, report unavailable with the actual error for diagnosis.
        if (allLabels.length === 0) {
          let detail = `${res.status}`;
          try {
            const errBody = (await res.json()) as { error?: { message?: string; status?: string } };
            if (errBody.error?.message) detail = errBody.error.message;
          } catch { /* ignore parse failure */ }
          console.error(`Drive Labels API error: ${res.status} — ${detail}`);
          return c.json({
            available: false,
            reason: `Drive Labels API error: ${detail}`,
          });
        }
        break;
      }

      const data = (await res.json()) as {
        labels?: typeof allLabels;
        nextPageToken?: string;
      };

      allLabels.push(...(data.labels ?? []));
      pageToken = data.nextPageToken;
    } while (pageToken);

    const labels = allLabels.map((l) => ({
      id: l.id,
      name: l.properties?.title ?? l.name ?? l.id,
      type: l.labelType ?? 'UNKNOWN',
    }));

    return c.json({ available: true, labels });
  } catch {
    return c.json({
      available: false,
      reason: 'Failed to fetch labels from Google Drive API',
    });
  }
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
      createdAt: integration.createdAt,
    },
  });
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
  await revokeCredential(c.env, 'user', user.id, integration.service);

  // Delete integration record
  await db.deleteIntegration(c.get('db'), id);

  return c.json({ success: true });
});

/**
 * GET /api/integrations/:service/oauth
 * Get OAuth URL for a service (MCP OAuth or traditional)
 */
integrationsRouter.get('/:service/oauth', async (c) => {
  const { service } = c.req.param();
  const { redirect_uri } = c.req.query();

  if (!redirect_uri) {
    throw new ValidationError('redirect_uri is required');
  }

  // Block OAuth flows for disabled plugins
  const disabledPlugins = await getDisabledPluginServices(c.env.DB);
  if (disabledPlugins.has(service)) {
    throw new ValidationError(`Integration "${service}" is disabled by your organization.`);
  }

  const provider = integrationRegistry.getProvider(service);
  if (!provider) {
    throw new ValidationError(`Unknown service: ${service}`);
  }

  if (provider.mcpServerUrl) {
    // ── MCP OAuth path ──
    const client = await ensureMcpOAuthClient(c.env, service, provider.mcpServerUrl, redirect_uri);
    const { codeVerifier, codeChallenge } = await generatePkceChallenge();
    const state = crypto.randomUUID();

    const url = buildAuthorizationUrl({
      authorizationEndpoint: client.authorizationEndpoint,
      clientId: client.clientId,
      redirectUri: redirect_uri,
      codeChallenge,
      state,
      scopes: provider.oauthScopes,
    });

    return c.json({ url, state, code_verifier: codeVerifier });
  }

  // ── Traditional OAuth path ──
  if (!provider.getOAuthUrl) {
    throw new ValidationError(`OAuth not supported for ${service}`);
  }

  const oauth = resolveOAuthConfig(service, c.env);
  const state = crypto.randomUUID();
  const url = provider.getOAuthUrl(oauth, redirect_uri, state);

  return c.json({ url, state });
});

/**
 * POST /api/integrations/:service/oauth/callback
 * Handle OAuth callback (MCP OAuth or traditional)
 */
integrationsRouter.post('/:service/oauth/callback', async (c) => {
  const { service } = c.req.param();
  const body = await c.req.json<{ code: string; redirect_uri: string; code_verifier?: string }>();
  const { code, redirect_uri, code_verifier } = body;

  if (!code || !redirect_uri) {
    throw new ValidationError('code and redirect_uri are required');
  }

  const provider = integrationRegistry.getProvider(service);
  if (!provider) {
    throw new ValidationError(`Unknown service: ${service}`);
  }

  if (provider.mcpServerUrl) {
    // ── MCP OAuth path ──
    if (!code_verifier) {
      throw new ValidationError('code_verifier is required for MCP OAuth callback');
    }

    const d1 = getDb(c.env.DB);
    const client = await mcpOAuthDb.getMcpOAuthClient(d1, service);
    if (!client) {
      throw new ValidationError(`No registered MCP OAuth client for ${service}. Initiate OAuth first.`);
    }

    const tokens = await exchangeCodePkce({
      tokenEndpoint: client.tokenEndpoint,
      clientId: client.clientId,
      code,
      redirectUri: redirect_uri,
      codeVerifier: code_verifier,
    });

    const credentials: Record<string, string> = {
      access_token: tokens.access_token,
      token_type: tokens.token_type || 'bearer',
    };
    if (tokens.refresh_token) credentials.refresh_token = tokens.refresh_token;
    if (tokens.expires_in) credentials.expires_in = String(tokens.expires_in);

    return c.json({ credentials });
  }

  // ── Traditional OAuth path ──
  if (!provider.exchangeOAuthCode) {
    throw new ValidationError(`OAuth not supported for ${service}`);
  }

  const oauth = resolveOAuthConfig(service, c.env);
  const credentials = await provider.exchangeOAuthCode(oauth, code, redirect_uri);

  return c.json({ credentials });
});
