import { sqliteTable, text, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { users } from './users.js';
import { sessions } from './sessions.js';

export const actionPolicies = sqliteTable('action_policies', {
  id: text().primaryKey(),
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

export const actionInvocations = sqliteTable('action_invocations', {
  id: text().primaryKey(),
  sessionId: text().notNull().references(() => sessions.id, { onDelete: 'cascade' }),
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
  createdAt: text().notNull().default(sql`(datetime('now'))`),
  updatedAt: text().notNull().default(sql`(datetime('now'))`),
}, (table) => [
  index('idx_ai_session').on(table.sessionId, table.createdAt),
  index('idx_ai_user').on(table.userId, table.status),
]);
