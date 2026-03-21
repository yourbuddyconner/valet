import { sqliteTable, text, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { users } from './users.js';

export const integrations = sqliteTable('integrations', {
  id: text().primaryKey(),
  userId: text().notNull().references(() => users.id, { onDelete: 'cascade' }),
  service: text().notNull(),
  config: text({ mode: 'json' }).notNull().$type<{ entities: string[]; filters?: Record<string, unknown> }>().default({ entities: [] }),
  status: text().notNull().default('pending'),
  errorMessage: text(),
  lastSyncedAt: text(),
  scope: text().notNull().default('user'),
  createdAt: text().default(sql`(datetime('now'))`),
  updatedAt: text().default(sql`(datetime('now'))`),
}, (table) => [
  uniqueIndex('idx_integrations_user_service').on(table.userId, table.service),
  index('idx_integrations_user').on(table.userId),
  index('idx_integrations_service').on(table.service),
]);


