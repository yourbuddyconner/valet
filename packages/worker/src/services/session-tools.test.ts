import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listTools, resolveActionPolicy } from './session-tools.js';
import { createTestDb } from '../test-utils/db.js';
import { upsertActionPolicy } from '../lib/db/actions.js';
import { upsertMcpToolCache } from '../lib/db/mcp-tool-cache.js';
import { integrations, sessions, users, customMcpConnectors, disabledActions } from '../lib/schema/index.js';
import { encryptString } from '../lib/crypto.js';
import type { AppDb } from '../lib/drizzle.js';
import { integrationRegistry } from '../integrations/registry.js';
import type { Env } from '../env.js';
import type { ActionSource, IntegrationProvider } from '@valet/sdk';

const USER_ID = 'mcp-policy-user';
const SESSION_ID = 'mcp-policy-session';

function mockD1(): D1Database {
  return {
    prepare: vi.fn(() => ({
      bind: vi.fn(() => ({
        all: vi.fn(async () => ({ results: [] })),
      })),
    })),
  } as unknown as D1Database;
}

function emptyCredentialCache() {
  return {
    get: vi.fn(() => null),
    set: vi.fn(),
    invalidate: vi.fn(),
  };
}

function envWithEncryption(): Env {
  return { ENCRYPTION_KEY: 'test-encryption-key' } as Env;
}

