import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { ForbiddenError } from '@valet/shared';
import type { Env, Variables } from '../env.js';
import * as db from '../lib/db.js';

export const personasRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

const createPersonaSchema = z.object({
  name: z.string().min(1).max(100),
  slug: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with dashes'),
  description: z.string().max(500).optional(),
  icon: z.string().max(10).optional(),
  defaultModel: z.string().max(255).optional(),
  visibility: z.enum(['private', 'shared']).default('shared'),
  isDefault: z.boolean().optional(),
  files: z
    .array(
      z.object({
        filename: z.string().min(1).max(100),
        content: z.string().min(1),
        sortOrder: z.number().int().min(0).default(0),
      })
    )
    .optional(),
});

/**
 * GET /api/personas
 * List visible personas (all shared + user's own private).
 */
personasRouter.get('/', async (c) => {
  const user = c.get('user');
  const personas = await db.listPersonas(c.env.DB, user.id);
  return c.json({ personas });
});

/**
 * GET /api/personas/:id
 * Get persona with files.
 */
personasRouter.get('/:id', async (c) => {
  const user = c.get('user');
  const { id } = c.req.param();

  const persona = await db.getPersonaWithFiles(c.env.DB, id);
  if (!persona) {
    return c.json({ error: 'Persona not found' }, 404);
  }

  // Check visibility
  if (persona.visibility === 'private' && persona.createdBy !== user.id) {
    return c.json({ error: 'Persona not found' }, 404);
  }

  return c.json({ persona });
});

/**
 * POST /api/personas
 * Create a persona (with optional inline files).
 */
personasRouter.post('/', zValidator('json', createPersonaSchema), async (c) => {
  const user = c.get('user');
  const body = c.req.valid('json');

  // Only admins can set is_default
  if (body.isDefault && user.role !== 'admin') {
    throw new ForbiddenError('Only admins can set a default persona');
  }

  const personaId = crypto.randomUUID();

  const persona = await db.createPersona(c.get('db'), {
    id: personaId,
    name: body.name,
    slug: body.slug,
    description: body.description,
    icon: body.icon,
    defaultModel: body.defaultModel,
    visibility: body.visibility,
    isDefault: body.isDefault,
    createdBy: user.id,
  });

  // Create inline files if provided
  if (body.files?.length) {
    for (const file of body.files) {
      await db.upsertPersonaFile(c.get('db'), {
        id: crypto.randomUUID(),
        personaId,
        filename: file.filename,
        content: file.content,
        sortOrder: file.sortOrder,
      });
    }
  }

  return c.json({ persona }, 201);
});

const updatePersonaSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  slug: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/).optional(),
  description: z.string().max(500).optional(),
  icon: z.string().max(10).optional(),
  defaultModel: z.string().max(255).optional(),
  visibility: z.enum(['private', 'shared']).optional(),
  isDefault: z.boolean().optional(),
});

/**
 * PUT /api/personas/:id
 * Update persona (creator or admin only).
 */
personasRouter.put('/:id', zValidator('json', updatePersonaSchema), async (c) => {
  const user = c.get('user');
  const { id } = c.req.param();
  const body = c.req.valid('json');

  const persona = await db.getPersonaWithFiles(c.env.DB, id);
  if (!persona) {
    return c.json({ error: 'Persona not found' }, 404);
  }

  // Only creator or admin can edit
  if (persona.createdBy !== user.id && user.role !== 'admin') {
    throw new ForbiddenError('Only the creator or an admin can edit this persona');
  }

  // Only admins can set is_default
  if (body.isDefault !== undefined && user.role !== 'admin') {
    throw new ForbiddenError('Only admins can set a default persona');
  }

  await db.updatePersona(c.get('db'), id, body);
  return c.json({ ok: true });
});

/**
 * DELETE /api/personas/:id
 * Delete persona (creator or admin only).
 */
personasRouter.delete('/:id', async (c) => {
  const user = c.get('user');
  const { id } = c.req.param();

  const persona = await db.getPersonaWithFiles(c.env.DB, id);
  if (!persona) {
    return c.json({ error: 'Persona not found' }, 404);
  }

  if (persona.createdBy !== user.id && user.role !== 'admin') {
    throw new ForbiddenError('Only the creator or an admin can delete this persona');
  }

  await db.deletePersona(c.get('db'), id);
  return c.json({ ok: true });
});

const bulkFilesSchema = z.array(
  z.object({
    filename: z.string().min(1).max(100),
    content: z.string().min(1),
    sortOrder: z.number().int().min(0).default(0),
  })
);

/**
 * PUT /api/personas/:id/files
 * Bulk replace persona files.
 */
personasRouter.put('/:id/files', zValidator('json', bulkFilesSchema), async (c) => {
  const user = c.get('user');
  const { id } = c.req.param();
  const files = c.req.valid('json');

  const persona = await db.getPersonaWithFiles(c.env.DB, id);
  if (!persona) {
    return c.json({ error: 'Persona not found' }, 404);
  }

  if (persona.createdBy !== user.id && user.role !== 'admin') {
    throw new ForbiddenError('Only the creator or an admin can edit this persona');
  }

  // Delete existing files
  if (persona.files?.length) {
    for (const f of persona.files) {
      await db.deletePersonaFile(c.get('db'), f.id);
    }
  }

  // Insert new files
  for (const file of files) {
    await db.upsertPersonaFile(c.get('db'), {
      id: crypto.randomUUID(),
      personaId: id,
      filename: file.filename,
      content: file.content,
      sortOrder: file.sortOrder,
    });
  }

  return c.json({ ok: true });
});

