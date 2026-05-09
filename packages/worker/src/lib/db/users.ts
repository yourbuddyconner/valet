import type { AppDb } from '../drizzle.js';
import type { User, UserRole, QueueMode } from '@valet/shared';
import { eq, sql, asc, and, inArray } from 'drizzle-orm';
import { toDate } from '../drizzle.js';
import { users, credentials } from '../schema/index.js';

function rowToUser(row: typeof users.$inferSelect): User {
  return {
    id: row.id,
    email: row.email,
    name: row.name || undefined,
    avatarUrl: row.avatarUrl || undefined,
    githubId: row.githubId || undefined,
    githubUsername: row.githubUsername || undefined,
    gitName: row.gitName || undefined,
    gitEmail: row.gitEmail || undefined,
    onboardingCompleted: !!row.onboardingCompleted,
    idleTimeoutSeconds: row.idleTimeoutSeconds ?? 900,
    sandboxCpuCores: row.sandboxCpuCores ?? undefined,
    sandboxMemoryMib: row.sandboxMemoryMib ?? undefined,
    modelPreferences: row.modelPreferences || undefined,
    uiQueueMode: (row.uiQueueMode as QueueMode) || 'followup',
    timezone: row.timezone || undefined,
    role: (row.role as UserRole) || 'member',
    createdAt: toDate(row.createdAt),
    updatedAt: toDate(row.updatedAt),
  };
}

