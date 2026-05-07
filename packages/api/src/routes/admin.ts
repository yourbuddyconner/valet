import { Hono } from 'hono';
import type { Env, Variables } from '../env.js';
import { adminMiddleware } from '../middleware/admin.js';
import { ValidationError } from '@valet/shared';
import {
  getOrgSettings,
  updateOrgSettings,
  listOrgApiKeys,
  deleteOrgApiKey,
  listInvites,
  deleteInvite,
  getInviteByCodeAny,
  listUsers,
  listCustomProviders,
  deleteCustomProvider,
  getOrchestratorIdentity,
} from '../lib/db.js';
import { getDb } from '../lib/drizzle.js';
import * as adminService from '../services/admin.js';
import { restartOrchestratorSession } from '../services/orchestrator.js';

function safeJsonParse(value: unknown): unknown {
  if (typeof value !== 'string') return undefined;
  try { return JSON.parse(value); } catch { return value; }
}

export const adminRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

// All admin routes require admin role
adminRouter.use('*', adminMiddleware);

// --- Org Settings ---

adminRouter.get('/', async (c) => {
  const settings = await getOrgSettings(c.get('db'));
  return c.json(settings);
});

adminRouter.put('/', async (c) => {
  const body = await c.req.json<{
    name?: string;
    allowedEmailDomain?: string;
    allowedEmails?: string;
    domainGatingEnabled?: boolean;
    emailAllowlistEnabled?: boolean;
    modelPreferences?: string[];
    enabledLoginProviders?: string[];
    driveLabelsGuardEnabled?: boolean;
    driveRequiredLabelIds?: string[];
    driveLabelsFailMode?: 'deny' | 'allow';
  }>();

  if (body.modelPreferences !== undefined) {
    if (!Array.isArray(body.modelPreferences)) {
      throw new ValidationError('modelPreferences must be an array of strings');
    }
    if (body.modelPreferences.length > 20) {
      throw new ValidationError('modelPreferences cannot exceed 20 items');
    }
    if (!body.modelPreferences.every((m) => typeof m === 'string' && m.length <= 255)) {
      throw new ValidationError('Each model preference must be a string (max 255 chars)');
    }
  }

  if (body.enabledLoginProviders !== undefined) {
    if (!Array.isArray(body.enabledLoginProviders)) {
      throw new ValidationError('enabledLoginProviders must be an array of strings');
    }
    if (!body.enabledLoginProviders.every((p) => typeof p === 'string' && p.length <= 50)) {
      throw new ValidationError('Each login provider must be a string (max 50 chars)');
    }
  }

  if (body.driveRequiredLabelIds !== undefined) {
    if (!Array.isArray(body.driveRequiredLabelIds)) {
      throw new ValidationError('driveRequiredLabelIds must be an array of strings');
    }
    const LABEL_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
    if (!body.driveRequiredLabelIds.every((id) => typeof id === 'string' && id.length <= 255 && LABEL_ID_PATTERN.test(id))) {
      throw new ValidationError('Each label ID must be alphanumeric (with hyphens/underscores, max 255 chars)');
    }
  }

  if (body.driveLabelsFailMode !== undefined && !['deny', 'allow'].includes(body.driveLabelsFailMode)) {
    throw new ValidationError('driveLabelsFailMode must be "deny" or "allow"');
  }

  const settings = await updateOrgSettings(c.get('db'), body);
  return c.json(settings);
});

// --- LLM API Keys ---

const VALID_PROVIDERS = ['anthropic', 'openai', 'google', 'parallel'] as const;

adminRouter.get('/llm-keys', async (c) => {
  const keys = await listOrgApiKeys(c.get('db'));
  return c.json(keys);
});

adminRouter.put('/llm-keys/:provider', async (c) => {
  const provider = c.req.param('provider');
  if (!VALID_PROVIDERS.includes(provider as any)) {
    throw new ValidationError(`Invalid provider: ${provider}. Must be one of: ${VALID_PROVIDERS.join(', ')}`);
  }

  const body = await c.req.json<{
    key?: string;
    models?: Array<{ id: string; name?: string }>;
    showAllModels?: boolean;
  }>();

  // Validate models if provided
  if (body.models !== undefined) {
    if (!Array.isArray(body.models)) {
      throw new ValidationError('models must be an array');
    }
    for (const m of body.models) {
      if (!m.id || typeof m.id !== 'string') {
        throw new ValidationError('Each model must have a string id');
      }
    }
  }

  const user = c.get('user');

  if (body.key && typeof body.key === 'string' && body.key.trim().length > 0) {
    // Setting key (optionally with model config)
    await adminService.setOrgLlmKey(c.get('db'), c.env.ENCRYPTION_KEY, {
      provider,
      key: body.key,
      setBy: user.id,
      models: body.models,
      showAllModels: body.showAllModels,
    });
  } else if (body.models !== undefined || body.showAllModels !== undefined) {
    // Updating model config only (no key change)
    await adminService.updateOrgLlmKeyModelConfig(c.get('db'), {
      provider,
      models: body.models,
      showAllModels: body.showAllModels,
    });
  } else {
    throw new ValidationError('API key or model configuration is required');
  }

  return c.json({ ok: true });
});

