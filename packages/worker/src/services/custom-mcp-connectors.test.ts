import { describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from '../test-utils/db.js';
import { users } from '../lib/schema/users.js';
import { credentials, integrations, mcpOauthClients, mcpToolCache, customMcpConnectors } from '../lib/schema/index.js';
import { actionPolicies, userActionPolicyOverrides } from '../lib/schema/actions.js';
import { disabledActions } from '../lib/schema/disabled-actions.js';
import { encryptString } from '../lib/crypto.js';
import type { AppDb } from '../lib/drizzle.js';
import {
  createCustomMcpConnector,
  deleteCustomMcpConnectorCascade,
  getCustomMcpOAuthConfig,
  loadCustomMcpConnectorContext,
  listConnectorSummaries,
  updateCustomMcpConnector,
} from './custom-mcp-connectors.js';
import type { Env } from '../env.js';

const ENCRYPTION_KEY = 'test-encryption-key';

function makeEnv(): Env {
  return {
    ENCRYPTION_KEY,
  } as Env;
}

function makeD1Batch(sqlite: ReturnType<typeof createTestDb>['sqlite']): D1Database {
  return {
    prepare: vi.fn((sql: string) => ({
      bind: vi.fn((...params: unknown[]) => ({
        run: vi.fn(() => {
          sqlite.prepare(sql).run(...params);
          return Promise.resolve({ success: true });
        }),
      })),
    })),
    batch: vi.fn(async (statements: Array<{ run: () => Promise<unknown> }>) => {
      for (const statement of statements) {
        await statement.run();
      }
      return [];
    }),
  } as unknown as D1Database;
}

describe('custom MCP connector service', () => {
  it('decrypts active connector context into static auth and additional headers', async () => {
    const { db } = createTestDb();
    const appDb: AppDb = db;
    await db.insert(customMcpConnectors).values({
      id: 'connector-1',
      orgId: 'default',
      serviceSlug: 'salesforce',
      displayName: 'Salesforce',
      serverUrl: 'https://mcp.salesforce.com/platform/mcp',
      authType: 'bearer',
      encryptedApiKey: await encryptString('bearer-token', ENCRYPTION_KEY),
      apiKeyHeaderName: 'Authorization',
      apiKeyPrefix: 'Bearer',
      encryptedAdditionalHeaders: await encryptString(JSON.stringify({ 'X-Tenant': 'acme' }), ENCRYPTION_KEY),
      status: 'active',
    }).run();

    const context = await loadCustomMcpConnectorContext(makeEnv(), appDb, 'default');

    expect(context.connectors.get('salesforce')).toMatchObject({
      serviceSlug: 'salesforce',
      displayName: 'Salesforce',
      serverUrl: 'https://mcp.salesforce.com/platform/mcp',
      authType: 'bearer',
      additionalHeaders: { 'X-Tenant': 'acme' },
      staticAuthHeader: { name: 'Authorization', value: 'Bearer bearer-token' },
    });
  });

  it('rejects protected additional headers while loading runtime context', async () => {
    const { db } = createTestDb();
    const appDb: AppDb = db;
    await db.insert(customMcpConnectors).values({
      id: 'connector-1',
      orgId: 'default',
      serviceSlug: 'bad-headers',
      displayName: 'Bad Headers',
      serverUrl: 'https://mcp.example.com',
      authType: 'none',
      encryptedAdditionalHeaders: await encryptString(JSON.stringify({ Authorization: 'Bearer nope' }), ENCRYPTION_KEY),
      status: 'active',
    }).run();

    await expect(loadCustomMcpConnectorContext(makeEnv(), appDb, 'default')).rejects.toThrow(/protected header/i);
  });

  it('creates and updates connectors with validation, encryption, and cache invalidation', async () => {
    const { db } = createTestDb();
    const appDb: AppDb = db;
    db.insert(users).values({ id: 'admin-1', email: 'admin@example.com' }).run();

    const created = await createCustomMcpConnector(makeEnv(), appDb, {
      displayName: 'Salesforce MCP',
      serverUrl: 'https://mcp.salesforce.com/platform/mcp',
      authType: 'api_key',
      apiKey: 'secret-key',
      apiKeyHeaderName: 'X-API-Key',
      apiKeyPrefix: 'Token',
      additionalHeaders: { 'X-Tenant': 'acme' },
      status: 'active',
    }, { orgId: 'default', createdBy: 'admin-1' });

    expect(created).toMatchObject({
      serviceSlug: 'salesforce-mcp',
      hasApiKey: true,
      hasAdditionalHeaders: true,
    });

    const row = db.select().from(customMcpConnectors).where(eq(customMcpConnectors.id, created.id)).get();
    expect(row?.encryptedApiKey).toBeTruthy();
    expect(row?.encryptedApiKey).not.toBe('secret-key');

    await db.insert(mcpToolCache).values({
      service: created.serviceSlug,
      actionId: 'salesforce.query',
      name: 'Query',
      description: '',
      riskLevel: 'low',
    }).run();

    const updated = await updateCustomMcpConnector(makeEnv(), appDb, created.id, {
      authType: 'none',
      serverUrl: 'https://mcp.salesforce.com/platform/new-mcp',
      clearAdditionalHeaders: true,
    });

    expect(updated?.authType).toBe('none');
    expect(updated?.hasApiKey).toBe(false);
    expect(updated?.hasAdditionalHeaders).toBe(false);
    expect(db.select().from(mcpToolCache).where(eq(mcpToolCache.service, created.serviceSlug)).all()).toEqual([]);
  });

  it('invalidates dynamic MCP OAuth clients when OAuth connector identity changes', async () => {
    const { db } = createTestDb();
    const appDb: AppDb = db;
    const connector = await createCustomMcpConnector(makeEnv(), appDb, {
      displayName: 'Ramp',
      serverUrl: 'https://mcp.ramp.com/mcp',
      authType: 'oauth',
      oauthClientId: null,
    }, { orgId: 'default', createdBy: null });

    db.insert(mcpOauthClients).values({
      service: connector.serviceSlug,
      clientId: 'stale-client',
      authorizationEndpoint: 'https://auth.ramp.com/oauth/authorize',
      tokenEndpoint: 'https://auth.ramp.com/oauth/token',
      registrationEndpoint: 'https://auth.ramp.com/oauth/register',
    }).run();

    await updateCustomMcpConnector(makeEnv(), appDb, connector.id, {
      serverUrl: 'https://mcp.ramp.com/new-mcp',
    });

    expect(db.select().from(mcpOauthClients).where(eq(mcpOauthClients.service, connector.serviceSlug)).all()).toEqual([]);
  });

  it('preserves dynamic MCP OAuth clients when unchanged no-client OAuth fields are submitted', async () => {
    const { db } = createTestDb();
    const appDb: AppDb = db;
    const connector = await createCustomMcpConnector(makeEnv(), appDb, {
      displayName: 'Ramp',
      serverUrl: 'https://mcp.ramp.com/mcp',
      authType: 'oauth',
      oauthClientId: null,
    }, { orgId: 'default', createdBy: null });

    db.insert(mcpOauthClients).values({
      service: connector.serviceSlug,
      clientId: 'dynamic-client',
      authorizationEndpoint: 'https://auth.ramp.com/oauth/authorize',
      tokenEndpoint: 'https://auth.ramp.com/oauth/token',
      registrationEndpoint: 'https://auth.ramp.com/oauth/register',
    }).run();

    await updateCustomMcpConnector(makeEnv(), appDb, connector.id, {
      status: 'disabled',
      oauthScopes: 'openid profile offline_access',
      oauthClientId: null,
      oauthAuthorizationEndpoint: null,
      oauthTokenEndpoint: null,
    });

    expect(db.select().from(mcpOauthClients).where(eq(mcpOauthClients.service, connector.serviceSlug)).all()).toEqual([
      expect.objectContaining({
        service: connector.serviceSlug,
        clientId: 'dynamic-client',
      }),
    ]);
  });

  it('rejects service slugs that collide with built-in integrations', async () => {
    const { db } = createTestDb();
    const appDb: AppDb = db;

    await expect(createCustomMcpConnector(makeEnv(), appDb, {
      displayName: 'GitHub',
      serverUrl: 'https://github-mcp.example.com/mcp',
      authType: 'none',
    }, { orgId: 'default', createdBy: null })).rejects.toThrow(/built-in/i);
  });

  it('rejects invalid API-key static auth header configuration before storage', async () => {
    const { db } = createTestDb();
    const appDb: AppDb = db;

    await expect(createCustomMcpConnector(makeEnv(), appDb, {
      displayName: 'Cookie Header MCP',
      serverUrl: 'https://cookie-header.example.com/mcp',
      authType: 'api_key',
      apiKey: 'secret-key',
      apiKeyHeaderName: 'Cookie',
    }, { orgId: 'default', createdBy: null })).rejects.toThrow(/protected header/i);

    await expect(createCustomMcpConnector(makeEnv(), appDb, {
      displayName: 'Bad Secret MCP',
      serverUrl: 'https://bad-secret.example.com/mcp',
      authType: 'api_key',
      apiKey: 'secret\r\nInjected: yes',
      apiKeyHeaderName: 'X-API-Key',
    }, { orgId: 'default', createdBy: null })).rejects.toThrow(/invalid value/i);
  });

  it('loads OAuth config with decrypted client secret', async () => {
    const { db } = createTestDb();
    const appDb: AppDb = db;
    await createCustomMcpConnector(makeEnv(), appDb, {
      displayName: 'Salesforce MCP',
      serverUrl: 'https://mcp.salesforce.com/platform/mcp',
      authType: 'oauth',
      oauthClientId: 'client-id',
      oauthClientSecret: 'client-secret',
      oauthTokenEndpointAuthMethod: 'client_secret_basic',
      oauthScopes: 'mcp_api refresh_token',
      oauthAuthorizationEndpoint: 'https://login.salesforce.com/services/oauth2/authorize',
      oauthTokenEndpoint: 'https://login.salesforce.com/services/oauth2/token',
    }, { orgId: 'default', createdBy: null });

    const config = await getCustomMcpOAuthConfig(makeEnv(), appDb, 'salesforce-mcp', 'default');

    expect(config).toMatchObject({
      serviceSlug: 'salesforce-mcp',
      serverUrl: 'https://mcp.salesforce.com/platform/mcp',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      tokenEndpointAuthMethod: 'client_secret_basic',
      scopes: ['mcp_api', 'refresh_token'],
      authorizationEndpoint: 'https://login.salesforce.com/services/oauth2/authorize',
      tokenEndpoint: 'https://login.salesforce.com/services/oauth2/token',
    });
  });

  it('does not fetch unsafe authorization servers during admin-provided OAuth discovery', async () => {
    const { db } = createTestDb();
    const appDb: AppDb = db;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === 'https://mcp.safe-discovery.example.com/.well-known/oauth-protected-resource') {
        return Response.json({ authorization_servers: ['http://localhost'] });
      }
      if (url.startsWith('http://localhost')) {
        throw new Error('unsafe authorization server should not be fetched');
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(createCustomMcpConnector(makeEnv(), appDb, {
      displayName: 'Safe Discovery MCP',
      serverUrl: 'https://mcp.safe-discovery.example.com/mcp',
      authType: 'oauth',
      oauthClientId: 'client-id',
    }, { orgId: 'default', createdBy: null })).rejects.toThrow(/discovery|not allowed|https/i);

    expect(fetchMock.mock.calls.map((call) => String(call[0]))).not.toContain(
      'http://localhost/.well-known/oauth-authorization-server',
    );
  });

  it('rejects unsafe OAuth endpoints returned by admin-provided discovery before storage', async () => {
    const { db } = createTestDb();
    const appDb: AppDb = db;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === 'https://mcp.unsafe-endpoints.example.com/.well-known/oauth-protected-resource') {
        return new Response('not found', { status: 404 });
      }
      if (url === 'https://mcp.unsafe-endpoints.example.com/.well-known/oauth-authorization-server') {
        return Response.json({
          authorization_endpoint: 'http://localhost/oauth/authorize',
          token_endpoint: 'http://localhost/oauth/token',
        });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(createCustomMcpConnector(makeEnv(), appDb, {
      displayName: 'Unsafe Endpoint Discovery MCP',
      serverUrl: 'https://mcp.unsafe-endpoints.example.com/mcp',
      authType: 'oauth',
      oauthClientId: 'client-id',
    }, { orgId: 'default', createdBy: null })).rejects.toThrow(/not allowed|https|localhost/i);

    expect(db.select().from(customMcpConnectors).all()).toHaveLength(0);
  });

  it('creates OAuth connectors without a preconfigured client ID for dynamic MCP OAuth', async () => {
    const { db } = createTestDb();
    const appDb: AppDb = db;

    const connector = await createCustomMcpConnector(makeEnv(), appDb, {
      displayName: 'Ramp',
      serverUrl: 'https://mcp.ramp.com/mcp',
      authType: 'oauth',
      oauthClientId: null,
      oauthScopes: 'openid profile offline_access',
    }, { orgId: 'default', createdBy: null });

    expect(connector).toMatchObject({
      serviceSlug: 'ramp',
      authType: 'oauth',
      oauthClientId: null,
      oauthScopes: 'openid profile offline_access',
      oauthAuthorizationEndpoint: null,
      oauthTokenEndpoint: null,
      hasClientSecret: false,
    });
  });

  it('returns connector summaries with cached tool counts', async () => {
    const { db } = createTestDb();
    const appDb: AppDb = db;
    const connector = await createCustomMcpConnector(makeEnv(), appDb, {
      displayName: 'Summary MCP',
      serverUrl: 'https://summary.example.com/mcp',
      authType: 'none',
    }, { orgId: 'default', createdBy: null });
    await db.insert(mcpToolCache).values([
      { service: connector.serviceSlug, actionId: 'a', name: 'A', description: '', riskLevel: 'low' },
      { service: connector.serviceSlug, actionId: 'b', name: 'B', description: '', riskLevel: 'medium' },
    ]).run();

    const summaries = await listConnectorSummaries(appDb, 'default');

    expect(summaries).toHaveLength(1);
    expect(summaries[0].toolCount).toBe(2);
  });

  it('deletes connector-owned runtime state in one D1 batch while preserving action history', async () => {
    const { db, sqlite } = createTestDb();
    const appDb: AppDb = db;
    db.insert(users).values({ id: 'user-1', email: 'user@example.com' }).run();
    const connector = await createCustomMcpConnector(makeEnv(), appDb, {
      displayName: 'Delete MCP',
      serverUrl: 'https://delete.example.com/mcp',
      authType: 'oauth',
      oauthClientId: 'client-id',
      oauthAuthorizationEndpoint: 'https://login.example.com/auth',
      oauthTokenEndpoint: 'https://login.example.com/token',
    }, { orgId: 'default', createdBy: null });

    db.insert(integrations).values({
      id: 'integration-1',
      userId: 'user-1',
      service: connector.serviceSlug,
      config: { entities: [] },
      status: 'active',
    }).run();
    db.insert(credentials).values({
      id: 'credential-1',
      ownerType: 'user',
      ownerId: 'user-1',
      provider: connector.serviceSlug,
      credentialType: 'oauth2',
      encryptedData: 'encrypted',
    }).run();
    db.insert(mcpToolCache).values({
      service: connector.serviceSlug,
      actionId: 'tool',
      name: 'Tool',
      description: '',
      riskLevel: 'low',
    }).run();
    db.insert(mcpOauthClients).values({
      service: connector.serviceSlug,
      clientId: 'dynamic-client',
      authorizationEndpoint: 'https://login.example.com/auth',
      tokenEndpoint: 'https://login.example.com/token',
      registrationEndpoint: 'https://login.example.com/register',
    }).run();
    db.insert(disabledActions).values({
      id: 'disabled-1',
      service: connector.serviceSlug,
      actionId: null,
      disabledBy: 'user-1',
    }).run();
    db.insert(actionPolicies).values({
      id: 'policy-1',
      service: connector.serviceSlug,
      actionId: null,
      riskLevel: null,
      mode: 'deny',
      createdBy: 'user-1',
    }).run();
    db.insert(userActionPolicyOverrides).values({
      id: 'override-1',
      userId: 'user-1',
      service: connector.serviceSlug,
      actionId: null,
      riskLevel: null,
      mode: 'allow',
    }).run();

    await deleteCustomMcpConnectorCascade(makeD1Batch(sqlite), appDb, connector.id);

    expect(db.select().from(customMcpConnectors).all()).toHaveLength(0);
    expect(db.select().from(integrations).all()).toHaveLength(0);
    expect(db.select().from(credentials).all()).toHaveLength(0);
    expect(db.select().from(mcpToolCache).all()).toHaveLength(0);
    expect(db.select().from(mcpOauthClients).all()).toHaveLength(0);
    expect(db.select().from(disabledActions).all()).toHaveLength(0);
    expect(db.select().from(actionPolicies).all()).toHaveLength(0);
    expect(db.select().from(userActionPolicyOverrides).all()).toHaveLength(0);
  });
});
