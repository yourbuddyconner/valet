import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { users } from './users.js';

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
  // dag/v1 draft + published-version pointer + editor UI layout.
  draftDefinition: text(),
  publishedVersionId: text(),
  ui: text(),
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
  // Per-trigger webhook auth token (0020). Server-generated at create
  // time, shown to the user once, never re-exposed via GET/PATCH.
  webhookToken: text(),
}, (table) => [
  index('idx_triggers_user').on(table.userId),
  index('idx_triggers_workflow').on(table.workflowId),
  index('idx_triggers_type').on(table.type),
  index('idx_triggers_enabled').on(table.enabled),
  // Note: SQL migration 0011 creates this with COLLATE NOCASE for case-insensitive matching.
  // Drizzle ORM does not support collation modifiers on index columns.
  uniqueIndex('idx_triggers_user_name').on(table.userId, table.name),
]);

// Per-trigger sliding-minute counter for webhook rate limiting (0020).
// The handler upserts the current bucket on each request and rejects
// once the count exceeds the trigger's configured limit (default 60).
export const triggerWebhookRate = sqliteTable('trigger_webhook_rate', {
  triggerId: text().notNull().references(() => triggers.id, { onDelete: 'cascade' }),
  windowStartTs: integer().notNull(),
  count: integer().notNull().default(0),
}, (table) => [
  index('idx_twr_lookup').on(table.triggerId, table.windowStartTs),
]);

// Column groupings:
//   - Identity + lifecycle: id, workflowId, userId, triggerId, status,
//     startedAt, completedAt, error.
//   - Trigger context: triggerType, triggerMetadata, initiatorType,
//     initiatorUserId.
//   - Inputs / outputs: inputs (validated), outputs (stop-node outputs),
//     definitionSnapshot, definitionVersionId, workflowVersion (the
//     human-facing semver, audit-only).
//   - CF instance handle: cloudflareInstanceId (mirror of id for legibility).
//   - Cancellation: cancelledAt, cancelledBy, cleanupCompletedAt.
//   - Mode: 'production' (triggers) or 'test' (draft test-run).
//   - Idempotency: idempotencyKey (unique with workflowId).
//
// Sessions spawned by `session` / `orchestrator` nodes are linked
// through the `workflow_spawned_sessions` table — there is no
// denormalized session id column on this table.
export const workflowExecutions = sqliteTable('workflow_executions', {
  id: text().primaryKey(),
  workflowId: text().references(() => workflows.id, { onDelete: 'set null' }),
  userId: text().notNull().references(() => users.id, { onDelete: 'cascade' }),
  triggerId: text().references(() => triggers.id, { onDelete: 'set null' }),
  status: text().notNull(),
  triggerType: text().notNull(),
  triggerMetadata: text({ mode: 'json' }),
  outputs: text({ mode: 'json' }),
  error: text(),
  startedAt: text().notNull(),
  completedAt: text(),
  workflowVersion: text(),
  idempotencyKey: text(),
  initiatorType: text(),
  initiatorUserId: text().references(() => users.id, { onDelete: 'set null' }),
  cancelledAt: text(),
  cancelledBy: text().references(() => users.id, { onDelete: 'set null' }),
  // The cancel pipeline writes this only when every step succeeded;
  // a partial-failure run leaves the row in `cancelling`. A row with
  // status='cancelled' AND cleanupCompletedAt set is fully terminal;
  // status='cancelled' with null cleanupCompletedAt means the runtime
  // self-finalized but the cancel pipeline still needs to run (handled
  // by the cancel API and the cron sweep).
  cleanupCompletedAt: text(),
  // dag/v1 execution columns.
  definitionSnapshot: text(),
  definitionVersionId: text(),
  inputs: text(),
  mode: text({ enum: ['production', 'test'] }).notNull().default('production'),
  cloudflareInstanceId: text(),
}, (table) => [
  index('idx_workflow_executions_workflow').on(table.workflowId),
  index('idx_workflow_executions_user').on(table.userId),
  index('idx_workflow_executions_trigger').on(table.triggerId),
  index('idx_workflow_executions_status').on(table.status),
  index('idx_workflow_executions_started').on(table.startedAt),
  uniqueIndex('idx_workflow_executions_idempotency').on(table.workflowId, table.idempotencyKey),
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

