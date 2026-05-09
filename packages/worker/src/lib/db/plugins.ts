import { eq, and, sql } from 'drizzle-orm';
import type { AppDb } from '../drizzle.js';
import { getDb } from '../drizzle.js';
import { orgPlugins, orgPluginArtifacts, orgPluginSettings } from '../schema/index.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export type PluginRecord = typeof orgPlugins.$inferSelect;
export type PluginArtifactRecord = typeof orgPluginArtifacts.$inferSelect;
export type PluginSettingsRecord = typeof orgPluginSettings.$inferSelect;

export type PluginWithArtifacts = PluginRecord & {
  artifacts: PluginArtifactRecord[];
};

export type PluginArtifact = {
  pluginName: string;
  type: string;
  filename: string;
  content: string;
  sortOrder: number;
};

export type PluginSettings = {
  allowRepoContent: boolean;
};

// ─── Plugins ────────────────────────────────────────────────────────────────

export async function listPlugins(db: D1Database, orgId: string = 'default'): Promise<PluginRecord[]> {
  const drizzle = getDb(db);
  return drizzle
    .select()
    .from(orgPlugins)
    .where(eq(orgPlugins.orgId, orgId))
    .orderBy(orgPlugins.name)
    .all();
}

export async function getPlugin(db: D1Database, id: string): Promise<PluginWithArtifacts | null> {
  const drizzle = getDb(db);

  const plugin = await drizzle
    .select()
    .from(orgPlugins)
    .where(eq(orgPlugins.id, id))
    .get();

  if (!plugin) return null;

  const artifacts = await drizzle
    .select()
    .from(orgPluginArtifacts)
    .where(eq(orgPluginArtifacts.pluginId, id))
    .orderBy(orgPluginArtifacts.sortOrder, orgPluginArtifacts.filename)
    .all();

  return { ...plugin, artifacts };
}

export async function upsertPlugin(
  db: AppDb,
  data: {
    id: string;
    orgId?: string;
    name: string;
    version: string;
    description?: string;
    icon?: string;
    actionType?: string;
    authRequired?: boolean;
    source?: string;
    capabilities?: string[];
    status?: string;
    installedBy?: string;
  },
): Promise<void> {
  await db.insert(orgPlugins).values({
    id: data.id,
    orgId: data.orgId ?? 'default',
    name: data.name,
    version: data.version,
    description: data.description ?? null,
    icon: data.icon ?? null,
    actionType: data.actionType ?? null,
    authRequired: data.authRequired ?? true,
    source: data.source ?? 'builtin',
    capabilities: data.capabilities ?? [],
    status: data.status ?? 'active',
    installedBy: data.installedBy ?? 'system',
  }).onConflictDoUpdate({
    target: [orgPlugins.orgId, orgPlugins.name],
    set: {
      version: sql`excluded.version`,
      description: sql`excluded.description`,
      icon: sql`excluded.icon`,
      actionType: sql`excluded.action_type`,
      authRequired: sql`excluded.auth_required`,
      source: sql`excluded.source`,
      capabilities: sql`excluded.capabilities`,
      updatedAt: sql`datetime('now')`,
    },
  });
}

export async function updatePluginStatus(db: AppDb, id: string, status: string): Promise<void> {
  await db
    .update(orgPlugins)
    .set({ status, updatedAt: sql`datetime('now')` })
    .where(eq(orgPlugins.id, id));
}

/**
 * Returns service names for active plugins that don't require auth.
 * These get synthetic integration entries so tools are available to all users.
 */
export async function getAutoEnabledServices(
  db: D1Database,
  orgId: string = 'default',
): Promise<string[]> {
  const result = await db
    .prepare(
      `SELECT name FROM org_plugins
       WHERE org_id = ? AND status = 'active' AND auth_required = 0`
    )
    .bind(orgId)
    .all();
  return (result.results || []).map((row: any) => pluginNameToService(row.name as string));
}

/**
 * Converts a plugin name (e.g. 'google-workspace') to the service identifier
 * used by the integration registry and credentials table (e.g. 'google_workspace').
 */
export function pluginNameToService(name: string): string {
  return name.replace(/-/g, '_');
}

/**
 * Returns service names for plugins that have been disabled by an admin.
 * Used by SessionAgentDO to block tool discovery and invocation.
 * Names are normalized to service identifiers (hyphens → underscores).
 */
export async function getDisabledPluginServices(
  db: D1Database,
  orgId: string = 'default',
): Promise<Set<string>> {
  const result = await db
    .prepare(
      `SELECT name FROM org_plugins
       WHERE org_id = ? AND status = 'disabled'`
    )
    .bind(orgId)
    .all();
  return new Set((result.results || []).map((row: any) => pluginNameToService(row.name as string)));
}

// ─── Artifacts ──────────────────────────────────────────────────────────────

export async function upsertPluginArtifact(
  db: AppDb,
  data: {
    id: string;
    pluginId: string;
    type: string;
    filename: string;
    content: string;
    sortOrder?: number;
  },
): Promise<void> {
  await db.insert(orgPluginArtifacts).values({
    id: data.id,
    pluginId: data.pluginId,
    type: data.type,
    filename: data.filename,
    content: data.content,
    sortOrder: data.sortOrder ?? 0,
  }).onConflictDoUpdate({
    target: [orgPluginArtifacts.pluginId, orgPluginArtifacts.type, orgPluginArtifacts.filename],
    set: {
      content: sql`excluded.content`,
      sortOrder: sql`excluded.sort_order`,
    },
  });
}

export async function deletePluginArtifacts(db: AppDb, pluginId: string): Promise<void> {
  await db.delete(orgPluginArtifacts).where(eq(orgPluginArtifacts.pluginId, pluginId));
}

export async function getActivePluginArtifacts(
  db: D1Database,
  orgId: string = 'default',
): Promise<PluginArtifact[]> {
  const result = await db
    .prepare(
      `SELECT p.name as plugin_name, a.type, a.filename, a.content, a.sort_order
       FROM org_plugin_artifacts a
       INNER JOIN org_plugins p ON p.id = a.plugin_id
       WHERE p.org_id = ? AND p.status = 'active'
       ORDER BY p.name, a.type, a.sort_order, a.filename`
    )
    .bind(orgId)
    .all();

  return (result.results || []).map((row: any): PluginArtifact => ({
    pluginName: row.plugin_name,
    type: row.type,
    filename: row.filename,
    content: row.content,
    sortOrder: row.sort_order ?? 0,
  }));
}

// ─── Settings ───────────────────────────────────────────────────────────────

export async function getPluginSettings(
  db: D1Database,
  orgId: string = 'default',
): Promise<PluginSettings> {
  const row = await db
    .prepare('SELECT allow_repo_content FROM org_plugin_settings WHERE org_id = ?')
    .bind(orgId)
    .first<any>();

  return {
    allowRepoContent: row ? !!row.allow_repo_content : true,
  };
}

export async function upsertPluginSettings(
  db: AppDb,
  orgId: string,
  settings: Partial<PluginSettings>,
): Promise<void> {
  await db.insert(orgPluginSettings).values({
    id: crypto.randomUUID(),
    orgId,
    allowRepoContent: settings.allowRepoContent ?? true,
  }).onConflictDoUpdate({
    target: [orgPluginSettings.orgId],
    set: {
      allowRepoContent: settings.allowRepoContent ?? true,
      updatedAt: sql`datetime('now')`,
    },
  });
}
