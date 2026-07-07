import { eq } from 'drizzle-orm';
import type { AppDb } from '../drizzle.js';
import { mcpToolCache } from '../schema/index.js';

export interface McpToolCacheEntry {
  service: string;
  actionId: string;
  name: string;
  description: string;
  riskLevel: string;
  /**
   * MCP-derived schemas (added in migration 0021). The DB stores them as
   * JSON-encoded TEXT; the helpers below transparently serialize on write
   * and parse on read so callers see real objects.
   */
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
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
    const inputSchemaJson = entry.inputSchema ? JSON.stringify(entry.inputSchema) : null;
    const outputSchemaJson = entry.outputSchema ? JSON.stringify(entry.outputSchema) : null;
    await db
      .insert(mcpToolCache)
      .values({
        service: entry.service,
        actionId: entry.actionId,
        name: entry.name,
        description: entry.description,
        riskLevel: entry.riskLevel,
        inputSchema: inputSchemaJson,
        outputSchema: outputSchemaJson,
        discoveredAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [mcpToolCache.service, mcpToolCache.actionId],
        set: {
          name: entry.name,
          description: entry.description,
          riskLevel: entry.riskLevel,
          inputSchema: inputSchemaJson,
          outputSchema: outputSchemaJson,
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
      inputSchema: mcpToolCache.inputSchema,
      outputSchema: mcpToolCache.outputSchema,
    })
    .from(mcpToolCache);

  if (serviceFilter) {
    query = query.where(eq(mcpToolCache.service, serviceFilter)) as typeof query;
  }

  const rows = (await query.all()) as Array<{
    service: string;
    actionId: string;
    name: string;
    description: string;
    riskLevel: string;
    inputSchema: string | null;
    outputSchema: string | null;
  }>;
  return rows.map((row) => ({
    service: row.service,
    actionId: row.actionId,
    name: row.name,
    description: row.description,
    riskLevel: row.riskLevel,
    ...(row.inputSchema ? { inputSchema: safeParseJsonObject(row.inputSchema) } : {}),
    ...(row.outputSchema ? { outputSchema: safeParseJsonObject(row.outputSchema) } : {}),
  }));
}

// Tolerant of a corrupted/empty JSON string in the cache: return undefined
// rather than throw so a single bad row doesn't poison the whole listing.
function safeParseJsonObject(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
