import { Hono } from 'hono';
import type { Env, Variables } from '../env.js';
import { adminMiddleware } from '../middleware/admin.js';
import { ValidationError } from '@agent-ops/shared';
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
} from '../lib/db.js';
import * as adminService from '../services/admin.js';

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
