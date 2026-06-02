import {
  ValidationError,
  type CustomMcpConnector,
  type CreateCustomMcpConnectorRequest,
  type UpdateCustomMcpConnectorRequest,
  type CustomMcpConnectorAuthType,
  type CustomMcpConnectorTokenEndpointAuthMethod,
} from '@valet/shared';
import { and, eq, sql } from 'drizzle-orm';
import type { Env } from '../env.js';
import type { AppDb } from '../lib/drizzle.js';
import { encryptString, decryptString } from '../lib/crypto.js';
import { getOrgSettings } from '../lib/db/org.js';
import {
  createConnector,
  getConnector,
  getConnectorBySlug,
  listConnectors,
  updateConnector,
} from '../lib/db/custom-mcp-connectors.js';
import { listMcpToolCache } from '../lib/db/mcp-tool-cache.js';
import { customMcpConnectors, mcpOauthClients, mcpToolCache } from '../lib/schema/index.js';
import { integrationRegistry } from '../integrations/registry.js';
import { validateOutboundUrl } from './outbound-url-policy.js';
import { createSafeFetchOutbound } from './safe-fetch-outbound.js';
import { discoverAuthServer } from '@valet/sdk';

export interface ResolvedCustomMcpConnector {
  id: string;
  orgId: string;
  serviceSlug: string;
  displayName: string;
  serverUrl: string;
  authType: CustomMcpConnectorAuthType;
  oauthClientId: string | null;
  oauthTokenEndpointAuthMethod: CustomMcpConnectorTokenEndpointAuthMethod;
  oauthScopes: string | null;
  oauthAuthorizationEndpoint: string | null;
  oauthTokenEndpoint: string | null;
  additionalHeaders?: Record<string, string>;
  staticAuthHeader?: { name: string; value: string };
}

export interface CustomMcpConnectorContext {
  orgId: string;
  connectors: Map<string, ResolvedCustomMcpConnector>;
  fetch: typeof fetch;
}

export interface CustomMcpOAuthConfig {
  serviceSlug: string;
  serverUrl: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string;
  tokenEndpointAuthMethod: CustomMcpConnectorTokenEndpointAuthMethod;
  scopes: string[];
}

interface ConnectorServiceOptions {
  orgId?: string;
  createdBy?: string | null;
}

type ConnectorRow = typeof customMcpConnectors.$inferSelect;

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const PROTECTED_ADDITIONAL_HEADERS = new Set([
  'authorization',
  'content-type',
  'accept',
  'mcp-session-id',
  'mcp-protocol-version',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
  'cookie',
  'date',
  'dnt',
  'expect',
  'origin',
  'referer',
  'accept-charset',
  'accept-encoding',
  'access-control-request-headers',
  'access-control-request-method',
  'permissions-policy',
]);

export async function resolveOrgIdOrDefault(db: AppDb): Promise<string> {
  try {
    return (await getOrgSettings(db)).id || 'default';
  } catch {
    return 'default';
  }
}

export async function listConnectorSummaries(db: AppDb, orgId = 'default'): Promise<CustomMcpConnector[]> {
  const connectors = await listConnectors(db, orgId);
  return Promise.all(connectors.map(async (connector) => ({
    ...connector,
    toolCount: (await listMcpToolCache(db, connector.serviceSlug)).length,
  })));
}

export async function loadCustomMcpConnectorContext(
  env: Pick<Env, 'ENCRYPTION_KEY'>,
  db: AppDb,
  orgId = 'default',
): Promise<CustomMcpConnectorContext> {
  const rows = await db
    .select()
    .from(customMcpConnectors)
    .where(and(eq(customMcpConnectors.orgId, orgId), eq(customMcpConnectors.status, 'active')))
    .all();

  const connectors = new Map<string, ResolvedCustomMcpConnector>();
  for (const row of rows) {
    await validateOutboundUrl(row.serverUrl);
    if (row.oauthAuthorizationEndpoint) await validateOutboundUrl(row.oauthAuthorizationEndpoint);
    if (row.oauthTokenEndpoint) await validateOutboundUrl(row.oauthTokenEndpoint);
    connectors.set(row.serviceSlug, await resolveConnectorRow(env, row));
  }

  return {
    orgId,
    connectors,
    fetch: createSafeFetchOutbound({ mode: 'mcp' }),
  };
}

