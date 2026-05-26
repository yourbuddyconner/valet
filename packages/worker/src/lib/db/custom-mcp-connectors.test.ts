import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from '../../test-utils/db.js';
import { users } from '../schema/users.js';
import { customMcpConnectors } from '../schema/custom-mcp-connectors.js';
import {
  createConnector,
  deleteConnector,
  getConnector,
  getConnectorBySlug,
  listActiveConnectors,
  listConnectors,
  updateConnector,
} from './custom-mcp-connectors.js';

describe('custom MCP connector DB helpers', () => {
  let db: ReturnType<typeof createTestDb>['db'];

  beforeEach(() => {
    db = createTestDb().db;
    db.insert(users).values({
      id: 'admin-1',
      email: 'admin@example.com',
      name: 'Admin',
    }).run();
  });

  it('creates and redacts connector metadata while preserving non-secret config', async () => {
    const connector = await createConnector(db, {
      orgId: 'default',
      serviceSlug: 'salesforce-mcp',
      displayName: 'Salesforce MCP',
      serverUrl: 'https://api.salesforce.com/platform/mcp/v1/platform/sobject-all',
      authType: 'oauth',
      oauthClientId: 'client-123',
      encryptedOauthClientSecret: 'encrypted-secret',
      oauthTokenEndpointAuthMethod: 'client_secret_basic',
      oauthScopes: 'mcp_api refresh_token',
      oauthAuthorizationEndpoint: 'https://login.salesforce.com/services/oauth2/authorize',
      oauthTokenEndpoint: 'https://login.salesforce.com/services/oauth2/token',
      encryptedApiKey: null,
      apiKeyHeaderName: null,
      apiKeyPrefix: null,
      encryptedAdditionalHeaders: 'encrypted-headers',
      status: 'active',
      createdBy: 'admin-1',
    });

    expect(connector).toMatchObject({
      orgId: 'default',
      serviceSlug: 'salesforce-mcp',
      displayName: 'Salesforce MCP',
      authType: 'oauth',
      oauthClientId: 'client-123',
      oauthTokenEndpointAuthMethod: 'client_secret_basic',
      hasClientSecret: true,
      hasApiKey: false,
      hasAdditionalHeaders: true,
      createdBy: 'admin-1',
    });
    expect('encryptedOauthClientSecret' in connector).toBe(false);
    expect('encryptedAdditionalHeaders' in connector).toBe(false);
  });

  it('lists active connectors by org and resolves by slug', async () => {
    await createConnector(db, {
      orgId: 'default',
      serviceSlug: 'active-one',
      displayName: 'Active One',
      serverUrl: 'https://mcp.example.com',
      authType: 'none',
      status: 'active',
      createdBy: null,
    });
    await createConnector(db, {
      orgId: 'default',
      serviceSlug: 'disabled-one',
      displayName: 'Disabled One',
      serverUrl: 'https://disabled.example.com',
      authType: 'none',
      status: 'disabled',
      createdBy: null,
    });
    await createConnector(db, {
      orgId: 'other-org',
      serviceSlug: 'other-org-one',
      displayName: 'Other Org',
      serverUrl: 'https://other.example.com',
      authType: 'none',
      status: 'active',
      createdBy: null,
    });

    const allDefault = await listConnectors(db, 'default');
    expect(allDefault.map((c) => c.serviceSlug).sort()).toEqual(['active-one', 'disabled-one']);

    const activeDefault = await listActiveConnectors(db, 'default');
    expect(activeDefault.map((c) => c.serviceSlug)).toEqual(['active-one']);

    const bySlug = await getConnectorBySlug(db, 'active-one');
    expect(bySlug?.displayName).toBe('Active One');
  });

  it('updates connector fields without exposing encrypted values', async () => {
    const created = await createConnector(db, {
      orgId: 'default',
      serviceSlug: 'configurable',
      displayName: 'Configurable',
      serverUrl: 'https://mcp.example.com',
      authType: 'api_key',
      encryptedApiKey: 'old-key',
      apiKeyHeaderName: 'X-API-Key',
      apiKeyPrefix: '',
      status: 'active',
      createdBy: null,
    });

    const updated = await updateConnector(db, created.id, {
      displayName: 'Updated',
      encryptedApiKey: 'new-key',
      encryptedAdditionalHeaders: 'encrypted-headers',
      status: 'disabled',
    });

    expect(updated?.displayName).toBe('Updated');
    expect(updated?.status).toBe('disabled');
    expect(updated?.hasApiKey).toBe(true);
    expect(updated?.hasAdditionalHeaders).toBe(true);
    expect('encryptedApiKey' in updated!).toBe(false);

    const row = db.select().from(customMcpConnectors).where(eq(customMcpConnectors.id, created.id)).get();
    expect(row?.encryptedApiKey).toBe('new-key');
  });

  it('deletes connector rows without touching service cleanup tables', async () => {
    const created = await createConnector(db, {
      orgId: 'default',
      serviceSlug: 'delete-me',
      displayName: 'Delete Me',
      serverUrl: 'https://mcp.example.com',
      authType: 'none',
      status: 'active',
      createdBy: null,
    });

    await deleteConnector(db, created.id);

    await expect(getConnector(db, created.id)).resolves.toBeNull();
    await expect(getConnectorBySlug(db, 'delete-me')).resolves.toBeNull();
  });

  it('keeps createdBy nullable when admin user is deleted', async () => {
    const created = await createConnector(db, {
      orgId: 'default',
      serviceSlug: 'admin-owned',
      displayName: 'Admin Owned',
      serverUrl: 'https://mcp.example.com',
      authType: 'none',
      status: 'active',
      createdBy: 'admin-1',
    });

    db.delete(users).where(eq(users.id, 'admin-1')).run();

    const connector = await getConnector(db, created.id);
    expect(connector?.createdBy).toBeNull();
  });
});