function stubMcpFetch() {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (body.method === 'initialize') {
      return new Response(JSON.stringify({
        jsonrpc: '2.0',
        id: body.id,
        result: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          serverInfo: { name: 'custom-mcp', version: '1.0.0' },
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'mcp-session-id': 'session-1' },
      });
    }
    if (body.method === 'notifications/initialized') {
      return new Response(null, { status: 202 });
    }
    return new Response(JSON.stringify({
      jsonrpc: '2.0',
      id: body.id,
      result: {
        tools: [{
          name: 'query',
          description: 'Query records',
          inputSchema: { type: 'object' },
          annotations: { readOnlyHint: true },
        }],
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('resolveActionPolicy', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('uses cached MCP risk metadata when runtime listActions misses the tool', async () => {
    const { db } = createTestDb();
    const appDb: AppDb = db;
    db.insert(users).values({ id: USER_ID, email: 'mcp-policy@example.com' }).run();
    db.insert(sessions).values({
      id: SESSION_ID,
      userId: USER_ID,
      workspace: '/tmp/mcp-policy',
      status: 'running',
    }).run();
    db.insert(integrations).values({
      id: 'integration-mcp',
      userId: USER_ID,
      service: 'mcp_service',
      config: { entities: [] },
      status: 'active',
    }).run();
    await upsertActionPolicy(appDb, {
      id: 'deny-critical',
      riskLevel: 'critical',
      mode: 'deny',
      createdBy: USER_ID,
    });
    await upsertMcpToolCache(appDb, [{
      service: 'mcp_service',
      actionId: 'dangerous_tool',
      name: 'Dangerous Tool',
      description: 'Known critical MCP tool',
      riskLevel: 'critical',
    }]);
    const emptyActionSource: ActionSource = {
      listActions: vi.fn(async () => []),
      execute: vi.fn(),
    };
    const noAuthProvider: IntegrationProvider = {
      service: 'mcp_service',
      displayName: 'MCP Service',
      authType: 'none',
      supportedEntities: [],
      validateCredentials: () => true,
      testConnection: async () => true,
    };
    vi.spyOn(integrationRegistry, 'getActions').mockReturnValue(emptyActionSource);
    vi.spyOn(integrationRegistry, 'getProvider').mockReturnValue(noAuthProvider);

    const result = await resolveActionPolicy(
      appDb,
      mockD1(),
      {} as Env,
      USER_ID,
      'mcp_service:dangerous_tool',
      {},
      {
        sessionId: SESSION_ID,
        discoveredToolRiskLevels: new Map(),
        credentialCache: emptyCredentialCache(),
        disabledPluginServicesCache: null,
      },
    );

    expect(result).toMatchObject({
      outcome: 'denied',
      riskLevel: 'critical',
    });
  });

  it('lists custom API-key connector tools without resolving user credentials', async () => {
    const { db } = createTestDb();
    const appDb: AppDb = db;
    db.insert(users).values({ id: USER_ID, email: 'mcp-policy@example.com' }).run();
    db.insert(customMcpConnectors).values({
      id: 'connector-1',
      orgId: 'default',
      serviceSlug: 'salesforce',
      displayName: 'Salesforce',
      serverUrl: 'https://mcp.example.com',
      authType: 'api_key',
      encryptedApiKey: await encryptString('org-api-key', 'test-encryption-key'),
      apiKeyHeaderName: 'X-API-Key',
      apiKeyPrefix: null,
      status: 'active',
    }).run();
    const fetchMock = stubMcpFetch();
    const credentialCache = emptyCredentialCache();
    const resolveSpy = vi.spyOn(integrationRegistry, 'resolveCredentials');

    const result = await listTools(appDb, mockD1(), envWithEncryption(), USER_ID, {
      credentialCache,
      orgId: 'default',
    });

    expect(result.tools).toMatchObject([{ id: 'salesforce:salesforce.query', riskLevel: 'low' }]);
    expect(resolveSpy).not.toHaveBeenCalledWith('salesforce', expect.anything(), expect.anything(), expect.anything());
    const toolsListHeaders = new Headers((fetchMock.mock.calls.at(-1)?.[1] as RequestInit).headers);
    expect(toolsListHeaders.get('X-API-Key')).toBe('org-api-key');
  });

  it('lists user-scoped custom API-key connector tools with the current user credential', async () => {
    const { db } = createTestDb();
    const appDb: AppDb = db;
    db.insert(users).values({ id: USER_ID, email: 'mcp-policy@example.com' }).run();
    db.insert(customMcpConnectors).values({
      id: 'connector-1',
      orgId: 'default',
      serviceSlug: 'excalibur',
      displayName: 'Excalibur',
      serverUrl: 'https://mcp.example.com',
      authType: 'api_key',
      credentialScope: 'user',
      apiKeyHeaderName: 'X-API-Key',
      apiKeyPrefix: 'Token',
      status: 'active',
    }).run();
    db.insert(integrations).values({
      id: 'integration-excalibur',
      userId: USER_ID,
      service: 'excalibur',
      config: { entities: [] },
      status: 'active',
    }).run();
    const fetchMock = stubMcpFetch();
    vi.spyOn(integrationRegistry, 'resolveCredentials').mockResolvedValue({
      ok: true,
      credential: {
        accessToken: 'user-api-key',
        credentialType: 'api_key',
        refreshed: false,
      },
    });

    const result = await listTools(appDb, mockD1(), envWithEncryption(), USER_ID, {
      credentialCache: emptyCredentialCache(),
      orgId: 'default',
    });

    expect(result.tools).toMatchObject([{ id: 'excalibur:excalibur.query', riskLevel: 'low' }]);
    expect(integrationRegistry.resolveCredentials).toHaveBeenCalledWith('excalibur', expect.anything(), USER_ID, {
      forceRefresh: false,
    });
    const toolsListHeaders = new Headers((fetchMock.mock.calls.at(-1)?.[1] as RequestInit).headers);
    expect(toolsListHeaders.get('X-API-Key')).toBe('Token user-api-key');
  });

  it('filters disabled actions for custom connector slugs', async () => {
    const { db } = createTestDb();
    const appDb: AppDb = db;
    db.insert(users).values({ id: USER_ID, email: 'mcp-policy@example.com' }).run();
    db.insert(customMcpConnectors).values({
      id: 'connector-1',
      orgId: 'default',
      serviceSlug: 'salesforce',
      displayName: 'Salesforce',
      serverUrl: 'https://mcp.example.com',
      authType: 'api_key',
      encryptedApiKey: await encryptString('org-api-key', 'test-encryption-key'),
      apiKeyHeaderName: 'X-API-Key',
      status: 'active',
    }).run();
    db.insert(disabledActions).values({
      id: 'disabled-salesforce-query',
      service: 'salesforce',
      actionId: 'salesforce.query',
      disabledBy: USER_ID,
    }).run();
    stubMcpFetch();

    const result = await listTools(appDb, mockD1(), envWithEncryption(), USER_ID, {
      credentialCache: emptyCredentialCache(),
      orgId: 'default',
    });

    expect(result.discoveredRiskLevels.get('salesforce:salesforce.query')).toBe('low');
    expect(result.tools.some((tool) => tool.id === 'salesforce:salesforce.query')).toBe(false);
  });

  it('matches custom connector service filters by display slug substring', async () => {
    const { db } = createTestDb();
    const appDb: AppDb = db;
    db.insert(users).values({ id: USER_ID, email: 'mcp-policy@example.com' }).run();
    db.insert(customMcpConnectors).values({
      id: 'connector-1',
      orgId: 'default',
      serviceSlug: 'salesforce-read-only',
      displayName: 'Salesforce Read Only',
      serverUrl: 'https://mcp.example.com',
      authType: 'api_key',
      encryptedApiKey: await encryptString('org-api-key', 'test-encryption-key'),
      apiKeyHeaderName: 'X-API-Key',
      status: 'active',
    }).run();
    stubMcpFetch();

    const result = await listTools(appDb, mockD1(), envWithEncryption(), USER_ID, {
      credentialCache: emptyCredentialCache(),
      orgId: 'default',
      service: 'salesforce',
    });

    expect(result.tools).toMatchObject([{
      id: 'salesforce-read-only:salesforce-read-only.query',
      riskLevel: 'low',
    }]);
  });

  it('returns a warning when authenticated custom MCP discovery fails', async () => {
    const { db } = createTestDb();
    const appDb: AppDb = db;
    db.insert(users).values({ id: USER_ID, email: 'mcp-policy@example.com' }).run();
    db.insert(customMcpConnectors).values({
      id: 'connector-1',
      orgId: 'default',
      serviceSlug: 'salesforce-read-only',
      displayName: 'Salesforce Read Only',
      serverUrl: 'https://mcp.example.com',
      authType: 'oauth',
      oauthClientId: 'sf-client-id',
      oauthScopes: 'mcp_api refresh_token',
      oauthAuthorizationEndpoint: 'https://login.salesforce.example.com/services/oauth2/authorize',
      oauthTokenEndpoint: 'https://login.salesforce.example.com/services/oauth2/token',
      status: 'active',
    }).run();
    db.insert(integrations).values({
      id: 'integration-1',
      userId: USER_ID,
      service: 'salesforce-read-only',
      config: { entities: ['mcp_api', 'refresh_token'] },
      status: 'active',
    }).run();
    vi.spyOn(integrationRegistry, 'resolveCredentials').mockResolvedValue({
      ok: true,
      credential: {
        accessToken: 'opaque-token',
        credentialType: 'oauth2',
        refreshed: false,
      },
    });
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => (
      new Response('{"errors":[{"message":"JWT Token is required"}]}', {
        status: 401,
        headers: { 'content-type': 'text/plain' },
      })
    )));

    const result = await listTools(appDb, mockD1(), envWithEncryption(), USER_ID, {
      credentialCache: emptyCredentialCache(),
      orgId: 'default',
      service: 'salesforce',
    });

    expect(result.tools).toEqual([]);
    expect(result.warnings).toMatchObject([{
      service: 'salesforce-read-only',
      displayName: 'Salesforce Read Only',
      reason: 'auth_failed',
      integrationId: 'integration-1',
    }]);
    expect(result.warnings[0].message).toContain('JWT Token is required');
  });

  it('allows active custom API-key connector policy resolution without an integration row', async () => {
    const { db } = createTestDb();
    const appDb: AppDb = db;
    db.insert(users).values({ id: USER_ID, email: 'mcp-policy@example.com' }).run();
    db.insert(sessions).values({
      id: SESSION_ID,
      userId: USER_ID,
      workspace: '/tmp/mcp-policy',
      status: 'running',
    }).run();
    db.insert(customMcpConnectors).values({
      id: 'connector-1',
      orgId: 'default',
      serviceSlug: 'salesforce',
      displayName: 'Salesforce',
      serverUrl: 'https://mcp.example.com',
      authType: 'api_key',
      encryptedApiKey: await encryptString('org-api-key', 'test-encryption-key'),
      apiKeyHeaderName: 'X-API-Key',
      status: 'active',
    }).run();

    const result = await resolveActionPolicy(
      appDb,
      mockD1(),
      envWithEncryption(),
      USER_ID,
      'salesforce:salesforce.query',
      {},
      {
        sessionId: SESSION_ID,
        discoveredToolRiskLevels: new Map([['salesforce:salesforce.query', 'low']]),
        credentialCache: emptyCredentialCache(),
        disabledPluginServicesCache: null,
        orgId: 'default',
      },
    );

    expect(result).toMatchObject({
      outcome: 'allowed',
      service: 'salesforce',
      actionId: 'salesforce.query',
      riskLevel: 'low',
    });
  });
});
