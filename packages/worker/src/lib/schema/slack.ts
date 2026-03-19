import { sqliteTable, text, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { users } from './users.js';

export const orgSlackInstalls = sqliteTable('org_slack_installs', {
  id: text().primaryKey(),
  teamId: text().notNull().unique(),
  teamName: text(),
  botUserId: text().notNull(),
  appId: text(),
  encryptedBotToken: text().notNull(),
  encryptedSigningSecret: text(),
  installedBy: text().references(() => users.id, { onDelete: 'set null' }),
  createdAt: text().notNull().default(sql`(datetime('now'))`),
  updatedAt: text().notNull().default(sql`(datetime('now'))`),
}, (table) => [
  index('idx_org_slack_installs_team').on(table.teamId),
]);

export const slackLinkVerifications = sqliteTable('slack_link_verifications', {
  id: text().primaryKey(),
  userId: text().notNull().references(() => users.id, { onDelete: 'cascade' }),
  slackUserId: text().notNull(),
  slackDisplayName: text(),
  code: text().notNull(),
  expiresAt: text().notNull(),
  createdAt: text().notNull().default(sql`(datetime('now'))`),
}, (table) => [
  index('idx_slack_link_verifications_user').on(table.userId),
]);
