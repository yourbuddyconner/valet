import { sqliteTable, text, index, primaryKey } from 'drizzle-orm/sqlite-core';
import { workflowExecutions } from './workflows.js';

/**
 * Lookup table for sessions that a workflow execution spawned via
 * `session` (mode=start) nodes. Terminal runtime cleanup and cancel
 * cleanup query this table to find every active session for an
 * execution and terminate it, without having to parse trace.output
 * (which may be truncated or absent for still-in-flight nodes).
 *
 * Successful termination deletes the row immediately. Failed terminal
 * cleanup attempts leave the row for scheduled retry. Rows expire per
 * `expires_at` (30d production, 7d test, matching workflow_execution_nodes)
 * as a final prune; ON DELETE CASCADE also removes them when an execution
 * row is purged.
 */
export const workflowSpawnedSessions = sqliteTable('workflow_spawned_sessions', {
  executionId: text('execution_id').notNull().references(() => workflowExecutions.id, { onDelete: 'cascade' }),
  nodeId: text('node_id').notNull(),
  sessionId: text('session_id').notNull(),
  // Added in migration 0022 so the unified resolver can recover the parent
  // workflow context for a spawned session (lineage walk → execution scope,
  // workflow-node subject matching). Nullable for backfilled / pre-0022 rows;
  // new spawn sites populate both.
  workflowId: text('workflow_id'),
  workflowVersionId: text('workflow_version_id'),
  createdAt: text('created_at').notNull(),
  expiresAt: text('expires_at').notNull(),
}, (table) => [
  primaryKey({ columns: [table.executionId, table.nodeId, table.sessionId] }),
  index('idx_workflow_spawned_sessions_execution_id').on(table.executionId),
  index('idx_workflow_spawned_sessions_expires_at').on(table.expiresAt),
]);
