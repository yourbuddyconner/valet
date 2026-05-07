import { sqliteTable, text, uniqueIndex, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { users } from './users.js';

export const githubInstallations = sqliteTable('github_installations', {
  id: text().primaryKey(),
  githubInstallationId: text().notNull(),
  accountLogin: text().notNull(),
  accountId: text().notNull(),
  accountType: text().notNull(),
  linkedUserId: text().references(() => users.id, { onDelete: 'set null' }),
  status: text().notNull().default('active'),
  repositorySelection: text().notNull(),
  permissions: text(),
  cachedTokenEncrypted: text(),
  cachedTokenExpiresAt: text(),
  createdAt: text().notNull().default(sql`(datetime('now'))`),
  updatedAt: text().notNull().default(sql`(datetime('now'))`),
}, (table) => [
  uniqueIndex('idx_github_installations_installation_id').on(table.githubInstallationId),
  index('idx_github_installations_account_login').on(table.accountLogin),
  index('idx_github_installations_account_id').on(table.accountId),
  index('idx_github_installations_linked_user').on(table.linkedUserId),
]);

export type GithubInstallation = typeof githubInstallations.$inferSelect;
export type NewGithubInstallation = typeof githubInstallations.$inferInsert;
