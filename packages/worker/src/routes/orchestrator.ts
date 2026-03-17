import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import type { Env, Variables } from '../env.js';
import * as db from '../lib/db.js';
import * as orchestratorService from '../services/orchestrator.js';

// Re-export for backward compatibility (used by index.ts cron handler)
export { restartOrchestratorSession } from '../services/orchestrator.js';

const createIdentityLinkSchema = z.object({
  provider: z.string().min(1).max(50),
  externalId: z.string().min(1).max(255),
  externalName: z.string().max(255).optional(),
  teamId: z.string().max(255).optional(),
});

export const orchestratorRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

// ─── Validation Schemas ──────────────────────────────────────────────────

const createOrchestratorSchema = z.object({
  name: z.string().min(1).max(100),
  handle: z.string().min(1).max(50).regex(/^[a-z0-9_-]+$/, 'Handle must be lowercase alphanumeric with dashes/underscores'),
  avatar: z.string().max(500).optional(),
  customInstructions: z.string().max(10000).optional(),
});

const updateIdentitySchema = z.object({
  name: z.string().min(1).max(100).optional(),
  handle: z.string().min(1).max(50).regex(/^[a-z0-9_-]+$/).optional(),
  avatar: z.string().max(500).optional(),
  customInstructions: z.string().max(10000).optional(),
});

const writeMemorySchema = z.object({
  path: z.string().min(1).max(256),
  content: z.string().min(1).max(50000),
});

const patchMemorySchema = z.object({
  path: z.string().min(1).max(256),
  operations: z.array(z.union([
    z.object({ op: z.literal('append'), content: z.string() }),
    z.object({ op: z.literal('prepend'), content: z.string() }),
    z.object({ op: z.literal('replace'), old: z.string(), new: z.string() }),
    z.object({ op: z.literal('replace_all'), old: z.string(), new: z.string() }),
    z.object({ op: z.literal('insert_after'), anchor: z.string(), content: z.string() }),
    z.object({ op: z.literal('delete_section'), heading: z.string() }),
  ])).min(1).max(20),
});

// ─── Orchestrator Routes ────────────────────────────────────────────────

/**
 * GET /api/me/orchestrator
 * Returns orchestrator info for the current user.
 */
orchestratorRouter.get('/orchestrator', async (c) => {
  const user = c.get('user');

  const info = await orchestratorService.getOrchestratorInfo(c.env, user.id);
  return c.json(info);
});

/**
 * POST /api/me/orchestrator
 * Onboarding: creates identity + session + DO.
 */
orchestratorRouter.post('/orchestrator', zValidator('json', createOrchestratorSchema), async (c) => {
  const user = c.get('user');
  const body = c.req.valid('json');

  const result = await orchestratorService.onboardOrchestrator(
    c.env,
    user.id,
    user.email,
    body,
    c.req.url,
  );

  if (!result.ok) {
    if (result.reason === 'already_exists') {
      return c.json({ error: 'Orchestrator already exists' }, 409);
    }
    if (result.reason === 'handle_taken') {
      return c.json({ error: 'Handle already taken' }, 409);
    }
    if (result.reason === 'name_taken') {
      return c.json({ error: 'Name already taken' }, 409);
    }
  }

  if (result.ok) {
    return c.json({ sessionId: result.sessionId, identity: result.identity, session: result.session }, 201);
  }

  // Should not reach here but satisfy TypeScript
  return c.json({ error: 'Unknown error' }, 500);
});

/**
 * GET /api/me/orchestrator/identity
 */
orchestratorRouter.get('/orchestrator/identity', async (c) => {
  const user = c.get('user');
  const identity = await db.getOrchestratorIdentity(c.get('db'), user.id);
  if (!identity) {
    return c.json({ error: 'Orchestrator not set up' }, 404);
  }
  return c.json({ identity });
});

/**
 * PUT /api/me/orchestrator/identity
 */
orchestratorRouter.put('/orchestrator/identity', zValidator('json', updateIdentitySchema), async (c) => {
  const user = c.get('user');
  const body = c.req.valid('json');

  const result = await orchestratorService.updateOrchestratorIdentity(c.get('db'), user.id, body);
  if (!result.ok) {
    if (result.error === 'not_found') {
      return c.json({ error: 'Orchestrator not set up' }, 404);
    }
    if (result.error === 'handle_taken') {
      return c.json({ error: 'Handle already taken' }, 409);
    }
    if (result.error === 'name_taken') {
      return c.json({ error: 'Name already taken' }, 409);
    }
  }

  if (result.ok) {
    return c.json({ identity: result.identity });
  }

  return c.json({ error: 'Unknown error' }, 500);
});

