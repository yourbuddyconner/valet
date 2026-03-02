import type { AppDb } from '../drizzle.js';
import { eq } from 'drizzle-orm';
import { mcpOauthClients } from '../schema/index.js';

export interface McpOAuthClientRow {
  service: string;
  clientId: string;
  clientSecret: string | null;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string | null;
  scopesSupported: string | null;
  metadataJson: string | null;
}

export async function getMcpOAuthClient(
  db: AppDb,
  service: string,
): Promise<McpOAuthClientRow | null> {
  const row = await db
    .select()
    .from(mcpOauthClients)
    .where(eq(mcpOauthClients.service, service))
    .get();
  return (row as McpOAuthClientRow | undefined) ?? null;
}

/**
 * Insert a registered MCP OAuth client, ignoring if one already exists.
 * Uses INSERT OR IGNORE so the first registration wins — concurrent workers
 * that register different client_ids will all converge on the same one.
 * Returns the canonical row from DB (which may differ from `data` if another
 * worker inserted first).
 */
export async function insertMcpOAuthClientIfNotExists(
  db: AppDb,
  data: McpOAuthClientRow,
): Promise<McpOAuthClientRow> {
  await db
    .insert(mcpOauthClients)
    .values({
      service: data.service,
      clientId: data.clientId,
      clientSecret: data.clientSecret,
      authorizationEndpoint: data.authorizationEndpoint,
      tokenEndpoint: data.tokenEndpoint,
      registrationEndpoint: data.registrationEndpoint,
      scopesSupported: data.scopesSupported,
      metadataJson: data.metadataJson,
    })
    .onConflictDoNothing();

  // Re-read to return the canonical row (may be from a concurrent insert)
  return (await getMcpOAuthClient(db, data.service))!;
}
