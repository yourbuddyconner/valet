import type { D1Database } from '@cloudflare/workers-types';
import type { MailboxMessage, UserNotificationPreference } from '@valet/shared';
import { eq, and, desc, sql, inArray } from 'drizzle-orm';
import type { AppDb } from '../drizzle.js';
import { mailboxMessages, userNotificationPreferences } from '../schema/index.js';
import { normalizeNotificationEventType } from './constants.js';

// ─── Notification Queue Types ───────────────────────────────────────────────

export type NotificationQueueItem = MailboxMessage;
export type NotificationQueueType = MailboxMessage['messageType'];

// ─── Row Conversion Helpers ─────────────────────────────────────────────────

/**
 * Convert a raw row from the mailbox_messages table (with optional joined columns)
 * into a MailboxMessage. Used for raw SQL results that include joined aliases.
 */
function rowToMailboxMessage(row: any): MailboxMessage {
  return {
    id: row.id,
    fromSessionId: row.from_session_id || undefined,
    fromUserId: row.from_user_id || undefined,
    toSessionId: row.to_session_id || undefined,
    toUserId: row.to_user_id || undefined,
    messageType: row.message_type,
    content: row.content,
    contextSessionId: row.context_session_id || undefined,
    contextTaskId: row.context_task_id || undefined,
    replyToId: row.reply_to_id || undefined,
    read: !!row.read,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    fromSessionTitle: row.from_session_title || undefined,
    fromUserName: row.from_user_name || undefined,
    fromUserEmail: row.from_user_email || undefined,
    toSessionTitle: row.to_session_title || undefined,
    toUserName: row.to_user_name || undefined,
    replyCount: row.reply_count !== undefined ? Number(row.reply_count) : undefined,
    lastActivityAt: row.last_activity_at || undefined,
  };
}

