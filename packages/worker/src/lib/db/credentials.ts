import type { AppDb } from '../drizzle.js';
import { eq, and, sql } from 'drizzle-orm';
import { credentials } from '../schema/index.js';

export interface CredentialRow {
  id: string;
  ownerType: string;
  ownerId: string;
  provider: string;
  credentialType: string;
  encryptedData: string;
  metadata: string | null;
  scopes: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export async function getCredentialRow(
  db: AppDb,
  ownerType: string,
  ownerId: string,
  provider: string,
  credentialType?: string,
): Promise<CredentialRow | null> {
  const conditions = [
    eq(credentials.ownerType, ownerType),
    eq(credentials.ownerId, ownerId),
    eq(credentials.provider, provider),
  ];
  if (credentialType) {
    conditions.push(eq(credentials.credentialType, credentialType));
  }
  const row = await db
    .select()
    .from(credentials)
    .where(and(...conditions))
    .get();
  return (row as CredentialRow | undefined) ?? null;
}

export async function upsertCredential(
  db: AppDb,
  data: {
    id: string;
    ownerType: string;
    ownerId: string;
    provider: string;
    credentialType: string;
    encryptedData: string;
    metadata?: string | null;
    scopes?: string | null;
    expiresAt?: string | null;
  },
): Promise<void> {
  await db
    .insert(credentials)
    .values({
      id: data.id,
      ownerType: data.ownerType,
      ownerId: data.ownerId,
      provider: data.provider,
      credentialType: data.credentialType,
      encryptedData: data.encryptedData,
      metadata: data.metadata ?? null,
      scopes: data.scopes ?? null,
      expiresAt: data.expiresAt ?? null,
    })
    .onConflictDoUpdate({
      target: [credentials.ownerType, credentials.ownerId, credentials.provider, credentials.credentialType],
      set: {
        encryptedData: sql`excluded.encrypted_data`,
        metadata: sql`COALESCE(excluded.metadata, ${credentials.metadata})`,
        scopes: sql`COALESCE(excluded.scopes, ${credentials.scopes})`,
        expiresAt: sql`excluded.expires_at`,
        updatedAt: sql`datetime('now')`,
      },
    });
}

export async function deleteCredential(
  db: AppDb,
  ownerType: string,
  ownerId: string,
  provider: string,
  credentialType?: string,
): Promise<void> {
  const conditions = [
    eq(credentials.ownerType, ownerType),
    eq(credentials.ownerId, ownerId),
    eq(credentials.provider, provider),
  ];
  if (credentialType) {
    conditions.push(eq(credentials.credentialType, credentialType));
  }
  await db
    .delete(credentials)
    .where(and(...conditions));
}

export async function deleteCredentialsByProvider(
  db: AppDb,
  provider: string,
): Promise<void> {
  await db.delete(credentials).where(eq(credentials.provider, provider));
}

export async function listCredentialsByOwner(
  db: AppDb,
  ownerType: string,
  ownerId: string,
): Promise<Array<{
  provider: string;
  credentialType: string;
  scopes: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}>> {
  return db
    .select({
      provider: credentials.provider,
      credentialType: credentials.credentialType,
      scopes: credentials.scopes,
      expiresAt: credentials.expiresAt,
      createdAt: credentials.createdAt,
      updatedAt: credentials.updatedAt,
    })
    .from(credentials)
    .where(and(eq(credentials.ownerType, ownerType), eq(credentials.ownerId, ownerId)));
}

/**
 * Find credentials expiring within the given window (seconds from now).
 * Returns ownerType + ownerId + provider tuples so the caller can attempt refresh.
 */
export async function getExpiringCredentials(
  db: AppDb,
  windowSeconds: number,
): Promise<Array<{ ownerType: string; ownerId: string; provider: string; expiresAt: string }>> {
  const cutoff = new Date(Date.now() + windowSeconds * 1000).toISOString();
  return db
    .select({
      ownerType: credentials.ownerType,
      ownerId: credentials.ownerId,
      provider: credentials.provider,
      expiresAt: credentials.expiresAt,
    })
    .from(credentials)
    .where(
      and(
        sql`${credentials.expiresAt} IS NOT NULL`,
        sql`${credentials.expiresAt} <= ${cutoff}`,
      ),
    ) as any;
}

export async function hasCredential(
  db: AppDb,
  ownerType: string,
  ownerId: string,
  provider: string,
): Promise<boolean> {
  const row = await db
    .select({ id: credentials.id })
    .from(credentials)
    .where(and(eq(credentials.ownerType, ownerType), eq(credentials.ownerId, ownerId), eq(credentials.provider, provider)))
    .get();
  return !!row;
}

/**
 * Resolve a repo-level credential, preferring:
 * 1. user-level oauth2 (personal GitHub OAuth — commits as user)
 * 2. org-level app_install (GitHub App — commits as bot)
 * 3. user-level app_install (legacy fallback)
 */
export async function resolveRepoCredential(
  db: AppDb,
  provider: string,
  orgId: string | undefined,
  userId: string,
): Promise<{ credential: CredentialRow; credentialType: 'oauth2' | 'app_install' } | null> {
  // 1. User's personal OAuth token (highest priority)
  const userOAuth = await getCredentialRow(db, 'user', userId, provider, 'oauth2');
  if (userOAuth) return { credential: userOAuth, credentialType: 'oauth2' };
  // 2. Org-level app installation
  if (orgId) {
    const orgInstall = await getCredentialRow(db, 'org', orgId, provider, 'app_install');
    if (orgInstall) return { credential: orgInstall, credentialType: 'app_install' };
  }
  // 3. User-level app installation (legacy)
  const userInstall = await getCredentialRow(db, 'user', userId, provider, 'app_install');
  if (userInstall) return { credential: userInstall, credentialType: 'app_install' };
  return null;
}
