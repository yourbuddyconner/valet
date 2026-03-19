import type { AppDb } from '../drizzle.js';
import type { UserIdentityLink, ChannelBinding, ChannelType, QueueMode } from '@valet/shared';
import { eq, and, desc, sql } from 'drizzle-orm';
import { userIdentityLinks, channelBindings } from '../schema/index.js';

function rowToIdentityLink(row: typeof userIdentityLinks.$inferSelect): UserIdentityLink {
  return {
    id: row.id,
    userId: row.userId,
    provider: row.provider,
    externalId: row.externalId,
    externalName: row.externalName || undefined,
    teamId: row.teamId || undefined,
    createdAt: row.createdAt,
  };
}

function rowToChannelBinding(row: typeof channelBindings.$inferSelect): ChannelBinding {
  return {
    id: row.id,
    sessionId: row.sessionId,
    channelType: row.channelType as ChannelType,
    channelId: row.channelId,
    scopeKey: row.scopeKey,
    userId: row.userId || undefined,
    orgId: row.orgId,
    queueMode: row.queueMode as QueueMode,
    collectDebounceMs: row.collectDebounceMs ?? 3000,
    slackChannelId: row.slackChannelId || undefined,
    slackThreadTs: row.slackThreadTs || undefined,
    githubRepoFullName: row.githubRepoFullName || undefined,
    githubPrNumber: row.githubPrNumber ?? undefined,
    createdAt: row.createdAt,
  };
}

// Identity Links

export async function createIdentityLink(
  db: AppDb,
  data: { id: string; userId: string; provider: string; externalId: string; externalName?: string; teamId?: string },
): Promise<UserIdentityLink> {
  await db.insert(userIdentityLinks).values({
    id: data.id,
    userId: data.userId,
    provider: data.provider,
    externalId: data.externalId,
    externalName: data.externalName || null,
    teamId: data.teamId || null,
  });

  return {
    id: data.id,
    userId: data.userId,
    provider: data.provider,
    externalId: data.externalId,
    externalName: data.externalName,
    teamId: data.teamId,
    createdAt: new Date().toISOString(),
  };
}

export async function getUserIdentityLinks(db: AppDb, userId: string): Promise<UserIdentityLink[]> {
  const rows = await db
    .select()
    .from(userIdentityLinks)
    .where(eq(userIdentityLinks.userId, userId))
    .orderBy(desc(userIdentityLinks.createdAt));
  return rows.map(rowToIdentityLink);
}

export async function deleteIdentityLink(db: AppDb, id: string, userId: string): Promise<boolean> {
  const result = await db
    .delete(userIdentityLinks)
    .where(and(eq(userIdentityLinks.id, id), eq(userIdentityLinks.userId, userId)));
  return (result.meta?.changes ?? 0) > 0;
}

export async function deleteIdentityLinkByExternalId(db: AppDb, provider: string, externalId: string): Promise<boolean> {
  const result = await db
    .delete(userIdentityLinks)
    .where(and(eq(userIdentityLinks.provider, provider), eq(userIdentityLinks.externalId, externalId)));
  return (result.meta?.changes ?? 0) > 0;
}

export async function resolveUserByExternalId(
  db: AppDb,
  provider: string,
  externalId: string,
): Promise<string | null> {
  const row = await db
    .select({ userId: userIdentityLinks.userId })
    .from(userIdentityLinks)
    .where(and(eq(userIdentityLinks.provider, provider), eq(userIdentityLinks.externalId, externalId)))
    .get();
  return row?.userId || null;
}

export async function getUserSlackIdentityLink(
  db: AppDb,
  userId: string,
): Promise<UserIdentityLink | null> {
  const row = await db
    .select()
    .from(userIdentityLinks)
    .where(and(eq(userIdentityLinks.userId, userId), eq(userIdentityLinks.provider, 'slack')))
    .get();
  return row ? rowToIdentityLink(row) : null;
}

// Channel Bindings