adminRouter.delete('/llm-keys/:provider', async (c) => {
  const provider = c.req.param('provider');
  await deleteOrgApiKey(c.get('db'), provider);
  return c.json({ ok: true });
});

// --- Invites ---

adminRouter.get('/invites', async (c) => {
  const invites = await listInvites(c.get('db'));
  return c.json(invites);
});

adminRouter.post('/invites', async (c) => {
  const { email, role } = await c.req.json<{ email?: string; role?: 'admin' | 'member' }>();
  const user = c.get('user');

  const invite = await adminService.createInvite(c.get('db'), { email, role, invitedBy: user.id });
  return c.json(invite, 201);
});

adminRouter.delete('/invites/:id', async (c) => {
  const id = c.req.param('id');
  await deleteInvite(c.get('db'), id);
  return c.json({ ok: true });
});

// --- Users ---

adminRouter.get('/users', async (c) => {
  const users = await listUsers(c.get('db'));
  return c.json(users);
});

adminRouter.patch('/users/:id', async (c) => {
  const userId = c.req.param('id');
  const { role } = await c.req.json<{ role: 'admin' | 'member' }>();

  if (!role || !['admin', 'member'].includes(role)) {
    throw new ValidationError('Valid role is required (admin or member)');
  }

  const result = await adminService.updateUserRoleSafe(c.get('db'), userId, role);
  if (!result.ok) {
    throw new ValidationError('Cannot demote the last admin');
  }

  return c.json({ ok: true });
});

adminRouter.delete('/users/:id', async (c) => {
  const userId = c.req.param('id');
  const currentUser = c.get('user');

  const result = await adminService.deleteUserSafe(c.get('db'), userId, currentUser.id);
  if (!result.ok) {
    if (result.error === 'self_delete') {
      throw new ValidationError('Cannot delete yourself');
    }
    if (result.error === 'last_admin') {
      throw new ValidationError('Cannot delete the last admin');
    }
  }

  return c.json({ ok: true });
});

// --- Custom Providers ---

const BUILT_IN_PROVIDER_IDS = ['anthropic', 'openai', 'google', 'parallel'];
const PROVIDER_ID_REGEX = /^[a-z0-9-]+$/;

adminRouter.get('/custom-providers', async (c) => {
  const providers = await listCustomProviders(c.get('db'));
  return c.json(providers);
});

adminRouter.put('/custom-providers/:providerId', async (c) => {
  const providerId = c.req.param('providerId');

  // Validate provider ID format
  if (!providerId || providerId.length > 50 || !PROVIDER_ID_REGEX.test(providerId)) {
    throw new ValidationError('Provider ID must be 1-50 characters, lowercase alphanumeric with hyphens');
  }

  // Prevent collision with built-in providers
  if (BUILT_IN_PROVIDER_IDS.includes(providerId)) {
    throw new ValidationError(`Provider ID "${providerId}" is reserved for a built-in provider`);
  }

  const body = await c.req.json<{
    displayName: string;
    baseUrl: string;
    apiKey?: string;
    models: Array<{ id: string; name?: string; contextLimit?: number; outputLimit?: number }>;
    showAllModels?: boolean;
  }>();

  if (!body.displayName || typeof body.displayName !== 'string' || body.displayName.trim().length === 0) {
    throw new ValidationError('Display name is required');
  }
  if (!body.baseUrl || typeof body.baseUrl !== 'string' || body.baseUrl.trim().length === 0) {
    throw new ValidationError('Base URL is required');
  }
  if (!Array.isArray(body.models) || body.models.length === 0) {
    throw new ValidationError('At least one model is required');
  }
  for (const model of body.models) {
    if (!model.id || typeof model.id !== 'string' || model.id.trim().length === 0) {
      throw new ValidationError('Each model must have an id');
    }
  }

  const user = c.get('user');
  await adminService.upsertCustomProviderWithEncryption(c.get('db'), c.env.ENCRYPTION_KEY, {
    providerId,
    displayName: body.displayName.trim(),
    baseUrl: body.baseUrl.trim(),
    apiKey: body.apiKey,
    models: JSON.stringify(body.models),
    showAllModels: !!body.showAllModels,
    setBy: user.id,
  });

  return c.json({ ok: true });
});

