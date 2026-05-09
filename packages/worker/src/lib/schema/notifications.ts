import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const mailboxMessages = sqliteTable('mailbox_messages', {
  id: text().primaryKey(),
  fromSessionId: text(),
  fromUserId: text(),
  toSessionId: text(),
  toUserId: text(),
  messageType: text().notNull().default('message'),
  content: text().notNull(),
  contextSessionId: text(),
  contextTaskId: text(),
  replyToId: text(),
  read: integer({ mode: 'boolean' }).notNull().default(false),
  createdAt: text().notNull().default(sql`(datetime('now'))`),
  updatedAt: text().notNull().default(sql`(datetime('now'))`),
}, (table) => [
  index('idx_mailbox_to_session').on(table.toSessionId, table.read, table.createdAt),
  index('idx_mailbox_to_user').on(table.toUserId, table.read, table.createdAt),
  index('idx_mailbox_from_session').on(table.fromSessionId, table.createdAt),
  index('idx_mailbox_reply_to').on(table.replyToId),
]);

export const userNotificationPreferences = sqliteTable('user_notification_preferences', {
  id: text().primaryKey(),
  userId: text().notNull(),
  messageType: text().notNull(),
  eventType: text().notNull().default('*'),
  webEnabled: integer({ mode: 'boolean' }).notNull().default(true),
  slackEnabled: integer({ mode: 'boolean' }).notNull().default(false),
  emailEnabled: integer({ mode: 'boolean' }).notNull().default(false),
  createdAt: text().notNull().default(sql`(datetime('now'))`),
  updatedAt: text().notNull().default(sql`(datetime('now'))`),
}, (table) => [
  uniqueIndex('idx_notification_prefs_unique').on(table.userId, table.messageType, table.eventType),
  index('idx_notification_prefs_user').on(table.userId),
  index('idx_notification_prefs_lookup').on(table.userId, table.messageType, table.eventType),
]);
