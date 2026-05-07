import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { users } from './users.js';
import { sessions } from './sessions.js';

export const userIdentityLinks = sqliteTable('user_identity_links', {
  id: text().primaryKey(),
  userId: text().notNull().references(() => users.id, { onDelete: 'cascade' }),
  provider: text().notNull(),
  externalId: text().notNull(),
  externalName: text(),
  teamId: text(),
  createdAt: text().notNull().default(sql`(datetime('now'))`),
}, (table) => [
  uniqueIndex('idx_identity_links_unique').on(table.provider, table.externalId),
  index('idx_identity_links_user').on(table.userId),
  index('idx_identity_links_provider').on(table.provider, table.externalId),
]);

export const channelBindings = sqliteTable('channel_bindings', {
  id: text().primaryKey(),
  sessionId: text().notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  channelType: text().notNull(),
  channelId: text().notNull(),
  scopeKey: text().notNull(),
  userId: text(),
  orgId: text().notNull(),
  queueMode: text().notNull().default('followup'),
  collectDebounceMs: integer().notNull().default(3000),
  slackChannelId: text(),
  slackThreadTs: text(),
  slackInitialMessageTs: text(),
  githubRepoFullName: text(),
  githubPrNumber: integer(),
  githubCommentId: text(),
  createdAt: text().notNull().default(sql`(datetime('now'))`),
}, (table) => [
  uniqueIndex('idx_channel_bindings_unique').on(table.channelType, table.channelId),
  index('idx_channel_bindings_session').on(table.sessionId),
  index('idx_channel_bindings_scope').on(table.scopeKey),
  index('idx_channel_bindings_user').on(table.userId),
]);
