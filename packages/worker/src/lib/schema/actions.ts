import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
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
  // ─── Unified policy framework (migration 0022) ──────────────────────────
  // Ownership / scope. Defaults backfill existing rows as admin/org policies.
  orgId: text().notNull().default('default'),
  managedBy: text().notNull().default('admin'),    // 'admin' | 'user' | 'system'
  principalType: text().notNull().default('org'),  // 'org' | 'user'
  principalId: text().notNull().default('default'),
  // Target discriminator. New code must respect the per-type required fields
  // in the spec; migrated rows are 'tool_action' regardless of partial targets.
  subjectType: text().notNull().default('tool_action'),
  subjectLabel: text(),                            // Display-only; never used for matching.
  workflowId: text(),
  workflowVersionId: text(),
  nodeId: text(),
  // Parameter matchers (Phase 2 enforces; Phase 1 stores).
  paramMatchers: text().notNull().default('[]'),
  matcherSummary: text(),
  // Admin require_approval rows: 'allowed' means user grants may quiet matching
  // approvals; 'blocked' forces a prompt every time.
  userGrantBehavior: text().notNull().default('allowed'),
  // Provenance / audit.
  origin: text().notNull().default('settings'),    // 'settings' | 'approval_prompt' | 'workflow_editor' | 'admin' | 'migration'
  sourceApprovalId: text(),
  lastMatchedAt: text(),
  expiresAt: text(),                               // Null = persistent; set = timed.
  revokedAt: text(),
});
// Note: Unique and lookup indexes (idx_ap_unique, idx_ap_lookup_*) are defined
// in migration 0022. Drizzle's SQLite index builder does not support WHERE
// clauses, so partial indexes live in the migration SQL.

/**
 * Ephemeral allow grants scoped to a live session or workflow execution.
 *
 * Exactly one of `sessionId` / `workflowExecutionId` is set (enforced by a
 * CHECK constraint in migration 0022). Hard-deleted on terminal-state
 * transition of the parent context; FK cascades are the backstop.
 *
 * All rows are implicitly `mode = 'allow'`. Quieting an approval is the
 * only function of this table.
 */
export const runtimeGrants = sqliteTable('runtime_grants', {
  id: text().primaryKey(),
  orgId: text().notNull().default('default'),
  userId: text().notNull().references(() => users.id, { onDelete: 'cascade' }),
  sessionId: text().references(() => sessions.id, { onDelete: 'cascade' }),
  workflowExecutionId: text().references(() => workflowExecutions.id, { onDelete: 'cascade' }),
  subjectType: text().notNull(),
  service: text(),
  actionId: text(),
  riskLevel: text(),
  workflowId: text(),
  nodeId: text(),
  paramMatchers: text().notNull().default('[]'),
  // Deterministic idempotency key: scope id + subject + node id + matcher fingerprint.
  // Equivalent later approvals reuse the same grant.
  policyKey: text().notNull(),
  matcherSummary: text(),
  createdAt: text().notNull().default(sql`(datetime('now'))`),
  revokedAt: text(),
});
// Note: Unique policy_key indexes (per-session, per-execution) and lookup
// indexes are partial-WHERE indexes defined in migration 0022.

/**
 * Legacy user-managed override table. Migration 0022 backfills every row
 * into action_policies (persistent / timed) or runtime_grants (session) and
 * leaves this table populated for the existing resolver. The next commit
 * retires reads/writes; a follow-up migration drops it.
 */
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
  // Legacy audit columns. Kept for historical reads; new code writes the
  // matched_* columns below instead.
  policyId: text().references(() => actionPolicies.id, { onDelete: 'set null' }),
  orgPolicyId: text().references(() => actionPolicies.id, { onDelete: 'set null' }),
  baseMode: text(),
  baseSource: text(),
  userOverrideId: text().references(() => userActionPolicyOverrides.id, { onDelete: 'set null' }),
  policySource: text(),
  policyLifetime: text(),
  policyScope: text(),
  // Unified-resolver audit (migration 0022). Backfilled from user_override_id
  // mapping; new invocations write these in place of the legacy columns.
  matchedPolicyId: text().references(() => actionPolicies.id, { onDelete: 'set null' }),
  matchedGrantId: text().references(() => runtimeGrants.id, { onDelete: 'set null' }),
  // Workflow-runtime context (migration 0023). Captured for workflow-attributed
  // invocations so the resume hook can derive the Workflows event type
  // (`approval_<nodeId>[_i_<index>]`) and to enable nodeId-aware grant matching.
  nodeId: text(),
  iterationIndex: integer(),
  createdAt: text().notNull().default(sql`(datetime('now'))`),
  updatedAt: text().notNull().default(sql`(datetime('now'))`),
}, (table) => [
  index('idx_ai_session').on(table.sessionId, table.createdAt),
  index('idx_ai_user').on(table.userId, table.status),
]);
