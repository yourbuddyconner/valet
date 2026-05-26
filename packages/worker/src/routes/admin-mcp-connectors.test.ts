import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { D1Database } from '@cloudflare/workers-types';
import { eq } from 'drizzle-orm';
import type { CustomMcpConnector } from '@valet/shared';
import type { Env, Variables } from '../env.js';
import type { AppDb } from '../lib/drizzle.js';
import { errorHandler } from '../middleware/error-handler.js';
import { createTestDb } from '../test-utils/db.js';
import { users } from '../lib/schema/users.js';
import {
  actionPolicies,
  credentials,
  customMcpConnectors,
  disabledActions,
  integrations,
  mcpToolCache,
  userActionPolicyOverrides,
} from '../lib/schema/index.js';
import { adminMcpConnectorsRouter } from './admin-mcp-connectors.js';

const ADMIN_ID = 'admin-user';
const ENCRYPTION_KEY = 'test-encryption-key';

type TestBatchStatement = {
  run: () => Promise<unknown>;
  runSync: () => void;
};

type RedactedConnector = CustomMcpConnector & {
  apiKey?: unknown;
  additionalHeaders?: unknown;
};
type ConnectorResponse = { connector: RedactedConnector };
type ConnectorListResponse = { connectors: RedactedConnector[] };

async function readJson<T>(response: Response): Promise<T> {
  return await response.json() as T;
}

function makeD1Batch(
  sqlite: ReturnType<typeof createTestDb>['sqlite'],
  options: { failOnSql?: string } = {},
): D1Database {
  return {
    prepare: vi.fn((sql: string) => ({
      bind: vi.fn((...params: unknown[]) => ({
        runSync: () => {
          if (options.failOnSql && sql.includes(options.failOnSql)) {
            throw new Error(`Simulated D1 batch failure for ${options.failOnSql}`);
          }
          sqlite.prepare(sql).run(...params);
        },
        run: vi.fn(function run(this: TestBatchStatement) {
          this.runSync();
          return Promise.resolve({ success: true });
        }),
      })),
    })),
    batch: vi.fn(async (statements: Array<TestBatchStatement>) => {
      const runBatch = sqlite.transaction((batchStatements: TestBatchStatement[]) => {
        for (const statement of batchStatements) {
          statement.runSync();
        }
      });
      runBatch(statements);
      return [];
    }),
  } as unknown as D1Database;
}

function buildApp(
  db: AppDb,
  role: 'admin' | 'member' = 'admin',
) {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    c.set('user', { id: ADMIN_ID, email: 'admin@example.com', role });
    c.set('db', db);
    c.set('requestId', 'req-admin-mcp-connectors');
    await next();
  });
  app.route('/', adminMcpConnectorsRouter);
  return app;
}

