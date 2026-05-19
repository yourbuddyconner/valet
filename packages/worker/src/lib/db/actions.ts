import { eq, and, or, isNull, desc, sql } from 'drizzle-orm';
import type { AppDb } from '../drizzle.js';
import { actionPolicies, actionInvocations, userActionPolicyOverrides } from '../schema/index.js';
import type { ActionMode } from '@valet/shared';

// ─── System Defaults ─────────────────────────────────────────────────────────

const SYSTEM_DEFAULTS: Record<string, ActionMode> = {
  low: 'allow',
  medium: 'require_approval',
  high: 'require_approval',
  critical: 'deny',
};

export type ActionPolicyLifetime = 'persistent' | 'session' | 'timed';
export type ActionPolicySource = 'settings' | 'approval_prompt';
export type EffectivePolicySource = 'system_default' | 'org_policy' | 'user_override' | 'session_override';
export type PolicyScope = 'action' | 'service' | 'risk_level' | 'none';
export type ActionPolicyOverrideRow = typeof userActionPolicyOverrides.$inferSelect;

export interface EffectivePolicyResult {
  mode: ActionMode;
  outcome: 'allowed' | 'pending_approval' | 'denied';
  riskLevel: string;
  baseMode: ActionMode;
  baseSource: 'org_policy' | 'system_default';
  orgPolicyId: string | null;
  userOverrideId: string | null;
  source: EffectivePolicySource;
  lifetime: ActionPolicyLifetime | null;
  scope: PolicyScope;
}

function modeToOutcome(mode: ActionMode): EffectivePolicyResult['outcome'] {
  if (mode === 'allow') return 'allowed';
  if (mode === 'deny') return 'denied';
  return 'pending_approval';
}

function systemDefaultForRisk(riskLevel: string): ActionMode {
  return SYSTEM_DEFAULTS[riskLevel] || 'require_approval';
}

function timestampMs(value: string | null): number {
  if (!value) return 0;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;
  return new Date(normalized).getTime();
}

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

export async function resolveOrgPolicyMatch(
  db: AppDb,
  service: string,
  actionId: string,
  riskLevel: string,
): Promise<{ mode: ActionMode; policyId: string; scope: PolicyScope } | null> {
  const rows = await db
    .select()
    .from(actionPolicies)
    .where(
      or(
        and(eq(actionPolicies.service, service), eq(actionPolicies.actionId, actionId)),
        and(eq(actionPolicies.service, service), isNull(actionPolicies.actionId), isNull(actionPolicies.riskLevel)),
        and(isNull(actionPolicies.service), isNull(actionPolicies.actionId), eq(actionPolicies.riskLevel, riskLevel)),
      ),
    )
    .all();

  type PolicyRow = typeof rows[number];

  const actionMatch = rows.find((r: PolicyRow) => r.service === service && r.actionId === actionId);
  if (actionMatch) {
    return { mode: actionMatch.mode as ActionMode, policyId: actionMatch.id, scope: 'action' };
  }

  const serviceMatch = rows.find((r: PolicyRow) => r.service === service && !r.actionId && !r.riskLevel);
  if (serviceMatch) {
    return { mode: serviceMatch.mode as ActionMode, policyId: serviceMatch.id, scope: 'service' };
  }

  const riskMatch = rows.find((r: PolicyRow) => !r.service && !r.actionId && r.riskLevel === riskLevel);
  if (riskMatch) {
    return { mode: riskMatch.mode as ActionMode, policyId: riskMatch.id, scope: 'risk_level' };
  }

  return null;
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
  const explicit = await resolveOrgPolicyMatch(db, service, actionId, riskLevel);
  if (explicit) {
    return { mode: explicit.mode, policyId: explicit.policyId };
  }

  return { mode: systemDefaultForRisk(riskLevel), policyId: null };
}

// ─── User Overrides ─────────────────────────────────────────────────────────

export async function listUserActionPolicyOverrides(db: AppDb, userId: string) {
  return db
    .select()
    .from(userActionPolicyOverrides)
    .where(eq(userActionPolicyOverrides.userId, userId))
    .orderBy(desc(userActionPolicyOverrides.updatedAt))
    .all();
}

export async function getUserActionPolicyOverride(db: AppDb, id: string) {
  return db
    .select()
    .from(userActionPolicyOverrides)
    .where(eq(userActionPolicyOverrides.id, id))
    .get();
}

