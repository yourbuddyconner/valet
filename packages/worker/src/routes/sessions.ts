import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import type { Env, Variables } from '../env.js';
import * as db from '../lib/db.js';
import * as sessionService from '../services/sessions.js';
import { resolveAvailableModels } from '../services/model-catalog.js';

export const sessionsRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

// Validation schemas
const createSessionSchema = z.object({
  workspace: z.string().min(1).max(100),
  repoUrl: z.string().url().optional(),
  branch: z.string().optional(),
  ref: z.string().optional(),
  title: z.string().max(200).optional(),
  parentSessionId: z.string().uuid().optional(),
  config: z
    .object({
      memory: z.string().optional(),
      timeout: z.number().optional(),
    })
    .optional(),
  sourceType: z.enum(['pr', 'issue', 'branch', 'manual']).optional(),
  sourcePrNumber: z.number().int().positive().optional(),
  sourceIssueNumber: z.number().int().positive().optional(),
  sourceRepoFullName: z.string().optional(),
  initialPrompt: z.string().max(100000).optional(),
  initialModel: z.string().max(255).optional(),
  personaId: z.string().uuid().optional(),
});

const sendMessageSchema = z.object({
  content: z.string().min(1).max(100000),
  attachments: z
    .array(
      z.object({
        type: z.enum(['file', 'url']),
        name: z.string(),
        data: z.string(),
        mimeType: z.string().optional(),
      })
    )
    .optional(),
});

/**
 * GET /api/sessions
 * List user's sessions
 */
sessionsRouter.get('/', async (c) => {
  const user = c.get('user');
  const { limit, cursor, status, ownership } = c.req.query();

  const result = await db.getUserSessions(c.env.DB, user.id, {
    limit: limit ? parseInt(limit) : undefined,
    cursor,
    status,
    ownership: ownership as db.SessionOwnershipFilter | undefined,
  });

  return c.json(result);
});

/**
 * POST /api/sessions
 * Create a new agent session.
 */
sessionsRouter.post('/', zValidator('json', createSessionSchema), async (c) => {
  const user = c.get('user');
  const body = c.req.valid('json');

  const result = await sessionService.createSession(
    c.env,
    { ...body, userId: user.id, userEmail: user.email },
    { url: c.req.url, host: c.req.header('host') || undefined },
  );

  if (!result.ok) {
    return c.json(
      { error: result.message, activeCount: result.activeCount, limit: result.limit },
      429
    );
  }
  return c.json(result, 201);
});

/**
 * GET /api/sessions/available-models
 * Returns the list of available models resolved from D1 configs + external catalogs.
 * No running sandbox required — models are available as soon as provider keys are configured.
 */
sessionsRouter.get('/available-models', async (c) => {
  try {
    const appDb = c.get('db');
    const [models, orgSettings] = await Promise.all([
      resolveAvailableModels(appDb, c.env),
      db.getOrgSettings(appDb),
    ]);
    // Filter org model preferences to only include models that exist in the resolved catalog
    const allModelIds = new Set(models.flatMap((p) => p.models.map((m) => m.id)));
    const validPrefs = orgSettings.modelPreferences?.filter((id) => allModelIds.has(id)) ?? null;
    return c.json({
      models,
      orgModelPreferences: validPrefs && validPrefs.length > 0 ? validPrefs : null,
    });
  } catch (err) {
    console.error('[available-models] resolution failed:', err);
    return c.json({ models: [], orgModelPreferences: null });
  }
});

/**
 * POST /api/sessions/join/:token
 * Redeem a share link and join as a participant
 */
sessionsRouter.post('/join/:token', async (c) => {
  const user = c.get('user');
  const { token } = c.req.param();

  const result = await sessionService.joinSessionViaShareLink(c.get('db'), token, user.id);
  if (!result) {
    return c.json({ error: 'Invalid, expired, or exhausted share link' }, 400);
  }

  return c.json({ sessionId: result.sessionId, role: result.role });
});

/**
 * GET /api/sessions/:id
 * Get session details
 */
sessionsRouter.get('/:id', async (c) => {
  const user = c.get('user');
  const { id } = c.req.param();

  const result = await sessionService.getSessionWithStatus(c.env, id, user.id);
  return c.json(result);
});

/**
 * GET /api/sessions/:id/git-state
 * Get the git state for a session
 */
sessionsRouter.get('/:id/git-state', async (c) => {
  const user = c.get('user');
  const { id } = c.req.param();

  await db.assertSessionAccess(c.get('db'), id, user.id, 'viewer');

  const gitState = await db.getSessionGitState(c.get('db'), id);

  return c.json({ gitState });
});

