import { eq, and, or, isNull, gt, desc, sql, inArray } from 'drizzle-orm';
import type { AppDb } from '../drizzle.js';
import {
  actionPolicies,
  actionInvocations,
  runtimeGrants,
  sessions,
  workflowSpawnedSessions,
} from '../schema/index.js';
import type { ActionMode } from '@valet/shared';

// ─── Types ───────────────────────────────────────────────────────────────────

export type ActionPolicyManagedBy = 'admin' | 'user' | 'system';
export type ActionPolicyPrincipalType = 'org' | 'user';
export type ActionPolicySubjectType =
  | 'tool_action'
  | 'workflow_node_action'
  | 'workflow_node'
  | 'session_tool';
export type ActionPolicyOrigin =
  | 'settings'
  | 'approval_prompt'
  | 'workflow_editor'
  | 'admin'
  | 'migration';
export type UserGrantBehavior = 'allowed' | 'blocked';

export type PolicyScope = 'action' | 'service' | 'risk_level' | 'none';
export type PolicySource = 'system_default' | 'admin_policy' | 'user_policy' | 'runtime_grant';

export type ActionPolicyRow = typeof actionPolicies.$inferSelect;
export type RuntimeGrantRow = typeof runtimeGrants.$inferSelect;
export type ActionInvocationRow = typeof actionInvocations.$inferSelect;

