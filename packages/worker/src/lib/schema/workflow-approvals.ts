import { sqliteTable, text, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { workflowExecutions } from './workflows.js';
import { users } from './users.js';

/**
 * One row per approval gate hit during a workflow execution. Created by
 * either an `approval` node (kind='explicit') or a `tool` node whose
 * action policy resolved to require_approval (kind='tool_policy').
 *
 * The Cloudflare Workflow instance pauses on
 * step.waitForEvent('approval_<nodeId>', { timeout }) and resumes when
 * the approve/deny API endpoint calls instance.sendEvent.
 */
export const workflowApprovals = sqliteTable('workflow_approvals', {
  id: text().primaryKey(),
  executionId: text().references(() => workflowExecutions.id, { onDelete: 'set null' }),
  nodeId: text().notNull(),
  kind: text({ enum: ['explicit', 'tool_policy'] }).notNull(),
  workflowInstanceId: text().notNull(),
  eventType: text().notNull(),
  prompt: text().notNull(),
  summary: text(),
  details: text(),
  status: text({ enum: ['pending', 'approved', 'denied', 'expired', 'cancelled'] })
    .notNull()
    .default('pending'),
  timeoutAt: text(),
  resolvedBy: text().references(() => users.id, { onDelete: 'set null' }),
  resolvedAt: text(),
  cancelledAt: text(),
  createdAt: text().default(sql`(datetime('now'))`),
  updatedAt: text().default(sql`(datetime('now'))`),
}, (table) => [
  index('idx_wa_execution').on(table.executionId, table.createdAt),
]);