/**
 * GET /api/me/orchestrator/check-handle?handle=foo
 */
orchestratorRouter.get('/orchestrator/check-handle', async (c) => {
  const handle = c.req.query('handle');
  if (!handle) {
    return c.json({ error: 'handle query param required' }, 400);
  }
  const existing = await db.getOrchestratorIdentityByHandle(c.get('db'), handle);
  const user = c.get('user');
  const available = !existing || existing.userId === user.id;
  return c.json({ available, handle });
});

/**
 * GET /api/me/orchestrator/check-name?name=foo
 * Checks if an orchestrator display name is already in use (case-insensitive).
 */
orchestratorRouter.get('/orchestrator/check-name', async (c) => {
  const name = c.req.query('name');
  if (!name) {
    return c.json({ error: 'name query param required' }, 400);
  }
  const existing = await db.getOrchestratorIdentityByName(c.get('db'), name);
  const user = c.get('user');
  const available = !existing || existing.userId === user.id;
  return c.json({ available, name });
});

// ─── Memory File Routes ─────────────────────────────────────────────────

/**
 * GET /api/me/memory?path=...
 * If path ends with '/' or is empty → directory listing
 * If path is a file → read file content
 */
orchestratorRouter.get('/memory', async (c) => {
  const user = c.get('user');
  const path = c.req.query('path') || '';

  if (!path || path.endsWith('/')) {
    const files = await db.listMemoryFiles(c.get('db'), user.id, path);
    return c.json({ files });
  }

  const file = await db.readMemoryFile(c.get('db'), user.id, path);
  if (!file) {
    return c.json({ file: null, content: '' });
  }

  // Boost relevance on read
  db.boostMemoryFileRelevance(c.get('db'), user.id, path).catch(() => {});

  return c.json({ file });
});

/**
 * PUT /api/me/memory — create or overwrite a file
 */
orchestratorRouter.put('/memory', zValidator('json', writeMemorySchema), async (c) => {
  const user = c.get('user');
  const body = c.req.valid('json');

  const file = await db.writeMemoryFile(c.env.DB, user.id, body.path, body.content);
  return c.json({ file }, 201);
});

/**
 * PATCH /api/me/memory — surgical edits to a file
 */
orchestratorRouter.patch('/memory', zValidator('json', patchMemorySchema), async (c) => {
  const user = c.get('user');
  const body = c.req.valid('json');

  const result = await db.patchMemoryFile(c.env.DB, user.id, body.path, body.operations);
  return c.json({ result });
});

/**
 * DELETE /api/me/memory?path=...
 * If path ends with '/' → delete all files under that prefix
 * If path is a file → delete that single file
 */
orchestratorRouter.delete('/memory', async (c) => {
  const user = c.get('user');
  const path = c.req.query('path');
  if (!path) {
    return c.json({ error: 'path query param required' }, 400);
  }

  let deleted: number;
  if (path.endsWith('/')) {
    deleted = await db.deleteMemoryFilesUnderPath(c.env.DB, user.id, path);
  } else {
    deleted = await db.deleteMemoryFile(c.env.DB, user.id, path);
  }

  return c.json({ success: deleted > 0, deleted });
});

/**
 * GET /api/me/memory/search?query=...&path=...
 */
orchestratorRouter.get('/memory/search', async (c) => {
  const user = c.get('user');
  const query = c.req.query('query');
  const path = c.req.query('path') || undefined;

  if (!query) {
    return c.json({ error: 'query param required' }, 400);
  }

  const results = await db.searchMemoryFiles(c.env.DB, user.id, query, path);
  return c.json({ results });
});

// ─── Notification Queue Routes (Phase C) ────────────────────────────────

async function listNotifications(c: Context<{ Bindings: Env; Variables: Variables }>) {
  const user = c.get('user');
  const unreadOnly = c.req.query('unreadOnly') === 'true';
  const messageType = c.req.query('messageType') || undefined;
  const limitRaw = c.req.query('limit');
  const limit = limitRaw ? parseInt(limitRaw, 10) : undefined;
  const cursor = c.req.query('cursor') || undefined;

  const result = await db.getUserNotifications(c.env.DB, user.id, {
    unreadOnly,
    messageType,
    limit,
    cursor,
  });
  return c.json(result);
}

async function getNotificationCount(c: Context<{ Bindings: Env; Variables: Variables }>) {
  const user = c.get('user');
  const count = await db.getUserNotificationCount(c.get('db'), user.id);
  return c.json({ count });
}

