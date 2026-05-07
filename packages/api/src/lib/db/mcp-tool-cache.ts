import { eq } from 'drizzle-orm';
import type { AppDb } from '../drizzle.js';
import { mcpToolCache } from '../schema/index.js';

export interface McpToolCacheEntry {
  service: string;
  actionId: string;
  name: string;
  description: string;
  riskLevel: string;
}

/**
 * Upsert a batch of MCP tool entries for a given service.
 * Uses INSERT ... ON CONFLICT to update existing rows.
 */
export async function upsertMcpToolCache(
  db: AppDb,
  entries: McpToolCacheEntry[],
): Promise<void> {
  if (entries.length === 0) return;

  const now = new Date().toISOString();
  for (const entry of entries) {
    await db
      .insert(mcpToolCache)
      .values({
        service: entry.service,
        actionId: entry.actionId,
        name: entry.name,
        description: entry.description,
        riskLevel: entry.riskLevel,
        discoveredAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [mcpToolCache.service, mcpToolCache.actionId],
        set: {
          name: entry.name,
          description: entry.description,
          riskLevel: entry.riskLevel,
          updatedAt: now,
        },
      });
  }
}

/**
 * List all cached MCP tools, optionally filtered by service.
 * Returns entries ordered by service + actionId.
 */
export async function listMcpToolCache(
  db: AppDb,
  serviceFilter?: string,
): Promise<McpToolCacheEntry[]> {
  let query = db
    .select({
      service: mcpToolCache.service,
      actionId: mcpToolCache.actionId,
      name: mcpToolCache.name,
      description: mcpToolCache.description,
      riskLevel: mcpToolCache.riskLevel,
    })
    .from(mcpToolCache);

  if (serviceFilter) {
    query = query.where(eq(mcpToolCache.service, serviceFilter)) as typeof query;
  }

  return query.all();
}
