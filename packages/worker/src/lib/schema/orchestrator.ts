import { sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const orchestratorIdentities = sqliteTable('orchestrator_identities', {
  id: text().primaryKey(),
  userId: text(),
  orgId: text().notNull().default('default'),
  type: text().notNull().default('personal'),
  name: text().notNull().default('Agent'),
  handle: text().notNull(),
  avatar: text(),
  customInstructions: text(),
  createdAt: text().notNull().default(sql`(datetime('now'))`),
  updatedAt: text().notNull().default(sql`(datetime('now'))`),
}, (table) => [
  uniqueIndex('idx_orch_identity_handle').on(table.orgId, table.handle),
  uniqueIndex('idx_orch_identity_user').on(table.orgId, table.userId),
]);

// orchestrator_memories table removed — replaced by orchestrator_memory_files (see schema/memory-files.ts)
