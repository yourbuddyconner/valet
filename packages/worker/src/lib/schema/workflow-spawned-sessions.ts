import { sqliteTable, text, index, primaryKey } from 'drizzle-orm/sqlite-core';
import { workflowExecutions } from './workflows.js';

/**
 * Lookup table for sessions that a workflow execution spawned via
 * `session` (mode=start) nodes. The cancel cleanup path queries this
 * to find every active session for an execution and abort it, without
 * having to parse trace.output (which may be truncated or absent for
 * still-in-flight nodes).
 *
 * Rows expire per `expires_at` (30d production, 7d test, matching
 * workflow_execution_nodes). The daily cron sweeps expired rows; the
 * ON DELETE CASCADE on workflow_executions(id) also wipes them when an
 * execution row is purged.
 */
export const workflowSpawnedSessions = sqliteTable('workflow_spawned_sessions', {
  executionId: text('execution_id').notNull().references(() => workflowExecutions.id, { onDelete: 'cascade' }),
  nodeId: text('node_id').notNull(),
  sessionId: text('session_id').notNull(),
  createdAt: text('created_at').notNull(),
  expiresAt: text('expires_at').notNull(),
}, (table) => [
  primaryKey({ columns: [table.executionId, table.nodeId, table.sessionId] }),
  index('idx_workflow_spawned_sessions_execution_id').on(table.executionId),
  index('idx_workflow_spawned_sessions_expires_at').on(table.expiresAt),
]);
