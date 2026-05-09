import { eq, and, isNull, sql } from 'drizzle-orm';
import type { AppDb } from '../drizzle.js';
import { githubInstallations, type GithubInstallation } from '../schema/github-installations.js';

interface UpsertInstallationInput {
  githubInstallationId: string;
  accountLogin: string;
  accountId: string;
  accountType: 'Organization' | 'User';
  repositorySelection: 'all' | 'selected';
  permissions?: Record<string, unknown>;
  linkedUserId?: string | null;
}

interface ListInstallationsOpts {
  orphanedOnly?: boolean;
}

export async function upsertGithubInstallation(
  db: AppDb,
  input: UpsertInstallationInput,
): Promise<GithubInstallation> {
  const id = crypto.randomUUID();
  const permissionsJson = input.permissions ? JSON.stringify(input.permissions) : null;

  await db
    .insert(githubInstallations)
    .values({
      id,
      githubInstallationId: input.githubInstallationId,
      accountLogin: input.accountLogin,
      accountId: input.accountId,
      accountType: input.accountType,
      repositorySelection: input.repositorySelection,
      permissions: permissionsJson,
      linkedUserId: input.linkedUserId ?? null,
      status: 'active',
    })
    .onConflictDoUpdate({
      target: githubInstallations.githubInstallationId,
      set: {
        accountLogin: input.accountLogin,
        accountId: input.accountId,
        accountType: input.accountType,
        repositorySelection: input.repositorySelection,
        permissions: permissionsJson,
        // Preserve existing linkedUserId unless input explicitly provides one
        linkedUserId: input.linkedUserId !== undefined
          ? input.linkedUserId
          : sql`${githubInstallations.linkedUserId}`,
        // Reinstall: always set back to active on upsert
        status: 'active',
        updatedAt: sql`datetime('now')`,
      },
    });

  const row = await db
    .select()
    .from(githubInstallations)
    .where(eq(githubInstallations.githubInstallationId, input.githubInstallationId))
    .get();

  return row!;
}

export async function getGithubInstallationByLogin(
  db: AppDb,
  accountLogin: string,
): Promise<GithubInstallation | undefined> {
  return db
    .select()
    .from(githubInstallations)
    .where(
      and(
        eq(githubInstallations.accountLogin, accountLogin),
        eq(githubInstallations.status, 'active'),
      ),
    )
    .get();
}

export async function getGithubInstallationById(
  db: AppDb,
  githubInstallationId: string,
): Promise<GithubInstallation | undefined> {
  return db
    .select()
    .from(githubInstallations)
    .where(eq(githubInstallations.githubInstallationId, githubInstallationId))
    .get();
}

export async function getGithubInstallationByAccountId(
  db: AppDb,
  accountId: string,
): Promise<GithubInstallation | undefined> {
  return db
    .select()
    .from(githubInstallations)
    .where(eq(githubInstallations.accountId, accountId))
    .get();
}

export async function listGithubInstallationsByAccountType(
  db: AppDb,
  accountType: 'Organization' | 'User',
  opts?: ListInstallationsOpts,
): Promise<GithubInstallation[]> {
  const conditions = [
    eq(githubInstallations.accountType, accountType),
    eq(githubInstallations.status, 'active'),
  ];

  if (opts?.orphanedOnly) {
    conditions.push(isNull(githubInstallations.linkedUserId));
  }

  return db
    .select()
    .from(githubInstallations)
    .where(and(...conditions))
    .all();
}

export async function listGithubInstallationsByUser(
  db: AppDb,
  userId: string,
): Promise<GithubInstallation[]> {
  return db
    .select()
    .from(githubInstallations)
    .where(and(eq(githubInstallations.linkedUserId, userId), eq(githubInstallations.status, 'active')))
    .all();
}

export async function listAllActiveInstallations(
  db: AppDb,
): Promise<GithubInstallation[]> {
  return db
    .select()
    .from(githubInstallations)
    .where(eq(githubInstallations.status, 'active'))
    .all();
}

export async function updateGithubInstallationStatus(
  db: AppDb,
  githubInstallationId: string,
  status: string,
): Promise<void> {
  await db
    .update(githubInstallations)
    .set({
      status,
      updatedAt: sql`datetime('now')`,
    })
    .where(eq(githubInstallations.githubInstallationId, githubInstallationId));
}

export async function updateGithubInstallationAccountLogin(
  db: AppDb,
  githubInstallationId: string,
  accountLogin: string,
): Promise<void> {
  await db
    .update(githubInstallations)
    .set({
      accountLogin,
      updatedAt: sql`datetime('now')`,
    })
    .where(eq(githubInstallations.githubInstallationId, githubInstallationId));
}

export async function linkGithubInstallationToUser(
  db: AppDb,
  githubInstallationId: string,
  userId: string,
): Promise<void> {
  await db
    .update(githubInstallations)
    .set({
      linkedUserId: userId,
      updatedAt: sql`datetime('now')`,
    })
    .where(eq(githubInstallations.githubInstallationId, githubInstallationId));
}

export async function deleteGithubInstallationsForAccount(
  db: AppDb,
  accountId: string,
): Promise<void> {
  await db
    .delete(githubInstallations)
    .where(eq(githubInstallations.accountId, accountId));
}
