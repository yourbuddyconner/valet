import { eq, and, or, isNull, desc, sql } from 'drizzle-orm';
import type { AppDb } from '../drizzle.js';
import { actionPolicies, actionInvocations } from '../schema/index.js';
import type { ActionMode } from '@agent-ops/shared';

// ─── System Defaults ─────────────────────────────────────────────────────────

const SYSTEM_DEFAULTS: Record<string, ActionMode> = {
  low: 'allow',
  medium: 'require_approval',
  high: 'require_approval',
  critical: 'deny',
};

// ─── Policies ────────────────────────────────────────────────────────────────

export async function listActionPolicies(db: AppDb) {
  return db
    .select()
    .from(actionPolicies)
    .orderBy(actionPolicies.createdAt)
    .all();
}

export async function upsertActionPolicy(
  db: AppDb,
  data: {
    id: string;
    service?: string | null;
    actionId?: string | null;
    riskLevel?: string | null;
    mode: ActionMode;
    createdBy: string;
  },
) {
  const now = new Date().toISOString();
  const svc = data.service ?? null;
  const act = data.actionId ?? null;
  const risk = data.riskLevel ?? null;

  // Check for an existing policy with the same scope to avoid partial-index conflicts.
  // The partial unique indexes enforce uniqueness on (service, action_id), (service), and (risk_level),
  // but onConflictDoUpdate only targets the PK. Find and reuse the existing ID if a scope match exists.
  let existingId: string | null = null;

  if (svc && act) {
    // Action-level scope
    const existing = await db.select({ id: actionPolicies.id }).from(actionPolicies)
      .where(and(eq(actionPolicies.service, svc), eq(actionPolicies.actionId, act)))
      .get();
    existingId = existing?.id ?? null;
  } else if (svc && !act && !risk) {
    // Service-level scope
    const existing = await db.select({ id: actionPolicies.id }).from(actionPolicies)
      .where(and(eq(actionPolicies.service, svc), isNull(actionPolicies.actionId), isNull(actionPolicies.riskLevel)))
      .get();
    existingId = existing?.id ?? null;
  } else if (!svc && !act && risk) {
    // Risk-level scope
    const existing = await db.select({ id: actionPolicies.id }).from(actionPolicies)
      .where(and(isNull(actionPolicies.service), isNull(actionPolicies.actionId), eq(actionPolicies.riskLevel, risk)))
      .get();
    existingId = existing?.id ?? null;
  }

  // Use the existing policy's ID if one was found for the same scope, otherwise use the provided ID
  const effectiveId = existingId ?? data.id;

  await db
    .insert(actionPolicies)
    .values({
      id: effectiveId,
      service: svc,
      actionId: act,
      riskLevel: risk,
      mode: data.mode,
      createdBy: data.createdBy,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: actionPolicies.id,
      set: {
        service: svc,
        actionId: act,
        riskLevel: risk,
        mode: data.mode,
        updatedAt: now,
      },
    });
}

export async function deleteActionPolicy(db: AppDb, id: string) {
  await db.delete(actionPolicies).where(eq(actionPolicies.id, id));
}

/**
 * Cascade resolution: fetch all potentially matching policies, then pick the
 * most specific match.
 *
 * Priority order:
 *   1. Exact action match (service + actionId)
 *   2. Service-level match (service only)
 *   3. Risk-level match
 *   4. System default based on risk level
 */
