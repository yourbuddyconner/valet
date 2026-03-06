import type { D1Database } from '@cloudflare/workers-types';
import { getDb } from '../lib/drizzle.js';
import * as db from '../lib/db.js';
import { pluginContentRegistry } from '../plugins/content-registry.js';

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
      source: 'builtin',
      capabilities: plugin.capabilities,
    });

    // Upsert each artifact (ON CONFLICT handles updates)
    for (const artifact of plugin.artifacts) {
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