adminRouter.post('/custom-providers/discover-models', async (c) => {
  const { baseUrl, apiKey } = await c.req.json<{ baseUrl: string; apiKey?: string }>();

  if (!baseUrl || typeof baseUrl !== 'string' || baseUrl.trim().length === 0) {
    throw new ValidationError('Base URL is required');
  }

  // Normalize: strip trailing slash, append /models if not already present
  let url = baseUrl.trim().replace(/\/+$/, '');
  if (!url.endsWith('/models')) {
    url += '/models';
  }

  const headers: Record<string, string> = { 'Accept': 'application/json' };
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    const res = await fetch(url, { headers, signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) {
      return c.json({ error: `Provider returned ${res.status}: ${res.statusText}` }, 502);
    }

    const body = await res.json() as { data?: Array<{ id: string; created?: number }> };
    const models = (body.data ?? [])
      .map((m) => ({ id: m.id, created: m.created }))
      .sort((a, b) => a.id.localeCompare(b.id));

    return c.json({ models });
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      return c.json({ error: 'Connection timed out (10s)' }, 504);
    }
    return c.json({ error: err?.message ?? 'Failed to connect to provider' }, 502);
  }
});

adminRouter.delete('/custom-providers/:providerId', async (c) => {
  const providerId = c.req.param('providerId');
  await deleteCustomProvider(c.get('db'), providerId);
  return c.json({ ok: true });
});

// --- Orchestrators ---

adminRouter.get('/orchestrators', async (c) => {
  const limitStr = c.req.query('limit');
  const cursor = c.req.query('cursor');
  const limit = limitStr ? Math.min(parseInt(limitStr, 10) || 25, 100) : 25;

  // Paginate sessions in a subquery, then join extras — avoids D1 bind-parameter limits
  let query = `
    SELECT
      s.id AS session_id,
      s.user_id,
      s.status,
      s.created_at,
      s.last_active_at,
      u.email AS user_email,
      u.name AS user_name,
      oi.name AS identity_name,
      oi.handle AS identity_handle,
      oi.avatar AS identity_avatar,
      cb.channel_type,
      cb.channel_id,
      cb.slack_channel_id
    FROM (
      SELECT * FROM sessions
      WHERE is_orchestrator = 1
        AND status IN ('running', 'idle', 'hibernating', 'hibernated', 'initializing', 'restoring')
  `;
  const params: (string | number)[] = [];

  if (cursor) {
    query += `    AND last_active_at < ?\n`;
    params.push(cursor);
  }

  query += `      ORDER BY last_active_at DESC
      LIMIT ?
    ) s
    JOIN users u ON u.id = s.user_id
    LEFT JOIN orchestrator_identities oi ON oi.user_id = s.user_id
    LEFT JOIN channel_bindings cb ON cb.session_id = s.id
    ORDER BY s.last_active_at DESC
  `;
  params.push(limit + 1); // fetch one extra to detect hasMore

  const rows = await c.env.DB.prepare(query).bind(...params).all();

  // Group rows by session (LEFT JOIN may produce multiple rows per session)
  const sessionMap = new Map<string, {
    sessionId: string; userId: string; status: string;
    userEmail: string; userName?: string;
    identityName?: string; identityHandle?: string; identityAvatar?: string;
    channels: Array<{ channelType: string; channelId: string; slackChannelId?: string }>;
    createdAt: string; lastActiveAt: string;
  }>();

  for (const r of (rows.results ?? []) as any[]) {
    let entry = sessionMap.get(r.session_id);
    if (!entry) {
      entry = {
        sessionId: r.session_id,
        userId: r.user_id,
        status: r.status,
        userEmail: r.user_email,
        userName: r.user_name || undefined,
        identityName: r.identity_name || undefined,
        identityHandle: r.identity_handle || undefined,
        identityAvatar: r.identity_avatar || undefined,
        channels: [],
        createdAt: r.created_at,
        lastActiveAt: r.last_active_at,
      };
      sessionMap.set(r.session_id, entry);
    }
    if (r.channel_type) {
      entry.channels.push({
        channelType: r.channel_type,
        channelId: r.channel_id,
        slackChannelId: r.slack_channel_id || undefined,
      });
    }
  }

  const all = [...sessionMap.values()];
  const hasMore = all.length > limit;
  const page = all.slice(0, limit);
  const nextCursor = hasMore ? page[page.length - 1].lastActiveAt : undefined;

  return c.json({ orchestrators: page, hasMore, nextCursor });
});

