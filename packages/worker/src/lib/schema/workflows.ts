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
]);

export const workflowExecutions = sqliteTable('workflow_executions', {
  id: text().primaryKey(),
  workflowId: text().references(() => workflows.id, { onDelete: 'set null' }),
  userId: text().notNull().references(() => users.id, { onDelete: 'cascade' }),
  triggerId: text().references(() => triggers.id, { onDelete: 'set null' }),
  status: text().notNull(),
  triggerType: text().notNull(),
  triggerMetadata: text({ mode: 'json' }),
  variables: text({ mode: 'json' }),
  outputs: text({ mode: 'json' }),
  steps: text({ mode: 'json' }),
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
  uniqueIndex('idx_workflow_executions_idempotency').on(table.workflowId, table.idempotencyKey),
  index('idx_workflow_executions_session').on(table.sessionId),
]);

export const workflowExecutionSteps = sqliteTable('workflow_execution_steps', {
  id: text().primaryKey(),
  executionId: text().notNull().references(() => workflowExecutions.id, { onDelete: 'cascade' }),
  stepId: text().notNull(),
  attempt: integer().notNull(),
  status: text().notNull(),
  inputJson: text({ mode: 'json' }),
  outputJson: text({ mode: 'json' }),
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
