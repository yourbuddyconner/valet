import { sqliteTable, text, index, primaryKey } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const mcpToolCache = sqliteTable('mcp_tool_cache', {
  service: text().notNull(),
  actionId: text('action_id').notNull(),
  name: text().notNull(),
  description: text().notNull().default(''),
  riskLevel: text('risk_level').notNull().default('medium'),
  discoveredAt: text('discovered_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
}, (table) => [
  primaryKey({ columns: [table.service, table.actionId] }),
  index('idx_mcp_tool_cache_service').on(table.service),
]);
