import type { D1Database } from '@cloudflare/workers-types';
import { getDb } from '../lib/drizzle.js';
import * as db from '../lib/db.js';
import { pluginContentRegistry } from '../plugins/content-registry.js';

const BUILTIN_SKILL_PLUGINS = new Set(['browser', 'workflows', 'sandbox-tunnels']);

let syncPromise: Promise<void> | null = null;

export async function syncPluginsOnce(d1: D1Database, orgId: string = 'default', force = false): Promise<void> {
  if (syncPromise && !force) return syncPromise;

  syncPromise = doSync(d1, orgId);
  try {
    await syncPromise;
  } catch (err) {
    // Reset so next request retries
    syncPromise = null;
    throw err;
  }
}

async function doSync(d1: D1Database, orgId: string): Promise<void> {
  const appDb = getDb(d1);
  const syncedSkillIds = new Set<string>();

  for (const plugin of pluginContentRegistry) {
    const pluginId = `builtin:${plugin.name}`;

    await db.upsertPlugin(appDb, {
      id: pluginId,
      orgId,
      name: plugin.name,
      version: plugin.version,
      description: plugin.description,
      icon: plugin.icon,
      actionType: plugin.actionType,
      authRequired: plugin.authRequired,
      source: 'builtin',
      capabilities: plugin.capabilities,
    });

    // Upsert each artifact (ON CONFLICT handles updates)
    for (const artifact of plugin.artifacts) {
      if (artifact.type === 'skill') {
        // Route skill artifacts to the unified skills table
        const slug = artifact.filename.replace('.md', '').replace(/_/g, '-');
        const source = BUILTIN_SKILL_PLUGINS.has(plugin.name) ? 'builtin' as const : 'plugin' as const;
        const skillId = `skill:${orgId}:${slug}`;
        await db.upsertSkillFromSync(appDb, {
          id: skillId,
          orgId,
          source,
          name: slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
          slug,
          content: artifact.content,
          visibility: 'shared',
        });
        syncedSkillIds.add(skillId);
      } else {
        // Non-skill artifacts (tools, personas) continue using plugin_artifacts
        await db.upsertPluginArtifact(appDb, {
          id: crypto.randomUUID(),
          pluginId,
          type: artifact.type,
          filename: artifact.filename,
          content: artifact.content,
          sortOrder: artifact.sortOrder,
        });
      }
    }
  }

  // Clean up orphaned builtin/plugin skills that were not part of this sync
  await db.deleteOrphanedSyncSkills(appDb, orgId, syncedSkillIds);
}
