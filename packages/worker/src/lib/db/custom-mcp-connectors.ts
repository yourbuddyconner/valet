import type { CustomMcpConnector } from '@valet/shared';
import { eq, desc, sql } from 'drizzle-orm';
import type { AppDb } from '../drizzle.js';
import { toDate } from '../drizzle.js';
import { customMcpConnectors } from '../schema/index.js';

type ConnectorRow = typeof customMcpConnectors.$inferSelect;
type ConnectorStatus = CustomMcpConnector['status'];
type ConnectorAuthType = CustomMcpConnector['authType'];
type ConnectorCredentialScope = CustomMcpConnector['credentialScope'];
type ConnectorApiKeyPlacement = CustomMcpConnector['apiKeyPlacement'];
type TokenEndpointAuthMethod = CustomMcpConnector['oauthTokenEndpointAuthMethod'];

export interface CreateCustomMcpConnectorData {
  id?: string;
  orgId?: string;
  serviceSlug: string;
  displayName: string;
  serverUrl: string;
  authType: ConnectorAuthType;
  credentialScope?: ConnectorCredentialScope;
  oauthClientId?: string | null;
  encryptedOauthClientSecret?: string | null;
  oauthTokenEndpointAuthMethod?: TokenEndpointAuthMethod;
  oauthScopes?: string | null;
  oauthAuthorizationEndpoint?: string | null;
  oauthTokenEndpoint?: string | null;
  encryptedApiKey?: string | null;
  apiKeyPlacement?: ConnectorApiKeyPlacement;
  apiKeyHeaderName?: string | null;
  apiKeyPrefix?: string | null;
  apiKeyQueryParam?: string | null;
  encryptedAdditionalHeaders?: string | null;
  status?: ConnectorStatus;
  lastDiscoveredAt?: string | null;
  lastError?: string | null;
  createdBy?: string | null;
}

export type UpdateCustomMcpConnectorData = Partial<Omit<CreateCustomMcpConnectorData, 'id' | 'orgId' | 'serviceSlug' | 'createdBy'>> & {
  orgId?: string;
  createdBy?: string | null;
};

function rowToConnector(row: ConnectorRow): CustomMcpConnector {
  return {
    id: row.id,
    orgId: row.orgId,
    serviceSlug: row.serviceSlug,
    displayName: row.displayName,
    serverUrl: row.serverUrl,
    authType: row.authType,
    credentialScope: row.credentialScope,
    oauthClientId: row.oauthClientId,
    oauthTokenEndpointAuthMethod: row.oauthTokenEndpointAuthMethod,
    oauthScopes: row.oauthScopes,
    oauthAuthorizationEndpoint: row.oauthAuthorizationEndpoint,
    oauthTokenEndpoint: row.oauthTokenEndpoint,
    apiKeyPlacement: row.apiKeyPlacement,
    apiKeyHeaderName: row.apiKeyHeaderName,
    apiKeyPrefix: row.apiKeyPrefix,
    apiKeyQueryParam: row.apiKeyQueryParam,
    status: row.status,
    lastDiscoveredAt: row.lastDiscoveredAt,
    lastError: row.lastError,
    createdBy: row.createdBy,
    createdAt: toDate(row.createdAt),
    updatedAt: toDate(row.updatedAt),
    hasClientSecret: !!row.encryptedOauthClientSecret,
    hasApiKey: !!row.encryptedApiKey,
    hasAdditionalHeaders: !!row.encryptedAdditionalHeaders,
  };
}

export async function listConnectors(db: AppDb, orgId = 'default'): Promise<CustomMcpConnector[]> {
  const rows = await db
    .select()
    .from(customMcpConnectors)
    .where(eq(customMcpConnectors.orgId, orgId))
    .orderBy(desc(customMcpConnectors.createdAt));

  return rows.map(rowToConnector);
}

export async function listActiveConnectors(db: AppDb, orgId = 'default'): Promise<CustomMcpConnector[]> {
  const rows = await db
    .select()
    .from(customMcpConnectors)
    .where(sql`${customMcpConnectors.orgId} = ${orgId} AND ${customMcpConnectors.status} = 'active'`)
    .orderBy(desc(customMcpConnectors.createdAt));

  return rows.map(rowToConnector);
}

export async function getConnector(db: AppDb, id: string): Promise<CustomMcpConnector | null> {
  const row = await db.select().from(customMcpConnectors).where(eq(customMcpConnectors.id, id)).get();
  return row ? rowToConnector(row) : null;
}

export async function getConnectorBySlug(db: AppDb, slug: string): Promise<CustomMcpConnector | null> {
  const row = await db.select().from(customMcpConnectors).where(eq(customMcpConnectors.serviceSlug, slug)).get();
  return row ? rowToConnector(row) : null;
}

export async function createConnector(
  db: AppDb,
  data: CreateCustomMcpConnectorData,
): Promise<CustomMcpConnector> {
  const id = data.id ?? crypto.randomUUID();

  await db.insert(customMcpConnectors).values({
    id,
    orgId: data.orgId ?? 'default',
    serviceSlug: data.serviceSlug,
    displayName: data.displayName,
    serverUrl: data.serverUrl,
    authType: data.authType,
    credentialScope: data.credentialScope ?? 'org',
    oauthClientId: data.oauthClientId ?? null,
    encryptedOauthClientSecret: data.encryptedOauthClientSecret ?? null,
    oauthTokenEndpointAuthMethod: data.oauthTokenEndpointAuthMethod ?? 'none',
    oauthScopes: data.oauthScopes ?? null,
    oauthAuthorizationEndpoint: data.oauthAuthorizationEndpoint ?? null,
    oauthTokenEndpoint: data.oauthTokenEndpoint ?? null,
    encryptedApiKey: data.encryptedApiKey ?? null,
    apiKeyPlacement: data.apiKeyPlacement ?? 'header',
    apiKeyHeaderName: data.apiKeyHeaderName ?? null,
    apiKeyPrefix: data.apiKeyPrefix ?? null,
    apiKeyQueryParam: data.apiKeyQueryParam ?? null,
    encryptedAdditionalHeaders: data.encryptedAdditionalHeaders ?? null,
    status: data.status ?? 'active',
    lastDiscoveredAt: data.lastDiscoveredAt ?? null,
    lastError: data.lastError ?? null,
    createdBy: data.createdBy ?? null,
  });

  const connector = await getConnector(db, id);
  if (!connector) throw new Error(`Failed to create custom MCP connector ${id}`);
  return connector;
}

export async function updateConnector(
  db: AppDb,
  id: string,
  data: UpdateCustomMcpConnectorData,
): Promise<CustomMcpConnector | null> {
  await db
    .update(customMcpConnectors)
    .set({
      ...data,
      updatedAt: sql`datetime('now')`,
    })
    .where(eq(customMcpConnectors.id, id));

  return getConnector(db, id);
}

export async function deleteConnector(db: AppDb, id: string): Promise<void> {
  await db.delete(customMcpConnectors).where(eq(customMcpConnectors.id, id));
}
