import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { users } from './users.js';

export const sessions = sqliteTable('sessions', {
  id: text().primaryKey(),
  userId: text().notNull().references(() => users.id, { onDelete: 'cascade' }),
  workspace: text().notNull(),
  status: text().notNull().default('initializing'),
  containerId: text(),
  sandboxId: text(),
  tunnelUrls: text({ mode: 'json' }).$type<Record<string, string>>(),
  metadata: text({ mode: 'json' }).$type<Record<string, unknown>>(),
  snapshotImageId: text(),
  messageCount: integer().notNull().default(0),
  toolCallCount: integer().notNull().default(0),
  errorMessage: text(),
  activeSeconds: integer().notNull().default(0),
  title: text(),
  parentSessionId: text(),
  personaId: text(),
  isOrchestrator: integer({ mode: 'boolean' }).notNull().default(false),
  purpose: text().notNull().default('interactive'),
  createdAt: text().default(sql`(datetime('now'))`),
  lastActiveAt: text().default(sql`(datetime('now'))`),
}, (table) => [
  index('idx_sessions_user').on(table.userId),
  index('idx_sessions_status').on(table.status),
  index('idx_sessions_parent').on(table.parentSessionId),
  index('idx_sessions_created_at').on(table.createdAt),
  index('idx_sessions_user_created_at').on(table.userId, table.createdAt),
  index('idx_sessions_workspace_created_at').on(table.workspace, table.createdAt),
  index('idx_sessions_status_last_active_at').on(table.status, table.lastActiveAt),
  index('idx_sessions_purpose_user_status').on(table.purpose, table.userId, table.status),
]);

export const messages = sqliteTable('messages', {
  id: text().primaryKey(),
  sessionId: text().notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  role: text().notNull(),
  content: text().notNull(),
  parts: text({ mode: 'json' }),
  toolCalls: text({ mode: 'json' }),
  authorId: text().references(() => users.id),
  authorEmail: text(),
  authorName: text(),
  channelType: text(),
  channelId: text(),
  opencodeSessionId: text(),
  authorAvatarUrl: text(),
  messageFormat: text().notNull().default('v1'),
  threadId: text(),
  createdAt: text().default(sql`(datetime('now'))`),
}, (table) => [
  index('idx_messages_session').on(table.sessionId),
]);

export const screenshots = sqliteTable('screenshots', {
  id: text().primaryKey(),
  sessionId: text().notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  r2Key: text().notNull(),
  description: text(),
  takenAt: text().default(sql`(datetime('now'))`),
  metadata: text({ mode: 'json' }),
}, (table) => [
  index('idx_screenshots_session').on(table.sessionId),
]);

export const sessionGitState = sqliteTable('session_git_state', {
  id: text().primaryKey(),
  sessionId: text().notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  sourceType: text(),
  sourcePrNumber: integer(),
  sourceIssueNumber: integer(),
  sourceRepoFullName: text(),
  sourceRepoUrl: text(),
  branch: text(),
  baseBranch: text(),
  commitCount: integer().default(0),
  prNumber: integer(),
  prTitle: text(),
  prState: text(),
  prUrl: text(),
  prCreatedAt: text(),
  prMergedAt: text(),
  ref: text(),
  agentAuthored: integer({ mode: 'boolean' }).default(true),
  createdAt: text().default(sql`(datetime('now'))`),
  updatedAt: text().default(sql`(datetime('now'))`),
}, (table) => [
  uniqueIndex('idx_sgs_session').on(table.sessionId),
  index('idx_sgs_repo_pr').on(table.sourceRepoFullName, table.prNumber),
  index('idx_sgs_agent_pr').on(table.agentAuthored, table.prState),
]);

export const sessionFilesChanged = sqliteTable('session_files_changed', {
  id: text().primaryKey(),
  sessionId: text().notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  filePath: text().notNull(),
  status: text().notNull(),
  additions: integer().default(0),
  deletions: integer().default(0),
  createdAt: text().default(sql`(datetime('now'))`),
  updatedAt: text().default(sql`(datetime('now'))`),
}, (table) => [
  uniqueIndex('idx_sfc_unique').on(table.sessionId, table.filePath),
  index('idx_sfc_session').on(table.sessionId),
]);

export const sessionParticipants = sqliteTable('session_participants', {
  id: text().primaryKey(),
  sessionId: text().notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  userId: text().notNull().references(() => users.id, { onDelete: 'cascade' }),
  role: text().notNull().default('collaborator'),
  addedBy: text().references(() => users.id),
  createdAt: text().default(sql`(datetime('now'))`),
}, (table) => [
  uniqueIndex('idx_sp_unique').on(table.sessionId, table.userId),
  index('idx_sp_session').on(table.sessionId),
  index('idx_sp_user').on(table.userId),
]);

export const sessionShareLinks = sqliteTable('session_share_links', {
  id: text().primaryKey(),
  sessionId: text().notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  token: text().notNull().unique(),
  role: text().notNull().default('collaborator'),
  createdBy: text().notNull().references(() => users.id),
  expiresAt: text(),
  maxUses: integer(),
  useCount: integer().default(0),
  active: integer({ mode: 'boolean' }).default(true),
  createdAt: text().default(sql`(datetime('now'))`),
}, (table) => [
  index('idx_ssl_token').on(table.token),
]);

export const sessionAuditLog = sqliteTable('session_audit_log', {
  id: text().primaryKey(),
  sessionId: text().notNull(),
  eventType: text().notNull(),
  summary: text().notNull(),
  actorId: text(),
  metadata: text({ mode: 'json' }).$type<Record<string, unknown>>(),
  createdAt: text().notNull().default(sql`(datetime('now'))`),
  flushedAt: text(),
}, (table) => [
  index('idx_session_audit_log_session_id').on(table.sessionId, table.createdAt),
  index('idx_session_audit_log_event_type').on(table.sessionId, table.eventType),
]);