export async function getOrCreateUser(
  db: AppDb,
  data: { id: string; email: string; name?: string; avatarUrl?: string }
): Promise<User> {
  const existing = await db.select().from(users).where(eq(users.id, data.id)).get();

  if (existing) {
    return rowToUser(existing);
  }

  await db.insert(users).values({
    id: data.id,
    email: data.email,
    name: data.name || null,
    avatarUrl: data.avatarUrl || null,
  });

  return {
    id: data.id,
    email: data.email,
    name: data.name,
    avatarUrl: data.avatarUrl,
    role: 'member' as const,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

export async function findUserByGitHubId(db: AppDb, githubId: string): Promise<User | null> {
  const row = await db.select().from(users).where(eq(users.githubId, githubId)).get();
  return row ? rowToUser(row) : null;
}

export async function findUserByEmail(db: AppDb, email: string): Promise<User | null> {
  const row = await db.select().from(users).where(eq(users.email, email)).get();
  return row ? rowToUser(row) : null;
}

export async function updateUserGitHub(
  db: AppDb,
  userId: string,
  data: { githubId: string | null; githubUsername: string | null; name?: string; avatarUrl?: string }
): Promise<void> {
  await db
    .update(users)
    .set({
      githubId: data.githubId,
      githubUsername: data.githubUsername,
      name: sql`COALESCE(${data.name || null}, ${users.name})`,
      avatarUrl: sql`COALESCE(${data.avatarUrl || null}, ${users.avatarUrl})`,
      updatedAt: sql`datetime('now')`,
    })
    .where(eq(users.id, userId));
}

export async function getUserById(db: AppDb, userId: string): Promise<User | null> {
  const row = await db.select().from(users).where(eq(users.id, userId)).get();
  return row ? rowToUser(row) : null;
}

export async function updateUserProfile(
  db: AppDb,
  userId: string,
  data: {
    name?: string;
    gitName?: string;
    gitEmail?: string;
    onboardingCompleted?: boolean;
    idleTimeoutSeconds?: number;
    sandboxCpuCores?: number;
    sandboxMemoryMib?: number;
    modelPreferences?: string[];
    uiQueueMode?: QueueMode;
    timezone?: string;
  },
): Promise<User | null> {
  const setValues: Record<string, unknown> = { updatedAt: sql`datetime('now')` };

  if (data.name !== undefined) setValues.name = sql`COALESCE(${data.name}, ${users.name})`;
  if (data.gitName !== undefined) setValues.gitName = sql`COALESCE(${data.gitName}, ${users.gitName})`;
  if (data.gitEmail !== undefined) setValues.gitEmail = sql`COALESCE(${data.gitEmail}, ${users.gitEmail})`;
  if (data.onboardingCompleted !== undefined) setValues.onboardingCompleted = data.onboardingCompleted;
  if (data.idleTimeoutSeconds !== undefined) setValues.idleTimeoutSeconds = sql`COALESCE(${data.idleTimeoutSeconds}, ${users.idleTimeoutSeconds})`;
  if (data.sandboxCpuCores !== undefined) setValues.sandboxCpuCores = data.sandboxCpuCores;
  if (data.sandboxMemoryMib !== undefined) setValues.sandboxMemoryMib = data.sandboxMemoryMib;
  if (data.modelPreferences !== undefined) setValues.modelPreferences = sql`COALESCE(${JSON.stringify(data.modelPreferences)}, ${users.modelPreferences})`;
  if (data.uiQueueMode !== undefined) setValues.uiQueueMode = sql`COALESCE(${data.uiQueueMode}, ${users.uiQueueMode})`;
  if (data.timezone !== undefined) setValues.timezone = data.timezone || null;

  await db
    .update(users)
    .set(setValues)
    .where(eq(users.id, userId));

  return getUserById(db, userId);
}

export async function backfillGitConfig(
  db: AppDb,
  userId: string,
  data: { gitName?: string; gitEmail?: string }
): Promise<User | null> {
  const setValues: Record<string, unknown> = {};

  if (data.gitName) {
    setValues.gitName = sql`COALESCE(${users.gitName}, ${data.gitName})`;
  }
  if (data.gitEmail) {
    setValues.gitEmail = sql`COALESCE(${users.gitEmail}, ${data.gitEmail})`;
  }

  if (Object.keys(setValues).length === 0) return getUserById(db, userId);

  setValues.updatedAt = sql`datetime('now')`;

  await db
    .update(users)
    .set(setValues)
    .where(eq(users.id, userId));

  return getUserById(db, userId);
}

export async function updateUserPasswordHash(
  db: AppDb,
  userId: string,
  passwordHash: string,
  identityProvider: string,
): Promise<void> {
  await db
    .update(users)
    .set({ passwordHash, identityProvider, updatedAt: sql`datetime('now')` })
    .where(eq(users.id, userId));
}

export async function findUserWithPasswordHash(
  db: AppDb,
  email: string,
): Promise<(User & { passwordHash: string | null }) | null> {
  const row = await db.select().from(users).where(eq(users.email, email)).get();
  if (!row) return null;
  return { ...rowToUser(row), passwordHash: row.passwordHash };
}

export async function updateUserRole(db: AppDb, userId: string, role: UserRole): Promise<void> {
  await db
    .update(users)
    .set({ role, updatedAt: sql`datetime('now')` })
    .where(eq(users.id, userId));
}

export async function getUserCount(db: AppDb): Promise<number> {
  const row = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(users)
    .get();
  return row?.count ?? 0;
}

/**
 * Atomically promote a user to admin only if they are the sole user in the system.
 * Uses a single UPDATE with a subquery to avoid race conditions where two concurrent
 * registrations both see count=1 and both get promoted.
 */
export async function promoteIfOnlyUser(db: AppDb, userId: string): Promise<void> {
  await db.run(sql`
    UPDATE users SET role = 'admin', updated_at = datetime('now')
    WHERE id = ${userId} AND (SELECT COUNT(*) FROM users) = 1
  `);
}

export async function listUsers(db: AppDb): Promise<User[]> {
  const rows = await db.select().from(users).orderBy(asc(users.createdAt));
  return rows.map(rowToUser);
}

export async function deleteUser(db: AppDb, userId: string): Promise<void> {
  // Clean up user-owned credentials (no longer cascade-deleted after migration 0066)
  await db.delete(credentials).where(and(eq(credentials.ownerType, 'user'), eq(credentials.ownerId, userId)));
  await db.delete(users).where(eq(users.id, userId));
}

// ─── DO Helpers ──────────────────────────────────────────────────────────────

export async function getUserIdleTimeout(db: AppDb, userId: string): Promise<number> {
  const row = await db
    .select({ idleTimeoutSeconds: users.idleTimeoutSeconds })
    .from(users)
    .where(eq(users.id, userId))
    .get();
  return row?.idleTimeoutSeconds ?? 900;
}

export async function getUserGitConfig(
  db: AppDb,
  userId: string,
): Promise<{
  name: string | null;
  email: string | null;
  githubUsername: string | null;
  gitName: string | null;
  gitEmail: string | null;
} | null> {
  const row = await db
    .select({
      name: users.name,
      email: users.email,
      githubUsername: users.githubUsername,
      gitName: users.gitName,
      gitEmail: users.gitEmail,
    })
    .from(users)
    .where(eq(users.id, userId))
    .get();
  return row || null;
}

export async function getUsersByIds(db: AppDb, userIds: string[]): Promise<User[]> {
  if (userIds.length === 0) return [];
  const rows = await db.select().from(users).where(inArray(users.id, userIds));
  return rows.map(rowToUser);
}

export async function getUserDiscoveredModels(
  db: AppDb,
  userId: string,
): Promise<unknown[] | null> {
  const row = await db
    .select({ discoveredModels: users.discoveredModels })
    .from(users)
    .where(eq(users.id, userId))
    .get();
  if (!row?.discoveredModels) return null;
  const parsed = row.discoveredModels;
  return Array.isArray(parsed) ? parsed : null;
}

export async function updateUserDiscoveredModels(
  db: AppDb,
  userId: string,
  modelsJson: string,
): Promise<void> {
  await db
    .update(users)
    .set({ discoveredModels: sql`${modelsJson}` })
    .where(eq(users.id, userId));
}
