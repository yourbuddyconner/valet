import type { AppDb } from '../lib/drizzle.js';
import {
  searchSkills,
  listSkills,
  getSkill,
  getSkillBySlug,
  createSkill,
  updateSkill,
  deleteSkill,
} from '../lib/db.js';

// ─── handleSkillAction ────────────────────────────────────────────────────────

export type SkillActionResult =
  | { data: Record<string, unknown>; statusCode?: undefined; error?: undefined }
  | { error: string; statusCode: number; data?: undefined };

export async function handleSkillAction(
  db: AppDb,
  orgId: string,
  userId: string,
  action: string,
  payload?: Record<string, unknown>,
): Promise<SkillActionResult> {
  if (action === 'search') {
    const q = typeof payload?.q === 'string' ? payload.q : '';
    const source = typeof payload?.source === 'string' ? payload.source as any : undefined;
    const skills = await searchSkills(db, orgId, userId, q, { source });
    return { data: { skills } };
  }

  if (action === 'list') {
    const source = typeof payload?.source === 'string' ? payload.source as any : undefined;
    const visibility = typeof payload?.visibility === 'string' ? payload.visibility as any : undefined;
    const skills = await listSkills(db, orgId, userId, { source, visibility });
    return { data: { skills } };
  }

  if (action === 'get') {
    const id = typeof payload?.id === 'string' ? payload.id : '';
    if (!id) {
      return { error: 'id is required', statusCode: 400 };
    }
    // Try by ID first, then fall back to slug lookup
    let skill = await getSkill(db, id);
    if (!skill) {
      skill = await getSkillBySlug(db, orgId, id, userId);
    }
    if (!skill) {
      return { error: 'Skill not found', statusCode: 404 };
    }
    if (skill.visibility === 'private' && skill.ownerId !== userId) {
      return { error: 'Skill not found', statusCode: 404 };
    }
    return { data: { skill } };
  }

  if (action === 'create') {
    const name = typeof payload?.name === 'string' ? payload.name.trim() : '';
    const content = typeof payload?.content === 'string' ? payload.content : '';
    if (!name || !content) {
      return { error: 'name and content are required', statusCode: 400 };
    }
    const slug = typeof payload?.slug === 'string' && payload.slug.trim()
      ? payload.slug.trim()
      : name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100);
    const description = typeof payload?.description === 'string' ? payload.description : undefined;
    const visibility = payload?.visibility === 'shared' ? 'shared' as const : 'private' as const;
    const skill = await createSkill(db, {
      id: crypto.randomUUID(),
      orgId,
      ownerId: userId,
      source: 'managed',
      name,
      slug,
      description,
      content,
      visibility,
    });
    return { data: { skill } };
  }

  if (action === 'update') {
    const id = typeof payload?.id === 'string' ? payload.id : '';
    if (!id) {
      return { error: 'id is required', statusCode: 400 };
    }
    const skill = await getSkill(db, id);
    if (!skill) {
      return { error: 'Skill not found', statusCode: 404 };
    }
    if (skill.source !== 'managed') {
      return { error: 'Only managed skills can be updated', statusCode: 403 };
    }
    if (skill.ownerId !== userId) {
      return { error: 'Only the owner can update this skill', statusCode: 403 };
    }
    const updates: Record<string, string> = {};
    if (typeof payload?.name === 'string') updates.name = payload.name;
    if (typeof payload?.slug === 'string') updates.slug = payload.slug;
    if (typeof payload?.description === 'string') updates.description = payload.description;
    if (typeof payload?.content === 'string') updates.content = payload.content;
    if (typeof payload?.visibility === 'string') updates.visibility = payload.visibility;
    await updateSkill(db, id, updates);
    return { data: { skill: { ...skill, ...updates } } };
  }

  if (action === 'delete') {
    const id = typeof payload?.id === 'string' ? payload.id : '';
    if (!id) {
      return { error: 'id is required', statusCode: 400 };
    }
    const skill = await getSkill(db, id);
    if (!skill) {
      return { error: 'Skill not found', statusCode: 404 };
    }
    if (skill.source !== 'managed') {
      return { error: 'Only managed skills can be deleted', statusCode: 403 };
    }
    if (skill.ownerId !== userId) {
      return { error: 'Only the owner can delete this skill', statusCode: 403 };
    }
    await deleteSkill(db, id);
    return { data: { deleted: true } };
  }

  return { error: `Unsupported skill action: ${action}`, statusCode: 400 };
}