export interface EffectivePolicyResult {
  mode: ActionMode;
  outcome: 'allowed' | 'pending_approval' | 'denied';
  riskLevel: string;
  baseMode: ActionMode;
  baseSource: 'admin_policy' | 'system_default';
  /** action_policies row that produced the decision (admin policy or durable user grant). */
  matchedPolicyId: string | null;
  /** runtime_grants row that auto-approved, when applicable. */
  matchedGrantId: string | null;
  source: PolicySource;
  scope: PolicyScope;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const SYSTEM_DEFAULTS: Record<string, ActionMode> = {
  low: 'allow',
  medium: 'require_approval',
  high: 'require_approval',
  critical: 'deny',
};

/**
 * Cap depth of the parent-session walk used during runtime-grant resolution.
 * Guards against pathological depth and a corrupted `parent_session_id` cycle.
 */
const LINEAGE_DEPTH_CAP = 16;

function systemDefaultForRisk(risk: string): ActionMode {
  return SYSTEM_DEFAULTS[risk] ?? 'require_approval';
}

function modeToOutcome(mode: ActionMode): EffectivePolicyResult['outcome'] {
  if (mode === 'allow') return 'allowed';
  if (mode === 'deny') return 'denied';
  return 'pending_approval';
}

function nowIso(): string {
  return new Date().toISOString();
}

// ─── Action policies — queries ───────────────────────────────────────────────

/**
 * Lists active admin/org policies for the admin settings UI.
 *
 * User durable grants and runtime grants are listed separately.
 */
export async function listActionPolicies(db: AppDb) {
  return db
    .select()
    .from(actionPolicies)
    .where(
      and(
        eq(actionPolicies.managedBy, 'admin'),
        isNull(actionPolicies.revokedAt),
      ),
    )
    .orderBy(actionPolicies.createdAt)
    .all();
}

/**
 * Lists active durable user grants for a specific user.
 * Used by the user-facing override/grants settings UI.
 */
export async function listUserDurableActionPolicies(
  db: AppDb,
  userId: string,
  opts?: { orgId?: string },
) {
  const now = nowIso();
  const orgId = opts?.orgId ?? 'default';
  return db
    .select()
    .from(actionPolicies)
    .where(
      and(
        eq(actionPolicies.orgId, orgId),
        eq(actionPolicies.managedBy, 'user'),
        eq(actionPolicies.principalType, 'user'),
        eq(actionPolicies.principalId, userId),
        isNull(actionPolicies.revokedAt),
        or(isNull(actionPolicies.expiresAt), gt(actionPolicies.expiresAt, now)),
      ),
    )
    .orderBy(desc(actionPolicies.updatedAt))
    .all();
}

export async function getActionPolicy(db: AppDb, id: string) {
  return db
    .select()
    .from(actionPolicies)
    .where(eq(actionPolicies.id, id))
    .get();
}

// ─── Action policies — upsert / delete ───────────────────────────────────────

export interface UpsertActionPolicyInput {
  id: string;
  service?: string | null;
  actionId?: string | null;
  riskLevel?: string | null;
  mode: ActionMode;
  createdBy?: string | null;
  // New ownership / target / matcher fields. All have safe defaults so legacy
  // admin-route callers continue to work without changes.
  orgId?: string;
  managedBy?: ActionPolicyManagedBy;
  principalType?: ActionPolicyPrincipalType;
  principalId?: string;
  subjectType?: ActionPolicySubjectType;
  subjectLabel?: string | null;
  workflowId?: string | null;
  workflowVersionId?: string | null;
  nodeId?: string | null;
  paramMatchers?: unknown[];
  matcherSummary?: string | null;
  userGrantBehavior?: UserGrantBehavior;
  origin?: ActionPolicyOrigin;
  sourceApprovalId?: string | null;
  expiresAt?: string | null;
}

/**
 * Idempotent upsert for `action_policies`. Reuses an existing row's id when
 * one already matches the scope+target+matcher fingerprint, so the row's
 * stable identity survives repeated writes from the same logical source.
 */
export async function upsertActionPolicy(
  db: AppDb,
  data: UpsertActionPolicyInput,
): Promise<string> {
  const now = nowIso();
  const svc = data.service ?? null;
  const act = data.actionId ?? null;
  const risk = data.riskLevel ?? null;

  const orgId = data.orgId ?? 'default';
  const managedBy: ActionPolicyManagedBy = data.managedBy ?? 'admin';
  const principalType: ActionPolicyPrincipalType =
    data.principalType ?? (managedBy === 'user' ? 'user' : 'org');
  const principalId =
    data.principalId ?? (principalType === 'org' ? orgId : 'default');
  const subjectType: ActionPolicySubjectType = data.subjectType ?? 'tool_action';
  const subjectLabel = data.subjectLabel ?? null;
  const workflowId = data.workflowId ?? null;
  const workflowVersionId = data.workflowVersionId ?? null;
  const nodeId = data.nodeId ?? null;
  const paramMatchersJson = JSON.stringify(data.paramMatchers ?? []);
  const matcherSummary = data.matcherSummary ?? null;
  const userGrantBehavior: UserGrantBehavior = data.userGrantBehavior ?? 'allowed';
  const origin: ActionPolicyOrigin = data.origin ?? 'settings';
  const sourceApprovalId = data.sourceApprovalId ?? null;
  const expiresAt = data.expiresAt ?? null;

  const existing = await db
    .select({ id: actionPolicies.id })
    .from(actionPolicies)
    .where(
      and(
        eq(actionPolicies.orgId, orgId),
        eq(actionPolicies.managedBy, managedBy),
        eq(actionPolicies.principalType, principalType),
        eq(actionPolicies.principalId, principalId),
        eq(actionPolicies.subjectType, subjectType),
        svc === null ? isNull(actionPolicies.service) : eq(actionPolicies.service, svc),
        act === null ? isNull(actionPolicies.actionId) : eq(actionPolicies.actionId, act),
        risk === null ? isNull(actionPolicies.riskLevel) : eq(actionPolicies.riskLevel, risk),
        workflowId === null
          ? isNull(actionPolicies.workflowId)
          : eq(actionPolicies.workflowId, workflowId),
        workflowVersionId === null
          ? isNull(actionPolicies.workflowVersionId)
          : eq(actionPolicies.workflowVersionId, workflowVersionId),
        nodeId === null ? isNull(actionPolicies.nodeId) : eq(actionPolicies.nodeId, nodeId),
        eq(actionPolicies.paramMatchers, paramMatchersJson),
        isNull(actionPolicies.revokedAt),
      ),
    )
    .get();

  const effectiveId = existing?.id ?? data.id;

  await db
    .insert(actionPolicies)
    .values({
      id: effectiveId,
      service: svc,
      actionId: act,
      riskLevel: risk,
      mode: data.mode,
      createdBy: data.createdBy ?? null,
      createdAt: now,
      updatedAt: now,
      orgId,
      managedBy,
      principalType,
      principalId,
      subjectType,
      subjectLabel,
      workflowId,
      workflowVersionId,
      nodeId,
      paramMatchers: paramMatchersJson,
      matcherSummary,
      userGrantBehavior,
      origin,
      sourceApprovalId,
      expiresAt,
    })
    .onConflictDoUpdate({
      target: actionPolicies.id,
      set: {
        mode: data.mode,
        matcherSummary,
        userGrantBehavior,
        sourceApprovalId,
        expiresAt,
        updatedAt: now,
      },
    });

  return effectiveId;
}

/** Hard-deletes a policy. Use {@link revokeActionPolicy} when audit history matters. */
export async function deleteActionPolicy(db: AppDb, id: string) {
  await db.delete(actionPolicies).where(eq(actionPolicies.id, id));
}

/** Soft-deletes a policy (sets `revoked_at`). Audit references in `action_invocations` survive. */
export async function revokeActionPolicy(db: AppDb, id: string) {
  await db
    .update(actionPolicies)
    .set({ revokedAt: nowIso(), updatedAt: nowIso() })
    .where(eq(actionPolicies.id, id));
}

// ─── Runtime grants ──────────────────────────────────────────────────────────

export interface UpsertRuntimeGrantInput {
  id: string;
  userId: string;
  orgId?: string;
  sessionId?: string | null;
  workflowExecutionId?: string | null;
  subjectType: ActionPolicySubjectType;
  service?: string | null;
  actionId?: string | null;
  riskLevel?: string | null;
  workflowId?: string | null;
  nodeId?: string | null;
  paramMatchers?: unknown[];
  /**
   * Deterministic idempotency key derived from scope id + subject + node id +
   * matcher fingerprint. Two approvals of the same logical request collapse
   * to one grant.
   */
  policyKey: string;
  matcherSummary?: string | null;
}

/**
 * Idempotent upsert for a `runtime_grants` row, keyed on the per-scope unique
 * index `(scope_id, subject_type, policy_key)`.
 */
export async function upsertRuntimeGrant(
  db: AppDb,
  data: UpsertRuntimeGrantInput,
): Promise<string> {
  const now = nowIso();
  const orgId = data.orgId ?? 'default';
  const sessionId = data.sessionId ?? null;
  const workflowExecutionId = data.workflowExecutionId ?? null;
  if ((sessionId === null) === (workflowExecutionId === null)) {
    throw new Error('runtime_grants requires exactly one of sessionId or workflowExecutionId');
  }

  const paramMatchersJson = JSON.stringify(data.paramMatchers ?? []);

  const scopeMatch = sessionId !== null
    ? and(
        eq(runtimeGrants.sessionId, sessionId),
        eq(runtimeGrants.subjectType, data.subjectType),
        eq(runtimeGrants.policyKey, data.policyKey),
        isNull(runtimeGrants.revokedAt),
      )
    : and(
        eq(runtimeGrants.workflowExecutionId, workflowExecutionId as string),
        eq(runtimeGrants.subjectType, data.subjectType),
        eq(runtimeGrants.policyKey, data.policyKey),
        isNull(runtimeGrants.revokedAt),
      );

  const existing = await db
    .select({ id: runtimeGrants.id })
    .from(runtimeGrants)
    .where(scopeMatch)
    .get();

  const effectiveId = existing?.id ?? data.id;

  await db
    .insert(runtimeGrants)
    .values({
      id: effectiveId,
      orgId,
      userId: data.userId,
      sessionId,
      workflowExecutionId,
      subjectType: data.subjectType,
      service: data.service ?? null,
      actionId: data.actionId ?? null,
      riskLevel: data.riskLevel ?? null,
      workflowId: data.workflowId ?? null,
      nodeId: data.nodeId ?? null,
      paramMatchers: paramMatchersJson,
      policyKey: data.policyKey,
      matcherSummary: data.matcherSummary ?? null,
      createdAt: now,
    })
    .onConflictDoUpdate({
      target: runtimeGrants.id,
      set: {
        paramMatchers: paramMatchersJson,
        matcherSummary: data.matcherSummary ?? null,
      },
    });

  return effectiveId;
}

export async function getRuntimeGrant(db: AppDb, id: string) {
  return db.select().from(runtimeGrants).where(eq(runtimeGrants.id, id)).get();
}

/** Soft-deletes a runtime grant. Used by user-facing revoke flows. */
export async function revokeRuntimeGrant(db: AppDb, id: string, userId: string) {
  await db
    .update(runtimeGrants)
    .set({ revokedAt: nowIso() })
    .where(and(eq(runtimeGrants.id, id), eq(runtimeGrants.userId, userId)));
}

/** Hard-deletes a runtime grant. Used by terminal-state cleanup. */
export async function deleteRuntimeGrant(db: AppDb, id: string) {
  await db.delete(runtimeGrants).where(eq(runtimeGrants.id, id));
}

/**
 * Lists active runtime grants tied to sessions / executions the user owns.
 * Used by the user-facing settings UI to show "active grants for this session".
 *
 * Access scoping (only grants on sessions/executions the caller can read)
 * happens at the route layer.
 */
export async function listActiveRuntimeGrantsForUser(db: AppDb, userId: string) {
  return db
    .select()
    .from(runtimeGrants)
    .where(and(eq(runtimeGrants.userId, userId), isNull(runtimeGrants.revokedAt)))
    .orderBy(desc(runtimeGrants.createdAt))
    .all();
}

/**
 * Cleanup hook called on a parent context's terminal-state transition.
 * Replaces the legacy `deleteSessionActionPolicyOverrides`; generalizes to
 * workflow-execution scope as well.
 */
export async function deleteRuntimeGrantsByScope(
  db: AppDb,
  scope: { sessionId?: string; workflowExecutionId?: string },
): Promise<void> {
  if (scope.sessionId) {
    await db
      .delete(runtimeGrants)
      .where(eq(runtimeGrants.sessionId, scope.sessionId));
  }
  if (scope.workflowExecutionId) {
    await db
      .delete(runtimeGrants)
      .where(eq(runtimeGrants.workflowExecutionId, scope.workflowExecutionId));
  }
}

// ─── Session lineage walk ────────────────────────────────────────────────────

export interface SessionLineage {
  /** The starting session plus its `parent_session_id` ancestor chain, in order. */
  sessionIds: string[];
  /** Workflow executions recovered from `workflow_spawned_sessions` for any lineage member. */
  executionIds: string[];
}

/**
 * Walks `parent_session_id` from the starting session, capped at
 * {@link LINEAGE_DEPTH_CAP} and guarded against cycles. For each session in
 * the resulting chain, looks up `workflow_spawned_sessions` to recover any
 * parent workflow execution — so a workflow-spawned session and its own
 * spawned children both surface the same execution scope.
 */
export async function expandSessionLineage(
  db: AppDb,
  sessionId: string,
): Promise<SessionLineage> {
  const sessionIds: string[] = [];
  const seen = new Set<string>();
  let current: string | null = sessionId;

  while (current && !seen.has(current) && sessionIds.length < LINEAGE_DEPTH_CAP) {
    seen.add(current);
    sessionIds.push(current);
    const row = await db
      .select({ parentSessionId: sessions.parentSessionId })
      .from(sessions)
      .where(eq(sessions.id, current))
      .get();
    current = row?.parentSessionId ?? null;
  }

  let executionIds: string[] = [];
  if (sessionIds.length > 0) {
    const spawnedRows: Array<{ executionId: string }> = await db
      .select({ executionId: workflowSpawnedSessions.executionId })
      .from(workflowSpawnedSessions)
      .where(inArray(workflowSpawnedSessions.sessionId, sessionIds))
      .all();
    executionIds = [...new Set(spawnedRows.map((r) => r.executionId))];
  }

  return { sessionIds, executionIds };
}

// ─── Most-specific match helper ──────────────────────────────────────────────

type TargetedRow = {
  id: string;
  service: string | null;
  actionId: string | null;
  riskLevel: string | null;
};

function pickMostSpecific<T extends TargetedRow>(
  rows: readonly T[],
  service: string,
  actionId: string,
  riskLevel: string,
): { row: T; scope: Exclude<PolicyScope, 'none'> } | null {
  const actionMatch = rows.find((r) => r.service === service && r.actionId === actionId);
  if (actionMatch) return { row: actionMatch, scope: 'action' };
  const serviceMatch = rows.find((r) => r.service === service && !r.actionId && !r.riskLevel);
  if (serviceMatch) return { row: serviceMatch, scope: 'service' };
  const riskMatch = rows.find((r) => !r.service && !r.actionId && r.riskLevel === riskLevel);
  if (riskMatch) return { row: riskMatch, scope: 'risk_level' };
  return null;
}

// ─── Resolver ────────────────────────────────────────────────────────────────

export interface ResolveActionPolicyInput {
  orgId?: string;
  userId: string;
  /** Resolver expands this to the lineage (self + parent chain) for grant matching. */
  sessionId?: string | null;
  workflowExecutionId?: string | null;
  service: string;
  actionId: string;
  riskLevel: string;
}

/**
 * Unified resolver. Replaces the previous split between admin policy and
 * UAPO. Flow:
 *
 *   1. Admin deny → deny.
 *   2. Pick base admin/system decision by specificity.
 *   3. Base allow → allow.
 *   4. Base require_approval + userGrantBehavior='blocked' → require approval.
 *   5. Check runtime grants over the session lineage and recovered executions.
 *   6. Check durable user grants.
 *   7. Otherwise → require approval.
 */
export async function resolveEffectiveActionPolicy(
  db: AppDb,
  input: ResolveActionPolicyInput,
): Promise<EffectivePolicyResult> {
  const orgId = input.orgId ?? 'default';
  const { service, actionId, riskLevel } = input;

  // 1-2. Admin candidate set, filtered by org + subject + target match.
  const adminRows: ActionPolicyRow[] = await db
    .select()
    .from(actionPolicies)
    .where(
      and(
        eq(actionPolicies.orgId, orgId),
        eq(actionPolicies.managedBy, 'admin'),
        eq(actionPolicies.subjectType, 'tool_action'),
        isNull(actionPolicies.revokedAt),
        or(
          and(eq(actionPolicies.service, service), eq(actionPolicies.actionId, actionId)),
          and(
            eq(actionPolicies.service, service),
            isNull(actionPolicies.actionId),
            isNull(actionPolicies.riskLevel),
          ),
          and(
            isNull(actionPolicies.service),
            isNull(actionPolicies.actionId),
            eq(actionPolicies.riskLevel, riskLevel),
          ),
        ),
      ),
    )
    .all();

  const adminDeny = pickMostSpecific(
    adminRows.filter((r) => r.mode === 'deny'),
    service,
    actionId,
    riskLevel,
  );
  if (adminDeny) {
    return {
      mode: 'deny',
      outcome: 'denied',
      riskLevel,
      baseMode: 'deny',
      baseSource: 'admin_policy',
      matchedPolicyId: adminDeny.row.id,
      matchedGrantId: null,
      source: 'admin_policy',
      scope: adminDeny.scope,
    };
  }

  const adminBase = pickMostSpecific(
    adminRows.filter((r) => r.mode === 'allow' || r.mode === 'require_approval'),
    service,
    actionId,
    riskLevel,
  );
  const baseMode: ActionMode = (adminBase?.row.mode as ActionMode) ?? systemDefaultForRisk(riskLevel);
  const baseSource: 'admin_policy' | 'system_default' = adminBase ? 'admin_policy' : 'system_default';
  const baseScope: PolicyScope = adminBase?.scope ?? 'none';

  // 3. Allow short-circuits.
  if (baseMode === 'allow') {
    return {
      mode: 'allow',
      outcome: 'allowed',
      riskLevel,
      baseMode,
      baseSource,
      matchedPolicyId: adminBase?.row.id ?? null,
      matchedGrantId: null,
      source: baseSource,
      scope: baseScope,
    };
  }

  // (System-default deny — baseMode 'deny' from systemDefaultForRisk — falls
  // through. Unlike admin deny, system-default deny is a conservative default
  // that user grants and runtime grants are allowed to override; admin deny
  // is already handled by step 2.)

  // 4. Blocked require_approval — user grants cannot quiet this.
  if (baseMode === 'require_approval' && adminBase?.row.userGrantBehavior === 'blocked') {
    return {
      mode: 'require_approval',
      outcome: 'pending_approval',
      riskLevel,
      baseMode,
      baseSource,
      matchedPolicyId: adminBase.row.id,
      matchedGrantId: null,
      source: 'admin_policy',
      scope: baseScope,
    };
  }

  // 5. Runtime grants over the lineage.
  if (input.sessionId || input.workflowExecutionId) {
    const lineage = input.sessionId
      ? await expandSessionLineage(db, input.sessionId)
      : { sessionIds: [], executionIds: [] };
    const executionIds = input.workflowExecutionId
      ? [...new Set([input.workflowExecutionId, ...lineage.executionIds])]
      : lineage.executionIds;

    if (lineage.sessionIds.length > 0 || executionIds.length > 0) {
      const scopeMatchers = [];
      if (lineage.sessionIds.length > 0) {
        scopeMatchers.push(inArray(runtimeGrants.sessionId, lineage.sessionIds));
      }
      if (executionIds.length > 0) {
        scopeMatchers.push(inArray(runtimeGrants.workflowExecutionId, executionIds));
      }

      const grants: RuntimeGrantRow[] = await db
        .select()
        .from(runtimeGrants)
        .where(
          and(
            isNull(runtimeGrants.revokedAt),
            eq(runtimeGrants.subjectType, 'tool_action'),
            or(...scopeMatchers),
            or(
              and(eq(runtimeGrants.service, service), eq(runtimeGrants.actionId, actionId)),
              and(
                eq(runtimeGrants.service, service),
                isNull(runtimeGrants.actionId),
                isNull(runtimeGrants.riskLevel),
              ),
              and(
                isNull(runtimeGrants.service),
                isNull(runtimeGrants.actionId),
                eq(runtimeGrants.riskLevel, riskLevel),
              ),
            ),
          ),
        )
        .all();

      const grantMatch = pickMostSpecific(grants, service, actionId, riskLevel);
      if (grantMatch) {
        return {
          mode: 'allow',
          outcome: 'allowed',
          riskLevel,
          baseMode,
          baseSource,
          matchedPolicyId: adminBase?.row.id ?? null,
          matchedGrantId: grantMatch.row.id,
          source: 'runtime_grant',
          scope: grantMatch.scope,
        };
      }
    }
  }

  // 6. Durable user grants.
  const now = nowIso();
  const userRows: ActionPolicyRow[] = await db
    .select()
    .from(actionPolicies)
    .where(
      and(
        eq(actionPolicies.orgId, orgId),
        eq(actionPolicies.managedBy, 'user'),
        eq(actionPolicies.principalType, 'user'),
        eq(actionPolicies.principalId, input.userId),
        eq(actionPolicies.subjectType, 'tool_action'),
        isNull(actionPolicies.revokedAt),
        or(isNull(actionPolicies.expiresAt), gt(actionPolicies.expiresAt, now)),
        or(
          and(eq(actionPolicies.service, service), eq(actionPolicies.actionId, actionId)),
          and(
            eq(actionPolicies.service, service),
            isNull(actionPolicies.actionId),
            isNull(actionPolicies.riskLevel),
          ),
          and(
            isNull(actionPolicies.service),
            isNull(actionPolicies.actionId),
            eq(actionPolicies.riskLevel, riskLevel),
          ),
        ),
      ),
    )
    .all();

  const userMatch = pickMostSpecific(
    userRows.filter((r) => r.mode === 'allow'),
    service,
    actionId,
    riskLevel,
  );
  if (userMatch) {
    return {
      mode: 'allow',
      outcome: 'allowed',
      riskLevel,
      baseMode,
      baseSource,
      matchedPolicyId: userMatch.row.id,
      matchedGrantId: null,
      source: 'user_policy',
      scope: userMatch.scope,
    };
  }

  // 7. Nothing matched. Fall back to baseMode — `require_approval` becomes
  // pending; system-default `deny` becomes denied (no grant flipped it).
  return {
    mode: baseMode,
    outcome: modeToOutcome(baseMode),
    riskLevel,
    baseMode,
    baseSource,
    matchedPolicyId: adminBase?.row.id ?? null,
    matchedGrantId: null,
    source: baseSource,
    scope: baseScope,
  };
}

/**
 * Admin-only resolver. Used by the override route to confirm that a user
 * grant request doesn't cross an admin deny.
 */
export async function resolveAdminPolicyMatch(
  db: AppDb,
  service: string,
  actionId: string,
  riskLevel: string,
  opts?: { orgId?: string },
): Promise<{ mode: ActionMode; policyId: string; scope: PolicyScope } | null> {
  const orgId = opts?.orgId ?? 'default';
  const rows: ActionPolicyRow[] = await db
    .select()
    .from(actionPolicies)
    .where(
      and(
        eq(actionPolicies.orgId, orgId),
        eq(actionPolicies.managedBy, 'admin'),
        eq(actionPolicies.subjectType, 'tool_action'),
        isNull(actionPolicies.revokedAt),
        or(
          and(eq(actionPolicies.service, service), eq(actionPolicies.actionId, actionId)),
          and(
            eq(actionPolicies.service, service),
            isNull(actionPolicies.actionId),
            isNull(actionPolicies.riskLevel),
          ),
          and(
            isNull(actionPolicies.service),
            isNull(actionPolicies.actionId),
            eq(actionPolicies.riskLevel, riskLevel),
          ),
        ),
      ),
    )
    .all();

  const match = pickMostSpecific(rows, service, actionId, riskLevel);
  if (!match) return null;
  return { mode: match.row.mode as ActionMode, policyId: match.row.id, scope: match.scope };
}

/**
 * System default + admin policy mode lookup. Used where the caller wants
 * just the mode (no grant check, no audit). Preserved as `resolvePolicy`
 * for back-compat with existing tests.
 */
export async function resolvePolicy(
  db: AppDb,
  service: string,
  actionId: string,
  riskLevel: string,
): Promise<{ mode: ActionMode; policyId: string | null }> {
  const explicit = await resolveAdminPolicyMatch(db, service, actionId, riskLevel);
  if (explicit) return { mode: explicit.mode, policyId: explicit.policyId };
  return { mode: systemDefaultForRisk(riskLevel), policyId: null };
}

// ─── Invocations ─────────────────────────────────────────────────────────────

export async function createInvocation(
  db: AppDb,
  data: {
    id: string;
    /** Exactly one of sessionId or workflowExecutionId must be set. */
    sessionId?: string | null;
    workflowExecutionId?: string | null;
    userId: string;
    service: string;
    actionId: string;
    riskLevel: string;
    resolvedMode: ActionMode;
    params?: string;
    expiresAt?: string;
    /** Audit metadata from the unified resolver. */
    matchedPolicyId?: string | null;
    matchedGrantId?: string | null;
    baseMode?: ActionMode | null;
    baseSource?: 'admin_policy' | 'system_default' | null;
    policySource?: PolicySource | null;
    policyScope?: PolicyScope | null;
    status?: string;
  },
) {
  const now = nowIso();
  await db.insert(actionInvocations).values({
    id: data.id,
    sessionId: data.sessionId ?? null,
    workflowExecutionId: data.workflowExecutionId ?? null,
    userId: data.userId,
    service: data.service,
    actionId: data.actionId,
    riskLevel: data.riskLevel,
    resolvedMode: data.resolvedMode,
    params: data.params,
    expiresAt: data.expiresAt,
    matchedPolicyId: data.matchedPolicyId ?? null,
    matchedGrantId: data.matchedGrantId ?? null,
    baseMode: data.baseMode ?? null,
    baseSource: data.baseSource ?? null,
    policySource: data.policySource ?? null,
    policyScope: data.policyScope ?? null,
    status: data.status || 'pending',
    createdAt: now,
    updatedAt: now,
  });
}

export async function getInvocation(db: AppDb, id: string) {
  return db.select().from(actionInvocations).where(eq(actionInvocations.id, id)).get();
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
  const now = nowIso();
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
  const now = nowIso();
  return db
    .select()
    .from(actionInvocations)
    .where(
      and(
        eq(actionInvocations.userId, userId),
        eq(actionInvocations.status, 'pending'),
        or(isNull(actionInvocations.expiresAt), sql`${actionInvocations.expiresAt} > ${now}`),
      ),
    )
    .orderBy(desc(actionInvocations.createdAt))
    .all();
}
