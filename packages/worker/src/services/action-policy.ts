import type { AppDb } from '../lib/drizzle.js';
import { resolveEffectiveActionPolicy, resolvePolicy } from '../lib/db.js';
import type { EffectivePolicyResult } from '../lib/db/actions.js';
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

export async function resolveEffectiveMode(
  db: AppDb,
  input: { userId: string; sessionId: string; service: string; actionId: string; riskLevel: string },
): Promise<EffectivePolicyResult> {
  return resolveEffectiveActionPolicy(db, input);
}
