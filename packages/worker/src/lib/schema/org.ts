import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { users } from './users.js';

export const orgSettings = sqliteTable('org_settings', {
  id: text().primaryKey().default('default'),
  name: text().notNull().default('My Organization'),
  allowedEmailDomain: text(),
  allowedEmails: text(),
  domainGatingEnabled: integer({ mode: 'boolean' }).default(false),
  emailAllowlistEnabled: integer({ mode: 'boolean' }).default(false),
  defaultSessionVisibility: text().notNull().default('private'),
  modelPreferences: text({ mode: 'json' }).$type<string[]>(),
  createdAt: text().default(sql`(datetime('now'))`),
  updatedAt: text().default(sql`(datetime('now'))`),
});

export const orgApiKeys = sqliteTable('org_api_keys', {
  id: text().primaryKey(),
  provider: text().notNull().unique(),
  encryptedKey: text().notNull(),
  models: text({ mode: 'json' }).$type<Array<{ id: string; name?: string }>>(),
  showAllModels: integer({ mode: 'boolean' }).notNull().default(true),
  setBy: text().notNull().references(() => users.id),
  createdAt: text().default(sql`(datetime('now'))`),
  updatedAt: text().default(sql`(datetime('now'))`),
});

export const invites = sqliteTable('invites', {
  id: text().primaryKey(),
  code: text().notNull().unique(),
  email: text(),
  role: text().notNull().default('member'),
  invitedBy: text().notNull().references(() => users.id),
  acceptedAt: text(),
  acceptedBy: text().references(() => users.id),
  expiresAt: text().notNull(),
  createdAt: text().default(sql`(datetime('now'))`),
}, (table) => [
  index('idx_invites_code').on(table.code),
  index('idx_invites_email').on(table.email),
]);

export const orgRepositories = sqliteTable('org_repositories', {
  id: text().primaryKey(),
  orgId: text().notNull().default('default'),
  provider: text().notNull().default('github'),
  owner: text().notNull(),
  name: text().notNull(),
  fullName: text().notNull(),
  description: text(),
  defaultBranch: text().default('main'),
  language: text(),
  topics: text({ mode: 'json' }).$type<string[]>(),
  enabled: integer({ mode: 'boolean' }).notNull().default(true),
  createdAt: text().notNull().default(sql`(datetime('now'))`),
  updatedAt: text().notNull().default(sql`(datetime('now'))`),
}, (table) => [
  uniqueIndex('idx_org_repos_full_name').on(table.orgId, table.fullName),
]);

export const orgRepoPersonaDefaults = sqliteTable('org_repo_persona_defaults', {
  id: text().primaryKey(),
  orgRepoId: text().notNull(),
  personaId: text().notNull(),
  createdAt: text().notNull().default(sql`(datetime('now'))`),
}, (table) => [
  uniqueIndex('idx_repo_persona_default').on(table.orgRepoId),
]);

export const customProviders = sqliteTable('custom_providers', {
  id: text().primaryKey(),
  providerId: text().notNull().unique(),
  displayName: text().notNull(),
  baseUrl: text().notNull(),
  encryptedKey: text(),
  models: text({ mode: 'json' }).notNull().$type<Array<{ id: string; name?: string; contextLimit?: number; outputLimit?: number }>>().default([]),
  showAllModels: integer({ mode: 'boolean' }).notNull().default(false),
  setBy: text().notNull(),
  createdAt: text().notNull().default(sql`(datetime('now'))`),
  updatedAt: text().notNull().default(sql`(datetime('now'))`),
});
