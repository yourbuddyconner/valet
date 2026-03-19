import type { AppDb } from '../drizzle.js';
import { eq, and, sql } from 'drizzle-orm';
import { credentials } from '../schema/index.js';
import { getServiceMetadata } from './service-configs.js';
import type { GitHubServiceMetadata } from '../../services/github-config.js';

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
 * 2. org/user app_install whose accessibleOwners covers repoOwner
 * 3. (when repoOwner is undefined) fall back to any app_install
 */
export async function resolveRepoCredential(
  db: AppDb,
  provider: string,
  repoOwner: string | undefined,
  orgId: string | undefined,
  userId: string,
): Promise<{ credential: CredentialRow; credentialType: 'oauth2' | 'app_install' } | null> {
  // 1. User OAuth token — always wins (commits as user)
  const userOAuth = await getCredentialRow(db, 'user', userId, provider, 'oauth2');
  if (userOAuth) return { credential: userOAuth, credentialType: 'oauth2' };

  // 2. If repoOwner is provided, check which App installation covers it
  if (repoOwner) {
    // Check org App's accessible owners
    if (orgId) {
      const orgInstall = await getCredentialRow(db, 'org', orgId, provider, 'app_install');
      if (orgInstall) {
        const meta = await getServiceMetadata<GitHubServiceMetadata>(db, 'github');
        if (meta?.accessibleOwners?.includes(repoOwner)) {
          return { credential: orgInstall, credentialType: 'app_install' };
        }
      }
    }

    // Check user App installation's accessible owners (stored in credential metadata)
    const userInstall = await getCredentialRow(db, 'user', userId, provider, 'app_install');
    if (userInstall && userInstall.metadata) {
      try {
        const meta = JSON.parse(userInstall.metadata);
        if (meta.accessibleOwners?.includes(repoOwner)) {
          return { credential: userInstall, credentialType: 'app_install' };
        }
      } catch {
        // Bad metadata, skip
      }
    }

    // No installation covers this owner
    return null;
  }

  // 3. repoOwner is undefined (non-repo-scoped operation) — fall back to old behavior
  if (orgId) {
    const orgInstall = await getCredentialRow(db, 'org', orgId, provider, 'app_install');
    if (orgInstall) return { credential: orgInstall, credentialType: 'app_install' };
  }
  const userInstall = await getCredentialRow(db, 'user', userId, provider, 'app_install');
  if (userInstall) return { credential: userInstall, credentialType: 'app_install' };

  return null;
}
