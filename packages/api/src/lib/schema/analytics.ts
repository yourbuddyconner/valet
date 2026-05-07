import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { sessions } from './sessions.js';

export const analyticsEvents = sqliteTable('analytics_events', {
  id: text().primaryKey(),
  eventType: text().notNull(),
  sessionId: text().notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  userId: text(),
  turnId: text(),
  durationMs: integer(),
  createdAt: text().default(sql`(datetime('now'))`),
  channel: text(),
  model: text(),
  queueMode: text(),
  inputTokens: integer(),
  outputTokens: integer(),
  toolName: text(),
  errorCode: text(),
  summary: text(),
  actorId: text(),
  properties: text(),
}, (table) => [
  index('idx_analytics_events_type_created').on(table.eventType, table.createdAt),
  index('idx_analytics_events_session_created').on(table.sessionId, table.createdAt),
  index('idx_analytics_events_session_type').on(table.sessionId, table.eventType),
  index('idx_analytics_events_user_type_created').on(table.userId, table.eventType, table.createdAt),
  index('idx_analytics_events_model_created').on(table.model, table.createdAt),
]);
