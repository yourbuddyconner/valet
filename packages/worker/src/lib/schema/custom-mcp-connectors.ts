import { sql } from 'drizzle-orm';
import { index, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { users } from './users.js';

export const customMcpConnectors = sqliteTable('custom_mcp_connectors', {
  id: text().primaryKey(),
  orgId: text('org_id').notNull().default('default'),
  serviceSlug: text('service_slug').notNull().unique(),
  displayName: text('display_name').notNull(),
  serverUrl: text('server_url').notNull(),
  authType: text('auth_type').notNull().default('none').$type<'none' | 'oauth' | 'api_key' | 'bearer'>(),

  oauthClientId: text('oauth_client_id'),
  encryptedOauthClientSecret: text('encrypted_oauth_client_secret'),
  oauthTokenEndpointAuthMethod: text('oauth_token_endpoint_auth_method')
    .notNull()
    .default('none')
    .$type<'none' | 'client_secret_basic' | 'client_secret_post'>(),
  oauthScopes: text('oauth_scopes'),
  oauthAuthorizationEndpoint: text('oauth_authorization_endpoint'),
  oauthTokenEndpoint: text('oauth_token_endpoint'),

  encryptedApiKey: text('encrypted_api_key'),
  apiKeyHeaderName: text('api_key_header_name').default('Authorization'),
  apiKeyPrefix: text('api_key_prefix').default('Bearer'),

  encryptedAdditionalHeaders: text('encrypted_additional_headers'),

  status: text().notNull().default('active').$type<'active' | 'disabled' | 'error'>(),
  lastDiscoveredAt: text('last_discovered_at'),
  lastError: text('last_error'),
  createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
}, (table) => [
  index('idx_custom_mcp_connectors_org_status').on(table.orgId, table.status),
]);