export async function upsertUserActionPolicyOverride(
  db: AppDb,
  data: {
    id: string;
    userId: string;
    service?: string | null;
    actionId?: string | null;
    riskLevel?: string | null;
    mode: ActionMode;
    lifetime?: ActionPolicyLifetime;
    sessionId?: string | null;
    expiresAt?: string | null;
    source?: ActionPolicySource;
    sourceInvocationId?: string | null;
  },
) {
  const now = new Date().toISOString();
  const svc = data.service ?? null;
  const act = data.actionId ?? null;
  const risk = data.riskLevel ?? null;
  const lifetime = data.lifetime ?? 'persistent';
  const sessionId = lifetime === 'session' ? data.sessionId ?? null : null;
  const expiresAt = data.expiresAt ?? null;
  const source = data.source ?? 'settings';
  const sourceInvocationId = data.sourceInvocationId ?? null;

  let existingId: string | null = null;

  if (svc && act) {
    if (lifetime === 'session' && !sessionId) {
      throw new Error('sessionId is required for session-scoped action policy overrides');
    }

    const conditions = [
      eq(userActionPolicyOverrides.userId, data.userId),
      eq(userActionPolicyOverrides.lifetime, lifetime),
      eq(userActionPolicyOverrides.service, svc),
      eq(userActionPolicyOverrides.actionId, act),
    ];
    if (lifetime === 'session') {
      const scopedSessionId = sessionId;
      if (!scopedSessionId) {
        throw new Error('sessionId is required for session-scoped action policy overrides');
      }
      conditions.push(eq(userActionPolicyOverrides.sessionId, scopedSessionId));
    }

    const existing = await db
      .select({ id: userActionPolicyOverrides.id })
      .from(userActionPolicyOverrides)
      .where(and(...conditions))
      .get();
    existingId = existing?.id ?? null;
  } else if (svc && !act && !risk) {
    const existing = await db
      .select({ id: userActionPolicyOverrides.id })
      .from(userActionPolicyOverrides)
      .where(and(
        eq(userActionPolicyOverrides.userId, data.userId),
        eq(userActionPolicyOverrides.lifetime, lifetime),
        eq(userActionPolicyOverrides.service, svc),
        isNull(userActionPolicyOverrides.actionId),
        isNull(userActionPolicyOverrides.riskLevel),
      ))
      .get();
    existingId = existing?.id ?? null;
  } else if (!svc && !act && risk) {
    const existing = await db
      .select({ id: userActionPolicyOverrides.id })
      .from(userActionPolicyOverrides)
      .where(and(
        eq(userActionPolicyOverrides.userId, data.userId),
        eq(userActionPolicyOverrides.lifetime, lifetime),
        isNull(userActionPolicyOverrides.service),
        isNull(userActionPolicyOverrides.actionId),
        eq(userActionPolicyOverrides.riskLevel, risk),
      ))
      .get();
    existingId = existing?.id ?? null;
  }

  const effectiveId = existingId ?? data.id;

  await db
    .insert(userActionPolicyOverrides)
    .values({
      id: effectiveId,
      userId: data.userId,
      service: svc,
      actionId: act,
      riskLevel: risk,
      mode: data.mode,
      lifetime,
      sessionId,
      expiresAt,
      source,
      sourceInvocationId,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: userActionPolicyOverrides.id,
      set: {
        service: svc,
        actionId: act,
        riskLevel: risk,
        mode: data.mode,
        lifetime,
        sessionId,
        expiresAt,
        source,
        sourceInvocationId,
        updatedAt: now,
      },
    });
}

export async function deleteUserActionPolicyOverride(db: AppDb, id: string, userId: string) {
  await db
    .delete(userActionPolicyOverrides)
    .where(and(eq(userActionPolicyOverrides.id, id), eq(userActionPolicyOverrides.userId, userId)));
}

export async function expireSessionActionPolicyOverrides(
  db: AppDb,
  sessionId: string,
  now = new Date().toISOString(),
): Promise<void> {
  await db
    .update(userActionPolicyOverrides)
    .set({
      expiresAt: now,
      updatedAt: now,
    })
    .where(and(
      eq(userActionPolicyOverrides.lifetime, 'session'),
      eq(userActionPolicyOverrides.sessionId, sessionId),
      or(
        isNull(userActionPolicyOverrides.expiresAt),
        sql`${userActionPolicyOverrides.expiresAt} > ${now}`,
      ),
    ));
}

