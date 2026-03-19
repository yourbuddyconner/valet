import type { AppDb } from '../drizzle.js';
import { eq, sql } from 'drizzle-orm';
import { orgServiceConfigs } from '../schema/index.js';
import { encryptString, decryptString } from '../crypto.js';

// ─── Service Config Helpers ────────────────────────────────────────────────

export async function getServiceConfig<TConfig = Record<string, unknown>, TMeta = Record<string, unknown>>(
  db: AppDb,
  encryptionKey: string,
  service: string,
): Promise<{ config: TConfig; metadata: TMeta; configuredBy: string; updatedAt: string } | null> {
  const row = await db
    .select()
    .from(orgServiceConfigs)
    .where(eq(orgServiceConfigs.service, service))
    .get();
  if (!row) return null;

  const decrypted = await decryptString(row.encryptedConfig, encryptionKey);
  const config = JSON.parse(decrypted) as TConfig;
  const metadata = row.metadata ? (JSON.parse(row.metadata) as TMeta) : ({} as TMeta);

  return { config, metadata, configuredBy: row.configuredBy, updatedAt: row.updatedAt! };
}

export async function setServiceConfig<TConfig = Record<string, unknown>, TMeta = Record<string, unknown>>(
  db: AppDb,
  encryptionKey: string,
  service: string,
  config: TConfig,
  metadata: TMeta,
  configuredBy: string,
): Promise<void> {
  const encrypted = await encryptString(JSON.stringify(config), encryptionKey);
  const metaJson = JSON.stringify(metadata);
  const now = new Date().toISOString();

  await db.insert(orgServiceConfigs).values({
    service,
    encryptedConfig: encrypted,
    metadata: metaJson,
    configuredBy,
    createdAt: now,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: orgServiceConfigs.service,
    set: {
      encryptedConfig: sql`excluded.encrypted_config`,
      metadata: sql`excluded.metadata`,
      configuredBy: sql`excluded.configured_by`,
      updatedAt: sql`excluded.updated_at`,
    },
  });
}

export async function getServiceMetadata<TMeta = Record<string, unknown>>(
  db: AppDb,
  service: string,
): Promise<TMeta | null> {
  const row = await db
    .select({ metadata: orgServiceConfigs.metadata })
    .from(orgServiceConfigs)
    .where(eq(orgServiceConfigs.service, service))
    .get();
  if (!row?.metadata) return null;
  return JSON.parse(row.metadata) as TMeta;
}

export async function updateServiceMetadata<TMeta = Record<string, unknown>>(
  db: AppDb,
  service: string,
  metadata: TMeta,
): Promise<void> {
  await db.update(orgServiceConfigs)
    .set({
      metadata: JSON.stringify(metadata),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(orgServiceConfigs.service, service));
}

export async function deleteServiceConfig(
  db: AppDb,
  service: string,
): Promise<boolean> {
  const result = await db
    .delete(orgServiceConfigs)
    .where(eq(orgServiceConfigs.service, service));
  return (result.meta?.changes ?? 0) > 0;
}
