import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { sessions } from './sessions.js';

export const usageEvents = sqliteTable('usage_events', {
  id: text().primaryKey(),
  sessionId: text().notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  turnId: text().notNull(),
  ocMessageId: text().notNull(),
  model: text().notNull(),
  inputTokens: integer().notNull().default(0),
  outputTokens: integer().notNull().default(0),
  createdAt: text().default(sql`(datetime('now'))`),
}, (table) => [
  index('idx_usage_events_session').on(table.sessionId),
  index('idx_usage_events_model').on(table.model),
  index('idx_usage_events_created_at').on(table.createdAt),
  index('idx_usage_events_session_created').on(table.sessionId, table.createdAt),
  index('idx_usage_events_model_created').on(table.model, table.createdAt),
]);
