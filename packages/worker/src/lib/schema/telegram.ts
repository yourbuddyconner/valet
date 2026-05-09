import { sqliteTable, text, integer, uniqueIndex, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { users } from './users.js';

export const userTelegramConfig = sqliteTable('user_telegram_config', {
  id: text().primaryKey(),
  userId: text().notNull().references(() => users.id, { onDelete: 'cascade' }),
  botUsername: text().notNull(),
  botInfo: text().notNull(),
  webhookUrl: text(),
  webhookActive: integer({ mode: 'boolean' }).notNull().default(false),
  ownerTelegramUserId: text(),
  createdAt: text().notNull().default(sql`(datetime('now'))`),
  updatedAt: text().notNull().default(sql`(datetime('now'))`),
}, (table) => [
  uniqueIndex('idx_telegram_config_unique').on(table.userId),
  index('idx_telegram_config_user').on(table.userId),
]);
