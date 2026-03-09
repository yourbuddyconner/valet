import { eq, and, or, sql, asc, inArray } from 'drizzle-orm';
import type { AppDb } from '../drizzle.js';
import { skills, personaSkills, orgDefaultSkills } from '../schema/index.js';
import type { Skill, SkillSummary, SkillSource, SkillVisibility } from '@valet/shared';

// ─── Types ──────────────────────────────────────────────────────────────────

export type SkillRecord = typeof skills.$inferSelect;
export type PersonaSkillRecord = typeof personaSkills.$inferSelect;
export type OrgDefaultSkillRecord = typeof orgDefaultSkills.$inferSelect;

export type SkillDeliveryItem = { filename: string; content: string };

export type ListSkillsFilters = {
  source?: SkillSource;
  visibility?: SkillVisibility;
  status?: string;
};

// ─── FTS Sync ───────────────────────────────────────────────────────────────

async function syncSkillFts(db: AppDb, skillId: string): Promise<void> {
  // Delete existing FTS entry by matching rowid via subquery
  await db.run(sql`
    DELETE FROM skills_fts WHERE rowid = (SELECT rowid FROM skills WHERE id = ${skillId})
  `);
  // Re-insert from skills table
  await db.run(sql`
    INSERT INTO skills_fts(rowid, name, description, content)
    SELECT rowid, name, COALESCE(description, ''), content FROM skills WHERE id = ${skillId}
  `);
}

async function deleteSkillFts(db: AppDb, skillId: string): Promise<void> {
  await db.run(sql`
    DELETE FROM skills_fts WHERE rowid = (SELECT rowid FROM skills WHERE id = ${skillId})
  `);
}

// ─── CRUD ───────────────────────────────────────────────────────────────────

