import { sqliteTable, text, uniqueIndex, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { sessions } from './sessions.js';
import { sessionThreads } from './threads.js';

export const channelThreadMappings = sqliteTable('channel_thread_mappings', {
  id: text().primaryKey(),
  sessionId: text().notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  threadId: text().notNull().references(() => sessionThreads.id, { onDelete: 'cascade' }),
  channelType: text().notNull(),
  channelId: text().notNull(),
  externalThreadId: text().notNull(),
  userId: text().notNull(),
  lastSeenTs: text(),
  createdAt: text().notNull().default(sql`(datetime('now'))`),
}, (table) => [
  uniqueIndex('idx_channel_thread_mappings_user_lookup').on(table.channelType, table.channelId, table.externalThreadId, table.userId),
  index('idx_channel_thread_mappings_thread').on(table.threadId),
  index('idx_channel_thread_mappings_session').on(table.sessionId),
]);