function drizzleRowToPreference(row: typeof userNotificationPreferences.$inferSelect): UserNotificationPreference {
  return {
    id: row.id,
    userId: row.userId,
    messageType: row.messageType as UserNotificationPreference['messageType'],
    eventType: row.eventType || '*',
    webEnabled: !!row.webEnabled,
    slackEnabled: !!row.slackEnabled,
    emailEnabled: !!row.emailEnabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ─── Mailbox Operations ─────────────────────────────────────────────────────

export async function createMailboxMessage(
  db: AppDb,
  data: {
    fromSessionId?: string;
    fromUserId?: string;
    toSessionId?: string;
    toUserId?: string;
    messageType?: string;
    content: string;
    contextSessionId?: string;
    contextTaskId?: string;
    replyToId?: string;
  },
): Promise<MailboxMessage> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await db.insert(mailboxMessages).values({
    id,
    fromSessionId: data.fromSessionId || null,
    fromUserId: data.fromUserId || null,
    toSessionId: data.toSessionId || null,
    toUserId: data.toUserId || null,
    messageType: data.messageType || 'message',
    content: data.content,
    contextSessionId: data.contextSessionId || null,
    contextTaskId: data.contextTaskId || null,
    replyToId: data.replyToId || null,
    read: false,
    createdAt: now,
    updatedAt: now,
  });

  return {
    id,
    fromSessionId: data.fromSessionId,
    fromUserId: data.fromUserId,
    toSessionId: data.toSessionId,
    toUserId: data.toUserId,
    messageType: (data.messageType as MailboxMessage['messageType']) || 'message',
    content: data.content,
    contextSessionId: data.contextSessionId,
    contextTaskId: data.contextTaskId,
    replyToId: data.replyToId,
    read: false,
    createdAt: now,
    updatedAt: now,
  };
}

export async function getSessionMailbox(
  db: D1Database,
  sessionId: string,
  opts?: { unreadOnly?: boolean; limit?: number; after?: string },
): Promise<MailboxMessage[]> {
  const conditions = ['m.to_session_id = ?'];
  const params: (string | number)[] = [sessionId];

  if (opts?.unreadOnly) {
    conditions.push('m.read = 0');
  }
  if (opts?.after) {
    conditions.push('m.created_at > ?');
    params.push(opts.after);
  }

  const limit = opts?.limit ?? 50;
  params.push(limit);

  const result = await db
    .prepare(
      `SELECT m.*,
              fs.title AS from_session_title,
              fu.name AS from_user_name,
              fu.email AS from_user_email
       FROM mailbox_messages m
       LEFT JOIN sessions fs ON m.from_session_id = fs.id
       LEFT JOIN users fu ON m.from_user_id = fu.id
       WHERE ${conditions.join(' AND ')}
       ORDER BY m.created_at DESC
       LIMIT ?`,
    )
    .bind(...params)
    .all();

  return (result.results || []).map(rowToMailboxMessage);
}

export async function getUserInbox(
  db: D1Database,
  userId: string,
  opts?: { unreadOnly?: boolean; messageType?: string; limit?: number; cursor?: string },
): Promise<{ messages: MailboxMessage[]; cursor?: string; hasMore: boolean }> {
  // Subquery param comes first in bind order (it's in the FROM clause)
  const subqueryParams: (string | number)[] = [userId];
  const conditions = ['m.to_user_id = ?', 'm.reply_to_id IS NULL'];
  const whereParams: (string | number)[] = [userId];

  if (opts?.unreadOnly) {
    // Thread has any unread message to user (root or replies)
    conditions.push(
      `(m.read = 0 OR EXISTS (SELECT 1 FROM mailbox_messages r WHERE r.reply_to_id = m.id AND r.to_user_id = ? AND r.read = 0))`,
    );
    whereParams.push(userId);
  }
  if (opts?.messageType) {
    conditions.push('m.message_type = ?');
    whereParams.push(opts.messageType);
  }
  if (opts?.cursor) {
    conditions.push('COALESCE(ts.last_activity_at, m.created_at) < ?');
    whereParams.push(opts.cursor);
  }

  const limit = (opts?.limit ?? 50) + 1;
  whereParams.push(limit);

  const result = await db
    .prepare(
      `SELECT m.*,
              fs.title AS from_session_title,
              fu.name AS from_user_name,
              fu.email AS from_user_email,
              COALESCE(ts.reply_count, 0) AS reply_count,
              COALESCE(ts.last_activity_at, m.created_at) AS last_activity_at
       FROM mailbox_messages m
       LEFT JOIN sessions fs ON m.from_session_id = fs.id
       LEFT JOIN users fu ON m.from_user_id = fu.id
       LEFT JOIN (
         SELECT reply_to_id,
                COUNT(*) AS reply_count,
                MAX(created_at) AS last_activity_at
         FROM mailbox_messages
         WHERE reply_to_id IS NOT NULL AND to_user_id = ?
         GROUP BY reply_to_id
       ) ts ON ts.reply_to_id = m.id
       WHERE ${conditions.join(' AND ')}
       ORDER BY COALESCE(ts.last_activity_at, m.created_at) DESC
       LIMIT ?`,
    )
    .bind(...subqueryParams, ...whereParams)
    .all();

  const rows = result.results || [];
  const hasMore = rows.length === limit;
  const items = hasMore ? rows.slice(0, -1) : rows;
  const messages = items.map(rowToMailboxMessage);
  const cursor =
    hasMore && messages.length > 0 ? messages[messages.length - 1].lastActivityAt || messages[messages.length - 1].createdAt : undefined;

  return { messages, cursor, hasMore };
}

export async function getUserInboxCount(db: AppDb, userId: string): Promise<number> {
  const row = await db
    .select({ count: sql<number>`count(*)` })
    .from(mailboxMessages)
    .where(and(eq(mailboxMessages.toUserId, userId), eq(mailboxMessages.read, false)))
    .get();
  return row?.count ?? 0;
}

export async function markSessionMailboxRead(db: AppDb, sessionId: string): Promise<number> {
  const result = await db
    .update(mailboxMessages)
    .set({
      read: true,
      updatedAt: sql`datetime('now')`,
    })
    .where(and(eq(mailboxMessages.toSessionId, sessionId), eq(mailboxMessages.read, false)));
  return (result as any).meta?.changes ?? 0;
}

export async function markInboxMessageRead(db: AppDb, messageId: string, userId: string): Promise<boolean> {
  const result = await db
    .update(mailboxMessages)
    .set({
      read: true,
      updatedAt: sql`datetime('now')`,
    })
    .where(and(eq(mailboxMessages.id, messageId), eq(mailboxMessages.toUserId, userId)));
  return ((result as any).meta?.changes ?? 0) > 0;
}

export async function getMailboxMessage(db: D1Database, messageId: string): Promise<MailboxMessage | null> {
  const row = await db
    .prepare(
      `SELECT m.*,
              fs.title AS from_session_title,
              fu.name AS from_user_name,
              fu.email AS from_user_email,
              ts.title AS to_session_title,
              tu.name AS to_user_name
       FROM mailbox_messages m
       LEFT JOIN sessions fs ON m.from_session_id = fs.id
       LEFT JOIN users fu ON m.from_user_id = fu.id
       LEFT JOIN sessions ts ON m.to_session_id = ts.id
       LEFT JOIN users tu ON m.to_user_id = tu.id
       WHERE m.id = ?`,
    )
    .bind(messageId)
    .first();
  return row ? rowToMailboxMessage(row) : null;
}

export async function getInboxThread(
  db: D1Database,
  threadId: string,
  userId: string,
): Promise<{ rootMessage: MailboxMessage | null; replies: MailboxMessage[] }> {
  const result = await db
    .prepare(
      `SELECT m.*,
              fs.title AS from_session_title,
              fu.name AS from_user_name,
              fu.email AS from_user_email,
              ts.title AS to_session_title,
              tu.name AS to_user_name
       FROM mailbox_messages m
       LEFT JOIN sessions fs ON m.from_session_id = fs.id
       LEFT JOIN users fu ON m.from_user_id = fu.id
       LEFT JOIN sessions ts ON m.to_session_id = ts.id
       LEFT JOIN users tu ON m.to_user_id = tu.id
       WHERE m.id = ? OR m.reply_to_id = ?
       ORDER BY m.created_at ASC`,
    )
    .bind(threadId, threadId)
    .all();

  const messages = (result.results || []).map(rowToMailboxMessage);
  const rootMessage = messages.find((m) => m.id === threadId && !m.replyToId) || null;

  // Security: user must be participant
  if (rootMessage && rootMessage.toUserId !== userId && rootMessage.fromUserId !== userId) {
    return { rootMessage: null, replies: [] };
  }

  const replies = messages.filter((m) => m.id !== threadId);
  return { rootMessage, replies };
}

export async function markInboxThreadRead(
  db: D1Database,
  threadId: string,
  userId: string,
): Promise<number> {
  const result = await db
    .prepare(
      `UPDATE mailbox_messages SET read = 1, updated_at = datetime('now')
       WHERE to_user_id = ? AND read = 0 AND (id = ? OR reply_to_id = ?)`,
    )
    .bind(userId, threadId, threadId)
    .run();
  return result.meta.changes ?? 0;
}

// ─── Notification Queue Operations ──────────────────────────────────────────

export async function isNotificationWebEnabled(
  db: D1Database,
  userId: string,
  messageType: string,
  eventType?: string,
): Promise<boolean> {
  const normalizedEventType = normalizeNotificationEventType(eventType);

  const row = await db
    .prepare(
      `SELECT web_enabled
       FROM user_notification_preferences
       WHERE user_id = ?
         AND message_type = ?
         AND event_type IN (?, '*')
       ORDER BY CASE WHEN event_type = ? THEN 0 ELSE 1 END
       LIMIT 1`,
    )
    .bind(userId, messageType, normalizedEventType, normalizedEventType)
    .first<{ web_enabled: number }>();

  // Default to enabled when no explicit preference exists.
  return row ? !!row.web_enabled : true;
}

export async function enqueueNotification(
  db: AppDb,
  data: {
    fromSessionId?: string;
    fromUserId?: string;
    toSessionId?: string;
    toUserId?: string;
    messageType?: NotificationQueueType;
    content: string;
    contextSessionId?: string;
    contextTaskId?: string;
    replyToId?: string;
  },
): Promise<NotificationQueueItem> {
  return createMailboxMessage(db, {
    ...data,
    messageType: data.messageType || 'notification',
  });
}

export async function enqueueWorkflowApprovalNotificationIfMissing(
  db: D1Database,
  data: {
    toUserId: string;
    executionId: string;
    fromSessionId?: string;
    contextSessionId?: string;
    workflowName?: string | null;
    approvalPrompt?: string | null;
  },
): Promise<boolean> {
  const approvalEnabled = await isNotificationWebEnabled(db, data.toUserId, 'approval');
  if (!approvalEnabled) {
    return false;
  }

  const workflowName = data.workflowName?.trim();
  const prompt = data.approvalPrompt?.trim();
  const workflowLabel = workflowName ? `Workflow "${workflowName}"` : 'Workflow';
  const content = prompt
    ? `${workflowLabel} is waiting for approval: ${prompt}`
    : `${workflowLabel} is waiting for approval.`;

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const result = await db.prepare(`
    INSERT INTO mailbox_messages (
      id,
      from_session_id,
      from_user_id,
      to_session_id,
      to_user_id,
      message_type,
      content,
      context_session_id,
      context_task_id,
      reply_to_id,
      read,
      created_at,
      updated_at
    )
    SELECT
      ?, ?, NULL, NULL, ?, 'approval', ?, ?, ?, NULL, 0, ?, ?
    WHERE NOT EXISTS (
      SELECT 1
      FROM mailbox_messages
      WHERE to_user_id = ?
        AND message_type = 'approval'
        AND context_task_id = ?
        AND read = 0
    )
  `).bind(
    id,
    data.fromSessionId || null,
    data.toUserId,
    content.slice(0, 10_000),
    data.contextSessionId || null,
    data.executionId,
    now,
    now,
    data.toUserId,
    data.executionId,
  ).run();

  return (result.meta.changes ?? 0) > 0;
}

export async function getSessionNotificationQueue(
  db: D1Database,
  sessionId: string,
  opts?: { unreadOnly?: boolean; limit?: number; after?: string },
): Promise<NotificationQueueItem[]> {
  return getSessionMailbox(db, sessionId, opts);
}

export async function acknowledgeSessionNotificationQueue(
  db: AppDb,
  sessionId: string,
): Promise<number> {
  return markSessionMailboxRead(db, sessionId);
}

export async function getUserNotifications(
  db: D1Database,
  userId: string,
  opts?: { unreadOnly?: boolean; messageType?: string; limit?: number; cursor?: string },
): Promise<{ messages: NotificationQueueItem[]; cursor?: string; hasMore: boolean }> {
  return getUserInbox(db, userId, opts);
}

export async function getUserNotificationCount(db: AppDb, userId: string): Promise<number> {
  return getUserInboxCount(db, userId);
}

export async function getNotificationThread(
  db: D1Database,
  threadId: string,
  userId: string,
): Promise<{ rootMessage: NotificationQueueItem | null; replies: NotificationQueueItem[] }> {
  return getInboxThread(db, threadId, userId);
}

export async function markNotificationRead(
  db: AppDb,
  messageId: string,
  userId: string,
): Promise<boolean> {
  return markInboxMessageRead(db, messageId, userId);
}

export async function markNonActionableNotificationsRead(
  db: AppDb,
  userId: string,
): Promise<number> {
  const result = await db
    .update(mailboxMessages)
    .set({
      read: true,
      updatedAt: sql`datetime('now')`,
    })
    .where(
      and(
        eq(mailboxMessages.toUserId, userId),
        eq(mailboxMessages.read, false),
        inArray(mailboxMessages.messageType, ['message', 'notification']),
      ),
    );
  return (result as any).meta?.changes ?? 0;
}

export async function markAllNotificationsRead(
  db: AppDb,
  userId: string,
): Promise<number> {
  const result = await db
    .update(mailboxMessages)
    .set({
      read: true,
      updatedAt: sql`datetime('now')`,
    })
    .where(and(eq(mailboxMessages.toUserId, userId), eq(mailboxMessages.read, false)));
  return (result as any).meta?.changes ?? 0;
}

export async function markWorkflowApprovalNotificationsRead(
  db: AppDb,
  userId: string,
  executionId: string,
): Promise<number> {
  const result = await db
    .update(mailboxMessages)
    .set({
      read: true,
      updatedAt: sql`datetime('now')`,
    })
    .where(
      and(
        eq(mailboxMessages.toUserId, userId),
        eq(mailboxMessages.read, false),
        eq(mailboxMessages.messageType, 'approval'),
        eq(mailboxMessages.contextTaskId, executionId),
      ),
    );
  return (result as any).meta?.changes ?? 0;
}

export async function markNotificationThreadRead(
  db: D1Database,
  threadId: string,
  userId: string,
): Promise<number> {
  return markInboxThreadRead(db, threadId, userId);
}

// ─── Notification Preferences ───────────────────────────────────────────────

export async function getNotificationPreferences(
  db: AppDb,
  userId: string,
): Promise<UserNotificationPreference[]> {
  const rows = await db
    .select()
    .from(userNotificationPreferences)
    .where(eq(userNotificationPreferences.userId, userId))
    .orderBy(
      userNotificationPreferences.messageType,
      sql`CASE WHEN ${userNotificationPreferences.eventType} = '*' THEN 0 ELSE 1 END`,
      userNotificationPreferences.eventType,
    );
  return rows.map(drizzleRowToPreference);
}

export async function upsertNotificationPreference(
  db: AppDb,
  userId: string,
  messageType: string,
  eventType: string | undefined,
  prefs: { webEnabled?: boolean; slackEnabled?: boolean; emailEnabled?: boolean },
): Promise<UserNotificationPreference> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const normalizedEventType = normalizeNotificationEventType(eventType);

  await db
    .insert(userNotificationPreferences)
    .values({
      id,
      userId,
      messageType,
      eventType: normalizedEventType,
      webEnabled: prefs.webEnabled !== undefined ? prefs.webEnabled : true,
      slackEnabled: prefs.slackEnabled !== undefined ? prefs.slackEnabled : false,
      emailEnabled: prefs.emailEnabled !== undefined ? prefs.emailEnabled : false,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [userNotificationPreferences.userId, userNotificationPreferences.messageType, userNotificationPreferences.eventType],
      set: {
        webEnabled: sql`COALESCE(excluded.web_enabled, ${userNotificationPreferences.webEnabled})`,
        slackEnabled: sql`COALESCE(excluded.slack_enabled, ${userNotificationPreferences.slackEnabled})`,
        emailEnabled: sql`COALESCE(excluded.email_enabled, ${userNotificationPreferences.emailEnabled})`,
        updatedAt: sql`excluded.updated_at`,
      },
    });

  const row = await db
    .select()
    .from(userNotificationPreferences)
    .where(
      and(
        eq(userNotificationPreferences.userId, userId),
        eq(userNotificationPreferences.messageType, messageType),
        eq(userNotificationPreferences.eventType, normalizedEventType),
      ),
    )
    .get();

  return drizzleRowToPreference(row!);
}
