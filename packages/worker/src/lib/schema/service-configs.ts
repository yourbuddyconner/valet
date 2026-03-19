import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { users } from './users.js';

export const orgServiceConfigs = sqliteTable('org_service_configs', {
  service: text().primaryKey(),
  encryptedConfig: text('encrypted_config').notNull(),
  metadata: text(),
  configuredBy: text('configured_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
});
