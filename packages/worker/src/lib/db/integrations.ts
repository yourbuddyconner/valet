import type { Integration, SyncStatusResponse } from '@agent-ops/shared';
import { eq, and, ne, desc, sql } from 'drizzle-orm';
import type { AppDb } from '../drizzle.js';
import { toDate } from '../drizzle.js';
import { integrations, syncLogs } from '../schema/index.js';

function rowToIntegration(row: typeof integrations.$inferSelect): Integration {
  return {
    id: row.id,
    userId: row.userId,
    service: row.service as Integration['service'],
    config: row.config as Integration['config'],
    status: row.status as Integration['status'],
    scope: (row.scope as 'user' | 'org') || 'user',
    lastSyncedAt: row.lastSyncedAt ? toDate(row.lastSyncedAt) : null,
    createdAt: toDate(row.createdAt),
    updatedAt: toDate(row.updatedAt),
  };
}

export async function createIntegration(
  db: AppDb,
  data: { id: string; userId: string; service: string; config: Record<string, unknown> }
): Promise<Integration> {
  await db.insert(integrations).values({
    id: data.id,
    userId: data.userId,
    service: data.service,
    config: data.config as unknown as Integration['config'],
    status: 'pending',
  });

  return {
    id: data.id,
    userId: data.userId,
    service: data.service as Integration['service'],
    config: data.config as unknown as Integration['config'],
    status: 'pending',
    scope: 'user' as const,
    lastSyncedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

export async function getIntegration(db: AppDb, id: string): Promise<Integration | null> {
  const row = await db.select().from(integrations).where(eq(integrations.id, id)).get();
  return row ? rowToIntegration(row) : null;
}

export async function getOrgIntegrations(db: AppDb, excludeUserId: string): Promise<Array<{
  id: string;
  service: string;
  status: string;
  scope: 'org';
  config: Record<string, unknown>;
  lastSyncedAt: Date | null;
  createdAt: Date;
}>> {
  const rows = await db
    .select()
    .from(integrations)
    .where(and(eq(integrations.scope, 'org'), ne(integrations.userId, excludeUserId)))
    .orderBy(desc(integrations.createdAt));

  return rows.map((row) => ({
    id: row.id,
    service: row.service,
    status: row.status,
    scope: 'org' as const,
    config: row.config as Record<string, unknown>,
    lastSyncedAt: row.lastSyncedAt ? toDate(row.lastSyncedAt) : null,
    createdAt: toDate(row.createdAt),
  }));
}

export async function getUserIntegrations(db: AppDb, userId: string): Promise<Integration[]> {
  const rows = await db
    .select()
    .from(integrations)
    .where(eq(integrations.userId, userId))
    .orderBy(desc(integrations.createdAt));
  return rows.map(rowToIntegration);
}

export async function updateIntegrationStatus(
  db: AppDb,
  id: string,
  status: Integration['status'],
  errorMessage?: string
): Promise<void> {
  await db
    .update(integrations)
    .set({
      status,
      errorMessage: errorMessage || null,
      updatedAt: sql`datetime('now')`,
    })
    .where(eq(integrations.id, id));
}

export async function updateIntegrationSyncTime(db: AppDb, id: string): Promise<void> {
  await db
    .update(integrations)
    .set({
      lastSyncedAt: sql`datetime('now')`,
      updatedAt: sql`datetime('now')`,
    })
    .where(eq(integrations.id, id));
}

export async function deleteIntegration(db: AppDb, id: string): Promise<void> {
  await db.delete(integrations).where(eq(integrations.id, id));
}

// Sync log operations
export async function createSyncLog(
  db: AppDb,
  data: { id: string; integrationId: string }
): Promise<SyncStatusResponse> {
  await db.insert(syncLogs).values({
    id: data.id,
    integrationId: data.integrationId,
    status: 'pending',
  });

  return {
    id: data.id,
    integrationId: data.integrationId,
    status: 'pending',
    startedAt: new Date(),
  };
}

export async function updateSyncLog(
  db: AppDb,
  id: string,
  data: { status: string; recordsSynced?: number; errors?: unknown[] }
): Promise<void> {
  await db
    .update(syncLogs)
    .set({
      status: data.status,
      recordsSynced: data.recordsSynced !== undefined
        ? data.recordsSynced
        : sql`${syncLogs.recordsSynced}`,
      errors: data.errors ? sql`${JSON.stringify(data.errors)}` : null,
      completedAt: ['completed', 'failed'].includes(data.status)
        ? sql`datetime('now')`
        : sql`${syncLogs.completedAt}`,
    })
    .where(eq(syncLogs.id, id));
}

export async function getSyncLog(db: AppDb, id: string): Promise<SyncStatusResponse | null> {
  const row = await db.select().from(syncLogs).where(eq(syncLogs.id, id)).get();
  if (!row) return null;

  return {
    id: row.id,
    integrationId: row.integrationId,
    status: row.status as SyncStatusResponse['status'],
    progress: row.recordsSynced ?? undefined,
    result: row.completedAt
      ? {
          success: row.status === 'completed',
          recordsSynced: row.recordsSynced || 0,
          errors: (row.errors as Array<{ entity: string; entityId?: string; message: string; code: string }>) || [],
          completedAt: toDate(row.completedAt),
        }
      : undefined,
    startedAt: toDate(row.startedAt),
    completedAt: row.completedAt ? toDate(row.completedAt) : undefined,
  };
}

