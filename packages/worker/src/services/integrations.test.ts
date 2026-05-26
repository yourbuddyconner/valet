import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Env } from '../env.js';
import { createTestDb } from '../test-utils/db.js';
import type { AppDb } from '../lib/drizzle.js';
import { credentials, integrations } from '../lib/schema/index.js';
import { createCustomMcpConnector } from './custom-mcp-connectors.js';

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

describe('configureIntegration custom MCP OAuth', () => {
  let db: AppDb;
  let env: Env;

  beforeEach(async () => {
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
});
