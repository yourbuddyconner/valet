import { sqliteTable, text, integer, index, primaryKey } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const sessionTasks = sqliteTable('session_tasks', {
  id: text().primaryKey(),
  orchestratorSessionId: text().notNull(),
  sessionId: text(),
  title: text().notNull(),
  description: text(),
  status: text().notNull().default('pending'),
  result: text(),
  parentTaskId: text(),
  createdAt: text().notNull().default(sql`(datetime('now'))`),
  updatedAt: text().notNull().default(sql`(datetime('now'))`),
}, (table) => [
  index('idx_session_tasks_orchestrator').on(table.orchestratorSessionId, table.status, table.createdAt),
  index('idx_session_tasks_session').on(table.sessionId, table.status),
  index('idx_session_tasks_parent').on(table.parentTaskId),
]);

export const sessionTaskDependencies = sqliteTable('session_task_dependencies', {
  taskId: text().notNull(),
  blockedByTaskId: text().notNull(),
}, (table) => [
  primaryKey({ columns: [table.taskId, table.blockedByTaskId] }),
]);
