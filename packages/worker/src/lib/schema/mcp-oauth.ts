import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const mcpOauthClients = sqliteTable('mcp_oauth_clients', {
  service: text().primaryKey(),
  clientId: text().notNull(),
  clientSecret: text(),
  authorizationEndpoint: text().notNull(),
  tokenEndpoint: text().notNull(),
  registrationEndpoint: text(),
  scopesSupported: text(),
  metadataJson: text(),
  createdAt: text().notNull().default(sql`(datetime('now'))`),
  updatedAt: text().notNull().default(sql`(datetime('now'))`),
});