export async function createChannelBinding(
  db: AppDb,
  data: {
    id: string;
    sessionId: string;
    channelType: ChannelType;
    channelId: string;
    scopeKey: string;
    userId?: string;
    orgId: string;
    queueMode?: QueueMode;
    collectDebounceMs?: number;
    slackChannelId?: string;
    slackThreadTs?: string;
    githubRepoFullName?: string;
    githubPrNumber?: number;
  },
): Promise<ChannelBinding> {
  const queueMode = data.queueMode || 'followup';
  const collectDebounceMs = data.collectDebounceMs ?? 3000;

  await db.insert(channelBindings).values({
    id: data.id,
    sessionId: data.sessionId,
    channelType: data.channelType,
    channelId: data.channelId,
    scopeKey: data.scopeKey,
    userId: data.userId || null,
    orgId: data.orgId,
    queueMode,
    collectDebounceMs,
    slackChannelId: data.slackChannelId || null,
    slackThreadTs: data.slackThreadTs || null,
    githubRepoFullName: data.githubRepoFullName || null,
    githubPrNumber: data.githubPrNumber ?? null,
  });

  return {
    id: data.id,
    sessionId: data.sessionId,
    channelType: data.channelType,
    channelId: data.channelId,
    scopeKey: data.scopeKey,
    userId: data.userId,
    orgId: data.orgId,
    queueMode,
    collectDebounceMs,
    slackChannelId: data.slackChannelId,
    slackThreadTs: data.slackThreadTs,
    githubRepoFullName: data.githubRepoFullName,
    githubPrNumber: data.githubPrNumber,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Ensure a channel binding exists for the given channel. Inserts a new row if no binding
 * exists for the (channelType, channelId) pair. On conflict, updates the session_id and
 * scope_key so stale bindings from terminated sessions are overwritten rather than
 * silently preserved.
 */
export async function ensureChannelBinding(
  db: AppDb,
  data: {
    sessionId: string;
    channelType: ChannelType;
    channelId: string;
    userId: string;
    orgId: string;
  },
): Promise<void> {
  const scopeKey = `user:${data.userId}:${data.channelType}:${data.channelId}`;
  await db.insert(channelBindings).values({
    id: crypto.randomUUID(),
    sessionId: data.sessionId,
    channelType: data.channelType,
    channelId: data.channelId,
    scopeKey,
    userId: data.userId,
    orgId: data.orgId,
    queueMode: 'followup',
    collectDebounceMs: 3000,
  }).onConflictDoUpdate({
    target: [channelBindings.channelType, channelBindings.channelId],
    set: {
      sessionId: sql`excluded.session_id`,
      scopeKey: sql`excluded.scope_key`,
      userId: sql`excluded.user_id`,
    },
  });
}

export async function getChannelBindingByScopeKey(db: AppDb, scopeKey: string): Promise<ChannelBinding | null> {
  const row = await db
    .select()
    .from(channelBindings)
    .where(eq(channelBindings.scopeKey, scopeKey))
    .get();
  return row ? rowToChannelBinding(row) : null;
}

export async function getSessionChannelBindings(db: AppDb, sessionId: string): Promise<ChannelBinding[]> {
  const rows = await db
    .select()
    .from(channelBindings)
    .where(eq(channelBindings.sessionId, sessionId))
    .orderBy(desc(channelBindings.createdAt));
  return rows.map(rowToChannelBinding);
}

export async function listUserChannelBindings(db: AppDb, userId: string): Promise<ChannelBinding[]> {
  const rows = await db
    .select()
    .from(channelBindings)
    .where(eq(channelBindings.userId, userId))
    .orderBy(desc(channelBindings.createdAt));
  return rows.map(rowToChannelBinding);
}

export async function deleteChannelBinding(db: AppDb, id: string): Promise<void> {
  await db.delete(channelBindings).where(eq(channelBindings.id, id));
}

export async function updateChannelBindingQueueMode(
  db: AppDb,
  id: string,
  queueMode: QueueMode,
  collectDebounceMs?: number,
): Promise<void> {
  const setValues: Record<string, unknown> = { queueMode };
  if (collectDebounceMs !== undefined) {
    setValues.collectDebounceMs = collectDebounceMs;
  }
  await db
    .update(channelBindings)
    .set(setValues)
    .where(eq(channelBindings.id, id));
}
