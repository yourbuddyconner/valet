import type { D1Database } from '@cloudflare/workers-types';
import type { OrchestratorIdentity, AgentSession } from '@valet/shared';
import { eq, and, sql } from 'drizzle-orm';
import type { AppDb } from '../drizzle.js';
import { orchestratorIdentities } from '../schema/index.js';

function mapSessionRow(row: any): AgentSession {
  return {
    id: row.id,
    userId: row.user_id,
    workspace: row.workspace,
    status: row.status,
    title: row.title || undefined,
    parentSessionId: row.parent_session_id || undefined,
    containerId: row.container_id || undefined,
    metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    errorMessage: row.error_message || undefined,
    personaId: row.persona_id || undefined,
    personaName: row.persona_name || undefined,
    isOrchestrator: !!row.is_orchestrator || undefined,
    purpose: row.purpose || 'interactive',
    createdAt: new Date(row.created_at),
    lastActiveAt: new Date(row.last_active_at),
  };
}

// ─── Row-to-Domain Converters ───────────────────────────────────────────────

function rowToIdentity(row: typeof orchestratorIdentities.$inferSelect): OrchestratorIdentity {
  return {
    id: row.id,
    userId: row.userId || undefined,
    orgId: row.orgId,
    type: row.type as OrchestratorIdentity['type'],
    name: row.name,
    handle: row.handle,
    avatar: row.avatar || undefined,
    customInstructions: row.customInstructions || undefined,
    personaId: row.personaId || undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ─── Orchestrator Identity Operations ───────────────────────────────────────

export async function getOrchestratorIdentity(db: AppDb, userId: string, orgId: string = 'default'): Promise<OrchestratorIdentity | null> {
  const row = await db
    .select()
    .from(orchestratorIdentities)
    .where(and(eq(orchestratorIdentities.userId, userId), eq(orchestratorIdentities.orgId, orgId)))
    .get();
  return row ? rowToIdentity(row) : null;
}

export async function getOrchestratorIdentityByHandle(db: AppDb, handle: string, orgId: string = 'default'): Promise<OrchestratorIdentity | null> {
  const row = await db
    .select()
    .from(orchestratorIdentities)
    .where(and(eq(orchestratorIdentities.handle, handle), eq(orchestratorIdentities.orgId, orgId)))
    .get();
  return row ? rowToIdentity(row) : null;
}

export async function getOrchestratorIdentityByName(db: AppDb, name: string, orgId: string = 'default'): Promise<OrchestratorIdentity | null> {
  const row = await db
    .select()
    .from(orchestratorIdentities)
    .where(and(sql`lower(${orchestratorIdentities.name}) = lower(${name})`, eq(orchestratorIdentities.orgId, orgId)))
    .get();
  return row ? rowToIdentity(row) : null;
}

export async function createOrchestratorIdentity(
  db: AppDb,
  data: { id: string; userId: string; name: string; handle: string; avatar?: string; customInstructions?: string; personaId?: string; orgId?: string }
): Promise<OrchestratorIdentity> {
  const orgId = data.orgId || 'default';

  await db.insert(orchestratorIdentities).values({
    id: data.id,
    userId: data.userId,
    orgId,
    type: 'personal',
    name: data.name,
    handle: data.handle,
    avatar: data.avatar || null,
    customInstructions: data.customInstructions || null,
    personaId: data.personaId || null,
  });

  return {
    id: data.id,
    userId: data.userId,
    orgId,
    type: 'personal',
    name: data.name,
    handle: data.handle,
    avatar: data.avatar,
    customInstructions: data.customInstructions,
    personaId: data.personaId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export async function updateOrchestratorIdentity(
  db: AppDb,
  id: string,
  updates: Partial<Pick<OrchestratorIdentity, 'name' | 'handle' | 'avatar' | 'customInstructions' | 'personaId'>>
): Promise<void> {
  const setValues: Record<string, unknown> = {};

  if (updates.name !== undefined) setValues.name = updates.name;
  if (updates.handle !== undefined) setValues.handle = updates.handle;
  if (updates.avatar !== undefined) setValues.avatar = updates.avatar || null;
  if (updates.customInstructions !== undefined) setValues.customInstructions = updates.customInstructions || null;
  if (updates.personaId !== undefined) setValues.personaId = updates.personaId || null;

  if (Object.keys(setValues).length === 0) return;

  setValues.updatedAt = sql`datetime('now')`;
  await db
    .update(orchestratorIdentities)
    .set(setValues)
    .where(eq(orchestratorIdentities.id, id));
}

// ─── Orchestrator Session Helpers ───────────────────────────────────────────

// Raw SQL: direct stable ID lookup
export async function getOrchestratorSession(db: D1Database, userId: string): Promise<AgentSession | null> {
  const result = await db.prepare(
    `SELECT * FROM sessions WHERE id = ? LIMIT 1`
  ).bind(`orchestrator:${userId}`).first();
  return result ? mapSessionRow(result) : null;
}

export async function getCurrentOrchestratorSession(db: D1Database, userId: string): Promise<AgentSession | null> {
  const activeRow = await db.prepare(
    `SELECT * FROM sessions
     WHERE user_id = ? AND is_orchestrator = 1
       AND status NOT IN ('terminated', 'archived', 'error')
     ORDER BY created_at DESC LIMIT 1`
  ).bind(userId).first();
  if (activeRow) return mapSessionRow(activeRow);
  return null;
}

