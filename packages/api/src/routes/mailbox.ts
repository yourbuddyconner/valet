import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import type { Env, Variables } from '../env.js';
import * as db from '../lib/db.js';
import { getDb } from '../lib/drizzle.js';

export const notificationQueueRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

// ─── Validation Schemas ──────────────────────────────────────────────────

const emitNotificationSchema = z.object({
  fromSessionId: z.string().optional(),
  fromUserId: z.string().optional(),
  toSessionId: z.string().optional(),
  toUserId: z.string().optional(),
  toHandle: z.string().optional(),
  messageType: z.enum(['notification', 'question', 'escalation', 'approval']).optional(),
  content: z.string().min(1).max(10000),
  contextSessionId: z.string().optional(),
  contextTaskId: z.string().optional(),
  replyToId: z.string().optional(),
});

async function resolveTargetUserId(
  env: Env,
  body: { toUserId?: string; toHandle?: string; toSessionId?: string },
): Promise<{ toUserId?: string; error?: string }> {
  let toUserId = body.toUserId;
  if (body.toHandle && !toUserId && !body.toSessionId) {
    const identity = await db.getOrchestratorIdentityByHandle(getDb(env.DB), body.toHandle);
    if (!identity) {
      return { error: `Handle @${body.toHandle} not found` };
    }
    toUserId = identity.userId;
  }
  return { toUserId };
}

async function listSessionNotifications(c: Context<{ Bindings: Env; Variables: Variables }>) {
  const { sessionId } = c.req.param();
  const unreadOnly = c.req.query('unreadOnly') === 'true';
  const limitRaw = c.req.query('limit');
  const limit = limitRaw ? parseInt(limitRaw, 10) : undefined;
  const after = c.req.query('after') || undefined;

  const messages = await db.getSessionNotificationQueue(c.env.DB, sessionId, {
    unreadOnly,
    limit,
    after,
  });
  return c.json({ messages });
}

async function markSessionNotificationsRead(c: Context<{ Bindings: Env; Variables: Variables }>) {
  const { sessionId } = c.req.param();
  const count = await db.acknowledgeSessionNotificationQueue(c.get('db'), sessionId);
  return c.json({ success: true, count });
}

// ─── Notification Queue Routes ──────────────────────────────────────────

/**
 * GET /api/sessions/:sessionId/notifications
 * Get queued notifications/messages for a session.
 */
notificationQueueRouter.get('/sessions/:sessionId/notifications', listSessionNotifications);

/**
 * POST /api/notifications/emit
 * Emit a notification into the persistent queue.
 */
notificationQueueRouter.post('/notifications/emit', zValidator('json', emitNotificationSchema), async (c) => {
  const body = c.req.valid('json');
  const resolved = await resolveTargetUserId(c.env, body);
  if (resolved.error) {
    return c.json({ error: resolved.error }, 404);
  }

  if (!body.toSessionId && !resolved.toUserId) {
    return c.json({ error: 'Must specify toSessionId, toUserId, or toHandle' }, 400);
  }

  const notification = await db.enqueueNotification(c.get('db'), {
    fromSessionId: body.fromSessionId,
    fromUserId: body.fromUserId,
    toSessionId: body.toSessionId,
    toUserId: resolved.toUserId,
    messageType: body.messageType,
    content: body.content,
    contextSessionId: body.contextSessionId,
    contextTaskId: body.contextTaskId,
    replyToId: body.replyToId,
  });

  return c.json({ notification }, 201);
});

/**
 * PUT /api/sessions/:sessionId/notifications/read
 * Mark all session queue items as read.
 */
notificationQueueRouter.put('/sessions/:sessionId/notifications/read', markSessionNotificationsRead);