async function getNotificationThread(c: Context<{ Bindings: Env; Variables: Variables }>) {
  const user = c.get('user');
  const { threadId } = c.req.param();

  const thread = await db.getNotificationThread(c.env.DB, threadId, user.id);
  if (!thread.rootMessage) {
    return c.json({ error: 'Thread not found' }, 404);
  }

  await db.markNotificationThreadRead(c.env.DB, threadId, user.id);

  return c.json({
    rootMessage: thread.rootMessage,
    replies: thread.replies,
    totalCount: 1 + thread.replies.length,
  });
}

async function markNotificationRead(c: Context<{ Bindings: Env; Variables: Variables }>) {
  const user = c.get('user');
  const { messageId } = c.req.param();

  const success = await db.markNotificationRead(c.get('db'), messageId, user.id);
  if (!success) {
    return c.json({ error: 'Message not found or already read' }, 404);
  }
  return c.json({ success: true });
}

async function replyToNotification(c: Context<{ Bindings: Env; Variables: Variables }>) {
  const user = c.get('user');
  const { messageId } = c.req.param();
  const body = await c.req.json<{ content: string }>();

  if (!body.content?.trim()) {
    return c.json({ error: 'content is required' }, 400);
  }

  const original = await db.getMailboxMessage(c.env.DB, messageId);
  if (!original) {
    return c.json({ error: 'Message not found' }, 404);
  }

  const threadRootId = original.replyToId || original.id;
  const rootMessage = original.replyToId
    ? await db.getMailboxMessage(c.env.DB, threadRootId)
    : original;
  if (!rootMessage) {
    return c.json({ error: 'Thread not found' }, 404);
  }

  if (rootMessage.toUserId !== user.id && rootMessage.fromUserId !== user.id) {
    return c.json({ error: 'Message not found' }, 404);
  }

  const isRecipient = rootMessage.toUserId === user.id;
  const reply = await db.enqueueNotification(c.get('db'), {
    fromUserId: user.id,
    toSessionId: isRecipient ? rootMessage.fromSessionId : rootMessage.toSessionId,
    toUserId: isRecipient ? rootMessage.fromUserId : rootMessage.toUserId,
    messageType: rootMessage.messageType,
    content: body.content,
    contextSessionId: rootMessage.contextSessionId,
    contextTaskId: rootMessage.contextTaskId,
    replyToId: threadRootId,
  });

  return c.json({ message: reply }, 201);
}

orchestratorRouter.get('/notifications', listNotifications);
orchestratorRouter.get('/notifications/count', getNotificationCount);
orchestratorRouter.get('/notifications/threads/:threadId', getNotificationThread);
orchestratorRouter.put('/notifications/:messageId/read', markNotificationRead);

orchestratorRouter.put('/notifications/read-non-actionable', async (c) => {
  const user = c.get('user');
  const count = await db.markNonActionableNotificationsRead(c.get('db'), user.id);
  return c.json({ success: true, count });
});

orchestratorRouter.put('/notifications/read-all', async (c) => {
  const user = c.get('user');
  const count = await db.markAllNotificationsRead(c.get('db'), user.id);
  return c.json({ success: true, count });
});

orchestratorRouter.post('/notifications/:messageId/reply', replyToNotification);

// ─── Notification Preferences Routes (Phase C) ─────────────────────────

orchestratorRouter.get('/notification-preferences', async (c) => {
  const user = c.get('user');
  const preferences = await db.getNotificationPreferences(c.get('db'), user.id);
  return c.json({ preferences });
});

orchestratorRouter.put('/notification-preferences', async (c) => {
  const user = c.get('user');
  const body = await c.req.json<{
    messageType: string;
    eventType?: string;
    webEnabled?: boolean;
    slackEnabled?: boolean;
    emailEnabled?: boolean;
  }>();

  if (!body.messageType) {
    return c.json({ error: 'messageType is required' }, 400);
  }

  const pref = await db.upsertNotificationPreference(c.get('db'), user.id, body.messageType, body.eventType, {
    webEnabled: body.webEnabled,
    slackEnabled: body.slackEnabled,
    emailEnabled: body.emailEnabled,
  });

  return c.json({ preference: pref });
});

// ─── Org Directory Routes (Phase C) ────────────────────────────────────

orchestratorRouter.get('/org-agents', async (c) => {
  try {
    const orgSettings = await db.getOrgSettings(c.get('db'));
    const agents = await db.getOrgAgents(c.get('db'), orgSettings.id);
    return c.json({ agents });
  } catch {
    return c.json({ agents: [] });
  }
});