/**
 * GET /api/sessions/:id/sandbox-token
 * Issue a short-lived JWT for direct iframe access to sandbox tunnel URLs.
 */
sessionsRouter.get('/:id/sandbox-token', async (c) => {
  const user = c.get('user');
  const { id } = c.req.param();

  const result = await sessionService.issueSandboxToken(c.env, id, user.id);

  if ('error' in result) {
    return c.json({ error: result.error }, result.status);
  }
  if ('hibernatedStatus' in result) {
    return c.json({ status: result.hibernatedStatus }, result.status);
  }

  return c.json(result);
});

/**
 * GET /api/sessions/:id/tunnels
 * Get tunnel URLs for a running session.
 */
sessionsRouter.get('/:id/tunnels', async (c) => {
  const user = c.get('user');
  const { id } = c.req.param();

  await db.assertSessionAccess(c.get('db'), id, user.id, 'viewer');

  const doId = c.env.SESSIONS.idFromName(id);
  const sessionDO = c.env.SESSIONS.get(doId);

  const statusRes = await sessionDO.fetch(new Request('http://do/status'));
  const statusData = await statusRes.json() as {
    tunnelUrls?: Record<string, string> | null;
    tunnels?: Array<{ name: string; url?: string; path?: string; port?: number; protocol?: string }> | null;
  };

  return c.json({
    gatewayUrl: statusData.tunnelUrls?.gateway ?? null,
    tunnels: statusData.tunnels ?? [],
  });
});

/**
 * DELETE /api/sessions/:id/tunnels/:name
 * Unregister a sandbox tunnel by name (delegated to the runner).
 */
sessionsRouter.delete('/:id/tunnels/:name', async (c) => {
  const user = c.get('user');
  const { id, name } = c.req.param();

  await db.assertSessionAccess(c.get('db'), id, user.id, 'collaborator');

  const doId = c.env.SESSIONS.idFromName(id);
  const sessionDO = c.env.SESSIONS.get(doId);

  const resp = await sessionDO.fetch(new Request('http://do/tunnels', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'delete',
      name,
      actorId: user.id,
      actorName: user.email,
      actorEmail: user.email,
    }),
  }));

  if (!resp.ok) {
    const errText = await resp.text();
    return c.json({ error: errText || 'Failed to delete tunnel' }, resp.status as 400 | 401 | 403 | 404 | 409 | 422 | 500);
  }

  return c.json({ success: true });
});

/**
 * POST /api/sessions/:id/messages
 * Send a message/prompt to the session agent.
 */
sessionsRouter.post('/:id/messages', zValidator('json', sendMessageSchema), async (c) => {
  const user = c.get('user');
  const { id } = c.req.param();
  const body = c.req.valid('json');

  await sessionService.sendSessionMessage(c.env, id, user.id, user.email, body.content);
  return c.json({ success: true });
});

/**
 * POST /api/sessions/:id/prompt
 * Send a prompt with attachments to the session agent.
 * Used by the web UI for large payloads that exceed the WebSocket frame limit.
 */
sessionsRouter.post('/:id/prompt', async (c) => {
  const user = c.get('user');
  const { id } = c.req.param();

  await db.assertSessionAccess(c.get('db'), id, user.id, 'collaborator');

  // Read raw body and inject author info without full re-serialization.
  // This avoids double-parsing multi-MB payloads (PDF base64 data URLs).
  const rawBody = await c.req.text();
  const injected = rawBody.replace(
    /^\{/,
    `{"authorId":${JSON.stringify(user.id)},"authorEmail":${JSON.stringify(user.email)},`,
  );

  const doId = c.env.SESSIONS.idFromName(id);
  const sessionDO = c.env.SESSIONS.get(doId);

  const res = await sessionDO.fetch(new Request('http://do/prompt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: injected,
  }));

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return c.json({ error: text || 'Prompt failed' }, res.status as any);
  }

  return c.json({ success: true });
});

/**
 * POST /api/sessions/:id/clear-queue
 * Clear the prompt queue for a session.
 */
sessionsRouter.post('/:id/clear-queue', async (c) => {
  const user = c.get('user');
  const { id } = c.req.param();

  await db.assertSessionAccess(c.get('db'), id, user.id, 'collaborator');

  const doId = c.env.SESSIONS.idFromName(id);
  const sessionDO = c.env.SESSIONS.get(doId);

  const res = await sessionDO.fetch(new Request('http://do/clear-queue', { method: 'POST' }));
  const result = await res.json() as { cleared: number };

  return c.json(result);
});

/**
 * GET /api/sessions/:id/messages
 * Get session message history — reads from DO SQLite (authoritative) to avoid
 * stale D1 data causing tool calls to disappear after page navigation.
 */
