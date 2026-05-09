import type { AppDb } from '../lib/drizzle.js';
import {
  getOrchestratorIdentity,
} from '../lib/db.js';
import { updateOrchestratorIdentity } from '../lib/db/orchestrator.js';
import { upsertPersonaFile } from '../lib/db.js';
import { buildOrchestratorPersonaFiles } from '../lib/orchestrator-persona.js';

// ─── identityGet ─────────────────────────────────────────────────────────────

export type IdentityGetResult =
  | { identity: NonNullable<Awaited<ReturnType<typeof getOrchestratorIdentity>>>; statusCode?: undefined; error?: undefined }
  | { error: string; statusCode: number; identity?: undefined };

export async function identityGet(
  db: AppDb,
  userId: string | null | undefined,
): Promise<IdentityGetResult> {
  const identity = await getOrchestratorIdentity(db, userId ?? '');
  if (!identity) {
    return { error: 'Identity not found', statusCode: 404 };
  }
  return { identity };
}

// ─── identityUpdate ──────────────────────────────────────────────────────────

export type IdentityUpdatePayload = {
  instructions?: string;
  customInstructions?: string;
};

export type IdentityUpdateResult =
  | { ok: true; personaFiles: ReturnType<typeof buildOrchestratorPersonaFiles> | null; error?: undefined; statusCode?: undefined }
  | { error: string; statusCode: number; ok?: undefined; personaFiles?: undefined };

export async function identityUpdate(
  db: AppDb,
  userId: string | null | undefined,
  payload: IdentityUpdatePayload,
): Promise<IdentityUpdateResult> {
  const instructions = (payload.instructions ?? payload.customInstructions) as string | undefined;
  if (instructions === undefined) {
    return { error: 'instructions field is required', statusCode: 400 };
  }

  const identity = await getOrchestratorIdentity(db, userId ?? '');
  if (!identity) {
    return { error: 'Identity not found', statusCode: 404 };
  }

  // Use nullish coalescing: empty string clears instructions, undefined is rejected above
  await updateOrchestratorIdentity(db, identity.id, { customInstructions: instructions || null } as any);

  // Also update the linked persona file if a personaId exists
  if (identity.personaId) {
    await upsertPersonaFile(db, {
      id: crypto.randomUUID(),
      personaId: identity.personaId,
      filename: 'custom-instructions.md',
      content: instructions || '',
      sortOrder: 10,
    });
  }

  // Return updated persona files for hot-reload by the DO
  const updatedIdentity = await getOrchestratorIdentity(db, userId ?? '');
  const personaFiles = updatedIdentity ? buildOrchestratorPersonaFiles(updatedIdentity as any) : null;

  return { ok: true, personaFiles };
}

// ─── handleIdentityAction dispatcher ─────────────────────────────────────────

export type IdentityActionResult =
  | { data: Record<string, unknown>; statusCode?: undefined; error?: undefined }
  | { error: string; statusCode: number; data?: undefined };

export async function handleIdentityAction(
  db: AppDb,
  userId: string | null | undefined,
  action: string,
  payload?: Record<string, unknown>,
): Promise<IdentityActionResult> {
  if (action === 'get') {
    const result = await identityGet(db, userId);
    if (result.error) {
      return { error: result.error, statusCode: result.statusCode };
    }
    return { data: { identity: result.identity } };
  }

  if (action === 'update-instructions') {
    const result = await identityUpdate(db, userId, payload ?? {});
    if (result.error) {
      return { error: result.error, statusCode: result.statusCode };
    }
    // Signal to DO that hot-reload is needed via the personaFiles field
    return { data: { ok: true, _personaFiles: result.personaFiles } };
  }

  return { error: `Unsupported identity action: ${action}`, statusCode: 400 };
}