export async function getCustomMcpConnectorBySlug(
  _env: Pick<Env, 'ENCRYPTION_KEY'>,
  db: AppDb,
  slug: string,
  orgId = 'default',
): Promise<CustomMcpConnector | null> {
  const connector = await getConnectorBySlug(db, slug);
  if (!connector || connector.orgId !== orgId || connector.status !== 'active') return null;
  return connector;
}

export async function getCustomMcpOAuthConnector(
  env: Pick<Env, 'ENCRYPTION_KEY'>,
  db: AppDb,
  slug: string,
  orgId = 'default',
): Promise<ResolvedCustomMcpConnector | null> {
  const row = await getConnectorRowBySlug(db, slug);
  if (!row || row.orgId !== orgId || row.status !== 'active') return null;
  if (row.authType !== 'oauth') {
    throw new ValidationError(`Custom connector "${slug}" is not configured for OAuth.`);
  }

  await validateOutboundUrl(row.serverUrl);
  if (row.oauthAuthorizationEndpoint) await validateOutboundUrl(row.oauthAuthorizationEndpoint);
  if (row.oauthTokenEndpoint) await validateOutboundUrl(row.oauthTokenEndpoint);

  return resolveConnectorRow(env, row);
}

export async function getCustomMcpOAuthConfig(
  env: Pick<Env, 'ENCRYPTION_KEY'>,
  db: AppDb,
  slug: string,
  orgId = 'default',
): Promise<CustomMcpOAuthConfig | null> {
  const row = await getConnectorRowBySlug(db, slug);
  if (!row || row.orgId !== orgId || row.status !== 'active') return null;
  if (row.authType !== 'oauth') {
    throw new ValidationError(`Custom connector "${slug}" is not configured for OAuth.`);
  }
  if (!row.oauthClientId) {
    return null;
  }
  if (!row.oauthAuthorizationEndpoint || !row.oauthTokenEndpoint) {
    throw new ValidationError(`Custom connector "${slug}" is missing OAuth configuration.`);
  }

  await validateOutboundUrl(row.serverUrl);
  await validateOutboundUrl(row.oauthAuthorizationEndpoint);
  await validateOutboundUrl(row.oauthTokenEndpoint);

  return {
    serviceSlug: row.serviceSlug,
    serverUrl: row.serverUrl,
    authorizationEndpoint: row.oauthAuthorizationEndpoint,
    tokenEndpoint: row.oauthTokenEndpoint,
    clientId: row.oauthClientId,
    clientSecret: row.encryptedOauthClientSecret
      ? await decryptString(row.encryptedOauthClientSecret, env.ENCRYPTION_KEY)
      : undefined,
    tokenEndpointAuthMethod: row.oauthTokenEndpointAuthMethod,
    scopes: splitScopes(row.oauthScopes),
  };
}

export async function createCustomMcpConnector(
  env: Pick<Env, 'ENCRYPTION_KEY'>,
  db: AppDb,
  input: CreateCustomMcpConnectorRequest,
  options: ConnectorServiceOptions = {},
): Promise<CustomMcpConnector> {
  const serviceSlug = slugify(input.displayName);
  validateSlug(serviceSlug);
  if (integrationRegistry.isBuiltinService(serviceSlug)) {
    throw new ValidationError(`Custom connector slug "${serviceSlug}" collides with a built-in integration.`);
  }
  if (await getConnectorBySlug(db, serviceSlug)) {
    throw new ValidationError(`Custom connector slug "${serviceSlug}" already exists.`);
  }

  await validateConfiguredUrls(input);
  const normalized = await buildCreateData(env, serviceSlug, input, options);
  return createConnector(db, normalized);
}