sessionsRouter.get('/:id/messages', async (c) => {
  const user = c.get('user');
  const { id } = c.req.param();
  const { limit, after } = c.req.query();

  await db.assertSessionAccess(c.get('db'), id, user.id, 'viewer');

  // Proxy to the DO's /messages endpoint for authoritative data from DO SQLite.
  // D1 can lag behind (debounced flushes, background waitUntil), causing tool call
  // parts to appear as empty '[]' placeholders when loaded after page navigation.
  const doId = c.env.SESSIONS.idFromName(id);
  const sessionDO = c.env.SESSIONS.get(doId);
  const params = new URLSearchParams();
  if (limit) params.set('limit', limit);
  if (after) params.set('after', after);
  const qs = params.toString();
  const doRes = await sessionDO.fetch(new Request(`http://do/messages${qs ? `?${qs}` : ''}`));
  const data = await doRes.json();

  return c.json(data);
});

/**
 * GET /api/sessions/:id/ws
 * WebSocket upgrade — proxies to SessionAgentDO.
 */
sessionsRouter.get('/:id/ws', async (c) => {
  const { id } = c.req.param();

  // Allow both client and runner connections
  // Clients: authenticated user (role/userId derived server-side)
  // Runner: ?role=runner&token=...
  const role = c.req.query('role');

  const doId = c.env.SESSIONS.idFromName(id);
  const sessionDO = c.env.SESSIONS.get(doId);

  if (role === 'client') {
    const user = c.get('user');
    await db.assertSessionAccess(c.get('db'), id, user.id, 'viewer');

    // Never trust user identity in URL params from the browser.
    // Rebuild request URL so DO receives server-derived userId.
    const doUrl = new URL(c.req.url);
    doUrl.searchParams.set('role', 'client');
    doUrl.searchParams.set('userId', user.id);
    doUrl.searchParams.delete('token');

    return sessionDO.fetch(new Request(doUrl.toString(), {
      headers: c.req.raw.headers,
    }));
  }

  // Runner auth is handled by the DO itself via token validation
  // Forward raw request for runner traffic.
  return sessionDO.fetch(c.req.raw);
});

/**
 * POST /api/sessions/:id/hibernate
 * Hibernate a running session.
 */
sessionsRouter.post('/:id/hibernate', async (c) => {
  const user = c.get('user');
  const { id } = c.req.param();

  await db.assertSessionAccess(c.get('db'), id, user.id, 'collaborator');

  const doId = c.env.SESSIONS.idFromName(id);
  const sessionDO = c.env.SESSIONS.get(doId);

  const res = await sessionDO.fetch(new Request('http://do/hibernate', { method: 'POST' }));
  const result = await res.json() as { status: string; message: string };

  return c.json(result);
});

/**
 * POST /api/sessions/:id/wake
 * Wake a hibernated session.
 */
sessionsRouter.post('/:id/wake', async (c) => {
  const user = c.get('user');
  const { id } = c.req.param();

  await db.assertSessionAccess(c.get('db'), id, user.id, 'collaborator');

  const doId = c.env.SESSIONS.idFromName(id);
  const sessionDO = c.env.SESSIONS.get(doId);

  const res = await sessionDO.fetch(new Request('http://do/wake', { method: 'POST' }));
  const result = await res.json() as { status: string; message: string };

  return c.json(result);
});

/**
 * POST /api/sessions/bulk-delete
 * Permanently delete multiple sessions.
 */
const bulkDeleteSchema = z.object({
  sessionIds: z.array(z.string().uuid()).min(1).max(100),
});

sessionsRouter.post('/bulk-delete', zValidator('json', bulkDeleteSchema), async (c) => {
  const user = c.get('user');
  const { sessionIds } = c.req.valid('json');

  const result = await sessionService.bulkDeleteSessions(c.env, user.id, sessionIds);
  return c.json(result);
});

/**
 * GET /api/sessions/:id/children
 * Get child sessions for a parent session (paginated).
 *
 * For orchestrator sessions, returns children across ALL of the user's
 * orchestrator sessions so history survives session rotation/hibernation.
 */
sessionsRouter.get('/:id/children', async (c) => {
  const user = c.get('user');
  const { id } = c.req.param();
  const { limit, cursor, status, hideTerminated } = c.req.query();

  const result = await sessionService.getEnrichedChildSessions(c.env, id, user.id, {
    limit: limit ? parseInt(limit) : undefined,
    cursor,
    status,
    hideTerminated: hideTerminated === 'true',
  });

  return c.json(result);
});

