import type { D1Database } from '@cloudflare/workers-types';
import type { AppDb } from '../lib/drizzle.js';
import {
  listPersonas,
  getPersonaWithFiles,
  createPersona,
  updatePersona,
  deletePersona,
  upsertPersonaFile,
  attachSkillToPersona,
  detachSkillFromPersona,
  getPersonaSkillsForApi,
  getSkill,
} from '../lib/db.js';

// ─── listPersonas ─────────────────────────────────────────────────────────────

export async function listPersonasForRunner(
  envDB: D1Database,
  userId: string,
) {
  return listPersonas(envDB, userId);
}

// ─── handlePersonaAction ──────────────────────────────────────────────────────

export type PersonaActionResult =
  | { data: Record<string, unknown>; statusCode?: undefined; error?: undefined }
  | { error: string; statusCode: number; data?: undefined };

export async function handlePersonaAction(
  db: AppDb,
  envDB: D1Database,
  userId: string,
  action: string,
  payload?: Record<string, unknown>,
): Promise<PersonaActionResult> {
  if (action === 'get') {
    const id = payload?.id as string;
    if (!id) {
      return { error: 'id is required', statusCode: 400 };
    }
    const persona = await getPersonaWithFiles(envDB, id);
    if (!persona) {
      return { error: 'Persona not found', statusCode: 404 };
    }
    if (persona.visibility === 'private' && persona.createdBy !== userId) {
      return { error: 'Persona not found', statusCode: 404 };
    }
    return { data: { persona } };
  }

  if (action === 'create') {
    const name = payload?.name as string;
    const slug = payload?.slug as string;
    if (!name || !slug) {
      return { error: 'name and slug are required', statusCode: 400 };
    }
    const personaId = crypto.randomUUID();
    const persona = await createPersona(db, {
      id: personaId,
      name,
      slug,
      description: payload?.description as string | undefined,
      icon: payload?.icon as string | undefined,
      defaultModel: payload?.defaultModel as string | undefined,
      visibility: (payload?.visibility as 'private' | 'shared') || 'shared',
      createdBy: userId,
    });
    // Create inline files if provided
    const files = payload?.files as Array<{ filename: string; content: string; sortOrder?: number }> | undefined;
    if (files?.length) {
      for (const file of files) {
        await upsertPersonaFile(db, {
          id: crypto.randomUUID(),
          personaId,
          filename: file.filename,
          content: file.content,
          sortOrder: file.sortOrder ?? 0,
        });
      }
    }
    return { data: { persona } };
  }

  if (action === 'update') {
    const id = payload?.id as string;
    if (!id) {
      return { error: 'id is required', statusCode: 400 };
    }
    const persona = await getPersonaWithFiles(envDB, id);
    if (!persona) {
      return { error: 'Persona not found', statusCode: 404 };
    }
    if (persona.createdBy !== userId) {
      return { error: 'Only the creator can update this persona', statusCode: 403 };
    }
    const updates: Record<string, unknown> = {};
    if (payload?.name) updates.name = payload.name;
    if (payload?.slug) updates.slug = payload.slug;
    if (payload?.description !== undefined) updates.description = payload.description;
    if (payload?.icon !== undefined) updates.icon = payload.icon;
    if (payload?.defaultModel !== undefined) updates.defaultModel = payload.defaultModel;
    if (payload?.visibility) updates.visibility = payload.visibility;
    await updatePersona(db, id, updates);
    return { data: { ok: true } };
  }

  if (action === 'delete') {
    const id = payload?.id as string;
    if (!id) {
      return { error: 'id is required', statusCode: 400 };
    }
    const persona = await getPersonaWithFiles(envDB, id);
    if (!persona) {
      return { error: 'Persona not found', statusCode: 404 };
    }
    if (persona.createdBy !== userId) {
      return { error: 'Only the creator can delete this persona', statusCode: 403 };
    }
    await deletePersona(db, id);
    return { data: { deleted: true } };
  }

  if (action === 'upsert-file') {
    const personaId = payload?.personaId as string;
    const filename = payload?.filename as string;
    const content = payload?.content as string;
    if (!personaId || !filename || !content) {
      return { error: 'personaId, filename, and content are required', statusCode: 400 };
    }
    const persona = await getPersonaWithFiles(envDB, personaId);
    if (!persona) {
      return { error: 'Persona not found', statusCode: 404 };
    }
    if (persona.createdBy !== userId) {
      return { error: 'Only the creator can edit this persona', statusCode: 403 };
    }
    await upsertPersonaFile(db, {
      id: crypto.randomUUID(),
      personaId,
      filename,
      content,
      sortOrder: (payload?.sortOrder as number) ?? 0,
    });
    return { data: { ok: true } };
  }

  if (action === 'list-skills') {
    const personaId = payload?.personaId as string;
    if (!personaId) {
      return { error: 'personaId is required', statusCode: 400 };
    }
    const persona = await getPersonaWithFiles(envDB, personaId);
    if (!persona) {
      return { error: 'Persona not found', statusCode: 404 };
    }
    if (persona.visibility === 'private' && persona.createdBy !== userId) {
      return { error: 'Persona not found', statusCode: 404 };
    }
    const skills = await getPersonaSkillsForApi(db, personaId);
    return { data: { skills } };
  }

  if (action === 'attach-skill') {
    const personaId = payload?.personaId as string;
    const skillId = payload?.skillId as string;
    const sortOrder = (payload?.sortOrder as number) ?? 0;
    if (!personaId || !skillId) {
      return { error: 'personaId and skillId are required', statusCode: 400 };
    }
    const persona = await getPersonaWithFiles(envDB, personaId);
    if (!persona) {
      return { error: 'Persona not found', statusCode: 404 };
    }
    if (persona.createdBy !== userId) {
      return { error: 'Only the creator can modify this persona', statusCode: 403 };
    }
    const skill = await getSkill(db, skillId);
    if (!skill) {
      return { error: 'Skill not found', statusCode: 404 };
    }
    await attachSkillToPersona(db, crypto.randomUUID(), personaId, skillId, sortOrder);
    return { data: { attached: true } };
  }

  if (action === 'detach-skill') {
    const personaId = payload?.personaId as string;
    const skillId = payload?.skillId as string;
    if (!personaId || !skillId) {
      return { error: 'personaId and skillId are required', statusCode: 400 };
    }
    const persona = await getPersonaWithFiles(envDB, personaId);
    if (!persona) {
      return { error: 'Persona not found', statusCode: 404 };
    }
    if (persona.createdBy !== userId) {
      return { error: 'Only the creator can modify this persona', statusCode: 403 };
    }
    const changes = await detachSkillFromPersona(db, personaId, skillId);
    if (changes === 0) {
      return { error: 'Skill was not attached to this persona', statusCode: 404 };
    }
    return { data: { detached: true } };
  }

  return { error: `Unsupported persona action: ${action}`, statusCode: 400 };
}
