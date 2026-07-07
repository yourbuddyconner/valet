import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Env } from '../env.js';
import { createTestDb } from '../test-utils/db.js';
import type { AppDb } from '../lib/drizzle.js';
import { credentials, customMcpConnectors, integrations } from '../lib/schema/index.js';
import { createCustomMcpConnector, updateCustomMcpConnector } from './custom-mcp-connectors.js';
import { getCredential } from './credentials.js';

const holder = vi.hoisted(() => ({
  db: null as AppDb | null,
}));

vi.mock('../lib/drizzle.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/drizzle.js')>();
  return {
    ...actual,
    getDb: vi.fn(() => holder.db),
  };
});

import { configureIntegration } from './integrations.js';

const ENCRYPTION_KEY = 'test-encryption-key';

function makeEnv(): Env {
  return {
    DB: {} as D1Database,
    ENCRYPTION_KEY,
  } as Env;
}

function stubMcpToolsList(expectedHeader?: { name: string; value: string }, status = 200) {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (expectedHeader) {
      expect(headers.get(expectedHeader.name)).toBe(expectedHeader.value);
    }

    if (status !== 200) {
      return new Response('unauthorized', { status });
    }

    const body = JSON.parse(String(init?.body)) as { id: number; method: string };
    if (body.method === 'initialize') {
      return Response.json({
        jsonrpc: '2.0',
        id: body.id,
        result: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          serverInfo: { name: 'custom-mcp', version: '1.0.0' },
        },
      }, { headers: { 'mcp-session-id': 'session-1' } });
    }
    if (body.method === 'notifications/initialized') {
      return new Response(null, { status: 202 });
    }
    return Response.json({
      jsonrpc: '2.0',
      id: body.id,
      result: { tools: [] },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('configureIntegration custom MCP connectors', () => {
  let db: AppDb;
  let env: Env;

  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    const testDb = createTestDb();
    db = testDb.db;
    holder.db = db;
    env = makeEnv();

    await createCustomMcpConnector(env, db, {
      displayName: 'Salesforce MCP',
      serverUrl: 'https://mcp.salesforce.example.com/platform/mcp',
      authType: 'oauth',
      oauthClientId: 'sf-client-id',
      oauthAuthorizationEndpoint: 'https://login.salesforce.example.com/auth',
      oauthTokenEndpoint: 'https://login.salesforce.example.com/token',
    }, { orgId: 'default', createdBy: null });
  });

  it('stores credentials and upserts existing custom OAuth integrations on reconnect', async () => {
    const first = await configureIntegration(env, 'user-1', 'user@example.com', {
      service: 'salesforce-mcp',
      credentials: {
        access_token: 'access-1',
        refresh_token: 'refresh-1',
        expires_in: '3600',
      },
      config: { entities: ['mcp_api'] },
    });

    expect(first).toMatchObject({
      service: 'salesforce-mcp',
      status: 'active',
    });

    const second = await configureIntegration(env, 'user-1', 'user@example.com', {
      service: 'salesforce-mcp',
      credentials: {
        access_token: 'access-2',
        refresh_token: 'refresh-2',
        expires_in: '7200',
      },
      config: { entities: ['mcp_api', 'refresh_token'] },
    });

    expect(second.id).toBe(first.id);
    const integrationRows = db.select().from(integrations).where(eq(integrations.service, 'salesforce-mcp')).all();
    expect(integrationRows).toHaveLength(1);
    expect(integrationRows[0].status).toBe('active');
    expect(integrationRows[0].config).toEqual({ entities: ['mcp_api', 'refresh_token'] });

    const credentialRows = db.select().from(credentials).where(eq(credentials.provider, 'salesforce-mcp')).all();
    expect(credentialRows).toHaveLength(1);
    expect(credentialRows[0].credentialType).toBe('oauth2');
    expect(credentialRows[0].expiresAt).toBeTruthy();
  });

  it('stores user-scoped API-key custom MCP connector credentials as api_key', async () => {
    await createCustomMcpConnector(env, db, {
      displayName: 'Excalibur MCP',
      serverUrl: 'https://mcp.excalibur.example.com/mcp',
      authType: 'api_key',
      credentialScope: 'user',
      apiKeyHeaderName: 'X-API-Key',
      apiKeyPrefix: 'Token',
    }, { orgId: 'default', createdBy: null });
    const fetchMock = stubMcpToolsList({ name: 'X-API-Key', value: 'Token excalibur-user-key' });

    const integration = await configureIntegration(env, 'user-1', 'user@example.com', {
      service: 'excalibur-mcp',
      credentials: { access_token: 'excalibur-user-key' },
      config: { entities: [] },
    });

    expect(integration).toMatchObject({
      service: 'excalibur-mcp',
      status: 'active',
    });

    const integrationRows = db.select().from(integrations).where(eq(integrations.service, 'excalibur-mcp')).all();
    expect(integrationRows).toHaveLength(1);

    const credentialRows = db.select().from(credentials).where(eq(credentials.provider, 'excalibur-mcp')).all();
    expect(credentialRows).toHaveLength(1);
    expect(credentialRows[0].credentialType).toBe('api_key');
    expect(credentialRows[0].expiresAt).toBeNull();

    const resolved = await getCredential(env, 'user', 'user-1', 'excalibur-mcp');
    expect(resolved).toMatchObject({
      ok: true,
      credential: {
        accessToken: 'excalibur-user-key',
        credentialType: 'api_key',
      },
    });
    expect(fetchMock).toHaveBeenCalled();
  });

  it('replaces stale OAuth credential rows when a custom connector changes to user API-key auth', async () => {
    const first = await configureIntegration(env, 'user-1', 'user@example.com', {
      service: 'salesforce-mcp',
      credentials: {
        access_token: 'oauth-token',
        refresh_token: 'refresh-token',
        expires_in: '3600',
      },
      config: { entities: ['mcp_api'] },
    });
    const connector = db.select().from(customMcpConnectors).where(eq(customMcpConnectors.serviceSlug, 'salesforce-mcp')).get();
    expect(connector).toBeTruthy();
    await updateCustomMcpConnector(env, db, connector!.id, {
      authType: 'api_key',
      credentialScope: 'user',
      apiKeyHeaderName: 'X-API-Key',
      apiKeyPrefix: 'Token',
    });
    expect(db.select().from(integrations).where(eq(integrations.service, 'salesforce-mcp')).all()).toEqual([]);
    const fetchMock = stubMcpToolsList({ name: 'X-API-Key', value: 'Token api-key-token' });

    const second = await configureIntegration(env, 'user-1', 'user@example.com', {
      service: 'salesforce-mcp',
      credentials: { access_token: 'api-key-token' },
      config: { entities: [] },
    });

    expect(second.id).not.toBe(first.id);
    const credentialRows = db.select().from(credentials).where(eq(credentials.provider, 'salesforce-mcp')).all();
    expect(credentialRows).toHaveLength(1);
    expect(credentialRows[0].credentialType).toBe('api_key');
    const resolved = await getCredential(env, 'user', 'user-1', 'salesforce-mcp');
    expect(resolved).toMatchObject({
      ok: true,
      credential: {
        accessToken: 'api-key-token',
        credentialType: 'api_key',
      },
    });
    expect(fetchMock).toHaveBeenCalled();
  });

  it('rejects invalid user-scoped API-key custom MCP connector credentials during connect', async () => {
    await createCustomMcpConnector(env, db, {
      displayName: 'Invalid Excalibur MCP',
      serverUrl: 'https://mcp.invalid-excalibur.example.com/mcp',
      authType: 'api_key',
      credentialScope: 'user',
      apiKeyHeaderName: 'X-API-Key',
      apiKeyPrefix: 'Token',
    }, { orgId: 'default', createdBy: null });
    stubMcpToolsList({ name: 'X-API-Key', value: 'Token bad-key' }, 401);

    await expect(configureIntegration(env, 'user-1', 'user@example.com', {
      service: 'invalid-excalibur-mcp',
      credentials: { access_token: 'bad-key' },
      config: { entities: [] },
    })).rejects.toThrow(/Failed to connect/i);

    expect(db.select().from(integrations).where(eq(integrations.service, 'invalid-excalibur-mcp')).all()).toEqual([]);
    expect(db.select().from(credentials).where(eq(credentials.provider, 'invalid-excalibur-mcp')).all()).toEqual([]);
  });
});
