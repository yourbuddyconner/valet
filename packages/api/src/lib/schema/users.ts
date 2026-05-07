import { sqliteTable, text, integer, real, uniqueIndex, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const users = sqliteTable('users', {
  id: text().primaryKey(),
  email: text().notNull().unique(),
  name: text(),
  avatarUrl: text(),
  githubId: text(),
  githubUsername: text(),
  gitName: text(),
  gitEmail: text(),
  onboardingCompleted: integer({ mode: 'boolean' }).default(false),
  idleTimeoutSeconds: integer().default(900),
  role: text().notNull().default('member'),
  modelPreferences: text({ mode: 'json' }).$type<string[]>(),
  discoveredModels: text({ mode: 'json' }),
  maxActiveSessions: integer(),
  uiQueueMode: text().default('followup'),
  timezone: text(),
  passwordHash: text(),
  identityProvider: text(),
  sandboxCpuCores: real(),
  sandboxMemoryMib: integer(),
  createdAt: text().default(sql`(datetime('now'))`),
  updatedAt: text().default(sql`(datetime('now'))`),
}, (table) => [
  uniqueIndex('idx_users_github_id').on(table.githubId),
]);

export const apiTokens = sqliteTable('api_tokens', {
  id: text().primaryKey(),
  userId: text().notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text().notNull(),
  tokenHash: text().notNull().unique(),
  prefix: text(),
  scopes: text().default('[]'),
  lastUsedAt: text(),
  expiresAt: text(),
  revokedAt: text(),
  createdAt: text().default(sql`(datetime('now'))`),
}, (table) => [
  index('idx_api_tokens_user').on(table.userId),
  index('idx_api_tokens_hash').on(table.tokenHash),
  index('idx_api_tokens_prefix').on(table.prefix),
]);

export const authSessions = sqliteTable('auth_sessions', {
  id: text().primaryKey(),
  userId: text().notNull().references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text().notNull().unique(),
  provider: text().notNull(),
  expiresAt: text().notNull(),
  createdAt: text().default(sql`(datetime('now'))`),
  lastUsedAt: text(),
}, (table) => [
  index('idx_auth_sessions_token').on(table.tokenHash),
]);

