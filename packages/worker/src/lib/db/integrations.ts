import type { Integration } from '@agent-ops/shared';
import { eq, and, ne, desc, sql } from 'drizzle-orm';
import type { AppDb } from '../drizzle.js';
import { toDate } from '../drizzle.js';
import { integrations } from '../schema/index.js';

function rowToIntegration(row: typeof integrations.$inferSelect): Integration {
  return {
    id: row.id,
    userId: row.userId,
    service: row.service as Integration['service'],
    config: row.config as Integration['config'],
    status: row.status as Integration['status'],
    scope: (row.scope as 'user' | 'org') || 'user',
    createdAt: toDate(row.createdAt),
    updatedAt: toDate(row.updatedAt),
  };
}

export async function createIntegration(
  db: AppDb,
  data: { id: string; userId: string; service: string; config: Record<string, unknown>; scope?: 'user' | 'org' }
): Promise<Integration> {
  const scope = data.scope || 'user';
  await db.insert(integrations).values({
    id: data.id,
    userId: data.userId,
    service: data.service,
    config: data.config as unknown as Integration['config'],
    status: 'pending',
    scope,
  });

  return {
    id: data.id,
    userId: data.userId,
    service: data.service as Integration['service'],
    config: data.config as unknown as Integration['config'],
    status: 'pending',
    scope,
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
  userId: string;
  service: string;
  status: string;
  scope: 'org';
  config: Record<string, unknown>;
  createdAt: Date;
}>> {
  const rows = await db
    .select()
    .from(integrations)
    .where(and(eq(integrations.scope, 'org'), ne(integrations.userId, excludeUserId)))
    .orderBy(desc(integrations.createdAt));

  return rows.map((row) => ({
    id: row.id,
    userId: row.userId,
    service: row.service,
    status: row.status,
    scope: 'org' as const,
    config: row.config as Record<string, unknown>,
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

export async function deleteIntegration(db: AppDb, id: string): Promise<void> {
  await db.delete(integrations).where(eq(integrations.id, id));
}

export async function deleteOrgIntegrationByService(db: AppDb, service: string): Promise<void> {
  await db.delete(integrations).where(
    and(eq(integrations.service, service), eq(integrations.scope, 'org')),
  );
}
