import { sqliteTable, text, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { users } from './users.js';

export const agentMemories = sqliteTable('agent_memories', {
  id: text().primaryKey(),
  userId: text().notNull().references(() => users.id, { onDelete: 'cascade' }),
  sessionId: text(),
  workspace: text(),
  content: text().notNull(),
  category: text().default('general'),
  createdAt: text().default(sql`(datetime('now'))`),
  updatedAt: text().default(sql`(datetime('now'))`),
}, (table) => [
  index('idx_memories_user').on(table.userId),
  index('idx_memories_workspace').on(table.userId, table.workspace),
]);
