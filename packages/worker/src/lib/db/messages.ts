import type { D1Database } from '@cloudflare/workers-types';
import type { Message } from '@valet/shared';
import { eq, and, gt, asc, isNull, sql } from 'drizzle-orm';
import type { AppDb } from '../drizzle.js';
import { toDate } from '../drizzle.js';
import { messages, sessions } from '../schema/index.js';

function parseCursorEpochSeconds(value: string): number | null {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;

  const parsedMs = Date.parse(value);
  if (Number.isFinite(parsedMs)) return Math.floor(parsedMs / 1000);

  return null;
}

function formatEpochSecondsForSqlite(epochSeconds: number | null | undefined): string | null {
  if (typeof epochSeconds !== 'number' || !Number.isFinite(epochSeconds)) return null;
  return new Date(epochSeconds * 1000).toISOString().replace('T', ' ').slice(0, 19);
}

function messageCreatedAt(createdAt: string | null | undefined, createdAtEpoch: number | null | undefined): Date {
  if (typeof createdAtEpoch === 'number' && Number.isFinite(createdAtEpoch)) {
    return new Date(createdAtEpoch * 1000);
  }
  return toDate(createdAt);
}

function messageCreatedAtEpochExpr() {
  return sql<number>`COALESCE(${messages.createdAtEpoch}, CAST(strftime('%s', ${messages.createdAt}) AS INTEGER))`;
}

function afterMessageCreatedAtCondition(after: string) {
  const afterEpoch = parseCursorEpochSeconds(after);
  if (afterEpoch === null) {
    return gt(messages.createdAt, after);
  }

  return gt(messageCreatedAtEpochExpr(), afterEpoch);
}

export async function getSessionMessages(
  db: AppDb,
  sessionId: string,
  options: { limit?: number; after?: string; threadId?: string } = {}
): Promise<Message[]> {
  const limit = options.limit || 5000;

  const conditions = [eq(messages.sessionId, sessionId)];
  if (options.after) {
    const afterCondition = afterMessageCreatedAtCondition(options.after);
    if (afterCondition) conditions.push(afterCondition);
  }
  if (options.threadId) {
    conditions.push(eq(messages.threadId, options.threadId));
  }

  const rows = await db
    .select()
    .from(messages)
    .where(and(...conditions))
    .orderBy(asc(messageCreatedAtEpochExpr()), asc(messages.createdAt), asc(messages.id))
    .limit(limit);

  return rows.map((row): Message => ({
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
    createdAt: messageCreatedAt(row.createdAt, row.createdAtEpoch),
  }));
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
    const afterCondition = afterMessageCreatedAtCondition(options.after);
    if (afterCondition) conditions.push(afterCondition);
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
    })
    .from(messages)
    .innerJoin(sessions, eq(messages.sessionId, sessions.id))
    .where(and(...conditions))
    .orderBy(asc(messageCreatedAtEpochExpr()), asc(messages.createdAt), asc(messages.id))
    .limit(limit);

  return rows.map((row): Message => ({
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
    createdAt: messageCreatedAt(row.createdAt, row.createdAtEpoch),
  }));
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
  }>,
): Promise<void> {
  if (msgs.length === 0) return;

  // db.batch() must use raw D1 — Drizzle doesn't wrap batch.
  // Use ON CONFLICT ... DO UPDATE to preserve existing created_at and tool_calls
  // columns (INSERT OR REPLACE deletes then re-inserts, destroying defaults).
  const SQL = `INSERT INTO messages (id, session_id, role, content, parts, author_id, author_email, author_name, author_avatar_url, channel_type, channel_id, opencode_session_id, message_format, thread_id, created_at_epoch, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))
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
         created_at = CASE
           WHEN excluded.created_at_epoch IS NOT NULL THEN excluded.created_at
           ELSE messages.created_at
         END`;

  const bindArgs = (msg: (typeof msgs)[number]) => [
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
    msg.createdAt ?? null,
    formatEpochSecondsForSqlite(msg.createdAt),
  ] as const;

  const stmts = msgs.map((msg) => db.prepare(SQL).bind(...bindArgs(msg)));

  try {
    await db.batch(stmts);
  } catch (batchErr) {
    // If the whole batch fails with a FK constraint error, one bad message reference
    // (e.g. a thread_id or author_id pointing to a since-deleted row) poisons the batch
    // forever since the watermark never advances. Fall back to inserting one at a time
    // so good messages land in D1 and the bad one is logged and skipped.
    if (!String(batchErr).includes('FOREIGN KEY')) throw batchErr;
    console.error('[batchUpsertMessages] Batch FK failure — falling back to individual inserts:', batchErr);
    for (const msg of msgs) {
      try {
        await db.prepare(SQL).bind(...bindArgs(msg)).run();
      } catch (singleErr) {
        if (!String(singleErr).includes('FOREIGN KEY')) throw singleErr;
        console.error(
          `[batchUpsertMessages] Skipping message ${msg.id} (session=${sessionId}) — FK violation: ` +
          `thread_id=${msg.threadId ?? 'null'} author_id=${msg.authorId ?? 'null'} role=${msg.role}`,
          singleErr,
        );
      }
    }
  }
}
