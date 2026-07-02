import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { workflowExecutions } from './workflows.js';

/**
 * Per-node trace row for dag/v1 workflow executions. Written by the
 * runtime's TraceWriter on every node state transition. Retained per
 * the expires_at column (30d production, 7d test) and pruned daily.
 */
export const workflowExecutionNodes = sqliteTable('workflow_execution_nodes', {
  id: text().primaryKey(),
  executionId: text().references(() => workflowExecutions.id, { onDelete: 'set null' }),
  nodeId: text().notNull(),
  nodeType: text().notNull(),
  status: text({ enum: ['pending', 'running', 'waiting_approval', 'waiting_time', 'skipped', 'completed', 'failed'] }).notNull(),
  inputPreview: text(),
  inputTruncated: integer({ mode: 'boolean' }).notNull().default(false),
  output: text(),
  outputTruncated: integer({ mode: 'boolean' }).notNull().default(false),
  error: text(),
  reason: text(),
  retryAttempts: integer().notNull().default(0),
  approvalId: text(),
  invocationId: text(),
  startedAt: text(),
  completedAt: text(),
  durationMs: integer(),
  expiresAt: text().notNull(),
  createdAt: text().notNull().default(sql`(datetime('now'))`),
}, (table) => [
  index('idx_wen_execution').on(table.executionId, table.createdAt),
  index('idx_wen_node').on(table.executionId, table.nodeId),
  index('idx_wen_expires').on(table.expiresAt),
]);
