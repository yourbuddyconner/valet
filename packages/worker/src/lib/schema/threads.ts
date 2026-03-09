import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { sessions } from './sessions.js';

export const sessionThreads = sqliteTable('session_threads', {
  id: text().primaryKey(),
  sessionId: text().notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  opencodeSessionId: text(),
  title: text(),
  summaryAdditions: integer().default(0),
  summaryDeletions: integer().default(0),
  summaryFiles: integer().default(0),
  status: text().notNull().default('active'),
  messageCount: integer().default(0),
  createdAt: text().notNull().default(sql`(datetime('now'))`),
  lastActiveAt: text().notNull().default(sql`(datetime('now'))`),
}, (table) => [
  index('idx_session_threads_session').on(table.sessionId),
  index('idx_session_threads_session_status').on(table.sessionId, table.status),
  index('idx_session_threads_last_active').on(table.sessionId, table.lastActiveAt),
]);
