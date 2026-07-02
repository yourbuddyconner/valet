import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import type { Env, Variables } from '../env.js';
import { errorHandler } from '../middleware/error-handler.js';
import { createTestDb } from '../test-utils/db.js';
import { users } from '../lib/schema/users.js';
import { customMcpConnectors, integrations, mcpOauthClients, mcpToolCache } from '../lib/schema/index.js';
import { createCustomMcpConnector } from '../services/custom-mcp-connectors.js';
import { integrationsRouter } from './integrations.js';
import type { AppDb } from '../lib/drizzle.js';

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

const USER_ID = 'user-1';
const ENCRYPTION_KEY = 'test-encryption-key';

function buildApp(db: AppDb) {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    c.set('user', { id: USER_ID, email: 'user@example.com', role: 'member' });
    c.set('db', db);
    c.set('requestId', 'req-integrations-test');
    await next();
  });
  app.route('/', integrationsRouter);
  return app;
}

function makeEnv(): Env {
  return {
    DB: {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({
          all: vi.fn(async () => ({ results: [] })),
        })),
      })),
    } as unknown as D1Database,
    ENCRYPTION_KEY,
    FRONTEND_URL: 'https://app.example.com',
  } as Env;
}

describe('integrationsRouter custom MCP OAuth', () => {
  let db: AppDb;
  let app: ReturnType<typeof buildApp>;
  let env: Env;

  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    const testDb = createTestDb();
    db = testDb.db;
    holder.db = db;
    db.insert(users).values({ id: USER_ID, email: 'user@example.com' }).run();
    env = makeEnv();
    app = buildApp(db);

    await createCustomMcpConnector(env, db, {
      displayName: 'Salesforce MCP',
      serverUrl: 'https://mcp.salesforce.example.com/platform/mcp',
      authType: 'oauth',
      oauthClientId: 'sf-client-id',
      oauthClientSecret: 'sf-client-secret',
      oauthTokenEndpointAuthMethod: 'client_secret_basic',
      oauthScopes: 'mcp_api refresh_token',
      oauthAuthorizationEndpoint: 'https://login.salesforce.example.com/services/oauth2/authorize',
      oauthTokenEndpoint: 'https://login.salesforce.example.com/services/oauth2/token',
    }, { orgId: 'default', createdBy: null });
  });

  it('starts custom OAuth from stored endpoints and includes the MCP resource', async () => {
    const res = await app.fetch(new Request(
      'http://localhost/salesforce-mcp/oauth?redirect_uri=https%3A%2F%2Fapp.example.com%2Fintegrations%2Fcallback',
    ), env);

    expect(res.status).toBe(200);
    const body = await res.json() as { url: string; state: string; code_verifier: string };
    const url = new URL(body.url);
    expect(url.origin + url.pathname).toBe('https://login.salesforce.example.com/services/oauth2/authorize');
    expect(url.searchParams.get('client_id')).toBe('sf-client-id');
    expect(url.searchParams.get('resource')).toBe('https://mcp.salesforce.example.com/platform/mcp');
    expect(url.searchParams.get('scope')).toBe('mcp_api refresh_token');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(body.code_verifier).toBeTruthy();
  });

  it('lists user-scoped API-key custom MCP connectors as connectable integrations', async () => {
    await createCustomMcpConnector(env, db, {
      displayName: 'Excalibur MCP',
      serverUrl: 'https://mcp.excalibur.example.com/mcp',
      authType: 'api_key',
      credentialScope: 'user',
      apiKeyHeaderName: 'X-API-Key',
      apiKeyPrefix: null,
    }, { orgId: 'default', createdBy: null });
    await createCustomMcpConnector(env, db, {
      displayName: 'Bearer MCP',
      serverUrl: 'https://mcp.bearer.example.com/mcp',
      authType: 'bearer',
      credentialScope: 'user',
    }, { orgId: 'default', createdBy: null });

    const res = await app.fetch(new Request('http://localhost/available'), env);

    expect(res.status).toBe(200);
    const body = await res.json() as { services: Array<{ service: string; displayName: string; authType: string; isCustomConnector?: boolean }> };
    expect(body.services).toContainEqual(expect.objectContaining({
      service: 'excalibur-mcp',
      displayName: 'Excalibur MCP',
      authType: 'api_key',
      isCustomConnector: true,
    }));
    expect(body.services).toContainEqual(expect.objectContaining({
      service: 'bearer-mcp',
      displayName: 'Bearer MCP',
      authType: 'bearer',
      isCustomConnector: true,
    }));
  });

  it('includes custom connector auth type when listing connected integrations', async () => {
    db.insert(integrations).values({
      id: 'integration-salesforce',
      userId: USER_ID,
      service: 'salesforce-mcp',
      config: { entities: [] },
      status: 'active',
    }).run();

    const res = await app.fetch(new Request('http://localhost/'), env);

    expect(res.status).toBe(200);
    const body = await res.json() as { integrations: Array<{ service: string; displayName?: string; authType?: string; isCustomConnector?: boolean }> };
    expect(body.integrations).toContainEqual(expect.objectContaining({
      service: 'salesforce-mcp',
      displayName: 'Salesforce MCP',
      authType: 'oauth2',
      isCustomConnector: true,
    }));
  });

  it('starts custom MCP OAuth with dynamic client registration when no client ID is configured', async () => {
    db.insert(customMcpConnectors).values({
      id: 'ramp-connector',
      orgId: 'default',
      serviceSlug: 'ramp',
      displayName: 'Ramp',
      serverUrl: 'https://mcp.ramp.com/mcp',
      authType: 'oauth',
      oauthClientId: null,
      oauthScopes: 'openid profile offline_access',
      status: 'active',
    }).run();

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === 'https://mcp.ramp.com/.well-known/oauth-protected-resource') {
        return Response.json({ authorization_servers: ['https://auth.ramp.com'] });
      }
      if (url === 'https://auth.ramp.com/.well-known/oauth-authorization-server') {
        return Response.json({
          authorization_endpoint: 'https://auth.ramp.com/oauth/authorize',
          token_endpoint: 'https://auth.ramp.com/oauth/token',
          registration_endpoint: 'https://auth.ramp.com/oauth/register',
        });
      }
      if (url === 'https://auth.ramp.com/oauth/register') {
        return Response.json({ client_id: 'ramp-dynamic-client' });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await app.fetch(new Request(
      'http://localhost/ramp/oauth?redirect_uri=https%3A%2F%2Fapp.example.com%2Fintegrations%2Fcallback',
    ), env);

    expect(res.status).toBe(200);
    const body = await res.json() as { url: string; state: string; code_verifier: string };
    const url = new URL(body.url);
    expect(url.origin + url.pathname).toBe('https://auth.ramp.com/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('ramp-dynamic-client');
    expect(url.searchParams.get('resource')).toBe('https://mcp.ramp.com/mcp');
    expect(url.searchParams.get('scope')).toBe('openid profile offline_access');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(body.code_verifier).toBeTruthy();
    expect(db.select().from(mcpOauthClients).all()).toEqual([
      expect.objectContaining({
        service: 'ramp',
        clientId: 'ramp-dynamic-client',
        authorizationEndpoint: 'https://auth.ramp.com/oauth/authorize',
        tokenEndpoint: 'https://auth.ramp.com/oauth/token',
      }),
    ]);
  });

  it('rejects non-Valet redirect URIs before dynamic custom MCP OAuth registration', async () => {
    db.insert(customMcpConnectors).values({
      id: 'redirect-guard-connector',
      orgId: 'default',
      serviceSlug: 'redirect-guard',
      displayName: 'Redirect Guard',
      serverUrl: 'https://mcp.redirect-guard.example.com/mcp',
      authType: 'oauth',
      oauthClientId: null,
      status: 'active',
    }).run();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const res = await app.fetch(new Request(
      'http://localhost/redirect-guard/oauth?redirect_uri=https%3A%2F%2Fevil.example.com%2Fintegrations%2Fcallback',
    ), env);

    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.select().from(mcpOauthClients).where(eq(mcpOauthClients.service, 'redirect-guard')).all()).toEqual([]);
  });

  it('rejects non-Valet redirect URIs before built-in MCP OAuth registration', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const res = await app.fetch(new Request(
      'http://localhost/linear/oauth?redirect_uri=https%3A%2F%2Fevil.example.com%2Fintegrations%2Fcallback',
    ), env);

    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects unsafe discovered OAuth metadata for custom dynamic MCP OAuth', async () => {
    db.insert(customMcpConnectors).values({
      id: 'unsafe-connector',
      orgId: 'default',
      serviceSlug: 'unsafe',
      displayName: 'Unsafe',
      serverUrl: 'https://mcp.unsafe.example.com/mcp',
      authType: 'oauth',
      oauthClientId: null,
      status: 'active',
    }).run();

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === 'https://mcp.unsafe.example.com/.well-known/oauth-protected-resource') {
        return Response.json({ authorization_servers: ['https://auth.unsafe.example.com'] });
      }
      if (url === 'https://auth.unsafe.example.com/.well-known/oauth-authorization-server') {
        return Response.json({
          authorization_endpoint: 'http://localhost/oauth/authorize',
          token_endpoint: 'https://auth.unsafe.example.com/oauth/token',
          registration_endpoint: 'https://auth.unsafe.example.com/oauth/register',
        });
      }
      if (url === 'https://auth.unsafe.example.com/oauth/register') {
        return Response.json({ client_id: 'unsafe-client' });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await app.fetch(new Request(
      'http://localhost/unsafe/oauth?redirect_uri=https%3A%2F%2Fapp.example.com%2Fintegrations%2Fcallback',
    ), env);

    expect(res.status).toBe(400);
    expect(db.select().from(mcpOauthClients).where(eq(mcpOauthClients.service, 'unsafe')).all()).toEqual([]);
  });

  it('lists custom OAuth connectors as available services and uses cached display names for actions', async () => {
    db.insert(mcpToolCache).values({
      service: 'salesforce-mcp',
      actionId: 'salesforce.query',
      name: 'Query',
      description: 'Query records',
      riskLevel: 'low',
    }).run();

    const availableRes = await app.fetch(new Request('http://localhost/available'), env);
    const actionsRes = await app.fetch(new Request('http://localhost/actions'), env);

    expect(availableRes.status).toBe(200);
    await expect(availableRes.json()).resolves.toMatchObject({
      services: expect.arrayContaining([
        expect.objectContaining({
          service: 'salesforce-mcp',
          displayName: 'Salesforce MCP',
          authType: 'oauth2',
          supportedEntities: [],
          hasActions: true,
          hasTriggers: false,
          isCustomConnector: true,
        }),
      ]),
    });

    expect(actionsRes.status).toBe(200);
    await expect(actionsRes.json()).resolves.toMatchObject({
      actions: expect.arrayContaining([
        expect.objectContaining({
          service: 'salesforce-mcp',
          serviceDisplayName: 'Salesforce MCP',
          actionId: 'salesforce.query',
        }),
      ]),
    });
  });

  it('includes authored output schemas in the action catalog', async () => {
    const actionsRes = await app.fetch(new Request('http://localhost/actions?service=github'), env);

    expect(actionsRes.status).toBe(200);
    await expect(actionsRes.json()).resolves.toMatchObject({
      actions: expect.arrayContaining([
        expect.objectContaining({
          service: 'github',
          actionId: 'github.list_issues',
          outputSchema: expect.objectContaining({
            type: 'array',
            items: expect.objectContaining({
              type: 'object',
              properties: expect.objectContaining({
                number: expect.objectContaining({ type: 'number' }),
                title: expect.objectContaining({ type: 'string' }),
              }),
            }),
          }),
        }),
        expect.objectContaining({
          service: 'github',
          actionId: 'github.list_workflows',
          outputSchema: expect.objectContaining({
            type: 'object',
            properties: expect.objectContaining({
              workflows: expect.objectContaining({
                type: 'array',
                items: expect.objectContaining({
                  type: 'object',
                  properties: expect.objectContaining({
                    id: expect.objectContaining({ type: 'number' }),
                    name: expect.objectContaining({ type: 'string' }),
                    path: expect.objectContaining({ type: 'string' }),
                    state: expect.objectContaining({ type: 'string' }),
                  }),
                }),
              }),
            }),
          }),
        }),
      ]),
    });
  });

  it('filters deleted custom connector integrations and stale cached actions', async () => {
    db.insert(integrations).values({
      id: 'integration-1',
      userId: USER_ID,
      service: 'deleted-custom',
      config: { entities: [] },
      status: 'active',
    }).run();
    db.insert(mcpToolCache).values({
      service: 'deleted-custom',
      actionId: 'stale.tool',
      name: 'Stale',
      description: '',
      riskLevel: 'medium',
    }).run();

    const integrationsRes = await app.fetch(new Request('http://localhost/'), env);
    const actionsRes = await app.fetch(new Request('http://localhost/actions'), env);

    expect(integrationsRes.status).toBe(200);
    await expect(integrationsRes.json()).resolves.toMatchObject({ integrations: [] });
    expect(actionsRes.status).toBe(200);
    expect((await actionsRes.json() as { actions: Array<{ service: string }> }).actions.some((a) => a.service === 'deleted-custom')).toBe(false);
  });

  it('exchanges custom OAuth callbacks with stored client credentials and resource', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const form = init?.body as URLSearchParams;
      expect(form.get('grant_type')).toBe('authorization_code');
      expect(form.get('client_id')).toBe('sf-client-id');
      expect(form.get('code')).toBe('auth-code');
      expect(form.get('code_verifier')).toBe('verifier');
      expect(form.get('resource')).toBe('https://mcp.salesforce.example.com/platform/mcp');
      expect(new Headers(init?.headers).get('Authorization')).toBe(`Basic ${btoa('sf-client-id:sf-client-secret')}`);
      return Response.json({
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        expires_in: 3600,
        token_type: 'bearer',
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await app.fetch(new Request('http://localhost/salesforce-mcp/oauth/callback', {
      method: 'POST',
      body: JSON.stringify({
        code: 'auth-code',
        redirect_uri: 'https://app.example.com/integrations/callback',
        code_verifier: 'verifier',
      }),
      headers: { 'content-type': 'application/json' },
    }), env);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      credentials: {
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        expires_in: '3600',
        token_type: 'bearer',
      },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('exchanges custom MCP OAuth callbacks with dynamically registered client credentials', async () => {
    db.insert(customMcpConnectors).values({
      id: 'ramp-connector',
      orgId: 'default',
      serviceSlug: 'ramp',
      displayName: 'Ramp',
      serverUrl: 'https://mcp.ramp.com/mcp',
      authType: 'oauth',
      oauthClientId: null,
      status: 'active',
    }).run();
    db.insert(mcpOauthClients).values({
      service: 'ramp',
      clientId: 'ramp-dynamic-client',
      authorizationEndpoint: 'https://auth.ramp.com/oauth/authorize',
      tokenEndpoint: 'https://auth.ramp.com/oauth/token',
      registrationEndpoint: 'https://auth.ramp.com/oauth/register',
    }).run();

    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const form = init?.body as URLSearchParams;
      expect(form.get('grant_type')).toBe('authorization_code');
      expect(form.get('client_id')).toBe('ramp-dynamic-client');
      expect(form.get('code')).toBe('auth-code');
      expect(form.get('code_verifier')).toBe('verifier');
      expect(form.get('resource')).toBe('https://mcp.ramp.com/mcp');
      return Response.json({
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        expires_in: 3600,
        token_type: 'bearer',
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await app.fetch(new Request('http://localhost/ramp/oauth/callback', {
      method: 'POST',
      body: JSON.stringify({
        code: 'auth-code',
        redirect_uri: 'https://app.example.com/integrations/callback',
        code_verifier: 'verifier',
      }),
      headers: { 'content-type': 'application/json' },
    }), env);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      credentials: {
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        expires_in: '3600',
        token_type: 'bearer',
      },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('rejects non-Valet redirect URIs before custom MCP OAuth callback exchange', async () => {
    db.insert(customMcpConnectors).values({
      id: 'redirect-callback-connector',
      orgId: 'default',
      serviceSlug: 'redirect-callback',
      displayName: 'Redirect Callback',
      serverUrl: 'https://mcp.redirect-callback.example.com/mcp',
      authType: 'oauth',
      oauthClientId: null,
      status: 'active',
    }).run();
    db.insert(mcpOauthClients).values({
      service: 'redirect-callback',
      clientId: 'redirect-callback-client',
      authorizationEndpoint: 'https://auth.redirect-callback.example.com/oauth/authorize',
      tokenEndpoint: 'https://auth.redirect-callback.example.com/oauth/token',
      registrationEndpoint: 'https://auth.redirect-callback.example.com/oauth/register',
    }).run();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const res = await app.fetch(new Request('http://localhost/redirect-callback/oauth/callback', {
      method: 'POST',
      body: JSON.stringify({
        code: 'auth-code',
        redirect_uri: 'https://evil.example.com/integrations/callback',
        code_verifier: 'verifier',
      }),
      headers: { 'content-type': 'application/json' },
    }), env);

    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('configures custom OAuth integrations through the route after callback exchange', async () => {
    const res = await app.fetch(new Request('http://localhost/', {
      method: 'POST',
      body: JSON.stringify({
        service: 'salesforce-mcp',
        credentials: {
          access_token: 'access-token',
          refresh_token: 'refresh-token',
          expires_in: '3600',
          token_type: 'bearer',
        },
        config: { entities: [] },
      }),
      headers: { 'content-type': 'application/json' },
    }), env);

    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toMatchObject({
      integration: {
        service: 'salesforce-mcp',
        status: 'active',
      },
    });
    expect(db.select().from(integrations).all()).toEqual([
      expect.objectContaining({
        service: 'salesforce-mcp',
        status: 'active',
      }),
    ]);
  });
});