export async function updateCustomMcpConnector(
  env: Pick<Env, 'ENCRYPTION_KEY'>,
  db: AppDb,
  id: string,
  input: UpdateCustomMcpConnectorRequest,
): Promise<CustomMcpConnector | null> {
  const existing = await getConnectorRow(db, id);
  if (!existing) return null;

  const nextAuthType = input.authType ?? existing.authType;
  const nextServerUrl = input.serverUrl ?? existing.serverUrl;
  await validateConfiguredUrls({
    serverUrl: nextServerUrl,
    authType: nextAuthType,
    oauthAuthorizationEndpoint: input.oauthAuthorizationEndpoint ?? existing.oauthAuthorizationEndpoint,
    oauthTokenEndpoint: input.oauthTokenEndpoint ?? existing.oauthTokenEndpoint,
  });

  const update = await buildUpdateData(env, existing, input);
  const nextOauthClientId = typeof update.oauthClientId === 'string' ? update.oauthClientId : null;
  const shouldInvalidateToolCache = existing.serverUrl !== nextServerUrl
    || existing.authType !== nextAuthType
    || input.status !== undefined
    || input.additionalHeaders !== undefined
    || input.clearAdditionalHeaders === true
    || input.apiKey !== undefined
    || input.oauthClientId !== undefined
    || input.oauthClientSecret !== undefined
    || input.clearClientSecret === true
    || input.oauthAuthorizationEndpoint !== undefined
    || input.oauthTokenEndpoint !== undefined
    || input.oauthScopes !== undefined
    || input.oauthTokenEndpointAuthMethod !== undefined;
  const shouldInvalidateOAuthClient = existing.serverUrl !== nextServerUrl
    || existing.authType !== nextAuthType
    || existing.oauthClientId !== nextOauthClientId;

  const connector = await updateConnector(db, id, update);
  if (shouldInvalidateToolCache) {
    await deleteMcpToolCacheForService(db, existing.serviceSlug);
  }
  if (shouldInvalidateOAuthClient) {
    await deleteMcpOAuthClientForService(db, existing.serviceSlug);
  }
  return connector;
}

export async function deleteCustomMcpConnectorCascade(
  d1: D1Database,
  db: AppDb,
  id: string,
): Promise<void> {
  const connector = await getConnector(db, id);
  if (!connector) return;

  const service = connector.serviceSlug;
  await d1.batch([
    d1.prepare('DELETE FROM mcp_tool_cache WHERE service = ?').bind(service),
    d1.prepare('DELETE FROM integrations WHERE service = ?').bind(service),
    d1.prepare('DELETE FROM credentials WHERE provider = ?').bind(service),
    d1.prepare('DELETE FROM mcp_oauth_clients WHERE service = ?').bind(service),
    d1.prepare('DELETE FROM disabled_actions WHERE service = ?').bind(service),
    d1.prepare('DELETE FROM action_policies WHERE service = ?').bind(service),
    d1.prepare('DELETE FROM user_action_policy_overrides WHERE service = ?').bind(service),
    d1.prepare('DELETE FROM custom_mcp_connectors WHERE id = ?').bind(id),
  ]);
}

async function resolveConnectorRow(
  env: Pick<Env, 'ENCRYPTION_KEY'>,
  row: ConnectorRow,
): Promise<ResolvedCustomMcpConnector> {
  const additionalHeaders = row.encryptedAdditionalHeaders
    ? validateAdditionalHeaders(JSON.parse(await decryptString(row.encryptedAdditionalHeaders, env.ENCRYPTION_KEY)) as Record<string, string>)
    : undefined;

  const staticAuthHeader = await resolveStaticAuthHeader(env, row, additionalHeaders);

  return {
    id: row.id,
    orgId: row.orgId,
    serviceSlug: row.serviceSlug,
    displayName: row.displayName,
    serverUrl: row.serverUrl,
    authType: row.authType,
    oauthClientId: row.oauthClientId,
    oauthTokenEndpointAuthMethod: row.oauthTokenEndpointAuthMethod,
    oauthScopes: row.oauthScopes,
    oauthAuthorizationEndpoint: row.oauthAuthorizationEndpoint,
    oauthTokenEndpoint: row.oauthTokenEndpoint,
    additionalHeaders,
    staticAuthHeader,
  };
}