export async function resolveUserActionPolicyOverride(
  db: AppDb,
  input: { userId: string; sessionId?: string; service: string; actionId: string; riskLevel: string },
): Promise<{ override: ActionPolicyOverrideRow; scope: PolicyScope } | null> {
  const now = new Date().toISOString();
  const rows = await db
    .select()
    .from(userActionPolicyOverrides)
    .where(
      and(
        eq(userActionPolicyOverrides.userId, input.userId),
        or(
          and(eq(userActionPolicyOverrides.service, input.service), eq(userActionPolicyOverrides.actionId, input.actionId)),
          and(eq(userActionPolicyOverrides.service, input.service), isNull(userActionPolicyOverrides.actionId), isNull(userActionPolicyOverrides.riskLevel)),
          and(isNull(userActionPolicyOverrides.service), isNull(userActionPolicyOverrides.actionId), eq(userActionPolicyOverrides.riskLevel, input.riskLevel)),
        ),
      ),
    )
    .all();

  type OverrideCandidate = { override: ActionPolicyOverrideRow; scope: Exclude<PolicyScope, 'none'> };
  const typedRows = rows as ActionPolicyOverrideRow[];
  const candidates = typedRows
    .map((override: ActionPolicyOverrideRow): OverrideCandidate | null => {
      let scope: OverrideCandidate['scope'] | null = null;
      if (override.service === input.service && override.actionId === input.actionId) {
        scope = 'action';
      } else if (override.service === input.service && !override.actionId && !override.riskLevel) {
        scope = 'service';
      } else if (!override.service && !override.actionId && override.riskLevel === input.riskLevel) {
        scope = 'risk_level';
      }

      if (!scope) return null;

      if (override.expiresAt && override.expiresAt <= now) return null;

      if (override.lifetime === 'session') {
        if (!input.sessionId || override.sessionId !== input.sessionId) return null;
      } else if (override.lifetime === 'timed') {
        if (!override.expiresAt || override.expiresAt <= now) return null;
      }

      return { override, scope };
    })
    .filter((candidate): candidate is OverrideCandidate => candidate !== null);

  const scopeRank: Record<PolicyScope, number> = {
    action: 3,
    service: 2,
    risk_level: 1,
    none: 0,
  };
  const lifetimeRank = (lifetime: string) => lifetime === 'persistent' ? 0 : 1;

  candidates.sort((a, b) => {
    const scopeDelta = scopeRank[b.scope] - scopeRank[a.scope];
    if (scopeDelta !== 0) return scopeDelta;

    const lifetimeDelta = lifetimeRank(b.override.lifetime) - lifetimeRank(a.override.lifetime);
    if (lifetimeDelta !== 0) return lifetimeDelta;

    return timestampMs(b.override.updatedAt) - timestampMs(a.override.updatedAt);
  });

  return candidates[0] ?? null;
}

export async function resolveEffectiveActionPolicy(
  db: AppDb,
  input: { userId: string; sessionId: string; service: string; actionId: string; riskLevel: string },
): Promise<EffectivePolicyResult> {
  const orgPolicy = await resolveOrgPolicyMatch(db, input.service, input.actionId, input.riskLevel);

  if (orgPolicy?.mode === 'deny') {
    return {
      mode: 'deny',
      outcome: 'denied',
      riskLevel: input.riskLevel,
      baseMode: 'deny',
      baseSource: 'org_policy',
      orgPolicyId: orgPolicy.policyId,
      userOverrideId: null,
      source: 'org_policy',
      lifetime: null,
      scope: orgPolicy.scope,
    };
  }

  const baseMode = orgPolicy?.mode ?? systemDefaultForRisk(input.riskLevel);
  const baseSource = orgPolicy ? 'org_policy' : 'system_default';
  const userOverride = await resolveUserActionPolicyOverride(db, input);

  if (userOverride) {
    const mode = userOverride.override.mode as ActionMode;
    const lifetime = userOverride.override.lifetime as ActionPolicyLifetime;
    return {
      mode,
      outcome: modeToOutcome(mode),
      riskLevel: input.riskLevel,
      baseMode,
      baseSource,
      orgPolicyId: orgPolicy?.policyId ?? null,
      userOverrideId: userOverride.override.id,
      source: lifetime === 'session' ? 'session_override' : 'user_override',
      lifetime,
      scope: userOverride.scope,
    };
  }

  return {
    mode: baseMode,
    outcome: modeToOutcome(baseMode),
    riskLevel: input.riskLevel,
    baseMode,
    baseSource,
    orgPolicyId: orgPolicy?.policyId ?? null,
    userOverrideId: null,
    source: baseSource,
    lifetime: null,
    scope: orgPolicy?.scope ?? 'none',
  };
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
    orgPolicyId?: string | null;
    baseMode?: ActionMode | null;
    baseSource?: 'org_policy' | 'system_default' | null;
    userOverrideId?: string | null;
    policySource?: EffectivePolicySource | null;
    policyLifetime?: ActionPolicyLifetime | null;
    policyScope?: PolicyScope | null;
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
    policyId: data.policyId ?? data.orgPolicyId ?? null,
    orgPolicyId: data.orgPolicyId ?? data.policyId ?? null,
    baseMode: data.baseMode ?? null,
    baseSource: data.baseSource ?? null,
    userOverrideId: data.userOverrideId ?? null,
    policySource: data.policySource ?? null,
    policyLifetime: data.policyLifetime ?? null,
    policyScope: data.policyScope ?? null,
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