// ─── Avatar Upload ──────────────────────────────────────────────────────

const MAX_AVATAR_SIZE = 2 * 1024 * 1024; // 2 MB
const ALLOWED_AVATAR_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/**
 * POST /api/me/orchestrator/avatar
 * Upload a profile picture. Accepts multipart form data with a `file` field.
 * Stores in R2 and updates the identity's avatar URL.
 */
orchestratorRouter.post('/orchestrator/avatar', async (c) => {
  const user = c.get('user');

  const formData = await c.req.formData();
  const file = formData.get('file');

  if (!file || typeof file === 'string') {
    return c.json({ error: 'file field is required' }, 400);
  }

  const blob = file as unknown as { type: string; size: number; name: string; stream(): ReadableStream; arrayBuffer(): Promise<ArrayBuffer> };

  if (!ALLOWED_AVATAR_TYPES.has(blob.type)) {
    return c.json({ error: 'File must be PNG, JPEG, GIF, or WebP' }, 400);
  }

  if (blob.size > MAX_AVATAR_SIZE) {
    return c.json({ error: 'File must be under 2 MB' }, 400);
  }

  // Store in R2
  const ext = blob.name?.split('.').pop() || 'png';
  const r2Key = `avatars/${user.id}/${Date.now()}.${ext}`;

  await c.env.STORAGE.put(r2Key, blob.stream(), {
    httpMetadata: { contentType: blob.type },
  });

  // Build the public URL: route is /avatars/:userId/:key, R2 key is avatars/:userId/:key
  const workerUrl = new URL(c.req.url).origin;
  const filename = r2Key.split('/').pop()!;
  const avatarUrl = `${workerUrl}/avatars/${user.id}/${filename}`;

  // Update the identity record
  const result = await orchestratorService.updateOrchestratorIdentity(c.get('db'), user.id, { avatar: avatarUrl });
  if (!result.ok) {
    return c.json({ error: 'Failed to update identity' }, 500);
  }

  return c.json({ avatar: avatarUrl, identity: result.identity });
});

/**
 * DELETE /api/me/orchestrator/avatar
 * Remove the orchestrator's avatar.
 */
orchestratorRouter.delete('/orchestrator/avatar', async (c) => {
  const user = c.get('user');

  const identity = await db.getOrchestratorIdentity(c.get('db'), user.id);
  if (!identity?.avatar) {
    return c.json({ success: true });
  }

  // Delete from R2 if it's our avatar
  // URL path is /avatars/{userId}/{key}, R2 key is avatars/{userId}/{key}
  try {
    const url = new URL(identity.avatar);
    const pathParts = url.pathname.replace(/^\/avatars\//, '').split('/');
    // pathParts = [userId, filename] or [avatars, userId, filename] (legacy double-prefix)
    const r2Key = pathParts[0] === 'avatars'
      ? pathParts.join('/')
      : `avatars/${pathParts.join('/')}`;
    if (r2Key.startsWith(`avatars/${user.id}/`)) {
      await c.env.STORAGE.delete(r2Key);
    }
  } catch {
    // URL parsing failed — skip R2 delete
  }

  await orchestratorService.updateOrchestratorIdentity(c.get('db'), user.id, { avatar: '' });
  return c.json({ success: true });
});

// ─── Identity Link Routes (Phase D) ──────────────────────────────────────

orchestratorRouter.get('/identity-links', async (c) => {
  const user = c.get('user');
  const links = await db.getUserIdentityLinks(c.get('db'), user.id);
  return c.json({ links });
});

orchestratorRouter.post('/identity-links', zValidator('json', createIdentityLinkSchema), async (c) => {
  const user = c.get('user');
  const body = c.req.valid('json');

  const id = crypto.randomUUID();
  try {
    const link = await db.createIdentityLink(c.get('db'), {
      id,
      userId: user.id,
      provider: body.provider,
      externalId: body.externalId,
      externalName: body.externalName,
      teamId: body.teamId,
    });
    return c.json({ link }, 201);
  } catch (err: any) {
    if (err?.message?.includes('UNIQUE constraint failed')) {
      return c.json({ error: 'This external identity is already linked' }, 409);
    }
    throw err;
  }
});

orchestratorRouter.delete('/identity-links/:id', async (c) => {
  const user = c.get('user');
  const { id } = c.req.param();

  const deleted = await db.deleteIdentityLink(c.get('db'), id, user.id);
  if (!deleted) {
    return c.json({ error: 'Identity link not found' }, 404);
  }

  return c.json({ success: true });
});
