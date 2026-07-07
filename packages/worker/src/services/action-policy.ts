import type { AppDb } from '../lib/drizzle.js';
import { resolveEffectiveActionPolicy, resolvePolicy } from '../lib/db.js';
import type { EffectivePolicyResult, ResolveActionPolicyInput } from '../lib/db/actions.js';
import type { ActionMode } from '@valet/shared';

/**
 * Resolve the effective admin/system mode for a service/action/risk combo —
 * no grant lookup. Used where the caller only needs the base decision.
 */
export async function resolveMode(
  db: AppDb,
  service: string,
  actionId: string,
  riskLevel: string,
): Promise<{ mode: ActionMode; policyId: string | null }> {
  return resolvePolicy(db, service, actionId, riskLevel);
}

/**
 * Resolve the effective decision for a concrete request, consulting admin
 * policy, runtime grants over the session lineage and workflow execution,
 * and durable user policies. See `resolveEffectiveActionPolicy` for the
 * full algorithm.
 */
export async function resolveEffectiveMode(
  db: AppDb,
  input: ResolveActionPolicyInput,
): Promise<EffectivePolicyResult> {
  return resolveEffectiveActionPolicy(db, input);
}
