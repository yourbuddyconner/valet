import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { workflows } from './workflows.js';
import { users } from './users.js';

export const copilotThreads = sqliteTable('copilot_threads', {
  id: text().primaryKey(),
  workflowId: text('workflow_id').notNull().references(() => workflows.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  systemPrompt: text('system_prompt').notNull(),
  model: text(),
  title: text(),
  messageCount: integer('message_count').notNull().default(0),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
}, (table) => [
  index('idx_copilot_threads_workflow').on(table.workflowId),
  index('idx_copilot_threads_user').on(table.userId),
  index('idx_copilot_threads_updated').on(table.workflowId, table.userId, table.updatedAt),
]);

export const copilotMessages = sqliteTable('copilot_messages', {
  id: text().primaryKey(),
  threadId: text('thread_id').notNull().references(() => copilotThreads.id, { onDelete: 'cascade' }),
  role: text().notNull(),
  content: text().notNull().default(''),
  parts: text(),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
}, (table) => [
  index('idx_copilot_messages_thread').on(table.threadId, table.createdAt),
]);
