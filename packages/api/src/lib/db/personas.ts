import type { D1Database } from '@cloudflare/workers-types';
import type { AppDb } from '../drizzle.js';
import type { AgentPersona, AgentPersonaFile, PersonaVisibility } from '@valet/shared';
import { eq, and, sql, asc } from 'drizzle-orm';
import { getDb } from '../drizzle.js';
import { agentPersonas, agentPersonaFiles, orgRepoPersonaDefaults, personaTools, personaSkills } from '../schema/index.js';

export async function createPersona(
  db: AppDb,
  data: { id: string; name: string; slug: string; description?: string; icon?: string; defaultModel?: string; visibility?: PersonaVisibility; isDefault?: boolean; createdBy: string }
): Promise<AgentPersona> {
  if (data.isDefault) {
    await db
      .update(agentPersonas)
      .set({ isDefault: false })
      .where(and(eq(agentPersonas.orgId, 'default'), eq(agentPersonas.isDefault, true)));
  }

  await db.insert(agentPersonas).values({
    id: data.id,
    name: data.name,
    slug: data.slug,
    description: data.description || null,
    icon: data.icon || null,
    defaultModel: data.defaultModel || null,
    visibility: data.visibility || 'shared',
    isDefault: !!data.isDefault,
    createdBy: data.createdBy,
  });

  return {
    id: data.id,
    orgId: 'default',
    name: data.name,
    slug: data.slug,
    description: data.description,
    icon: data.icon,
    defaultModel: data.defaultModel,
    visibility: data.visibility || 'shared',
    isDefault: !!data.isDefault,
    createdBy: data.createdBy,
    fileCount: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export async function listPersonas(db: D1Database, userId: string, orgId: string = 'default'): Promise<AgentPersona[]> {
  // Subquery for file_count — use raw SQL for the subquery
  const result = await db
    .prepare(
      `SELECT p.*, u.name as creator_name,
              (SELECT COUNT(*) FROM agent_persona_files f WHERE f.persona_id = p.id) as file_count
       FROM agent_personas p
       LEFT JOIN users u ON u.id = p.created_by
       WHERE p.org_id = ?
         AND (p.visibility = 'shared' OR p.created_by = ?)
       ORDER BY p.is_default DESC, p.name ASC`
    )
    .bind(orgId, userId)
    .all();

  return (result.results || []).map((row: any): AgentPersona => ({
    id: row.id,
    orgId: row.org_id,
    name: row.name,
    slug: row.slug,
    description: row.description || undefined,
    icon: row.icon || undefined,
    defaultModel: row.default_model || undefined,
    visibility: row.visibility as PersonaVisibility,
    isDefault: !!row.is_default,
    createdBy: row.created_by,
    creatorName: row.creator_name || undefined,
    fileCount: row.file_count ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export async function getPersonaWithFiles(db: D1Database, id: string): Promise<AgentPersona | null> {
  const drizzle = getDb(db);

  // Main persona with creator name via raw SQL for the join
  const row = await db
    .prepare(
      `SELECT p.*, u.name as creator_name
       FROM agent_personas p
       LEFT JOIN users u ON u.id = p.created_by
       WHERE p.id = ?`
    )
    .bind(id)
    .first<any>();

  if (!row) return null;

  const files = await drizzle
    .select()
    .from(agentPersonaFiles)
    .where(eq(agentPersonaFiles.personaId, id))
    .orderBy(asc(agentPersonaFiles.sortOrder), asc(agentPersonaFiles.filename));

  const persona: AgentPersona = {
    id: row.id,
    orgId: row.org_id,
    name: row.name,
    slug: row.slug,
    description: row.description || undefined,
    icon: row.icon || undefined,
    defaultModel: row.default_model || undefined,
    visibility: row.visibility as PersonaVisibility,
    isDefault: !!row.is_default,
    createdBy: row.created_by,
    creatorName: row.creator_name || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };

  persona.files = files.map((f): AgentPersonaFile => ({
    id: f.id,
    personaId: f.personaId,
    filename: f.filename,
    content: f.content,
    sortOrder: f.sortOrder ?? 0,
    createdAt: f.createdAt,
    updatedAt: f.updatedAt,
  }));

  return persona;
}

export async function updatePersona(
  db: AppDb,
  id: string,
  updates: Partial<Pick<AgentPersona, 'name' | 'slug' | 'description' | 'icon' | 'defaultModel' | 'visibility' | 'isDefault'>>
): Promise<void> {
  const setValues: Record<string, unknown> = {};

  if (updates.name !== undefined) setValues.name = updates.name;
  if (updates.slug !== undefined) setValues.slug = updates.slug;
  if (updates.description !== undefined) setValues.description = updates.description || null;
  if (updates.icon !== undefined) setValues.icon = updates.icon || null;
  if (updates.defaultModel !== undefined) setValues.defaultModel = updates.defaultModel || null;
  if (updates.visibility !== undefined) setValues.visibility = updates.visibility;
  if (updates.isDefault !== undefined) {
    if (updates.isDefault) {
      await db
        .update(agentPersonas)
        .set({ isDefault: false })
        .where(and(eq(agentPersonas.orgId, 'default'), eq(agentPersonas.isDefault, true)));
    }
    setValues.isDefault = updates.isDefault;
  }

  if (Object.keys(setValues).length === 0) return;

  setValues.updatedAt = sql`datetime('now')`;
  await db
    .update(agentPersonas)
    .set(setValues)
    .where(eq(agentPersonas.id, id));
}

export async function deletePersona(db: AppDb, id: string): Promise<void> {
  // Clean up related rows before deleting the persona
  await db.delete(personaTools).where(eq(personaTools.personaId, id));
  await db.delete(personaSkills).where(eq(personaSkills.personaId, id));
  await db.delete(agentPersonaFiles).where(eq(agentPersonaFiles.personaId, id));
  await db.delete(agentPersonas).where(eq(agentPersonas.id, id));
}

// Persona File Operations
export async function upsertPersonaFile(
  db: AppDb,
  data: { id: string; personaId: string; filename: string; content: string; sortOrder?: number }
): Promise<void> {
  await db.insert(agentPersonaFiles).values({
    id: data.id,
    personaId: data.personaId,
    filename: data.filename,
    content: data.content,
    sortOrder: data.sortOrder ?? 0,
  }).onConflictDoUpdate({
    target: [agentPersonaFiles.personaId, agentPersonaFiles.filename],
    set: {
      content: sql`excluded.content`,
      sortOrder: sql`excluded.sort_order`,
      updatedAt: sql`datetime('now')`,
    },
  });
}

export async function deletePersonaFile(db: AppDb, id: string): Promise<void> {
  await db.delete(agentPersonaFiles).where(eq(agentPersonaFiles.id, id));
}

// Repo-Persona Default Operations
export async function setRepoPersonaDefault(db: AppDb, orgRepoId: string, personaId: string): Promise<void> {
  const id = crypto.randomUUID();
  await db.insert(orgRepoPersonaDefaults).values({
    id,
    orgRepoId,
    personaId,
  }).onConflictDoUpdate({
    target: orgRepoPersonaDefaults.orgRepoId,
    set: { personaId: sql`excluded.persona_id` },
  });
}

export async function getRepoPersonaDefault(db: AppDb, orgRepoId: string): Promise<string | null> {
  const row = await db
    .select({ personaId: orgRepoPersonaDefaults.personaId })
    .from(orgRepoPersonaDefaults)
    .where(eq(orgRepoPersonaDefaults.orgRepoId, orgRepoId))
    .get();
  return row?.personaId || null;
}

export async function deleteRepoPersonaDefault(db: AppDb, orgRepoId: string): Promise<void> {
  await db.delete(orgRepoPersonaDefaults).where(eq(orgRepoPersonaDefaults.orgRepoId, orgRepoId));
}
