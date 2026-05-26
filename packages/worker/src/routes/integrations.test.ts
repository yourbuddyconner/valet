import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env, Variables } from '../env.js';
import { errorHandler } from '../middleware/error-handler.js';
import { createTestDb } from '../test-utils/db.js';
import { users } from '../lib/schema/users.js';
import { integrations, mcpToolCache } from '../lib/schema/index.js';
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