function jsonRequest(path: string, method: string, body: unknown) {
  return new Request(`http://localhost${path}`, {
    method,
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

describe('adminMcpConnectorsRouter', () => {
  let db: ReturnType<typeof createTestDb>['db'];
  let sqlite: ReturnType<typeof createTestDb>['sqlite'];
  let app: ReturnType<typeof buildApp>;
  let env: Env;

  beforeEach(() => {
    ({ db, sqlite } = createTestDb());
    db.insert(users).values({ id: ADMIN_ID, email: 'admin@example.com' }).run();
    app = buildApp(db);
    env = {
      DB: makeD1Batch(sqlite),
      ENCRYPTION_KEY,
    } as Env;
  });

  it('creates connectors and lists redacted summaries with tool counts', async () => {
    const createRes = await app.fetch(jsonRequest('/', 'POST', {
      displayName: 'Linear Custom MCP',
      serverUrl: 'https://mcp.linear.example.com/sse',
      authType: 'api_key',
      apiKey: 'linear-secret',
      apiKeyHeaderName: 'X-Linear-Key',
      apiKeyPrefix: 'Token',
      additionalHeaders: { 'X-Tenant': 'acme' },
    }), env);

    expect(createRes.status).toBe(201);
    const created = await readJson<ConnectorResponse>(createRes);
    expect(created.connector).toMatchObject({
      orgId: 'default',
      serviceSlug: 'linear-custom-mcp',
      displayName: 'Linear Custom MCP',
      authType: 'api_key',
      hasApiKey: true,
      hasAdditionalHeaders: true,
      createdBy: ADMIN_ID,
    });
    expect(created.connector.apiKey).toBeUndefined();
    expect(created.connector.additionalHeaders).toBeUndefined();

    db.insert(mcpToolCache).values([
      { service: 'linear-custom-mcp', actionId: 'issue.create', name: 'Create issue', description: '', riskLevel: 'medium' },
      { service: 'linear-custom-mcp', actionId: 'issue.read', name: 'Read issue', description: '', riskLevel: 'low' },
    ]).run();

    const listRes = await app.fetch(new Request('http://localhost/'), env);

    expect(listRes.status).toBe(200);
    const list = await readJson<ConnectorListResponse>(listRes);
    expect(list.connectors).toHaveLength(1);
    expect(list.connectors[0]).toMatchObject({
      serviceSlug: 'linear-custom-mcp',
      toolCount: 2,
      hasApiKey: true,
      hasAdditionalHeaders: true,
    });
    expect(list.connectors[0].apiKey).toBeUndefined();
    expect(list.connectors[0].additionalHeaders).toBeUndefined();
  });

  it('updates OAuth connectors while preserving and clearing client secrets explicitly', async () => {
    const createRes = await app.fetch(jsonRequest('/', 'POST', {
      displayName: 'OAuth MCP',
      serverUrl: 'https://oauth.example.com/mcp',
      authType: 'oauth',
      oauthClientId: 'client-id',
      oauthClientSecret: 'client-secret',
      oauthTokenEndpointAuthMethod: 'client_secret_basic',
      oauthAuthorizationEndpoint: 'https://oauth.example.com/authorize',
      oauthTokenEndpoint: 'https://oauth.example.com/token',
    }), env);
    const created = await readJson<ConnectorResponse>(createRes);

    const preserveRes = await app.fetch(jsonRequest(`/${created.connector.id}`, 'PUT', {
      displayName: 'OAuth MCP Renamed',
      authType: 'oauth',
    }), env);

    expect(preserveRes.status).toBe(200);
    expect((await readJson<ConnectorResponse>(preserveRes)).connector).toMatchObject({
      displayName: 'OAuth MCP Renamed',
      serviceSlug: 'oauth-mcp',
      hasClientSecret: true,
    });

    const clearRes = await app.fetch(jsonRequest(`/${created.connector.id}`, 'PUT', {
      authType: 'oauth',
      clearClientSecret: true,
    }), env);

    expect(clearRes.status).toBe(200);
    expect((await readJson<ConnectorResponse>(clearRes)).connector).toMatchObject({
      serviceSlug: 'oauth-mcp',
      hasClientSecret: false,
    });
  });

  it('rejects update requests that try to change the service slug', async () => {
    const createRes = await app.fetch(jsonRequest('/', 'POST', {
      displayName: 'Slug Guard MCP',
      serverUrl: 'https://slug.example.com/mcp',
      authType: 'none',
    }), env);
    const created = await readJson<ConnectorResponse>(createRes);

    const res = await app.fetch(jsonRequest(`/${created.connector.id}`, 'PUT', {
      authType: 'none',
      serviceSlug: 'new-slug',
    }), env);

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      code: 'VALIDATION_ERROR',
      error: expect.stringMatching(/service slug/i),
    });
  });

  it('deletes connectors and their owned runtime state', async () => {
    db.insert(users).values({ id: 'user-1', email: 'user@example.com' }).run();
    const createRes = await app.fetch(jsonRequest('/', 'POST', {
      displayName: 'Delete MCP',
      serverUrl: 'https://delete.example.com/mcp',
      authType: 'none',
    }), env);
    const created = await readJson<ConnectorResponse>(createRes);

    db.insert(integrations).values({
      id: 'integration-1',
      userId: 'user-1',
      service: created.connector.serviceSlug,
      config: { entities: [] },
      status: 'active',
    }).run();
    db.insert(credentials).values({
      id: 'credential-1',
      ownerType: 'user',
      ownerId: 'user-1',
      provider: created.connector.serviceSlug,
      credentialType: 'oauth2',
      encryptedData: 'encrypted',
    }).run();
    db.insert(mcpToolCache).values({
      service: created.connector.serviceSlug,
      actionId: 'tool',
      name: 'Tool',
      description: '',
      riskLevel: 'low',
    }).run();
    db.insert(disabledActions).values({
      id: 'disabled-1',
      service: created.connector.serviceSlug,
      actionId: null,
      disabledBy: 'user-1',
    }).run();
    db.insert(actionPolicies).values({
      id: 'policy-1',
      service: created.connector.serviceSlug,
      actionId: null,
      riskLevel: null,
      mode: 'deny',
      createdBy: 'user-1',
    }).run();
    db.insert(userActionPolicyOverrides).values({
      id: 'override-1',
      userId: 'user-1',
      service: created.connector.serviceSlug,
      actionId: null,
      riskLevel: null,
      mode: 'allow',
    }).run();

    const res = await app.fetch(new Request(`http://localhost/${created.connector.id}`, { method: 'DELETE' }), env);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(db.select().from(customMcpConnectors).where(eq(customMcpConnectors.id, created.connector.id)).all()).toEqual([]);
    expect(db.select().from(integrations).all()).toEqual([]);
    expect(db.select().from(credentials).all()).toEqual([]);
    expect(db.select().from(mcpToolCache).all()).toEqual([]);
    expect(db.select().from(disabledActions).all()).toEqual([]);
    expect(db.select().from(actionPolicies).all()).toEqual([]);
    expect(db.select().from(userActionPolicyOverrides).all()).toEqual([]);
  });

  it('keeps owned runtime state intact when cascade batch fails', async () => {
    db.insert(users).values({ id: 'user-1', email: 'user@example.com' }).run();
    const createRes = await app.fetch(jsonRequest('/', 'POST', {
      displayName: 'Rollback MCP',
      serverUrl: 'https://rollback.example.com/mcp',
      authType: 'none',
    }), env);
    const created = await readJson<ConnectorResponse>(createRes);
    const service = created.connector.serviceSlug;

    db.insert(integrations).values({
      id: 'integration-1',
      userId: 'user-1',
      service,
      config: { entities: [] },
      status: 'active',
    }).run();
    db.insert(credentials).values({
      id: 'credential-1',
      ownerType: 'user',
      ownerId: 'user-1',
      provider: service,
      credentialType: 'oauth2',
      encryptedData: 'encrypted',
    }).run();
    db.insert(mcpToolCache).values({
      service,
      actionId: 'tool',
      name: 'Tool',
      description: '',
      riskLevel: 'low',
    }).run();

    env = {
      ...env,
      DB: makeD1Batch(sqlite, { failOnSql: 'DELETE FROM credentials' }),
    };

    const res = await app.fetch(new Request(`http://localhost/${created.connector.id}`, { method: 'DELETE' }), env);

    expect(res.status).toBe(500);
    expect(db.select().from(customMcpConnectors).where(eq(customMcpConnectors.id, created.connector.id)).all()).toHaveLength(1);
    expect(db.select().from(integrations).where(eq(integrations.service, service)).all()).toHaveLength(1);
    expect(db.select().from(credentials).where(eq(credentials.provider, service)).all()).toHaveLength(1);
    expect(db.select().from(mcpToolCache).where(eq(mcpToolCache.service, service)).all()).toHaveLength(1);
  });

  it('requires an admin user', async () => {
    const memberApp = buildApp(db, 'member');

    const res = await memberApp.fetch(new Request('http://localhost/'), env);

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      code: 'FORBIDDEN',
      error: 'Admin access required',
    });
  });
});