async function resolveStaticAuthHeader(
  env: Pick<Env, 'ENCRYPTION_KEY'>,
  row: ConnectorRow,
  additionalHeaders?: Record<string, string>,
): Promise<{ name: string; value: string } | undefined> {
  if (row.authType !== 'api_key' && row.authType !== 'bearer') return undefined;
  if (!row.encryptedApiKey) {
    throw new ValidationError(`Custom connector "${row.serviceSlug}" is missing its API key.`);
  }

  const secret = await decryptString(row.encryptedApiKey, env.ENCRYPTION_KEY);
  const name = row.authType === 'bearer' ? 'Authorization' : row.apiKeyHeaderName || 'X-API-Key';
  const prefix = row.authType === 'bearer' ? 'Bearer' : row.apiKeyPrefix || '';
  validateStaticAuthHeaderName(name);
  validateHeaderValue(name, prefix ? `${prefix} ${secret}` : secret);

  if (additionalHeaders && Object.keys(additionalHeaders).some((header) => header.toLowerCase() === name.toLowerCase())) {
    throw new ValidationError(`Custom connector "${row.serviceSlug}" has duplicate static header "${name}".`);
  }

  return {
    name,
    value: prefix ? `${prefix} ${secret}` : secret,
  };
}

function validateAdditionalHeaders(headers: Record<string, string>): Record<string, string> {
  const normalized = new Set<string>();
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lowerName = validateHeaderName(name);
    if (normalized.has(lowerName)) {
      throw new ValidationError(`Duplicate additional header "${name}".`);
    }
    if (PROTECTED_ADDITIONAL_HEADERS.has(lowerName) || lowerName.startsWith('proxy-') || lowerName.startsWith('sec-')) {
      throw new ValidationError(`Protected header "${name}" cannot be configured as an additional header.`);
    }
    validateHeaderValue(name, value);
    normalized.add(lowerName);
    result[name] = value;
  }
  return result;
}

function validateHeaderName(name: string): string {
  if (!HEADER_NAME_RE.test(name)) {
    throw new ValidationError(`Invalid header name "${name}".`);
  }
  return name.toLowerCase();
}

function validateStaticAuthHeaderName(name: string): string {
  const lowerName = validateHeaderName(name);
  if (
    lowerName !== 'authorization'
    && (PROTECTED_ADDITIONAL_HEADERS.has(lowerName) || lowerName.startsWith('proxy-') || lowerName.startsWith('sec-'))
  ) {
    throw new ValidationError(`Protected header "${name}" cannot be configured as a static auth header.`);
  }
  return lowerName;
}

function validateHeaderValue(name: string, value: string): void {
  if (typeof value !== 'string' || /[\r\n\0]/.test(value)) {
    throw new ValidationError(`Invalid value for header "${name}".`);
  }
}

async function validateConfiguredUrls(input: {
  serverUrl: string;
  authType: CustomMcpConnectorAuthType;
  oauthAuthorizationEndpoint?: string | null;
  oauthTokenEndpoint?: string | null;
}): Promise<void> {
  await validateOutboundUrl(input.serverUrl);
  if (input.oauthAuthorizationEndpoint) await validateOutboundUrl(input.oauthAuthorizationEndpoint);
  if (input.oauthTokenEndpoint) await validateOutboundUrl(input.oauthTokenEndpoint);
}

async function buildCreateData(
  env: Pick<Env, 'ENCRYPTION_KEY'>,
  serviceSlug: string,
  input: CreateCustomMcpConnectorRequest,
  options: ConnectorServiceOptions,
) {
  const auth = await normalizeAuthFields(env, input.authType, input, null, input.serverUrl);
  const encryptedAdditionalHeaders = await encryptAdditionalHeaders(env, input.additionalHeaders);
  return {
    orgId: options.orgId ?? 'default',
    serviceSlug,
    displayName: input.displayName.trim(),
    serverUrl: input.serverUrl,
    authType: input.authType,
    ...auth,
    encryptedAdditionalHeaders,
    status: input.status ?? 'active',
    createdBy: options.createdBy ?? null,
  };
}

