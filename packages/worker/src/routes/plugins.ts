import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { ForbiddenError, NotFoundError } from '@valet/shared';
import type { Env, Variables } from '../env.js';
import * as db from '../lib/db.js';
import { deleteCredentialsByProvider } from '../lib/db/credentials.js';
import { pluginNameToService } from '../lib/db/plugins.js';
import { getDb } from '../lib/drizzle.js';
import { syncPluginsOnce } from '../services/plugin-sync.js';

export const pluginsRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

// GET /api/plugins — list installed plugins
pluginsRouter.get('/', async (c) => {
  const plugins = await db.listPlugins(c.env.DB);
  return c.json({ plugins });
});

// GET /api/plugins/settings — org plugin settings
pluginsRouter.get('/settings', async (c) => {
  const settings = await db.getPluginSettings(c.env.DB);
  return c.json({ settings });
});

// PUT /api/plugins/settings — update org plugin settings (admin)
pluginsRouter.put('/settings', zValidator('json', z.object({
  allowRepoContent: z.boolean().optional(),
})), async (c) => {
  const user = c.get('user');
  if (user.role !== 'admin') throw new ForbiddenError('Admin only');
  const body = c.req.valid('json');
  await db.upsertPluginSettings(c.get('db'), 'default', body);
  return c.json({ ok: true });
});

// POST /api/plugins/sync — force re-sync (admin)
pluginsRouter.post('/sync', async (c) => {
  const user = c.get('user');
  if (user.role !== 'admin') throw new ForbiddenError('Admin only');
  await syncPluginsOnce(c.env.DB, 'default', true);
  return c.json({ ok: true });
});

// GET /api/plugins/:id — plugin detail with artifacts
pluginsRouter.get('/:id', async (c) => {
  const { id } = c.req.param();
  const plugin = await db.getPlugin(c.env.DB, id);
  if (!plugin) return c.json({ error: 'Plugin not found' }, 404);
  return c.json({ plugin });
});

// PUT /api/plugins/:id — enable/disable (admin)
pluginsRouter.put('/:id', zValidator('json', z.object({
  status: z.enum(['active', 'disabled']),
})), async (c) => {
  const user = c.get('user');
  if (user.role !== 'admin') throw new ForbiddenError('Admin only');
  const { id } = c.req.param();
  const { status } = c.req.valid('json');

  const plugin = await db.getPlugin(c.env.DB, id);
  if (!plugin) throw new NotFoundError('Plugin', id);

  await db.updatePluginStatus(c.get('db'), id, status);

  // When disabling, delete all integration rows and credentials for this service
  if (status === 'disabled') {
    const service = pluginNameToService(plugin.name);
    const drizzleDb = getDb(c.env.DB);
    await db.deleteIntegrationsByService(drizzleDb, service);
    await deleteCredentialsByProvider(drizzleDb, service);
  }

  return c.json({ ok: true });
});