export async function resolvePolicy(
  db: AppDb,
  service: string,
  actionId: string,
  riskLevel: string,
): Promise<{ mode: ActionMode; policyId: string | null }> {
  const rows = await db
    .select()
    .from(actionPolicies)
    .where(
      or(
        // Match specific action
        and(eq(actionPolicies.service, service), eq(actionPolicies.actionId, actionId)),
        // Match service-level (no actionId, no riskLevel)
        and(eq(actionPolicies.service, service), isNull(actionPolicies.actionId), isNull(actionPolicies.riskLevel)),
        // Match risk-level (no service, no actionId)
        and(isNull(actionPolicies.service), isNull(actionPolicies.actionId), eq(actionPolicies.riskLevel, riskLevel)),
      ),
    )
    .all();

  // Find most specific match
  type PolicyRow = typeof rows[number];

  // Priority 1: exact action match
  const actionMatch = rows.find((r: PolicyRow) => r.service === service && r.actionId === actionId);
  if (actionMatch) {
    return { mode: actionMatch.mode as ActionMode, policyId: actionMatch.id };
  }

  // Priority 2: service-level match
  const serviceMatch = rows.find((r: PolicyRow) => r.service === service && !r.actionId && !r.riskLevel);
  if (serviceMatch) {
    return { mode: serviceMatch.mode as ActionMode, policyId: serviceMatch.id };
  }

  // Priority 3: risk-level match
  const riskMatch = rows.find((r: PolicyRow) => !r.service && !r.actionId && r.riskLevel === riskLevel);
  if (riskMatch) {
    return { mode: riskMatch.mode as ActionMode, policyId: riskMatch.id };
  }

  // Priority 4: system default
  const defaultMode = SYSTEM_DEFAULTS[riskLevel] || 'require_approval';
  return { mode: defaultMode, policyId: null };
}

// ─── Invocations ─────────────────────────────────────────────────────────────

export async function createInvocation(
  db: AppDb,
  data: {
    id: string;
    sessionId: string;
    userId: string;
    service: string;
    actionId: string;
    riskLevel: string;
    resolvedMode: ActionMode;
    params?: string;
    expiresAt?: string;
    policyId?: string | null;
    status?: string;
  },
) {
  const now = new Date().toISOString();
  await db.insert(actionInvocations).values({
    id: data.id,
    sessionId: data.sessionId,
    userId: data.userId,
    service: data.service,
    actionId: data.actionId,
    riskLevel: data.riskLevel,
    resolvedMode: data.resolvedMode,
    params: data.params,
    expiresAt: data.expiresAt,
    policyId: data.policyId ?? null,
    status: data.status || 'pending',
    createdAt: now,
    updatedAt: now,
  });
}

export async function getInvocation(db: AppDb, id: string) {
  return db
    .select()
    .from(actionInvocations)
    .where(eq(actionInvocations.id, id))
    .get();
}

export async function updateInvocationStatus(
  db: AppDb,
  id: string,
  update: {
    status: string;
    result?: string;
    error?: string;
    resolvedBy?: string;
    resolvedAt?: string;
    executedAt?: string;
    expectedStatus?: string;
  },
) {
  const now = new Date().toISOString();
  // Only include fields that are explicitly provided to avoid overwriting existing values
  const setFields: Record<string, unknown> = {
    status: update.status,
    updatedAt: now,
  };
  if (update.result !== undefined) setFields.result = update.result;
  if (update.error !== undefined) setFields.error = update.error;
  if (update.resolvedBy !== undefined) setFields.resolvedBy = update.resolvedBy;
  if (update.resolvedAt !== undefined) setFields.resolvedAt = update.resolvedAt;
  if (update.executedAt !== undefined) setFields.executedAt = update.executedAt;

  const conditions = [eq(actionInvocations.id, id)];
  if (update.expectedStatus) {
    conditions.push(eq(actionInvocations.status, update.expectedStatus));
  }

  await db
    .update(actionInvocations)
    .set(setFields)
    .where(and(...conditions));
}

export async function listInvocationsBySession(
  db: AppDb,
  sessionId: string,
  opts?: { limit?: number; status?: string },
) {
  const conditions = [eq(actionInvocations.sessionId, sessionId)];
  if (opts?.status) {
    conditions.push(eq(actionInvocations.status, opts.status));
  }

  let query = db
    .select()
    .from(actionInvocations)
    .where(and(...conditions))
    .orderBy(desc(actionInvocations.createdAt));

  if (opts?.limit) {
    query = query.limit(opts.limit) as typeof query;
  }

  return query.all();
}

export async function listPendingInvocationsByUser(db: AppDb, userId: string) {
  const now = new Date().toISOString();
  return db
    .select()
    .from(actionInvocations)
    .where(
      and(
        eq(actionInvocations.userId, userId),
        eq(actionInvocations.status, 'pending'),
        or(
          isNull(actionInvocations.expiresAt),
          sql`${actionInvocations.expiresAt} > ${now}`,
        ),
      ),
    )
    .orderBy(desc(actionInvocations.createdAt))
    .all();
}
