import { Hono } from 'hono';
import type { Env, Variables } from '../env.js';
import { NotFoundError } from '@valet/shared';
import type { Message } from '@valet/shared';
import * as db from '../lib/db.js';

export const threadsRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * GET /api/sessions/:sessionId/threads
 * List threads for a session (paginated).
 */
threadsRouter.get('/:sessionId/threads', async (c) => {
  const user = c.get('user');
  const { sessionId } = c.req.param();
  const { cursor, limit } = c.req.query();

  await db.assertSessionAccess(c.get('db'), sessionId, user.id, 'viewer');

  const parsedLimit = limit ? parseInt(limit, 10) : 20;
  const safeLimit = Number.isNaN(parsedLimit) ? 20 : Math.min(Math.max(parsedLimit, 1), 100);

  const result = await db.listThreads(c.env.DB, sessionId, {
    cursor,
    limit: safeLimit,
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
 */
threadsRouter.get('/:sessionId/threads/:threadId', async (c) => {
  const user = c.get('user');
  const { sessionId, threadId } = c.req.param();

  await db.assertSessionAccess(c.get('db'), sessionId, user.id, 'viewer');

  const thread = await db.getThread(c.env.DB, threadId);
  if (!thread || thread.sessionId !== sessionId) {
    throw new NotFoundError('Thread', threadId);
  }

  // Fetch messages for this thread using raw D1 query
  const result = await c.env.DB
    .prepare(
      'SELECT * FROM messages WHERE session_id = ? AND thread_id = ? ORDER BY created_at ASC'
    )
    .bind(sessionId, threadId)
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
 */
threadsRouter.post('/:sessionId/threads/:threadId/continue', async (c) => {
  const user = c.get('user');
  const { sessionId, threadId } = c.req.param();

  await db.assertSessionAccess(c.get('db'), sessionId, user.id, 'collaborator');

  const oldThread = await db.getThread(c.env.DB, threadId);
  if (!oldThread || oldThread.sessionId !== sessionId) {
    throw new NotFoundError('Thread', threadId);
  }

  // Fetch last ~20 messages from the old thread for continuation context
  const msgResult = await c.env.DB
    .prepare(
      'SELECT role, content FROM messages WHERE session_id = ? AND thread_id = ? ORDER BY created_at DESC LIMIT 20'
    )
    .bind(sessionId, threadId)
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
