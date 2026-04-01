import { Hono } from 'hono';
import type { Env, Variables } from '../env.js';
import { NotFoundError } from '@valet/shared';
import type { Message, AgentSession, SessionThread, SessionParticipantRole } from '@valet/shared';
import type { AppDb } from '../lib/drizzle.js';
import * as db from '../lib/db.js';

export const threadsRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

function isOrchestratorSession(session: AgentSession): boolean {
  return !!session.isOrchestrator || session.purpose === 'orchestrator';
}

/**
 * For orchestrator sessions, verify that a thread from a different (rotated)
 * orchestrator session is still owned by the same user. Throws NotFoundError
 * if the cross-session access is not permitted.
 */
async function assertOrchestratorThreadAccess(
  appDb: AppDb,
  session: AgentSession,
  thread: SessionThread,
  userId: string,
  role: SessionParticipantRole,
): Promise<void> {
  if (thread.sessionId === session.id) return;
  if (!isOrchestratorSession(session)) {
    throw new NotFoundError('Thread', thread.id);
  }
  const threadSession = await db.assertSessionAccess(appDb, thread.sessionId, userId, role);
  if (!isOrchestratorSession(threadSession)) {
    throw new NotFoundError('Thread', thread.id);
  }
}

/**
 * GET /api/sessions/:sessionId/threads
 * List threads for a session (paginated).
 *
 * For orchestrator sessions, returns threads across ALL of the user's
 * orchestrator sessions so history survives session rotation/hibernation.
 */
threadsRouter.get('/:sessionId/threads', async (c) => {
  const user = c.get('user');
  const { sessionId } = c.req.param();
  const { cursor, limit, status } = c.req.query();

  const session = await db.assertSessionAccess(c.get('db'), sessionId, user.id, 'viewer');

  const parsedLimit = limit ? parseInt(limit, 10) : 20;
  const safeLimit = Number.isNaN(parsedLimit) ? 20 : Math.min(Math.max(parsedLimit, 1), 100);

  const result = await db.listThreads(c.env.DB, sessionId, {
    cursor,
    limit: safeLimit,
    status,
    userId: isOrchestratorSession(session) ? user.id : undefined,
  });

  return c.json(result);
});

/**
 * POST /api/sessions/:sessionId/threads
 * Create a new thread.
 */
threadsRouter.post('/:sessionId/threads', async (c) => {
  const user = c.get('user');
  const { sessionId } = c.req.param();

  await db.assertSessionAccess(c.get('db'), sessionId, user.id, 'collaborator');

  const id = crypto.randomUUID();
  const thread = await db.createThread(c.env.DB, { id, sessionId });

  return c.json(thread, 201);
});

/**
 * GET /api/sessions/:sessionId/threads/active
 * Get the current active thread, or create one if none exists.
 * This is the primary entry point for channel adapters routing messages.
 */
threadsRouter.get('/:sessionId/threads/active', async (c) => {
  const user = c.get('user');
  const { sessionId } = c.req.param();

  await db.assertSessionAccess(c.get('db'), sessionId, user.id, 'viewer');

  let thread = await db.getActiveThread(c.env.DB, sessionId);

  if (!thread) {
    // Auto-create a thread if none exists
    const id = crypto.randomUUID();
    thread = await db.createThread(c.env.DB, { id, sessionId });
  }

  return c.json({ thread });
});

/**
 * GET /api/sessions/:sessionId/threads/:threadId
 * Get thread detail with messages.
 *
 * For orchestrator sessions, allows viewing threads that belong to any
 * of the user's orchestrator sessions (not just the current one).
 */
