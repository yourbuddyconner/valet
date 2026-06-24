import { sqliteTable, text, index, primaryKey } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const mcpToolCache = sqliteTable('mcp_tool_cache', {
  service: text().notNull(),
  actionId: text('action_id').notNull(),
  name: text().notNull(),
  description: text().notNull().default(''),
  riskLevel: text('risk_level').notNull().default('medium'),
  // JSON-encoded MCP tool schemas (added in 0021). Nullable for backward
  // compatibility with rows cached before the column existed and for MCP
  // servers that don't advertise an outputSchema.
  inputSchema: text('input_schema'),
  outputSchema: text('output_schema'),
  discoveredAt: text('discovered_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
}, (table) => [
  primaryKey({ columns: [table.service, table.actionId] }),
  index('idx_mcp_tool_cache_service').on(table.service),
]);
