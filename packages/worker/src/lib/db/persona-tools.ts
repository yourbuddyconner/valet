import { eq } from 'drizzle-orm';
import type { AppDb } from '../drizzle.js';
import { personaTools } from '../schema/index.js';
import type { PersonaToolConfig, PersonaToolWhitelist } from '@valet/shared';

// ─── Types ──────────────────────────────────────────────────────────────────

export type PersonaToolRecord = typeof personaTools.$inferSelect;

// ─── CRUD ───────────────────────────────────────────────────────────────────

export async function getPersonaTools(
  db: AppDb,
  personaId: string,
): Promise<PersonaToolConfig[]> {
  const rows = await db
    .select()
    .from(personaTools)
    .where(eq(personaTools.personaId, personaId));

  return rows.map(rowToPersonaToolConfig);
}

export async function setPersonaTools(
  db: AppDb,
  personaId: string,
  tools: Array<{ service: string; actionId?: string; enabled: boolean }>,
): Promise<void> {
  // Delete all existing tool config for this persona
  await db.delete(personaTools).where(eq(personaTools.personaId, personaId));

  // Insert new config
  if (tools.length > 0) {
    await db.insert(personaTools).values(
      tools.map((t) => ({
        id: crypto.randomUUID(),
        personaId,
        service: t.service,
        actionId: t.actionId ?? null,
        enabled: t.enabled ? 1 : 0,
      })),
    );
  }
}

export async function getPersonaToolWhitelist(
  db: AppDb,
  personaId: string,
): Promise<PersonaToolWhitelist> {
  const rows = await db
    .select()
    .from(personaTools)
    .where(eq(personaTools.personaId, personaId));

  const services: string[] = [];
  const excludedActions: Array<{ service: string; actionId: string }> = [];

  for (const row of rows) {
    if (row.actionId === null && row.enabled === 1) {
      // Service-level whitelist entry
      services.push(row.service);
    } else if (row.actionId !== null && row.enabled === 0) {
      // Action-level exclusion
      excludedActions.push({ service: row.service, actionId: row.actionId });
    }
  }

  return { services, excludedActions };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function rowToPersonaToolConfig(row: PersonaToolRecord): PersonaToolConfig {
  return {
    id: row.id,
    personaId: row.personaId,
    service: row.service,
    actionId: row.actionId,
    enabled: row.enabled === 1,
    createdAt: row.createdAt,
  };
}
