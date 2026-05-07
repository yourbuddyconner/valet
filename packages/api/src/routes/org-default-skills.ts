import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import type { Env, Variables } from '../env.js';
import { adminMiddleware } from '../middleware/admin.js';
import { ValidationError } from '@valet/shared';
import { getOrgDefaultSkillsRich, setOrgDefaultSkills, validateSkillIds } from '../lib/db.js';

export const orgDefaultSkillsRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

// All org default skill routes require admin role
orgDefaultSkillsRouter.use('*', adminMiddleware);

// GET / — list org default skills
orgDefaultSkillsRouter.get('/', async (c) => {
  const db = c.get('db');
  const skills = await getOrgDefaultSkillsRich(db, 'default');
  return c.json({ skills });
});

const setOrgDefaultSkillsSchema = z.object({
  skillIds: z.array(z.string().min(1)),
});

// PUT / — replace org default skills
orgDefaultSkillsRouter.put('/', zValidator('json', setOrgDefaultSkillsSchema), async (c) => {
  const db = c.get('db');
  const { skillIds } = c.req.valid('json');

  // Validate all skill IDs exist
  if (skillIds.length > 0) {
    const validIds = await validateSkillIds(db, skillIds);
    const invalidIds = skillIds.filter((id) => !validIds.has(id));
    if (invalidIds.length > 0) {
      throw new ValidationError(`Invalid skill IDs: ${invalidIds.join(', ')}`);
    }
  }

  await setOrgDefaultSkills(db, 'default', skillIds);
  return c.json({ updated: true });
});
