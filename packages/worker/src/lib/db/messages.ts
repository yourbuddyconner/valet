import type { D1Database } from '@cloudflare/workers-types';
import type { Message } from '@valet/shared';
import { eq, and, gt, asc, isNull } from 'drizzle-orm';
import type { AppDb } from '../drizzle.js';
import { toDate } from '../drizzle.js';
import { messages, sessions } from '../schema/index.js';

export async function getSessionMessages(
  db: AppDb,
  sessionId: string,
  options: { limit?: number; after?: string; threadId?: string } = {}
): Promise<Message[]> {
  const limit = options.limit || 5000;

  const conditions = [eq(messages.sessionId, sessionId)];
  if (options.after) {
    conditions.push(gt(messages.createdAt, options.after));
  }
  if (options.threadId) {
    conditions.push(eq(messages.threadId, options.threadId));
  }

  const rows = await db
    .select()
    .from(messages)
    .where(and(...conditions))
    .orderBy(asc(messages.createdAtEpoch), asc(messages.createdAt))
    .limit(limit);

  return rows.map(mapMessageRow);
}

export async function getThreadMessages(
  db: AppDb,
  threadId: string,
  options: { limit?: number; after?: string } = {}
): Promise<Message[]> {
  const limit = options.limit || 5000;

  // Only include messages from orchestrator sessions (not child sessions).
  // Threads can span multiple orchestrator session rows (resumed threads),
  // but child session messages that share the same threadId should be excluded.
  const conditions = [
    eq(messages.threadId, threadId),
    isNull(sessions.parentSessionId),
  ];
  if (options.after) {
    conditions.push(gt(messages.createdAt, options.after));
  }

  const rows = await db
    .select({
      id: messages.id,
      sessionId: messages.sessionId,
      role: messages.role,
      content: messages.content,
      parts: messages.parts,
      authorId: messages.authorId,
      authorEmail: messages.authorEmail,
      authorName: messages.authorName,
      authorAvatarUrl: messages.authorAvatarUrl,
      channelType: messages.channelType,
      channelId: messages.channelId,
      opencodeSessionId: messages.opencodeSessionId,
      threadId: messages.threadId,
      createdAt: messages.createdAt,
      createdAtEpoch: messages.createdAtEpoch,
      workflowExecutionId: messages.workflowExecutionId,
      workflowStepId: messages.workflowStepId,
      workflowIterationPath: messages.workflowIterationPath,
    })
    .from(messages)
    .innerJoin(sessions, eq(messages.sessionId, sessions.id))
    .where(and(...conditions))
    .orderBy(asc(messages.createdAtEpoch), asc(messages.createdAt))
    .limit(limit);

  return rows.map(mapMessageRow);
}

/**
 * Map a messages row to the shared Message type. Tolerates rows that lack the
 * workflow back-pointer columns (older selects) via optional access.
 */
function mapMessageRow(row: {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  parts: unknown;
  authorId: string | null;
  authorEmail: string | null;
  authorName: string | null;
  authorAvatarUrl: string | null;
  channelType: string | null;
  channelId: string | null;
  opencodeSessionId: string | null;
  threadId: string | null;
  createdAt: string | null;
  workflowExecutionId?: string | null;
  workflowStepId?: string | null;
  workflowIterationPath?: string | null;
}): Message {
  return {
    id: row.id,
    sessionId: row.sessionId,
    role: row.role as Message['role'],
    content: row.content,
    parts: row.parts as Message['parts'],
    authorId: row.authorId || undefined,
    authorEmail: row.authorEmail || undefined,
    authorName: row.authorName || undefined,
    authorAvatarUrl: row.authorAvatarUrl || undefined,
    channelType: row.channelType || undefined,
    channelId: row.channelId || undefined,
    opencodeSessionId: row.opencodeSessionId || undefined,
    threadId: row.threadId || undefined,
    createdAt: toDate(row.createdAt),
    workflowExecutionId: row.workflowExecutionId || undefined,
    workflowStepId: row.workflowStepId || undefined,
    workflowIterationPath: row.workflowIterationPath ?? undefined,
  };
}

export async function batchUpsertMessages(
  db: D1Database,
  sessionId: string,
  msgs: Array<{
    id: string;
    role: string;
    content: string;
    parts: string | null;
    authorId: string | null;
    authorEmail: string | null;
    authorName: string | null;
    authorAvatarUrl: string | null;
    channelType: string | null;
    channelId: string | null;
    opencodeSessionId: string | null;
    messageFormat: string;
    threadId?: string | null;
    createdAt?: number;
    workflowExecutionId?: string | null;
    workflowStepId?: string | null;
    workflowIterationPath?: string | null;
  }>,
): Promise<void> {
  if (msgs.length === 0) return;

  // db.batch() must use raw D1 — Drizzle doesn't wrap batch.
  // Use ON CONFLICT ... DO UPDATE to preserve existing created_at and tool_calls
  // columns (INSERT OR REPLACE deletes then re-inserts, destroying defaults).
  const stmts = msgs.map((msg) =>
    db.prepare(
      `INSERT INTO messages (id, session_id, role, content, parts, author_id, author_email, author_name, author_avatar_url, channel_type, channel_id, opencode_session_id, message_format, thread_id, created_at_epoch, workflow_execution_id, workflow_step_id, workflow_iteration_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         role = excluded.role,
         content = excluded.content,
         parts = excluded.parts,
         author_id = excluded.author_id,
         author_email = excluded.author_email,
         author_name = excluded.author_name,
         author_avatar_url = excluded.author_avatar_url,
         channel_type = excluded.channel_type,
         channel_id = excluded.channel_id,
         opencode_session_id = excluded.opencode_session_id,
         message_format = excluded.message_format,
         thread_id = excluded.thread_id,
         created_at_epoch = excluded.created_at_epoch,
         workflow_execution_id = excluded.workflow_execution_id,
         workflow_step_id = excluded.workflow_step_id,
         workflow_iteration_path = excluded.workflow_iteration_path`
    ).bind(
      msg.id,
      sessionId,
      msg.role,
      msg.content,
      msg.parts,
      msg.authorId,
      msg.authorEmail,
      msg.authorName,
      msg.authorAvatarUrl,
      msg.channelType,
      msg.channelId,
      msg.opencodeSessionId,
      msg.messageFormat || 'v2',
      msg.threadId || null,
      msg.createdAt || null,
      msg.workflowExecutionId || null,
      msg.workflowStepId || null,
      msg.workflowIterationPath || null,
    )
  );

  await db.batch(stmts);
}
