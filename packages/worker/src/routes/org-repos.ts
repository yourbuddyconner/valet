import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { ValidationError } from '@valet/shared';
import type { Env, Variables } from '../env.js';
import { adminMiddleware } from '../middleware/admin.js';
import * as db from '../lib/db.js';

// Admin routes (mounted at /api/admin/repos)
export const orgReposAdminRouter = new Hono<{ Bindings: Env; Variables: Variables }>();
orgReposAdminRouter.use('*', adminMiddleware);

const createRepoSchema = z.object({
  fullName: z.string().min(3).regex(/^[^/]+\/[^/]+$/, 'Must be in owner/repo format'),
  description: z.string().optional(),
  language: z.string().optional(),
  defaultBranch: z.string().optional(),
});

/**
 * POST /api/admin/repos
 * Add an org repository.
 */
orgReposAdminRouter.post('/', zValidator('json', createRepoSchema), async (c) => {
  const body = c.req.valid('json');
  const id = crypto.randomUUID();

  const repo = await db.createOrgRepository(c.get('db'), {
    id,
    fullName: body.fullName,
    description: body.description,
    defaultBranch: body.defaultBranch,
    language: body.language,
  });

  return c.json(repo, 201);
});

const updateRepoSchema = z.object({
  description: z.string().optional(),
  language: z.string().optional(),
  defaultBranch: z.string().optional(),
  enabled: z.boolean().optional(),
});

/**
 * PUT /api/admin/repos/:id
 * Update repo metadata.
 */
orgReposAdminRouter.put('/:id', zValidator('json', updateRepoSchema), async (c) => {
  const { id } = c.req.param();
  const body = c.req.valid('json');

  const repo = await db.getOrgRepository(c.get('db'), id);
  if (!repo) {
    return c.json({ error: 'Repository not found' }, 404);
  }

  await db.updateOrgRepository(c.get('db'), id, body);
  return c.json({ ok: true });
});

/**
 * DELETE /api/admin/repos/:id
 * Remove an org repository.
 */
orgReposAdminRouter.delete('/:id', async (c) => {
  const { id } = c.req.param();
  await db.deleteOrgRepository(c.get('db'), id);
  return c.json({ ok: true });
});

const setPersonaDefaultSchema = z.object({
  personaId: z.string().min(1),
});

/**
 * PUT /api/admin/repos/:id/persona-default
 * Set default persona for a repo.
 */
orgReposAdminRouter.put('/:id/persona-default', zValidator('json', setPersonaDefaultSchema), async (c) => {
  const { id } = c.req.param();
  const { personaId } = c.req.valid('json');

  const repo = await db.getOrgRepository(c.get('db'), id);
  if (!repo) {
    return c.json({ error: 'Repository not found' }, 404);
  }

  await db.setRepoPersonaDefault(c.get('db'), id, personaId);
  return c.json({ ok: true });
});

/**
 * DELETE /api/admin/repos/:id/persona-default
 * Remove default persona for a repo.
 */
orgReposAdminRouter.delete('/:id/persona-default', async (c) => {
  const { id } = c.req.param();
  await db.deleteRepoPersonaDefault(c.get('db'), id);
  return c.json({ ok: true });
});

// Read routes (mounted at /api/repos/org, accessible to all authenticated users)
export const orgReposReadRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * GET /api/repos/org
 * List org repositories.
 */
orgReposReadRouter.get('/', async (c) => {
  const repos = await db.listOrgRepositories(c.env.DB);
  return c.json({ repos });
});
