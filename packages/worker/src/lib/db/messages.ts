import type { D1Database } from '@cloudflare/workers-types';
import type { Message } from '@valet/shared';
import { eq, and, gt, asc } from 'drizzle-orm';
import type { AppDb } from '../drizzle.js';
import { toDate } from '../drizzle.js';
import { messages } from '../schema/index.js';

export async function saveMessage(
  db: D1Database,
  data: { id: string; sessionId: string; role: string; content: string; toolCalls?: unknown[]; parts?: unknown; authorId?: string; authorEmail?: string; authorName?: string; authorAvatarUrl?: string; channelType?: string; channelId?: string; opencodeSessionId?: string }
): Promise<void> {
  // INSERT OR IGNORE needs raw SQL — Drizzle doesn't support it for SQLite
  await db
    .prepare('INSERT OR IGNORE INTO messages (id, session_id, role, content, tool_calls, parts, author_id, author_email, author_name, author_avatar_url, channel_type, channel_id, opencode_session_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(data.id, data.sessionId, data.role, data.content, data.toolCalls ? JSON.stringify(data.toolCalls) : null, data.parts ? JSON.stringify(data.parts) : null, data.authorId || null, data.authorEmail || null, data.authorName || null, data.authorAvatarUrl || null, data.channelType || null, data.channelId || null, data.opencodeSessionId || null)
    .run();
}

export async function getSessionMessages(
  db: AppDb,
  sessionId: string,
  options: { limit?: number; after?: string } = {}
): Promise<Message[]> {
  const limit = options.limit || 100;

  const conditions = [eq(messages.sessionId, sessionId)];
  if (options.after) {
    conditions.push(gt(messages.createdAt, options.after));
  }

  const rows = await db
    .select()
    .from(messages)
    .where(and(...conditions))
    .orderBy(asc(messages.createdAt))
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
    createdAt: toDate(row.createdAt),
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
  }>,
): Promise<void> {
  if (msgs.length === 0) return;

  // db.batch() must use raw D1 — Drizzle doesn't wrap batch
  const stmts = msgs.map((msg) =>
    db.prepare(
      'INSERT OR REPLACE INTO messages (id, session_id, role, content, parts, author_id, author_email, author_name, author_avatar_url, channel_type, channel_id, opencode_session_id, message_format) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
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
    )
  );

  await db.batch(stmts);
}