threadsRouter.get('/:sessionId/threads/:threadId', async (c) => {
  const user = c.get('user');
  const { sessionId, threadId } = c.req.param();

  const session = await db.assertSessionAccess(c.get('db'), sessionId, user.id, 'viewer');

  const thread = await db.getThread(c.env.DB, threadId);
  if (!thread) {
    throw new NotFoundError('Thread', threadId);
  }

  await assertOrchestratorThreadAccess(c.get('db'), session, thread, user.id, 'viewer');

  // Fetch messages using the thread's actual session ID (may differ from the URL param)
  const result = await c.env.DB
    .prepare(
      'SELECT * FROM messages WHERE session_id = ? AND thread_id = ? ORDER BY created_at_epoch ASC, created_at ASC'
    )
    .bind(thread.sessionId, threadId)
    .all();

  const messages: Message[] = (result.results || []).map((row: any) => ({
    id: row.id,
    sessionId: row.session_id,
    role: row.role as Message['role'],
    content: row.content,
    parts: row.parts ? JSON.parse(row.parts) : undefined,
    authorId: row.author_id || undefined,
    authorEmail: row.author_email || undefined,
    authorName: row.author_name || undefined,
    authorAvatarUrl: row.author_avatar_url || undefined,
    channelType: row.channel_type || undefined,
    channelId: row.channel_id || undefined,
    opencodeSessionId: row.opencode_session_id || undefined,
    createdAt: new Date(row.created_at),
  }));

  return c.json({ thread, messages });
});

/**
 * POST /api/sessions/:sessionId/threads/:threadId/continue
 * Create a new thread as a continuation of an old one.
 *
 * For orchestrator sessions, allows continuing threads from any of the
 * user's orchestrator sessions.
 */
threadsRouter.post('/:sessionId/threads/:threadId/continue', async (c) => {
  const user = c.get('user');
  const { sessionId, threadId } = c.req.param();

  const session = await db.assertSessionAccess(c.get('db'), sessionId, user.id, 'collaborator');

  const oldThread = await db.getThread(c.env.DB, threadId);
  if (!oldThread) {
    throw new NotFoundError('Thread', threadId);
  }

  await assertOrchestratorThreadAccess(c.get('db'), session, oldThread, user.id, 'collaborator');

  // Fetch last ~20 messages from the old thread for continuation context
  // (use the thread's actual session ID)
  const msgResult = await c.env.DB
    .prepare(
      'SELECT role, content FROM messages WHERE session_id = ? AND thread_id = ? ORDER BY created_at DESC LIMIT 20'
    )
    .bind(oldThread.sessionId, threadId)
    .all();

  const oldMessages = (msgResult.results || []).reverse();
  const continuationContext = oldMessages
    .map((row: any) => {
      const content = (row.content as string) || '';
      const truncated = content.length > 500 ? content.slice(0, 500) + '...' : content;
      return `[${row.role}]: ${truncated}`;
    })
    .join('\n');

  const id = crypto.randomUUID();
  const thread = await db.createThread(c.env.DB, { id, sessionId });

  return c.json({ thread, continuationContext }, 201);
});

/**
 * PATCH /api/sessions/:sessionId/threads/:threadId
 * Update thread status (active/archived).
 *
 * For orchestrator sessions, allows updating threads from any of the
 * user's orchestrator sessions.
 */
threadsRouter.patch('/:sessionId/threads/:threadId', async (c) => {
  const user = c.get('user');
  const { sessionId, threadId } = c.req.param();

  const session = await db.assertSessionAccess(c.get('db'), sessionId, user.id, 'collaborator');

  const thread = await db.getThread(c.env.DB, threadId);
  if (!thread) {
    throw new NotFoundError('Thread', threadId);
  }

  await assertOrchestratorThreadAccess(c.get('db'), session, thread, user.id, 'collaborator');

  const body = await c.req.json<{ status?: 'active' | 'archived' }>();
  if (body.status && !['active', 'archived'].includes(body.status)) {
    return c.json({ error: 'Invalid status' }, 400);
  }

  if (body.status) {
    await db.updateThreadStatus(c.env.DB, threadId, body.status);
  }

  const updated = await db.getThread(c.env.DB, threadId);
  return c.json({ thread: updated });
});
