import type { AppDb } from '../drizzle.js';
import type { UserTelegramConfig } from '@valet/shared';
import { eq, sql } from 'drizzle-orm';
import { userTelegramConfig } from '../schema/index.js';

export async function getUserTelegramConfig(
  db: AppDb,
  userId: string,
): Promise<UserTelegramConfig | null> {
  const row = await db
    .select({
      id: userTelegramConfig.id,
      userId: userTelegramConfig.userId,
      botUsername: userTelegramConfig.botUsername,
      botInfo: userTelegramConfig.botInfo,
      webhookActive: userTelegramConfig.webhookActive,
      ownerTelegramUserId: userTelegramConfig.ownerTelegramUserId,
      createdAt: userTelegramConfig.createdAt,
      updatedAt: userTelegramConfig.updatedAt,
    })
    .from(userTelegramConfig)
    .where(eq(userTelegramConfig.userId, userId))
    .get();
  if (!row) return null;
  return {
    ...row,
    webhookActive: !!row.webhookActive,
    ownerTelegramUserId: row.ownerTelegramUserId ?? undefined,
    createdAt: row.createdAt!,
    updatedAt: row.updatedAt!,
  };
}

export async function saveUserTelegramConfig(
  db: AppDb,
  data: {
    id: string;
    userId: string;
    botUsername: string;
    botInfo: string;
  },
): Promise<UserTelegramConfig> {
  const now = new Date().toISOString();

  await db.insert(userTelegramConfig).values({
    id: data.id,
    userId: data.userId,
    botUsername: data.botUsername,
    botInfo: data.botInfo,
    createdAt: now,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: userTelegramConfig.userId,
    set: {
      botUsername: sql`excluded.bot_username`,
      botInfo: sql`excluded.bot_info`,
      updatedAt: sql`excluded.updated_at`,
    },
  });

  return {
    id: data.id,
    userId: data.userId,
    botUsername: data.botUsername,
    botInfo: data.botInfo,
    webhookActive: false,
    createdAt: now,
    updatedAt: now,
  };
}

export async function updateTelegramWebhookStatus(
  db: AppDb,
  userId: string,
  webhookUrl: string,
  active: boolean,
): Promise<void> {
  await db
    .update(userTelegramConfig)
    .set({
      webhookUrl,
      webhookActive: active,
      updatedAt: sql`datetime('now')`,
    })
    .where(eq(userTelegramConfig.userId, userId));
}

export async function updateTelegramOwner(
  db: AppDb,
  userId: string,
  ownerTelegramUserId: string,
): Promise<void> {
  await db
    .update(userTelegramConfig)
    .set({ ownerTelegramUserId, updatedAt: new Date().toISOString() })
    .where(eq(userTelegramConfig.userId, userId));
}

export async function deleteUserTelegramConfig(
  db: AppDb,
  userId: string,
): Promise<boolean> {
  const result = await db
    .delete(userTelegramConfig)
    .where(eq(userTelegramConfig.userId, userId));
  return (result.meta?.changes ?? 0) > 0;
}