const singleFileSchema = z.object({
  filename: z.string().min(1).max(100),
  content: z.string().min(1),
  sortOrder: z.number().int().min(0).default(0),
});

/**
 * POST /api/personas/:id/files
 * Add/update a single file.
 */
personasRouter.post('/:id/files', zValidator('json', singleFileSchema), async (c) => {
  const user = c.get('user');
  const { id } = c.req.param();
  const body = c.req.valid('json');

  const persona = await db.getPersonaWithFiles(c.env.DB, id);
  if (!persona) {
    return c.json({ error: 'Persona not found' }, 404);
  }

  if (persona.createdBy !== user.id && user.role !== 'admin') {
    throw new ForbiddenError('Only the creator or an admin can edit this persona');
  }

  await db.upsertPersonaFile(c.get('db'), {
    id: crypto.randomUUID(),
    personaId: id,
    filename: body.filename,
    content: body.content,
    sortOrder: body.sortOrder,
  });

  return c.json({ ok: true });
});

/**
 * DELETE /api/personas/:id/files/:fileId
 * Delete a persona file.
 */
personasRouter.delete('/:id/files/:fileId', async (c) => {
  const user = c.get('user');
  const { id, fileId } = c.req.param();

  const persona = await db.getPersonaWithFiles(c.env.DB, id);
  if (!persona) {
    return c.json({ error: 'Persona not found' }, 404);
  }

  if (persona.createdBy !== user.id && user.role !== 'admin') {
    throw new ForbiddenError('Only the creator or an admin can edit this persona');
  }

  await db.deletePersonaFile(c.get('db'), fileId);
  return c.json({ ok: true });
});

// ─── Persona-Skill Attachments ─────────────────────────────────────────────

/**
 * GET /api/personas/:id/skills
 * List skills attached to a persona.
 */
personasRouter.get('/:id/skills', async (c) => {
  const user = c.get('user');
  const { id } = c.req.param();

  const persona = await db.getPersonaWithFiles(c.env.DB, id);
  if (!persona) {
    return c.json({ error: 'Persona not found' }, 404);
  }

  // Check visibility: private personas only visible to creator or admin
  if (persona.visibility === 'private' && persona.createdBy !== user.id && user.role !== 'admin') {
    return c.json({ error: 'Persona not found' }, 404);
  }

  const skills = await db.getPersonaSkillsForApi(c.get('db'), id);
  return c.json({ skills });
});

const attachSkillSchema = z.object({
  skillId: z.string().min(1),
  sortOrder: z.number().int().min(0).optional(),
});

/**
 * POST /api/personas/:id/skills
 * Attach a skill to a persona (creator or admin only).
 */
personasRouter.post('/:id/skills', zValidator('json', attachSkillSchema), async (c) => {
  const user = c.get('user');
  const { id } = c.req.param();
  const body = c.req.valid('json');

  const persona = await db.getPersonaWithFiles(c.env.DB, id);
  if (!persona) {
    return c.json({ error: 'Persona not found' }, 404);
  }
  if (persona.createdBy !== user.id && user.role !== 'admin') {
    throw new ForbiddenError('Only the creator or an admin can edit this persona');
  }

  await db.attachSkillToPersona(c.get('db'), crypto.randomUUID(), id, body.skillId, body.sortOrder ?? 0);
  return c.json({ attached: true }, 201);
});

/**
 * DELETE /api/personas/:id/skills/:skillId
 * Detach a skill from a persona (creator or admin only).
 */
personasRouter.delete('/:id/skills/:skillId', async (c) => {
  const user = c.get('user');
  const { id, skillId } = c.req.param();

  const persona = await db.getPersonaWithFiles(c.env.DB, id);
  if (!persona) {
    return c.json({ error: 'Persona not found' }, 404);
  }
  if (persona.createdBy !== user.id && user.role !== 'admin') {
    throw new ForbiddenError('Only the creator or an admin can edit this persona');
  }

  await db.detachSkillFromPersona(c.get('db'), id, skillId);
  return c.json({ detached: true });
});

// ─── Persona-Tool Configuration ─────────────────────────────────────────────

/**
 * GET /api/personas/:id/tools
 * List tool configurations for a persona.
 */
personasRouter.get('/:id/tools', async (c) => {
  const user = c.get('user');
  const { id } = c.req.param();

  const persona = await db.getPersonaWithFiles(c.env.DB, id);
  if (!persona) {
    return c.json({ error: 'Persona not found' }, 404);
  }

  // Check visibility: private personas only visible to creator or admin
  if (persona.visibility === 'private' && persona.createdBy !== user.id && user.role !== 'admin') {
    return c.json({ error: 'Persona not found' }, 404);
  }

  const tools = await db.getPersonaTools(c.get('db'), id);
  return c.json({ tools });
});

const setPersonaToolsSchema = z.object({
  tools: z.array(
    z.object({
      service: z.string().min(1),
      actionId: z.string().min(1).optional(),
      enabled: z.boolean(),
    })
  ),
});

/**
 * PUT /api/personas/:id/tools
 * Replace all tool configuration for a persona (creator or admin only).
 */
personasRouter.put('/:id/tools', zValidator('json', setPersonaToolsSchema), async (c) => {
  const user = c.get('user');
  const { id } = c.req.param();
  const body = c.req.valid('json');

  const persona = await db.getPersonaWithFiles(c.env.DB, id);
  if (!persona) {
    return c.json({ error: 'Persona not found' }, 404);
  }

  if (persona.createdBy !== user.id && user.role !== 'admin') {
    throw new ForbiddenError('Only the creator or an admin can edit this persona');
  }

  await db.setPersonaTools(c.get('db'), id, body.tools);
  return c.json({ ok: true });
});
