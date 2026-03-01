import { sqliteTable, text, real, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

// Note: orchestrator_memory_files_fts is an FTS5 virtual table and cannot be represented in Drizzle schema.
// FTS5 queries must use raw SQL via d1.prepare().
export const orchestratorMemoryFiles = sqliteTable('orchestrator_memory_files', {
  id: text().primaryKey(),
  userId: text('user_id').notNull(),
  orgId: text('org_id').notNull().default('default'),
  path: text().notNull(),
  content: text().notNull(),
  relevance: real().notNull().default(1.0),
  pinned: integer().notNull().default(0),
  version: integer().notNull().default(1),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
  lastAccessedAt: text('last_accessed_at').notNull().default(sql`(datetime('now'))`),
}, (table) => [
  uniqueIndex('idx_memory_files_user_path').on(table.userId, table.path),
  index('idx_memory_files_user').on(table.userId),
  index('idx_memory_files_pinned').on(table.userId, table.pinned),
]);
