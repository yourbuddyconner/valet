import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const orgPlugins = sqliteTable('org_plugins', {
  id: text().primaryKey(),
  orgId: text().notNull().default('default'),
  name: text().notNull(),
  version: text().notNull(),
  description: text(),
  icon: text(),
  source: text().notNull().default('builtin'),
  capabilities: text({ mode: 'json' }).notNull().$type<string[]>().default([]),
  actionType: text(),
  authRequired: integer({ mode: 'boolean' }).notNull().default(true),
  status: text().notNull().default('active'),
  installedBy: text().notNull().default('system'),
  installedAt: text().notNull().default(sql`(datetime('now'))`),
  updatedAt: text().notNull().default(sql`(datetime('now'))`),
}, (table) => [
  uniqueIndex('idx_org_plugins_name').on(table.orgId, table.name),
]);

export const orgPluginArtifacts = sqliteTable('org_plugin_artifacts', {
  id: text().primaryKey(),
  pluginId: text().notNull(),
  type: text().notNull(),
  filename: text().notNull(),
  content: text().notNull(),
  sortOrder: integer().notNull().default(0),
}, (table) => [
  uniqueIndex('idx_plugin_artifacts_file').on(table.pluginId, table.type, table.filename),
  index('idx_plugin_artifacts_plugin').on(table.pluginId),
]);

export const orgPluginSettings = sqliteTable('org_plugin_settings', {
  id: text().primaryKey(),
  orgId: text().notNull(),
  allowRepoContent: integer({ mode: 'boolean' }).notNull().default(true),
  createdAt: text().notNull().default(sql`(datetime('now'))`),
  updatedAt: text().notNull().default(sql`(datetime('now'))`),
}, (table) => [
  uniqueIndex('idx_org_plugin_settings_org').on(table.orgId),
]);
