import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import type { Env, Variables } from '../env.js';
import * as db from '../lib/db.js';

export const skillsRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * GET /api/skills
 * List or search skills visible to the current user.
 * If `q` query param is provided, performs FTS search.
 * Otherwise lists with optional `source` and `visibility` filters.
 */
skillsRouter.get('/', async (c) => {
  const user = c.get('user');
  const q = c.req.query('q');

  if (q) {
    const source = c.req.query('source') as db.ListSkillsFilters['source'];
    const skills = await db.searchSkills(c.get('db'), 'default', user.id, q, { source });
    return c.json({ skills });
  }

  const source = c.req.query('source') as db.ListSkillsFilters['source'];
  const visibility = c.req.query('visibility') as db.ListSkillsFilters['visibility'];
  const skills = await db.listSkills(c.get('db'), 'default', user.id, { source, visibility });
  return c.json({ skills });
});

/**
 * GET /api/skills/:id
 * Get a single skill by ID.
 */
skillsRouter.get('/:id', async (c) => {
  const user = c.get('user');
  const { id } = c.req.param();

  // Try by ID first, then fall back to slug lookup
  let skill = await db.getSkill(c.get('db'), id);
  if (!skill) {
    skill = await db.getSkillBySlug(c.get('db'), 'default', id, user.id);
  }
  if (!skill) {
    return c.json({ error: 'Skill not found' }, 404);
  }

  // Private skills only visible to owner
  if (skill.visibility === 'private' && skill.ownerId !== user.id) {
    return c.json({ error: 'Skill not found' }, 404);
  }

  return c.json({ skill });
});

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
}

const createSkillSchema = z.object({
  name: z.string().min(1).max(100),
  slug: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with dashes').optional(),
  description: z.string().max(500).optional(),
  content: z.string().min(1),
  visibility: z.enum(['private', 'shared']).default('private'),
});

/**
 * POST /api/skills
 * Create a managed skill.
 */
skillsRouter.post('/', zValidator('json', createSkillSchema), async (c) => {
  const user = c.get('user');
  const body = c.req.valid('json');

  const skill = await db.createSkill(c.get('db'), {
    id: crypto.randomUUID(),
    orgId: 'default',
    ownerId: user.id,
    source: 'managed',
    name: body.name,
    slug: body.slug || slugify(body.name),
    description: body.description,
    content: body.content,
    visibility: body.visibility,
  });

  return c.json({ skill }, 201);
});

const updateSkillSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  slug: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/).optional(),
  description: z.string().max(500).optional(),
  content: z.string().min(1).optional(),
  visibility: z.enum(['private', 'shared']).optional(),
});

/**
 * PUT /api/skills/:id
 * Update a managed skill (owner only).
 */
skillsRouter.put('/:id', zValidator('json', updateSkillSchema), async (c) => {
  const user = c.get('user');
  const { id } = c.req.param();

  const skill = await db.getSkill(c.get('db'), id);
  if (!skill) {
    return c.json({ error: 'Skill not found' }, 404);
  }

  if (skill.source !== 'managed') {
    return c.json({ error: 'Only managed skills can be updated' }, 403);
  }

  if (skill.ownerId !== user.id) {
    return c.json({ error: 'Only the owner can update this skill' }, 403);
  }

  const body = c.req.valid('json');
  await db.updateSkill(c.get('db'), id, body);
  return c.json({ skill: { ...skill, ...body } });
});

/**
 * DELETE /api/skills/:id
 * Delete a managed skill (owner only).
 */
skillsRouter.delete('/:id', async (c) => {
  const user = c.get('user');
  const { id } = c.req.param();

  const skill = await db.getSkill(c.get('db'), id);
  if (!skill) {
    return c.json({ error: 'Skill not found' }, 404);
  }

  if (skill.source !== 'managed') {
    return c.json({ error: 'Only managed skills can be deleted' }, 403);
  }

  if (skill.ownerId !== user.id) {
    return c.json({ error: 'Only the owner can delete this skill' }, 403);
  }

  await db.deleteSkill(c.get('db'), id);
  return c.json({ deleted: true });
});
