import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { users } from './users.js';
import { sessions } from './sessions.js';

export const workflows = sqliteTable('workflows', {
  id: text().primaryKey(),
  userId: text().notNull().references(() => users.id, { onDelete: 'cascade' }),
  slug: text(),
  name: text().notNull(),
  description: text(),
  version: text().notNull().default('1.0.0'),
  data: text().notNull(),
  enabled: integer({ mode: 'boolean' }).default(true),
  tags: text(),
  createdAt: text().default(sql`(datetime('now'))`),
  updatedAt: text().default(sql`(datetime('now'))`),
}, (table) => [
  index('idx_workflows_user').on(table.userId),
  uniqueIndex('idx_workflows_slug').on(table.userId, table.slug),
  index('idx_workflows_enabled').on(table.enabled),
]);

export const triggers = sqliteTable('triggers', {
  id: text().primaryKey(),
  userId: text().notNull().references(() => users.id, { onDelete: 'cascade' }),
  workflowId: text().references(() => workflows.id, { onDelete: 'cascade' }),
  name: text().notNull(),
  enabled: integer({ mode: 'boolean' }).default(true),
  type: text().notNull(),
  config: text().notNull(),
  variableMapping: text(),
  lastRunAt: text(),
  createdAt: text().default(sql`(datetime('now'))`),
  updatedAt: text().default(sql`(datetime('now'))`),
}, (table) => [
  index('idx_triggers_user').on(table.userId),
  index('idx_triggers_workflow').on(table.workflowId),
  index('idx_triggers_type').on(table.type),
  index('idx_triggers_enabled').on(table.enabled),
  // Composite for the webhook + cron dispatch path: WHERE type = ? AND enabled = 1.
  // See migration 0016.
  index('idx_triggers_type_enabled').on(table.type, table.enabled),
  // Note: SQL migration 0011 creates this with COLLATE NOCASE for case-insensitive matching.
  // Drizzle ORM does not support collation modifiers on index columns.
  uniqueIndex('idx_triggers_user_name').on(table.userId, table.name),
]);

export const workflowExecutions = sqliteTable('workflow_executions', {
  id: text().primaryKey(),
  workflowId: text().references(() => workflows.id, { onDelete: 'set null' }),
  userId: text().notNull().references(() => users.id, { onDelete: 'cascade' }),
  triggerId: text().references(() => triggers.id, { onDelete: 'set null' }),
  status: text().notNull(),
  triggerType: text().notNull(),
  // Stored as JSON-encoded text. Writers call JSON.stringify; readers JSON.parse.
  // Not mode:'json' because Drizzle's auto-serialize would double-encode our pre-stringified values.
  triggerMetadata: text(),
  variables: text(),
  outputs: text(),
  steps: text(),
  error: text(),
  startedAt: text().notNull(),
  completedAt: text(),
  workflowVersion: text(),
  workflowHash: text(),
  workflowSnapshot: text(),
  idempotencyKey: text(),
  runtimeState: text(),
  resumeToken: text(),
  attemptCount: integer().notNull().default(0),
  sessionId: text().references(() => sessions.id, { onDelete: 'set null' }),
  initiatorType: text(),
  initiatorUserId: text().references(() => users.id, { onDelete: 'set null' }),
}, (table) => [
  index('idx_workflow_executions_workflow').on(table.workflowId),
  index('idx_workflow_executions_user').on(table.userId),
  index('idx_workflow_executions_trigger').on(table.triggerId),
  index('idx_workflow_executions_status').on(table.status),
  index('idx_workflow_executions_started').on(table.startedAt),
  // Composite for the executions list query (WHERE user_id = ? ORDER BY started_at DESC).
  // Drizzle's SQLite dialect doesn't expose .desc() on index columns; migration 0016
  // declares the DESC ordering on disk.
  index('idx_workflow_executions_user_started').on(table.userId, table.startedAt),
  uniqueIndex('idx_workflow_executions_idempotency').on(table.workflowId, table.idempotencyKey),
  index('idx_workflow_executions_session').on(table.sessionId),
]);

