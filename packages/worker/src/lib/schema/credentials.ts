import { sqliteTable, text, uniqueIndex, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const credentials = sqliteTable('credentials', {
  id: text().primaryKey(),
  ownerType: text().notNull().default('user'),
  ownerId: text().notNull(),
  provider: text().notNull(),
  credentialType: text().notNull().default('oauth2'),
  encryptedData: text().notNull(),
  metadata: text(),
  scopes: text(),
  expiresAt: text(),
  createdAt: text().notNull().default(sql`(datetime('now'))`),
  updatedAt: text().notNull().default(sql`(datetime('now'))`),
}, (table) => [
  uniqueIndex('credentials_owner_unique').on(table.ownerType, table.ownerId, table.provider, table.credentialType),
  index('credentials_owner_lookup').on(table.ownerType, table.ownerId),
  index('credentials_provider').on(table.provider),
]);