async function buildUpdateData(
  env: Pick<Env, 'ENCRYPTION_KEY'>,
  existing: ConnectorRow,
  input: UpdateCustomMcpConnectorRequest,
) {
  const effectiveAuthType = input.authType ?? existing.authType;
  const effectiveServerUrl = input.serverUrl ?? existing.serverUrl;
  const auth = await normalizeAuthFields(env, effectiveAuthType, input, existing, effectiveServerUrl);
  const update: Record<string, unknown> = {
    displayName: input.displayName?.trim() ?? existing.displayName,
    serverUrl: input.serverUrl ?? existing.serverUrl,
    authType: effectiveAuthType,
    ...auth,
  };

  if (input.status !== undefined) update.status = input.status;
  if (input.serverUrl && input.serverUrl !== existing.serverUrl) update.lastError = null;
  if (input.clearAdditionalHeaders || (input.additionalHeaders && Object.keys(input.additionalHeaders).length === 0)) {
    update.encryptedAdditionalHeaders = null;
  } else if (input.additionalHeaders) {
    update.encryptedAdditionalHeaders = await encryptAdditionalHeaders(env, input.additionalHeaders);
  }

  return update;
}

async function normalizeAuthFields(
  env: Pick<Env, 'ENCRYPTION_KEY'>,
  authType: CustomMcpConnectorAuthType,
  input: CreateCustomMcpConnectorRequest | UpdateCustomMcpConnectorRequest,
  existing: ConnectorRow | null,
  serverUrl: string,
) {
  if (authType === 'none') {
    return {
      oauthClientId: null,
      encryptedOauthClientSecret: null,
      oauthTokenEndpointAuthMethod: 'none' as const,
      oauthScopes: null,
      oauthAuthorizationEndpoint: null,
      oauthTokenEndpoint: null,
      encryptedApiKey: null,
      apiKeyHeaderName: null,
      apiKeyPrefix: null,
    };
  }

  if (authType === 'oauth') {
    const clientId = hasInputField(input, 'oauthClientId')
      ? normalizeNullableString(input.oauthClientId)
      : existing?.oauthClientId ?? null;
    const scopes = hasInputField(input, 'oauthScopes')
      ? normalizeNullableString(input.oauthScopes)
      : existing?.oauthScopes ?? null;

    if (!clientId) {
      return {
        oauthClientId: null,
        encryptedOauthClientSecret: null,
        oauthTokenEndpointAuthMethod: 'none' as const,
        oauthScopes: scopes,
        oauthAuthorizationEndpoint: null,
        oauthTokenEndpoint: null,
        encryptedApiKey: null,
        apiKeyHeaderName: null,
        apiKeyPrefix: null,
      };
    }

    let authorizationEndpoint = hasInputField(input, 'oauthAuthorizationEndpoint')
      ? normalizeNullableString(input.oauthAuthorizationEndpoint)
      : existing?.oauthAuthorizationEndpoint ?? null;
    let tokenEndpoint = hasInputField(input, 'oauthTokenEndpoint')
      ? normalizeNullableString(input.oauthTokenEndpoint)
      : existing?.oauthTokenEndpoint ?? null;
    if (!authorizationEndpoint || !tokenEndpoint) {
      try {
        const metadata = await discoverAuthServer(serverUrl, {
          fetch: createSafeFetchOutbound({ mode: 'discovery' }),
        });
        authorizationEndpoint = authorizationEndpoint ?? metadata.authorization_endpoint;
        tokenEndpoint = tokenEndpoint ?? metadata.token_endpoint;
      } catch {
        throw new ValidationError(
          'OAuth authorization and token endpoints are required when the MCP server does not support .well-known discovery.',
        );
      }
    }
    if (!authorizationEndpoint || !tokenEndpoint) {
      throw new ValidationError(
        'OAuth authorization and token endpoints are required when the MCP server does not support .well-known discovery.',
      );
    }
    await validateOutboundUrl(authorizationEndpoint);
    await validateOutboundUrl(tokenEndpoint);

    const replacingSecret = input.oauthClientSecret && input.oauthClientSecret.trim().length > 0;
    const clearSecret = 'clearClientSecret' in input && input.clearClientSecret === true;
    let encryptedOauthClientSecret: string | null = existing?.encryptedOauthClientSecret ?? null;
    if (replacingSecret) {
      encryptedOauthClientSecret = await encryptString(input.oauthClientSecret!.trim(), env.ENCRYPTION_KEY);
    } else if (clearSecret) {
      encryptedOauthClientSecret = null;
    } else if (existing?.authType !== 'oauth') {
      encryptedOauthClientSecret = null;
    }

    return {
      oauthClientId: clientId,
      encryptedOauthClientSecret,
      oauthTokenEndpointAuthMethod: normalizeTokenEndpointAuthMethod(
        input.oauthTokenEndpointAuthMethod ?? existing?.oauthTokenEndpointAuthMethod ?? 'none',
        !!encryptedOauthClientSecret,
      ),
      oauthScopes: scopes,
      oauthAuthorizationEndpoint: authorizationEndpoint,
      oauthTokenEndpoint: tokenEndpoint,
      encryptedApiKey: null,
      apiKeyHeaderName: null,
      apiKeyPrefix: null,
    };
  }

  const secret = 'apiKey' in input ? input.apiKey?.trim() : undefined;
  let encryptedApiKey = existing?.authType === authType ? existing.encryptedApiKey : null;
  if (secret) {
    encryptedApiKey = await encryptString(secret, env.ENCRYPTION_KEY);
  }
  if (!encryptedApiKey) {
    throw new ValidationError('API key and bearer connectors require a secret.');
  }

  const apiKeyHeaderName = authType === 'bearer' ? 'Authorization' : input.apiKeyHeaderName || existing?.apiKeyHeaderName || 'X-API-Key';
  const apiKeyPrefix = authType === 'bearer' ? 'Bearer' : input.apiKeyPrefix ?? existing?.apiKeyPrefix ?? null;
  validateStaticAuthHeaderName(apiKeyHeaderName);
  validateHeaderValue(apiKeyHeaderName, apiKeyPrefix ?? '');
  if (secret) {
    validateHeaderValue(apiKeyHeaderName, apiKeyPrefix ? `${apiKeyPrefix} ${secret}` : secret);
  }

  return {
    oauthClientId: null,
    encryptedOauthClientSecret: null,
    oauthTokenEndpointAuthMethod: 'none' as const,
    oauthScopes: null,
    oauthAuthorizationEndpoint: null,
    oauthTokenEndpoint: null,
    encryptedApiKey,
    apiKeyHeaderName,
    apiKeyPrefix,
  };
}