export const workflowExecutionSteps = sqliteTable('workflow_execution_steps', {
  id: text().primaryKey(),
  executionId: text().notNull().references(() => workflowExecutions.id, { onDelete: 'cascade' }),
  stepId: text().notNull(),
  attempt: integer().notNull(),
  status: text().notNull(),
  // JSON-encoded text. All writes use raw SQL; all reads parse manually. Not mode:'json'
  // to keep schema honest about that and avoid any future Drizzle double-encoding.
  inputJson: text(),
  outputJson: text(),
  error: text(),
  startedAt: text(),
  completedAt: text(),
  createdAt: text().notNull().default(sql`(datetime('now'))`),
}, (table) => [
  uniqueIndex('idx_execution_steps_unique').on(table.executionId, table.stepId, table.attempt),
  index('idx_workflow_execution_steps_execution').on(table.executionId),
  index('idx_workflow_execution_steps_status').on(table.status),
]);

export const workflowMutationProposals = sqliteTable('workflow_mutation_proposals', {
  id: text().primaryKey(),
  workflowId: text().notNull().references(() => workflows.id, { onDelete: 'cascade' }),
  executionId: text().references(() => workflowExecutions.id, { onDelete: 'set null' }),
  proposedBySessionId: text().references(() => sessions.id, { onDelete: 'set null' }),
  baseWorkflowHash: text().notNull(),
  proposalJson: text().notNull(),
  diffText: text(),
  status: text().notNull(),
  reviewNotes: text(),
  expiresAt: text(),
  createdAt: text().notNull().default(sql`(datetime('now'))`),
  updatedAt: text().notNull().default(sql`(datetime('now'))`),
}, (table) => [
  index('idx_workflow_mutation_proposals_workflow').on(table.workflowId),
  index('idx_workflow_mutation_proposals_status').on(table.status),
]);

export const workflowScheduleTicks = sqliteTable('workflow_schedule_ticks', {
  id: text().primaryKey(),
  triggerId: text().notNull().references(() => triggers.id, { onDelete: 'cascade' }),
  tickBucket: text().notNull(),
  createdAt: text().notNull().default(sql`(datetime('now'))`),
}, (table) => [
  uniqueIndex('idx_schedule_ticks_unique').on(table.triggerId, table.tickBucket),
  index('idx_workflow_schedule_ticks_trigger').on(table.triggerId),
]);

export const pendingApprovals = sqliteTable('pending_approvals', {
  id: text().primaryKey(),
  executionId: text().notNull().references(() => workflowExecutions.id, { onDelete: 'cascade' }),
  stepId: text().notNull(),
  message: text().notNull(),
  timeoutAt: text(),
  defaultAction: text(),
  status: text().notNull().default('pending'),
  respondedAt: text(),
  respondedBy: text(),
  createdAt: text().default(sql`(datetime('now'))`),
}, (table) => [
  index('idx_pending_approvals_execution').on(table.executionId),
  index('idx_pending_approvals_status').on(table.status),
]);

export const triggerDeliveries = sqliteTable('trigger_deliveries', {
  id: text().primaryKey(),
  triggerId: text('trigger_id').notNull().references(() => triggers.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  eventType: text('event_type'),
  deliveryId: text('delivery_id'),
  outcome: text().notNull(),
  executionId: text('execution_id').references(() => workflowExecutions.id, { onDelete: 'set null' }),
  reason: text(),
  payloadPreview: text('payload_preview'),
  receivedAt: text('received_at').notNull().default(sql`(datetime('now'))`),
}, (table) => [
  index('idx_trigger_deliveries_trigger').on(table.triggerId),
  // Migration 0014 declares this index DESC on received_at; Drizzle's SQLite
  // dialect doesn't expose .desc() on index columns, so the declarative
  // mirror here lists the column un-ordered. The actual DB index is correct.
  index('idx_trigger_deliveries_received').on(table.triggerId, table.receivedAt),
  index('idx_trigger_deliveries_user').on(table.userId),
]);

export const workflowVersionHistory = sqliteTable('workflow_version_history', {
  id: text().primaryKey(),
  workflowId: text().notNull().references(() => workflows.id, { onDelete: 'cascade' }),
  workflowVersion: text(),
  workflowHash: text().notNull(),
  workflowData: text().notNull(),
  source: text().notNull(),
  sourceProposalId: text(),
  notes: text(),
  createdBy: text().references(() => users.id, { onDelete: 'set null' }),
  createdAt: text().notNull().default(sql`(datetime('now'))`),
}, (table) => [
  uniqueIndex('idx_version_history_unique').on(table.workflowId, table.workflowHash),
  index('idx_workflow_version_history_workflow_created').on(table.workflowId, table.createdAt),
  index('idx_workflow_version_history_hash').on(table.workflowHash),
]);
