import type { AppDb } from '../lib/drizzle.js';
import { resolvePolicy } from '../lib/db.js';
import type { ActionMode } from '@valet/shared';

/**
 * Resolve the effective action mode for a given service/action/risk combination.
 * Thin wrapper around the DB cascade resolution.
 */
export async function resolveMode(
  db: AppDb,
  service: string,
  actionId: string,
  riskLevel: string,
): Promise<{ mode: ActionMode; policyId: string | null }> {
  return resolvePolicy(db, service, actionId, riskLevel);
}