export async function createSkill(
  db: AppDb,
  data: {
    id: string;
    orgId?: string;
    ownerId?: string | null;
    source?: SkillSource;
    name: string;
    slug: string;
    description?: string | null;
    content: string;
    visibility?: SkillVisibility;
    status?: string;
  },
): Promise<Skill> {
  const row = {
    id: data.id,
    orgId: data.orgId ?? 'default',
    ownerId: data.ownerId ?? null,
    source: data.source ?? 'managed',
    name: data.name,
    slug: data.slug,
    description: data.description ?? null,
    content: data.content,
    visibility: data.visibility ?? 'private',
    status: data.status ?? 'active',
  };

  await db.insert(skills).values(row);
  await syncSkillFts(db, data.id);

  return {
    ...row,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export async function updateSkill(
  db: AppDb,
  id: string,
  updates: Partial<Pick<Skill, 'name' | 'slug' | 'description' | 'content' | 'visibility' | 'status'>>,
): Promise<void> {
  const setValues: Record<string, unknown> = {};

  if (updates.name !== undefined) setValues.name = updates.name;
  if (updates.slug !== undefined) setValues.slug = updates.slug;
  if (updates.description !== undefined) setValues.description = updates.description;
  if (updates.content !== undefined) setValues.content = updates.content;
  if (updates.visibility !== undefined) setValues.visibility = updates.visibility;
  if (updates.status !== undefined) setValues.status = updates.status;

  if (Object.keys(setValues).length === 0) return;

  setValues.updatedAt = sql`datetime('now')`;
  await db.update(skills).set(setValues).where(eq(skills.id, id));
  await syncSkillFts(db, id);
}

export async function deleteSkill(db: AppDb, id: string): Promise<void> {
  await deleteSkillFts(db, id);
  await db.delete(personaSkills).where(eq(personaSkills.skillId, id));
  await db.delete(orgDefaultSkills).where(eq(orgDefaultSkills.skillId, id));
  await db.delete(skills).where(eq(skills.id, id));
}

export async function getSkill(db: AppDb, id: string): Promise<Skill | null> {
  const row = await db.select().from(skills).where(eq(skills.id, id)).get();
  if (!row) return null;
  return rowToSkill(row);
}

export async function getSkillBySlug(
  db: AppDb,
  orgId: string,
  slug: string,
  userId?: string,
): Promise<Skill | null> {
  const baseConditions = [eq(skills.orgId, orgId), eq(skills.slug, slug)];

  if (userId !== undefined) {
    // Return skills the user can see: their own private skills OR shared skills
    const row = await db
      .select()
      .from(skills)
      .where(and(
        ...baseConditions,
        or(eq(skills.ownerId, userId), eq(skills.visibility, 'shared')),
      ))
      .get();
    if (!row) return null;
    return rowToSkill(row);
  }

  // No userId hint — return any matching skill (legacy behavior)
  const row = await db.select().from(skills).where(and(...baseConditions)).get();
  if (!row) return null;
  return rowToSkill(row);
}

// ─── Search & List ──────────────────────────────────────────────────────────

export async function searchSkills(
  db: AppDb,
  orgId: string,
  userId: string,
  query: string,
  options?: { source?: SkillSource; limit?: number },
): Promise<SkillSummary[]> {
  const limit = options?.limit ?? 20;

  let q = sql`
    SELECT s.id, s.name, s.slug, s.description, s.source, s.visibility, s.owner_id as "ownerId", s.updated_at as "updatedAt"
    FROM skills s
    INNER JOIN skills_fts f ON f.rowid = s.rowid
    WHERE f.skills_fts MATCH ${query}
      AND s.org_id = ${orgId}
      AND s.status = 'active'
      AND (s.visibility = 'shared' OR s.owner_id = ${userId})
  `;

  if (options?.source) {
    q = sql`${q} AND s.source = ${options.source}`;
  }

  q = sql`${q} ORDER BY rank LIMIT ${limit}`;

  const results = await db.all<SkillSummary>(q);
  return results;
}

export async function listSkills(
  db: AppDb,
  orgId: string,
  userId: string,
  filters?: ListSkillsFilters,
): Promise<SkillSummary[]> {
  const status = filters?.status ?? 'active';

  // Base query with visibility check
  let query = sql`
    SELECT s.id, s.name, s.slug, s.description, s.source, s.visibility, s.owner_id as "ownerId", s.updated_at as "updatedAt"
    FROM skills s
    WHERE s.org_id = ${orgId}
      AND s.status = ${status}
      AND (s.visibility = 'shared' OR s.owner_id = ${userId})
  `;

  if (filters?.source) {
    query = sql`${query} AND s.source = ${filters.source}`;
  }
  if (filters?.visibility) {
    query = sql`${query} AND s.visibility = ${filters.visibility}`;
  }

  query = sql`${query} ORDER BY s.name ASC`;

  const results = await db.all<SkillSummary>(query);
  return results;
}

// ─── Plugin Sync ────────────────────────────────────────────────────────────

export async function upsertSkillFromSync(
  db: AppDb,
  data: {
    id: string;
    orgId?: string;
    source: SkillSource;
    name: string;
    slug: string;
    description?: string | null;
    content: string;
    visibility?: SkillVisibility;
  },
): Promise<void> {
  // Use raw SQL because Drizzle generates table-qualified column names in
  // ON CONFLICT ("skills"."id") which SQLite/D1 doesn't support.
  await db.run(sql`
    INSERT INTO skills (id, org_id, owner_id, source, name, slug, description, content, visibility, status, created_at, updated_at)
    VALUES (${data.id}, ${data.orgId ?? 'default'}, NULL, ${data.source}, ${data.name}, ${data.slug}, ${data.description ?? null}, ${data.content}, ${data.visibility ?? 'shared'}, 'active', datetime('now'), datetime('now'))
    ON CONFLICT (id) DO UPDATE SET
      name = excluded.name,
      description = excluded.description,
      content = excluded.content,
      visibility = excluded.visibility,
      updated_at = datetime('now')
  `);
  await syncSkillFts(db, data.id);
}

export async function deleteOrphanedSyncSkills(
  db: AppDb,
  orgId: string,
  syncedIds: Set<string>,
): Promise<void> {
  if (syncedIds.size === 0) return;

  // Find orphaned skill IDs: source is builtin/plugin, same org, not in synced set
  const allSynced = await db
    .select({ id: skills.id })
    .from(skills)
    .where(
      and(
        eq(skills.orgId, orgId),
        sql`${skills.source} IN ('builtin', 'plugin')`,
      ),
    );

  const orphanIds = allSynced
    .map((r) => r.id)
    .filter((id) => !syncedIds.has(id));

  if (orphanIds.length === 0) return;

  // Clean up FTS entries, persona_skills, org_default_skills, then the skills themselves
  for (const id of orphanIds) {
    await deleteSkillFts(db, id);
    await db.delete(personaSkills).where(eq(personaSkills.skillId, id));
    await db.delete(orgDefaultSkills).where(eq(orgDefaultSkills.skillId, id));
    await db.delete(skills).where(eq(skills.id, id));
  }
}

// ─── Persona Skills ─────────────────────────────────────────────────────────

export async function getPersonaSkillsForApi(
  db: AppDb,
  personaId: string,
) {
  return db
    .select({
      id: skills.id,
      name: skills.name,
      slug: skills.slug,
      description: skills.description,
      source: skills.source,
      visibility: skills.visibility,
      sortOrder: personaSkills.sortOrder,
    })
    .from(personaSkills)
    .innerJoin(skills, eq(personaSkills.skillId, skills.id))
    .where(and(eq(personaSkills.personaId, personaId), eq(skills.status, 'active')))
    .orderBy(personaSkills.sortOrder);
}

export async function getPersonaSkills(
  db: AppDb,
  personaId: string,
): Promise<SkillDeliveryItem[]> {
  const rows = await db
    .select({
      slug: skills.slug,
      content: skills.content,
    })
    .from(personaSkills)
    .innerJoin(skills, eq(skills.id, personaSkills.skillId))
    .where(and(
      eq(personaSkills.personaId, personaId),
      eq(skills.status, 'active'),
    ))
    .orderBy(asc(personaSkills.sortOrder), asc(skills.name));

  return rows.map((r) => ({
    filename: `${r.slug}.md`,
    content: r.content,
  }));
}

export async function attachSkillToPersona(
  db: AppDb,
  id: string,
  personaId: string,
  skillId: string,
  sortOrder: number = 0,
): Promise<void> {
  await db.insert(personaSkills).values({
    id,
    personaId,
    skillId,
    sortOrder,
  }).onConflictDoNothing();
}

export async function detachSkillFromPersona(
  db: AppDb,
  personaId: string,
  skillId: string,
): Promise<void> {
  await db.delete(personaSkills).where(
    and(eq(personaSkills.personaId, personaId), eq(personaSkills.skillId, skillId)),
  );
}

// ─── Org Default Skills ─────────────────────────────────────────────────────

export async function getOrgDefaultSkills(
  db: AppDb,
  orgId: string,
): Promise<SkillDeliveryItem[]> {
  const rows = await db
    .select({
      slug: skills.slug,
      content: skills.content,
    })
    .from(orgDefaultSkills)
    .innerJoin(skills, eq(skills.id, orgDefaultSkills.skillId))
    .where(and(
      eq(orgDefaultSkills.orgId, orgId),
      eq(skills.status, 'active'),
    ))
    .orderBy(asc(skills.name));

  return rows.map((r) => ({
    filename: `${r.slug}.md`,
    content: r.content,
  }));
}

export async function getOrgDefaultSkillsRich(
  db: AppDb,
  orgId: string,
): Promise<SkillSummary[]> {
  const rows = await db
    .select({
      id: skills.id,
      name: skills.name,
      slug: skills.slug,
      source: skills.source,
      description: skills.description,
      visibility: skills.visibility,
      ownerId: skills.ownerId,
      updatedAt: skills.updatedAt,
    })
    .from(orgDefaultSkills)
    .innerJoin(skills, eq(skills.id, orgDefaultSkills.skillId))
    .where(and(
      eq(orgDefaultSkills.orgId, orgId),
      eq(skills.status, 'active'),
    ))
    .orderBy(asc(skills.name));

  return rows as SkillSummary[];
}

export async function setOrgDefaultSkills(
  db: AppDb,
  orgId: string,
  skillIds: string[],
): Promise<void> {
  // Remove all existing defaults for this org
  await db.delete(orgDefaultSkills).where(eq(orgDefaultSkills.orgId, orgId));

  // Insert new defaults
  if (skillIds.length > 0) {
    await db.insert(orgDefaultSkills).values(
      skillIds.map((skillId) => ({
        id: crypto.randomUUID(),
        orgId,
        skillId,
      })),
    );
  }
}

// ─── Validation ──────────────────────────────────────────────────────────────

export async function validateSkillIds(db: AppDb, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();

  const rows = await db
    .select({ id: skills.id })
    .from(skills)
    .where(inArray(skills.id, ids));
  return new Set(rows.map((r) => r.id));
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function rowToSkill(row: SkillRecord): Skill {
  return {
    id: row.id,
    orgId: row.orgId,
    ownerId: row.ownerId,
    source: row.source as SkillSource,
    name: row.name,
    slug: row.slug,
    description: row.description,
    content: row.content,
    visibility: row.visibility as SkillVisibility,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