adminRouter.post('/orchestrators/:sessionId/refresh', async (c) => {
  const { sessionId } = c.req.param();
  const appDb = getDb(c.env.DB);

  // Look up the session to get the user ID
  const session = await c.env.DB.prepare(
    `SELECT user_id, is_orchestrator FROM sessions WHERE id = ?`
  ).bind(sessionId).first<{ user_id: string; is_orchestrator: number }>();

  if (!session || !session.is_orchestrator) {
    return c.json({ error: 'Orchestrator session not found' }, 404);
  }

  // Look up identity for this user
  const identity = await getOrchestratorIdentity(appDb, session.user_id);
  if (!identity) {
    return c.json({ error: 'Orchestrator identity not found' }, 404);
  }

  // Look up user email
  const user = await c.env.DB.prepare(
    `SELECT email FROM users WHERE id = ?`
  ).bind(session.user_id).first<{ email: string }>();

  if (!user) {
    return c.json({ error: 'User not found' }, 404);
  }

  // restartOrchestratorSession now stops the old DO + marks D1 terminated before
  // creating the new session, so no explicit stop/terminate needed here.
  const result = await restartOrchestratorSession(
    c.env,
    session.user_id,
    user.email,
    {
      id: identity.id,
      name: identity.name,
      handle: identity.handle,
      customInstructions: identity.customInstructions ?? null,
      personaId: identity.personaId ?? null,
    },
    c.req.url,
  );

  return c.json({ ok: true, newSessionId: result.sessionId });
});

// --- Action Invocation Log ---

adminRouter.get('/action-log', async (c) => {
  const service = c.req.query('service');
  const userId = c.req.query('userId');
  const limitStr = c.req.query('limit');
  const cursor = c.req.query('cursor');
  const limit = limitStr ? Math.min(parseInt(limitStr, 10) || 50, 200) : 50;

  let query = `
    SELECT
      ai.id,
      ai.session_id,
      ai.user_id,
      ai.service,
      ai.action_id,
      ai.risk_level,
      ai.resolved_mode,
      ai.status,
      ai.params,
      ai.result,
      ai.error,
      ai.executed_at,
      ai.created_at,
      u.email AS user_email,
      u.name AS user_name,
      oi.name AS identity_name,
      oi.handle AS identity_handle
    FROM action_invocations ai
    JOIN users u ON u.id = ai.user_id
    LEFT JOIN orchestrator_identities oi ON oi.user_id = ai.user_id
    WHERE 1=1
  `;
  const params: (string | number)[] = [];

  if (service) {
    query += ' AND ai.service = ?';
    params.push(service);
  }
  if (userId) {
    query += ' AND ai.user_id = ?';
    params.push(userId);
  }
  if (cursor) {
    query += ' AND ai.created_at < ?';
    params.push(cursor);
  }

  query += ' ORDER BY ai.created_at DESC LIMIT ?';
  params.push(limit + 1);

  const rows = await c.env.DB.prepare(query).bind(...params).all();
  const results = rows.results ?? [];
  const hasMore = results.length > limit;
  const page = results.slice(0, limit);

  const entries = page.map((r: any) => ({
    id: r.id,
    sessionId: r.session_id,
    userId: r.user_id,
    userEmail: r.user_email,
    userName: r.user_name || undefined,
    identityName: r.identity_name || undefined,
    identityHandle: r.identity_handle || undefined,
    service: r.service,
    actionId: r.action_id,
    riskLevel: r.risk_level,
    resolvedMode: r.resolved_mode,
    status: r.status,
    params: safeJsonParse(r.params),
    result: safeJsonParse(r.result),
    error: r.error || undefined,
    executedAt: r.executed_at || undefined,
    createdAt: r.created_at,
  }));

  return c.json({
    entries,
    cursor: hasMore ? (page[page.length - 1] as any).created_at : undefined,
    hasMore,
  });
});
