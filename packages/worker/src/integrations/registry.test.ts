import { describe, expect, it, vi } from 'vitest';
import { IntegrationRegistry, type CustomMcpConnectorContext } from './registry.js';

function buildContext(authType: 'none' | 'oauth' | 'api_key' | 'bearer'): CustomMcpConnectorContext {
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

  return {
    orgId: 'default',
    fetch: fetchMock as unknown as typeof fetch,
    connectors: new Map([
      ['salesforce', {
        id: 'connector-1',
        orgId: 'default',
        serviceSlug: 'salesforce',
        displayName: 'Salesforce',
        serverUrl: 'https://mcp.salesforce.com/platform/mcp',
        authType,
        credentialScope: authType === 'api_key' || authType === 'bearer' ? 'org' : 'user',
        oauthClientId: authType === 'oauth' ? 'client-id' : null,
        oauthTokenEndpointAuthMethod: 'none',
        oauthScopes: 'mcp_api',
        oauthAuthorizationEndpoint: authType === 'oauth' ? 'https://login.salesforce.com/auth' : null,
        oauthTokenEndpoint: authType === 'oauth' ? 'https://login.salesforce.com/token' : null,
        apiKeyPlacement: 'header',
        apiKeyHeaderName: 'X-API-Key',
        apiKeyPrefix: null,
        apiKeyQueryParam: null,
        additionalHeaders: { 'X-Tenant': 'acme' },
        staticAuthHeader: authType === 'api_key' ? { name: 'X-API-Key', value: 'secret' } : undefined,
      }],
    ]),
  };
}

describe('IntegrationRegistry custom MCP fallback', () => {
  it('requires every native static action to declare an output schema', async () => {
    const registry = new IntegrationRegistry();
    registry.init();

    const nativeStaticServices = [
      'github',
      'gmail',
      'google_calendar',
      'google_workspace',
      'slack',
      'workflows',
    ];
    const missing: string[] = [];

    for (const service of nativeStaticServices) {
      const actionSource = registry.getActions(service);
      expect(actionSource, `${service} action source should be registered`).toBeDefined();
      const actions = await actionSource!.listActions();
      for (const action of actions) {
        if (!action.outputSchema) {
          missing.push(action.id);
        }
      }
    }

    expect(missing).toEqual([]);
  });

  it('resolves built-in services before custom connector context', () => {
    const registry = new IntegrationRegistry();
    registry.init();

    const builtInProvider = registry.getProvider('github');
    const provider = registry.getProvider('github', {
      ...buildContext('none'),
      connectors: new Map([['github', {
        ...buildContext('none').connectors.get('salesforce')!,
        serviceSlug: 'github',
        displayName: 'Custom GitHub',
      }]]),
    });

    expect(provider).toBe(builtInProvider);
    expect(registry.isBuiltinService('github')).toBe(true);
    expect(registry.isBuiltinService('salesforce')).toBe(false);
  });

  it('synthesizes provider metadata for custom connectors', () => {
    const registry = new IntegrationRegistry();
    registry.init();

    expect(registry.getProvider('salesforce', buildContext('none'))).toMatchObject({
      service: 'salesforce',
      displayName: 'Salesforce',
      authType: 'none',
      supportedEntities: [],
      mcpServerUrl: 'https://mcp.salesforce.com/platform/mcp',
      isCustomConnector: true,
    });
    expect(registry.getProvider('salesforce', buildContext('oauth'))).toMatchObject({
      authType: 'oauth2',
      oauthScopes: ['mcp_api'],
    });
    expect(registry.getProvider('salesforce', buildContext('api_key'))).toMatchObject({
      authType: 'api_key',
    });
  });

  it('builds custom MCP action sources with injected fetch and static auth', async () => {
    const registry = new IntegrationRegistry();
    registry.init();
    const context = buildContext('api_key');

    const actionSource = registry.getActions('salesforce', context);
    const actions = await actionSource?.listActions();

    expect(actions).toMatchObject([{ id: 'salesforce.query', riskLevel: 'low' }]);
    const calls = vi.mocked(context.fetch).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const toolsListHeaders = new Headers((calls.at(-1)?.[1] as RequestInit).headers);
    expect(toolsListHeaders.get('X-API-Key')).toBe('secret');
    expect(toolsListHeaders.get('X-Tenant')).toBe('acme');
  });
});
