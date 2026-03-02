import { sqliteTable, text, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const actionPolicies = sqliteTable('action_policies', {
  id: text().primaryKey(),
  service: text(),
  actionId: text(),
  riskLevel: text(),
  mode: text().notNull(),
  createdBy: text().notNull(),
  createdAt: text().default(sql`(datetime('now'))`),
  updatedAt: text().default(sql`(datetime('now'))`),
}, (table) => [
  index('idx_ap_mode').on(table.mode),
]);

export const actionInvocations = sqliteTable('action_invocations', {
  id: text().primaryKey(),
  sessionId: text().notNull(),
  userId: text().notNull(),
  service: text().notNull(),
  actionId: text().notNull(),
  riskLevel: text().notNull(),
  resolvedMode: text().notNull(),
  status: text().notNull().default('pending'),
  params: text(),
  result: text(),
  error: text(),
  resolvedBy: text(),
  resolvedAt: text(),
  executedAt: text(),
  expiresAt: text(),
  policyId: text(),
  createdAt: text().default(sql`(datetime('now'))`),
  updatedAt: text().default(sql`(datetime('now'))`),
}, (table) => [
  index('idx_ai_session').on(table.sessionId, table.createdAt),
  index('idx_ai_user').on(table.userId, table.status),
]);