/**
 * GET /api/sessions/:id/files-changed
 * Get files changed in a session.
 */
sessionsRouter.get('/:id/files-changed', async (c) => {
  const user = c.get('user');
  const { id } = c.req.param();

  await db.assertSessionAccess(c.get('db'), id, user.id, 'viewer');

  const files = await db.getSessionFilesChanged(c.get('db'), id);
  return c.json({ files });
});

/**
 * PATCH /api/sessions/:id
 * Update session title.
 */
const updateSessionSchema = z.object({
  title: z.string().max(200),
});

sessionsRouter.patch('/:id', zValidator('json', updateSessionSchema), async (c) => {
  const user = c.get('user');
  const { id } = c.req.param();
  const body = c.req.valid('json');

  await db.assertSessionAccess(c.get('db'), id, user.id, 'owner');

  await db.updateSessionTitle(c.get('db'), id, body.title);
  return c.json({ success: true });
});

/**
 * DELETE /api/sessions/:id
 * Terminate a session.
 */
sessionsRouter.delete('/:id', async (c) => {
  const user = c.get('user');
  const { id } = c.req.param();

  await sessionService.terminateSession(c.env, id, user.id);
  return c.json({ success: true });
});

// ─── Participant Management Endpoints ─────────────────────────────────────

/**
 * GET /api/sessions/:id/participants
 */
sessionsRouter.get('/:id/participants', async (c) => {
  const user = c.get('user');
  const { id } = c.req.param();

  const session = await db.assertSessionAccess(c.get('db'), id, user.id, 'viewer');
  sessionService.assertSessionShareable(session);

  const allParticipants = await sessionService.getSessionParticipantsWithOwner(c.get('db'), id, session.userId);

  return c.json({ participants: allParticipants });
});

const addParticipantSchema = z.object({
  userId: z.string().optional(),
  email: z.string().email().optional(),
  role: z.enum(['collaborator', 'viewer']).default('collaborator'),
}).refine((d) => d.userId || d.email, { message: 'userId or email required' });

/**
 * POST /api/sessions/:id/participants
 */
sessionsRouter.post('/:id/participants', zValidator('json', addParticipantSchema), async (c) => {
  const user = c.get('user');
  const { id } = c.req.param();
  const body = c.req.valid('json');

  await sessionService.addSessionParticipant(c.get('db'), id, user.id, { userId: body.userId, email: body.email }, body.role);
  return c.json({ success: true });
});

/**
 * DELETE /api/sessions/:id/participants/:userId
 */
sessionsRouter.delete('/:id/participants/:userId', async (c) => {
  const user = c.get('user');
  const { id, userId: targetUserId } = c.req.param();

  const session = await db.assertSessionAccess(c.get('db'), id, user.id, 'owner');
  sessionService.assertSessionShareable(session);

  await db.removeSessionParticipant(c.get('db'), id, targetUserId);

  return c.json({ success: true });
});

// ─── Share Link Endpoints ─────────────────────────────────────────────────

const createShareLinkSchema = z.object({
  role: z.enum(['collaborator', 'viewer']).default('collaborator'),
  expiresAt: z.string().datetime().optional(),
  maxUses: z.number().int().positive().optional(),
});

/**
 * POST /api/sessions/:id/share-link
 */
sessionsRouter.post('/:id/share-link', zValidator('json', createShareLinkSchema), async (c) => {
  const user = c.get('user');
  const { id } = c.req.param();
  const body = c.req.valid('json');

  const session = await db.assertSessionAccess(c.get('db'), id, user.id, 'owner');
  sessionService.assertSessionShareable(session);

  const link = await db.createShareLink(c.get('db'), id, body.role, user.id, body.expiresAt, body.maxUses);

  return c.json({ shareLink: link }, 201);
});

/**
 * GET /api/sessions/:id/share-links
 */
sessionsRouter.get('/:id/share-links', async (c) => {
  const user = c.get('user');
  const { id } = c.req.param();

  const session = await db.assertSessionAccess(c.get('db'), id, user.id, 'owner');
  sessionService.assertSessionShareable(session);

  const links = await db.getSessionShareLinks(c.get('db'), id);

  return c.json({ shareLinks: links });
});

/**
 * DELETE /api/sessions/:id/share-link/:linkId
 */
sessionsRouter.delete('/:id/share-link/:linkId', async (c) => {
  const user = c.get('user');
  const { id, linkId } = c.req.param();

  const session = await db.assertSessionAccess(c.get('db'), id, user.id, 'owner');
  sessionService.assertSessionShareable(session);

  await db.deactivateShareLink(c.get('db'), linkId);

  return c.json({ success: true });
});