function normalizeTokenEndpointAuthMethod(
  method: CustomMcpConnectorTokenEndpointAuthMethod | 'auto',
  hasClientSecret: boolean,
): CustomMcpConnectorTokenEndpointAuthMethod {
  if (method === 'auto') return hasClientSecret ? 'client_secret_basic' : 'none';
  return method;
}

function hasInputField<
  T extends CreateCustomMcpConnectorRequest | UpdateCustomMcpConnectorRequest,
  K extends keyof T,
>(input: T, field: K): boolean {
  return Object.prototype.hasOwnProperty.call(input, field);
}

function normalizeNullableString(value: string | null | undefined): string | null {
  return value?.trim() || null;
}

async function encryptAdditionalHeaders(
  env: Pick<Env, 'ENCRYPTION_KEY'>,
  headers: Record<string, string> | undefined,
): Promise<string | null> {
  if (!headers || Object.keys(headers).length === 0) return null;
  return encryptString(JSON.stringify(validateAdditionalHeaders(headers)), env.ENCRYPTION_KEY);
}

function splitScopes(scopes: string | null): string[] {
  return scopes?.split(/\s+/).filter(Boolean) ?? [];
}

function slugify(displayName: string): string {
  return displayName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/g, '');
}

function validateSlug(slug: string): void {
  if (!SLUG_RE.test(slug)) {
    throw new ValidationError('Connector name must produce a valid service slug.');
  }
}

async function getConnectorRow(db: AppDb, id: string): Promise<ConnectorRow | null> {
  return await db.select().from(customMcpConnectors).where(eq(customMcpConnectors.id, id)).get() ?? null;
}

async function getConnectorRowBySlug(db: AppDb, slug: string): Promise<ConnectorRow | null> {
  return await db.select().from(customMcpConnectors).where(eq(customMcpConnectors.serviceSlug, slug)).get() ?? null;
}

async function deleteMcpToolCacheForService(db: AppDb, service: string): Promise<void> {
  await db.delete(mcpToolCache).where(eq(mcpToolCache.service, service));
}

async function deleteMcpOAuthClientForService(db: AppDb, service: string): Promise<void> {
  await db.delete(mcpOauthClients).where(eq(mcpOauthClients.service, service));
}
