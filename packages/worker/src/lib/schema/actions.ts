import { sqliteTable, text, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { users } from './users.js';
import { sessions } from './sessions.js';
import { workflowExecutions } from './workflows.js';

export const actionPolicies = sqliteTable('action_policies', {
  id: text().primaryKey(),
  // IntegrationPackage.service id. Services are registry-backed, not all service ids have DB rows.
  service: text(),
  actionId: text(),
  riskLevel: text(),
  mode: text().notNull(),
  createdBy: text().references(() => users.id, { onDelete: 'set null' }),
  createdAt: text().notNull().default(sql`(datetime('now'))`),
  updatedAt: text().notNull().default(sql`(datetime('now'))`),
});
// Note: Partial unique indexes (idx_ap_action, idx_ap_service, idx_ap_risk) are defined
// in the migration SQL. Drizzle's SQLite index builder does not support WHERE clauses.

export const userActionPolicyOverrides = sqliteTable('user_action_policy_overrides', {
  id: text().primaryKey(),
  userId: text().notNull().references(() => users.id, { onDelete: 'cascade' }),
  // IntegrationPackage.service id. Intentionally mirrors action_policies.service.
  service: text(),
  actionId: text(),
  riskLevel: text(),
  mode: text().notNull(),
  lifetime: text().notNull().default('persistent'),
  sessionId: text().references(() => sessions.id, { onDelete: 'cascade' }),
  expiresAt: text(),
  source: text().notNull().default('settings'),
  sourceInvocationId: text(),
  createdAt: text().notNull().default(sql`(datetime('now'))`),
  updatedAt: text().notNull().default(sql`(datetime('now'))`),
}, (table) => [
  index('idx_uapo_user').on(table.userId),
  index('idx_uapo_session').on(table.sessionId),
  index('idx_uapo_expires').on(table.expiresAt),
]);
// Note: Partial unique indexes for user overrides are defined in the migration SQL.
// Drizzle's SQLite index builder does not support WHERE clauses.

export const actionInvocations = sqliteTable('action_invocations', {
  id: text().primaryKey(),
  // session_id is nullable as of migration 0019. SET NULL on both
  // session_id and workflow_execution_id so audit rows outlive their
  // originating session / workflow_execution.
  sessionId: text().references(() => sessions.id, { onDelete: 'set null' }),
  workflowExecutionId: text().references(() => workflowExecutions.id, { onDelete: 'set null' }),
  userId: text().notNull().references(() => users.id, { onDelete: 'cascade' }),
  service: text().notNull(),
  actionId: text().notNull(),
  riskLevel: text().notNull(),
  resolvedMode: text().notNull(),
  status: text().notNull().default('pending'),
  params: text(),
  result: text(),
  error: text(),
  resolvedBy: text().references(() => users.id, { onDelete: 'set null' }),
  resolvedAt: text(),
  executedAt: text(),
  expiresAt: text(),
  policyId: text().references(() => actionPolicies.id, { onDelete: 'set null' }),
  orgPolicyId: text().references(() => actionPolicies.id, { onDelete: 'set null' }),
  baseMode: text(),
  baseSource: text(),
  userOverrideId: text().references(() => userActionPolicyOverrides.id, { onDelete: 'set null' }),
  policySource: text(),
  policyLifetime: text(),
  policyScope: text(),
  createdAt: text().notNull().default(sql`(datetime('now'))`),
  updatedAt: text().notNull().default(sql`(datetime('now'))`),
}, (table) => [
  index('idx_ai_session').on(table.sessionId, table.createdAt),
  index('idx_ai_user').on(table.userId, table.status),
]);
