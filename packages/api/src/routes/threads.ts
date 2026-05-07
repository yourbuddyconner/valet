import { Hono } from 'hono';
import type { D1Database } from '@cloudflare/workers-types';
import type { Env, Variables } from '../env.js';
import { NotFoundError } from '@valet/shared';
import type { AgentSession, SessionThread, SessionParticipantRole } from '@valet/shared';
import type { AppDb } from '../lib/drizzle.js';
import * as db from '../lib/db.js';

export const threadsRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

async function buildContinuationContext(dbConn: D1Database, threadId: string): Promise<string> {
  const msgResult = await dbConn
    .prepare(
      `SELECT m.role, m.content FROM messages m
       JOIN sessions s ON m.session_id = s.id
       WHERE m.thread_id = ? AND s.parent_session_id IS NULL
       ORDER BY m.created_at DESC LIMIT 20`
    )
    .bind(threadId)
    .all();

  const oldMessages = (msgResult.results || []).reverse();
  return oldMessages
    .map((row: any) => {
      const content = (row.content as string) || '';
      const truncated = content.length > 500 ? content.slice(0, 500) + '...' : content;
      return `[${row.role}]: ${truncated}`;
    })
    .join('\n');
}

function isOrchestratorSession(session: AgentSession): boolean {
  return !!session.isOrchestrator || session.purpose === 'orchestrator';
}

async function resolveRequestedSessionId(dbConn: D1Database, userId: string, requestedId: string): Promise<string> {
  if (requestedId !== 'orchestrator') return requestedId;

  const session = await db.getCurrentOrchestratorSession(dbConn, userId);
  if (!session) {
    throw new NotFoundError('Session', requestedId);
  }
  return session.id;
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
  const { cursor, limit, status, page, pageSize } = c.req.query();
  const resolvedSessionId = await resolveRequestedSessionId(c.env.DB, user.id, sessionId);

  const session = await db.assertSessionAccess(c.get('db'), resolvedSessionId, user.id, 'viewer');

  const parsedLimit = pageSize ? parseInt(pageSize, 10) : limit ? parseInt(limit, 10) : 20;
  const safeLimit = Number.isNaN(parsedLimit) ? 20 : Math.min(Math.max(parsedLimit, 1), 100);
  const parsedPage = page ? parseInt(page, 10) : undefined;
  const safePage = parsedPage && !Number.isNaN(parsedPage) ? Math.max(parsedPage, 1) : undefined;

  const result = await db.listThreads(c.env.DB, resolvedSessionId, {
    cursor,
    limit: safeLimit,
    ...(safePage ? { page: safePage, pageSize: safeLimit } : {}),
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
  const resolvedSessionId = await resolveRequestedSessionId(c.env.DB, user.id, sessionId);

  await db.assertSessionAccess(c.get('db'), resolvedSessionId, user.id, 'collaborator');

  const id = crypto.randomUUID();
  const thread = await db.createThread(c.env.DB, { id, sessionId: resolvedSessionId });

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
  const resolvedSessionId = await resolveRequestedSessionId(c.env.DB, user.id, sessionId);

  await db.assertSessionAccess(c.get('db'), resolvedSessionId, user.id, 'viewer');

  let thread = await db.getActiveThread(c.env.DB, resolvedSessionId);

  if (!thread) {
    // Auto-create a thread if none exists
    const id = crypto.randomUUID();
    thread = await db.createThread(c.env.DB, { id, sessionId: resolvedSessionId });
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
  const resolvedSessionId = await resolveRequestedSessionId(c.env.DB, user.id, sessionId);

  const session = await db.assertSessionAccess(c.get('db'), resolvedSessionId, user.id, 'viewer');

  const thread = await db.getThread(c.env.DB, threadId);
  if (!thread) {
    throw new NotFoundError('Thread', threadId);
  }

  await assertOrchestratorThreadAccess(c.get('db'), session, thread, user.id, 'viewer');

  const messages = await db.getThreadMessages(c.get('db'), threadId);

  return c.json({ thread, messages });
});

/**
 * POST /api/sessions/:sessionId/threads/:threadId/continue
 * Resume an existing thread in the active chat view.
 *
 * For orchestrator sessions, allows continuing threads from any of the
 * user's orchestrator sessions.
 */
threadsRouter.post('/:sessionId/threads/:threadId/continue', async (c) => {
  const user = c.get('user');
  const { sessionId, threadId } = c.req.param();
  const resolvedSessionId = await resolveRequestedSessionId(c.env.DB, user.id, sessionId);

  const session = await db.assertSessionAccess(c.get('db'), resolvedSessionId, user.id, 'collaborator');

  const thread = await db.getThread(c.env.DB, threadId);
  if (!thread) {
    throw new NotFoundError('Thread', threadId);
  }

  await assertOrchestratorThreadAccess(c.get('db'), session, thread, user.id, 'collaborator');
  // Always build continuation context — even if the thread has an opencodeSessionId,
  // the orchestrator may have restarted and the old OpenCode session is gone.
  const continuationContext = await buildContinuationContext(c.env.DB, threadId);

  if (thread.status === 'archived') {
    await db.updateThreadStatus(c.env.DB, threadId, 'active');
    const reactivated = await db.getThread(c.env.DB, threadId);
    return c.json({
      thread: reactivated ?? { ...thread, status: 'active' },
      resumed: true,
      ...(continuationContext ? { continuationContext } : {}),
    });
  }

  return c.json({
    thread,
    resumed: true,
    ...(continuationContext ? { continuationContext } : {}),
  });
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
  const resolvedSessionId = await resolveRequestedSessionId(c.env.DB, user.id, sessionId);

  const session = await db.assertSessionAccess(c.get('db'), resolvedSessionId, user.id, 'collaborator');

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
