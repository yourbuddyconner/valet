import type { AppDb } from '../drizzle.js';
import { eq, and, sql, lt } from 'drizzle-orm';
import { orgSlackInstalls, slackLinkVerifications } from '../schema/index.js';
import { decryptString } from '../crypto.js';
import { getServiceConfig, setServiceConfig, deleteServiceConfig } from './service-configs.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/** @deprecated Use SlackInstallInfo for getter return types */
export interface OrgSlackInstall {
  id: string;
  teamId: string;
  teamName: string | null;
  botUserId: string;
  appId: string | null;
  encryptedBotToken: string;
  encryptedSigningSecret: string | null;
  installedBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface SlackServiceConfig {
  botToken: string;
  signingSecret?: string;
}

export interface SlackServiceMetadata {
  teamId: string;
  teamName?: string;
  botUserId: string;
  appId?: string;
}

/** Decrypted return type — replaces OrgSlackInstall in getter returns */
export interface SlackInstallInfo {
  teamId: string;
  teamName: string | null;
  botUserId: string;
  appId: string | null;
  botToken: string;
  signingSecret: string | null;
  configuredBy: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface SlackLinkVerification {
  id: string;
  userId: string;
  slackUserId: string;
  slackDisplayName: string | null;
  code: string;
  expiresAt: string;
  createdAt: string;
}

// ─── Org Install Helpers ────────────────────────────────────────────────────

export async function getOrgSlackInstall(
  db: AppDb,
  encryptionKey: string,
  teamId: string,
): Promise<SlackInstallInfo | null> {
  try {
    const result = await getServiceConfig<SlackServiceConfig, SlackServiceMetadata>(db, encryptionKey, 'slack');
    if (result) {
      if (result.metadata.teamId !== teamId) return null;
      return {
        teamId: result.metadata.teamId,
        teamName: result.metadata.teamName || null,
        botUserId: result.metadata.botUserId,
        appId: result.metadata.appId || null,
        botToken: result.config.botToken,
        signingSecret: result.config.signingSecret || null,
        configuredBy: result.configuredBy,
        updatedAt: result.updatedAt,
      };
    }
  } catch {
    // Table may not exist yet — fall through to legacy table
  }

  // Legacy fallback: read from org_slack_installs, migrate to new table
  const row = await db
    .select()
    .from(orgSlackInstalls)
    .where(eq(orgSlackInstalls.teamId, teamId))
    .get();
  if (!row) return null;

  const botToken = await decryptString(row.encryptedBotToken, encryptionKey);
  const signingSecret = row.encryptedSigningSecret
    ? await decryptString(row.encryptedSigningSecret, encryptionKey)
    : null;

  // Migrate to new table
  await setServiceConfig<SlackServiceConfig, SlackServiceMetadata>(
    db,
    encryptionKey,
    'slack',
    { botToken, signingSecret: signingSecret || undefined },
    { teamId: row.teamId, teamName: row.teamName || undefined, botUserId: row.botUserId, appId: row.appId || undefined },
    row.installedBy,
  );

  return {
    teamId: row.teamId,
    teamName: row.teamName,
    botUserId: row.botUserId,
    appId: row.appId,
    botToken,
    signingSecret,
    configuredBy: row.installedBy,
    createdAt: row.createdAt!,
    updatedAt: row.updatedAt!,
  };
}

export async function getOrgSlackInstallAny(
  db: AppDb,
  encryptionKey: string,
): Promise<SlackInstallInfo | null> {
  try {
    const result = await getServiceConfig<SlackServiceConfig, SlackServiceMetadata>(db, encryptionKey, 'slack');
    if (result) {
      return {
        teamId: result.metadata.teamId,
        teamName: result.metadata.teamName || null,
        botUserId: result.metadata.botUserId,
        appId: result.metadata.appId || null,
        botToken: result.config.botToken,
        signingSecret: result.config.signingSecret || null,
        configuredBy: result.configuredBy,
        updatedAt: result.updatedAt,
      };
    }
  } catch {
    // Table may not exist yet — fall through to legacy table
  }

  // Legacy fallback: read from org_slack_installs, migrate to new table
  const row = await db
    .select()
    .from(orgSlackInstalls)
    .limit(1)
    .get();
  if (!row) return null;

  const botToken = await decryptString(row.encryptedBotToken, encryptionKey);
  const signingSecret = row.encryptedSigningSecret
    ? await decryptString(row.encryptedSigningSecret, encryptionKey)
    : null;

  // Migrate to new table
  await setServiceConfig<SlackServiceConfig, SlackServiceMetadata>(
    db,
    encryptionKey,
    'slack',
    { botToken, signingSecret: signingSecret || undefined },
    { teamId: row.teamId, teamName: row.teamName || undefined, botUserId: row.botUserId, appId: row.appId || undefined },
    row.installedBy,
  );

  return {
    teamId: row.teamId,
    teamName: row.teamName,
    botUserId: row.botUserId,
    appId: row.appId,
    botToken,
    signingSecret,
    configuredBy: row.installedBy,
    createdAt: row.createdAt!,
    updatedAt: row.updatedAt!,
  };
}

export async function saveOrgSlackInstall(
  db: AppDb,
  encryptionKey: string,
  data: {
    teamId: string;
    teamName?: string;
    botUserId: string;
    appId?: string;
    botToken: string;
    signingSecret?: string;
    installedBy: string;
  },
): Promise<SlackInstallInfo> {
  await setServiceConfig<SlackServiceConfig, SlackServiceMetadata>(
    db,
    encryptionKey,
    'slack',
    { botToken: data.botToken, signingSecret: data.signingSecret },
    { teamId: data.teamId, teamName: data.teamName, botUserId: data.botUserId, appId: data.appId },
    data.installedBy,
  );

  return {
    teamId: data.teamId,
    teamName: data.teamName || null,
    botUserId: data.botUserId,
    appId: data.appId || null,
    botToken: data.botToken,
    signingSecret: data.signingSecret || null,
    configuredBy: data.installedBy,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export async function deleteOrgSlackInstall(
  db: AppDb,
): Promise<boolean> {
  return deleteServiceConfig(db, 'slack');
}

// ─── Verification Helpers ───────────────────────────────────────────────────

export async function createSlackLinkVerification(
  db: AppDb,
  data: {
    id: string;
    userId: string;
    slackUserId: string;
    slackDisplayName?: string;
    code: string;
    expiresAt: string;
  },
): Promise<SlackLinkVerification> {
  await db.insert(slackLinkVerifications).values({
    id: data.id,
    userId: data.userId,
    slackUserId: data.slackUserId,
    slackDisplayName: data.slackDisplayName || null,
    code: data.code,
    expiresAt: data.expiresAt,
  });

  return {
    id: data.id,
    userId: data.userId,
    slackUserId: data.slackUserId,
    slackDisplayName: data.slackDisplayName || null,
    code: data.code,
    expiresAt: data.expiresAt,
    createdAt: new Date().toISOString(),
  };
}

export async function getSlackLinkVerification(
  db: AppDb,
  userId: string,
): Promise<SlackLinkVerification | null> {
  const now = new Date().toISOString();
  const row = await db
    .select()
    .from(slackLinkVerifications)
    .where(
      and(
        eq(slackLinkVerifications.userId, userId),
        sql`${slackLinkVerifications.expiresAt} > ${now}`,
      ),
    )
    .orderBy(sql`${slackLinkVerifications.createdAt} DESC`)
    .limit(1)
    .get();
  return row ? { ...row, createdAt: row.createdAt! } : null;
}

export async function deleteSlackLinkVerification(
  db: AppDb,
  id: string,
): Promise<void> {
  await db.delete(slackLinkVerifications).where(eq(slackLinkVerifications.id, id));
}

export async function deleteExpiredSlackLinkVerifications(
  db: AppDb,
): Promise<number> {
  const now = new Date().toISOString();
  const result = await db
    .delete(slackLinkVerifications)
    .where(lt(slackLinkVerifications.expiresAt, now));
  return result.meta?.changes ?? 0;
}
