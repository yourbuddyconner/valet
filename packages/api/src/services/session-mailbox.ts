import type { D1Database } from '@cloudflare/workers-types';
import type { AppDb } from '../lib/drizzle.js';
import {
  createMailboxMessage,
  getSessionMailbox,
  markSessionMailboxRead,
  getOrchestratorIdentityByHandle,
} from '../lib/db.js';

// ─── mailboxSend ─────────────────────────────────────────────────────────────

export type MailboxSendParams = {
  toSessionId?: string;
  toUserId?: string;
  toHandle?: string;
  messageType?: string;
  content: string;
  contextSessionId?: string;
  contextTaskId?: string;
  replyToId?: string;
};

export type MailboxSendResult =
  | { messageId: string; error?: undefined }
  | { error: string; messageId?: undefined };

export async function mailboxSend(
  db: AppDb,
  _envDB: D1Database,
  sessionId: string | null | undefined,
  userId: string | null | undefined,
  params: MailboxSendParams,
): Promise<MailboxSendResult> {
  let toUserId = params.toUserId;

  // Resolve @handle to userId if provided
  if (params.toHandle && !toUserId && !params.toSessionId) {
    const identity = await getOrchestratorIdentityByHandle(db, params.toHandle);
    if (!identity) {
      return { error: `Handle @${params.toHandle} not found` };
    }
    toUserId = identity.userId;
  }

  const message = await createMailboxMessage(db, {
    fromSessionId: sessionId || undefined,
    fromUserId: userId || undefined,
    toSessionId: params.toSessionId,
    toUserId,
    messageType: params.messageType,
    content: params.content,
    contextSessionId: params.contextSessionId,
    contextTaskId: params.contextTaskId,
    replyToId: params.replyToId,
  });

  return { messageId: message.id };
}

// ─── mailboxCheck ────────────────────────────────────────────────────────────

export type MailboxCheckResult =
  | { messages: Awaited<ReturnType<typeof getSessionMailbox>>; error?: undefined }
  | { error: string; messages?: undefined };

export async function mailboxCheck(
  db: AppDb,
  envDB: D1Database,
  sessionId: string | null | undefined,
  _userId: string | null | undefined,
  limit?: number,
  after?: string,
): Promise<MailboxCheckResult> {
  if (!sessionId) {
    return { error: 'No session ID' };
  }

  const messages = await getSessionMailbox(envDB, sessionId, {
    unreadOnly: true,
    limit,
    after,
  });

  // Auto-mark as read
  if (messages.length > 0) {
    await markSessionMailboxRead(db, sessionId);
  }

  return { messages };
}
