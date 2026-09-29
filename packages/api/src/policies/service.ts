/**
 * Host wiring for the org action-policy engine (action-policies plan, Task 3).
 *
 * This module is the impure counterpart to `resolution.ts`'s pure precedence
 * core: it loads policy/grant/override rows FRESH from the app db per call
 * (never cached — a policy edit applies on the very next invocation), adapts
 * the engine's `PolicyResolveInput` into `resolution.ts`'s
 * `PolicyResolutionInput`, and owns every write the policy arc performs:
 *
 *  - runtime grant upserts (session- or workflow-execution-scoped), idempotent
 *    under exact restart replay via T2's partial unique index on
 *    `(org_id, {session_id|workflow_execution_id}, policy_key)`;
 *  - the "always allow" org-policy write minted from an approval prompt,
 *    keyed on a DETERMINISTIC row id so a replayed gate resolution upserts the
 *    same row rather than inserting a duplicate;
 *  - the fire-and-forget audit sink over `action_invocations`, with 8KB field
 *    caps + truncation flags and PK-level dedup for gated (replayable) rows.
 *
 * `buildPolicyResolver` assembles these into the engine's `PolicyResolver`
 * port; the workflow invoker (`plugins/action-invoker.ts`) reuses
 * `resolveActionPolicy` + the grant/audit writers directly for its
 * non-interactive `appliesIn: "workflow"` enforcement path.
 */
import { randomUUID } from "node:crypto";
import { and, eq, isNull, ne, or, sql } from "drizzle-orm";
import type {
  ActionPlugin,
  ApprovalMode,
  DecisionResolution,
  PolicyDecision,
  PolicyInvocationRecord,
  PolicyResolveInput,
  PolicyResolver,
  RiskLevel,
  ValetPlugin,
} from "@valet/engine";
import type { AppDb, AppQueryable } from "../lib/drizzle.js";
import { agentSessions, actionInvocations, actionPolicies, actionPolicyOverrides, runtimeGrants, workflowActionGrants, workflowDefinitions, workflowRuns } from "../schema/index.js";
import { isOrgAdmin } from "../services/org.js";
import {
  grantPolicyKey,
  resolvePolicyDecision,
  type ActionPolicyOverrideRow,
  type ActionPolicyRow,
  type PolicyResolutionRows,
  type RuntimeGrantRow,
} from "./resolution.js";

/** Per-field cap for the audit sink's `params`/`result` jsonb columns. A
 *  field whose canonical JSON exceeds this is replaced by a truncated preview
 *  and its paired `*Truncated` flag is set. `error` (plain text) is capped to
 *  the same length silently — the schema has no `errorTruncated` column. */
export const POLICY_AUDIT_FIELD_CAP = 8192;

/** The two extra approval-gate actions the resolver offers on a
 *  `require_approval` gate. Both are `approves: true` (the engine treats the
 *  choice as an approval), but `onResolution` performs a DIFFERENT durable
 *  write for each — see its body. Kept as named constants so the engine gate,
 *  `onResolution`, and any UI stay in lockstep on the ids. */
export const GATE_ACTION_APPROVE_SESSION = "approve_session";
export const GATE_ACTION_ALWAYS_ALLOW = "always_allow";

/**
 * May `userId` pick `always_allow` on a gate raised in `sessionOrgId`?
 * The action widens policy for that whole org, so only that org's admins
 * qualify — checked against the SESSION's org, not the caller's or the
 * deploy's. One definition for every resolver surface (the web decision
 * routes and the channel gate-callback path), so a new surface cannot ship
 * a weaker rule. Front half of a defense-in-depth pair: `onResolution` (T3)
 * also fails closed for a non-admin resolver, but only after the engine has
 * already consumed the gate.
 */
export async function canApplyAlwaysAllow(db: AppDb, sessionOrgId: string, userId: string): Promise<boolean> {
  return isOrgAdmin(db, sessionOrgId, userId);
}

/** Deterministic row id for an "always allow" org policy minted from an
 *  approval prompt (binding carry-forward #1): a replayed gate resolution
 *  re-fires `onResolution`, so the write MUST be an upsert on a stable key —
 *  never a bare INSERT. Scoped by org + exact action so a second genuine
 *  always-allow for the same action is a true idempotent no-op. */
export function alwaysAllowPolicyId(orgId: string, actionId: string): string {
  return `pol:approval:${orgId}:${actionId}`;
}

export interface PolicyRowScope {
  workflowId?: string;
  orgId: string;
  teamId?: string;
  userId?: string;
  sessionId?: string;
  workflowExecutionId?: string;
}

/**
 * Load the three row sets `resolvePolicyDecision` needs, FRESH from the db
 * (no caching — pin). Only rows that could possibly match the given scope are
 * fetched: all of the org's live `action_policies`, the grants scoped to this
 * session/execution, and the user's overrides. Filtering/precedence is the
 * pure core's job; this only narrows the query.
 */
export async function loadPolicyRows(db: AppQueryable, scope: PolicyRowScope): Promise<PolicyResolutionRows> {
  // Session ownership comes from the durable row, never the acting member.
  let teamId = scope.teamId;
  if (scope.sessionId) {
    const [session] = await db.select({ ownerType: agentSessions.ownerType, ownerId: agentSessions.ownerId })
      .from(agentSessions).where(and(eq(agentSessions.id, scope.sessionId), eq(agentSessions.orgId, scope.orgId))).limit(1);
    if (session) teamId = session.ownerType === "team" ? session.ownerId ?? undefined : undefined;
  }
  const principalFilter = teamId
    ? or(and(eq(actionPolicies.principalType, "org"), eq(actionPolicies.principalId, scope.orgId)), and(eq(actionPolicies.principalType, "team"), eq(actionPolicies.principalId, teamId)))
    : and(eq(actionPolicies.principalType, "org"), eq(actionPolicies.principalId, scope.orgId));
  const policyRows = await db
    .select()
    .from(actionPolicies)
    .where(and(eq(actionPolicies.orgId, scope.orgId), principalFilter, isNull(actionPolicies.revokedAt)));

  const policies: ActionPolicyRow[] = policyRows.map((r) => ({
    id: r.id,
    principalType: r.principalType,
    service: r.service,
    actionId: r.actionId,
    riskLevel: r.riskLevel,
    mode: r.mode,
    paramMatchers: r.paramMatchers,
    appliesIn: r.appliesIn,
    expiresAt: r.expiresAt,
    revokedAt: r.revokedAt,
    updatedAt: r.updatedAt,
  }));

  let grants: RuntimeGrantRow[] = [];
  if (scope.sessionId) {
    const rows = await db
      .select()
      .from(runtimeGrants)
      .where(
        and(
          eq(runtimeGrants.orgId, scope.orgId),
          eq(runtimeGrants.sessionId, scope.sessionId),
          isNull(runtimeGrants.revokedAt),
        ),
      );
    grants = rows.map(toGrantRow);
  } else if (scope.workflowExecutionId) {
    const rows = await db
      .select()
      .from(runtimeGrants)
      .where(
        and(
          eq(runtimeGrants.orgId, scope.orgId),
          eq(runtimeGrants.workflowExecutionId, scope.workflowExecutionId),
          isNull(runtimeGrants.revokedAt),
        ),
      );
    grants = rows.map(toGrantRow);
  }

  let overrides: ActionPolicyOverrideRow[] = [];
  if (scope.userId && !teamId) {
    const rows = await db
      .select()
      .from(actionPolicyOverrides)
      .where(and(eq(actionPolicyOverrides.orgId, scope.orgId), eq(actionPolicyOverrides.userId, scope.userId)));
    overrides = rows.map((r) => ({
      id: r.id,
      service: r.service,
      actionId: r.actionId,
      riskLevel: r.riskLevel,
      mode: r.mode,
      paramMatchers: r.paramMatchers,
      updatedAt: r.updatedAt,
    }));
  }

  let workflowId = scope.workflowId;
  if (!workflowId && scope.workflowExecutionId) {
    const [run] = await db.select({ workflowId: workflowRuns.workflowId }).from(workflowRuns)
      .innerJoin(workflowDefinitions, and(eq(workflowDefinitions.id, workflowRuns.workflowId), eq(workflowDefinitions.orgId, scope.orgId)))
      .where(eq(workflowRuns.id, scope.workflowExecutionId)).limit(1);
    workflowId = run?.workflowId;
  }
  const workflowGrants = workflowId ? await db.select({ id: workflowActionGrants.id, actionId: workflowActionGrants.actionId })
    .from(workflowActionGrants)
    .innerJoin(workflowDefinitions, and(eq(workflowDefinitions.id, workflowActionGrants.workflowId),
      eq(workflowDefinitions.orgId, scope.orgId), eq(workflowDefinitions.ownerType, workflowActionGrants.ownerType),
      eq(workflowDefinitions.ownerId, workflowActionGrants.ownerId)))
    .where(and(eq(workflowActionGrants.orgId, scope.orgId), eq(workflowActionGrants.workflowId, workflowId),
      eq(workflowActionGrants.ownerType, teamId ? "team" : "user"),
      eq(workflowActionGrants.ownerId, teamId ?? scope.userId ?? ""))) : [];
  return { policies, grants, overrides, workflowGrants };
}

function toGrantRow(r: {
  id: string;
  sessionId: string | null;
  workflowExecutionId: string | null;
  policyKey: string;
  revokedAt: number | null;
}): RuntimeGrantRow {
  return {
    id: r.id,
    sessionId: r.sessionId,
    workflowExecutionId: r.workflowExecutionId,
    policyKey: r.policyKey,
    revokedAt: r.revokedAt,
  };
}

export interface ResolveActionPolicyInput {
  orgId: string;
  teamId?: string;
  userId?: string;
  service: string;
  actionId: string;
  riskLevel: RiskLevel;
  params: Record<string, unknown> | undefined;
  appliesIn: "session" | "workflow";
  sessionId?: string;
  workflowExecutionId?: string;
  pluginDefault: ApprovalMode | undefined;
  now: number;
}

/**
 * Load rows + run the pure precedence core. Shared by the engine
 * `PolicyResolver` (session path) and the workflow invoker (workflow path) so
 * both enforce identical precedence.
 */
export async function resolveActionPolicy(db: AppDb, input: ResolveActionPolicyInput): Promise<PolicyDecision> {
  const rows = await loadPolicyRows(db, {
    orgId: input.orgId,
    teamId: input.teamId,
    userId: input.userId,
    sessionId: input.sessionId,
    workflowExecutionId: input.workflowExecutionId,
  });
  return resolvePolicyDecision(
    rows,
    {
      service: input.service,
      actionId: input.actionId,
      riskLevel: input.riskLevel,
      params: input.params,
      appliesIn: input.appliesIn,
      sessionId: input.sessionId,
      workflowExecutionId: input.workflowExecutionId,
      now: input.now,
    },
    input.pluginDefault,
  );
}

// ── Grant writes ────────────────────────────────────────────────────

export interface GrantWrite {
  orgId: string;
  service: string;
  actionId: string;
  grantedBy: string;
  now: number;
}

/**
 * Upsert a session-scoped runtime grant (allow-only). Idempotent under exact
 * restart replay via T2's partial unique index
 * `runtime_grants_session_policy_key` — a replayed `onResolution` re-fires
 * this write with the same `(org, session, policyKey)` and no-ops. A grant
 * re-issued AFTER a revoke inserts a fresh row (revoked rows are excluded
 * from the partial index), which is correct.
 */
export async function writeSessionGrant(db: AppDb, sessionId: string, grant: GrantWrite): Promise<void> {
  await db
    .insert(runtimeGrants)
    .values({
      id: randomUUID(),
      orgId: grant.orgId,
      sessionId,
      workflowExecutionId: null,
      policyKey: grantPolicyKey(grant.service, grant.actionId),
      mode: "allow",
      grantedBy: grant.grantedBy,
      createdAt: grant.now,
      revokedAt: null,
    })
    .onConflictDoNothing({
      target: [runtimeGrants.orgId, runtimeGrants.sessionId, runtimeGrants.policyKey],
      where: sql`${runtimeGrants.sessionId} is not null and ${runtimeGrants.revokedAt} is null`,
    });
}

/** Workflow-execution-scoped twin of `writeSessionGrant` — backed by the
 *  `runtime_grants_execution_policy_key` partial unique index. */
export async function writeExecutionGrant(
  db: AppDb,
  workflowExecutionId: string,
  grant: GrantWrite,
): Promise<void> {
  await db
    .insert(runtimeGrants)
    .values({
      id: randomUUID(),
      orgId: grant.orgId,
      sessionId: null,
      workflowExecutionId,
      policyKey: grantPolicyKey(grant.service, grant.actionId),
      mode: "allow",
      grantedBy: grant.grantedBy,
      createdAt: grant.now,
      revokedAt: null,
    })
    .onConflictDoNothing({
      target: [runtimeGrants.orgId, runtimeGrants.workflowExecutionId, runtimeGrants.policyKey],
      where: sql`${runtimeGrants.workflowExecutionId} is not null and ${runtimeGrants.revokedAt} is null`,
    });
}

/** Soft-revoke every live grant for a session (grant expiry hook — called
 *  from `EngineHost.destroy`). Idempotent: a second call matches no live rows.
 *  Soft (sets `revoked_at`) rather than hard-delete so a re-grant after
 *  revoke still inserts cleanly under the partial unique index. */
export async function revokeSessionGrants(db: AppDb, sessionId: string, now: number = Date.now()): Promise<void> {
  await db
    .update(runtimeGrants)
    .set({ revokedAt: now })
    .where(and(eq(runtimeGrants.sessionId, sessionId), isNull(runtimeGrants.revokedAt)));
}

/** Workflow-execution twin of `revokeSessionGrants` — called from
 *  `PgWorkflowStore.settleRun`. Idempotent (guarded by `revoked_at IS NULL`). */
export async function revokeExecutionGrants(
  db: AppDb,
  workflowExecutionId: string,
  now: number = Date.now(),
): Promise<void> {
  await db
    .update(runtimeGrants)
    .set({ revokedAt: now })
    .where(and(eq(runtimeGrants.workflowExecutionId, workflowExecutionId), isNull(runtimeGrants.revokedAt)));
}

// ── "Always allow" org policy write ────────────────────────────────

export interface AlwaysAllowWrite {
  orgId: string;
  actionId: string;
  /** The user who resolved the approval gate — verified to be an org admin
   *  before the write (defense in depth; the route-level check lands in T4). */
  grantedBy: string;
  now: number;
}

/** Thrown by `writeAlwaysAllowPolicy` when the resolver is not an org admin.
 *  `onResolution` lets it propagate so `call_tool` fails the approval closed. */
export class AlwaysAllowNotAdminError extends Error {
  constructor(orgId: string, userId: string) {
    super(`always_allow requires an org admin: user "${userId}" is not an admin of org "${orgId}"`);
    this.name = "AlwaysAllowNotAdminError";
  }
}

/**
 * UPSERT an org-scoped, action-scoped `allow` policy (origin
 * `approval_prompt`) on the deterministic `alwaysAllowPolicyId` key. Verifies
 * `grantedBy` is an org admin first — a non-admin throws
 * `AlwaysAllowNotAdminError` (nothing is written). Reinstates a previously
 * revoked row (`revoked_at → null`) so "always allow" after an admin revoked
 * it works, while a replayed resolution upserts identical values.
 *
 * After the upsert, soft-revokes any OTHER live action-scope org policy on the
 * same `actionId` whose mode is NOT `deny` (I1): an admin clicking "always
 * allow" is explicitly superseding whatever gated this action, so a lingering
 * duplicate-target `require_approval` (or a stale `allow`) row must not stay
 * live to re-tie against the always-allow row under the deterministic
 * tie-break. Deny rows are never touched — an org deny is absolute and a
 * non-admin-overridable kill switch, not something an approval prompt clears.
 */
export async function writeAlwaysAllowPolicy(db: AppDb, write: AlwaysAllowWrite): Promise<void> {
  const admin = await isOrgAdmin(db, write.orgId, write.grantedBy);
  if (!admin) throw new AlwaysAllowNotAdminError(write.orgId, write.grantedBy);

  const policyId = alwaysAllowPolicyId(write.orgId, write.actionId);
  await db
    .insert(actionPolicies)
    .values({
      id: policyId,
      orgId: write.orgId,
      principalType: "org",
      principalId: write.orgId,
      service: null,
      actionId: write.actionId,
      riskLevel: null,
      mode: "allow",
      paramMatchers: [],
      appliesIn: "any",
      origin: "approval_prompt",
      managedBy: write.grantedBy,
      expiresAt: null,
      revokedAt: null,
      createdAt: write.now,
      updatedAt: write.now,
    })
    .onConflictDoUpdate({
      target: actionPolicies.id,
      set: { mode: "allow", revokedAt: null, managedBy: write.grantedBy, updatedAt: write.now },
    });

  await db
    .update(actionPolicies)
    .set({ revokedAt: write.now, updatedAt: write.now })
    .where(
      and(
        eq(actionPolicies.orgId, write.orgId),
        eq(actionPolicies.principalType, "org"),
        eq(actionPolicies.actionId, write.actionId),
        isNull(actionPolicies.revokedAt),
        ne(actionPolicies.id, policyId),
        ne(actionPolicies.mode, "deny"),
      ),
    );
}

// ── Audit sink ─────────────────────────────────────────────────────

/** Cap a value's canonical JSON at `POLICY_AUDIT_FIELD_CAP`. Over-cap values
 *  are replaced by a `{ truncated: true, preview }` marker so the row still
 *  lands (a giant param blob must never fail — or bloat — the audit write). */
export function capAuditField(value: unknown): { value: unknown; truncated: boolean } {
  const json = JSON.stringify(value ?? null);
  if (json.length <= POLICY_AUDIT_FIELD_CAP) return { value: value ?? null, truncated: false };
  return { value: { truncated: true, preview: json.slice(0, POLICY_AUDIT_FIELD_CAP) }, truncated: true };
}

export interface AuditInvocationRow {
  /** `action_invocations` PK. Deterministic for gated/replayable rows (dedup
   *  on `(sessionId, resumeKey, gateOrdinal)`), random otherwise. */
  invocationId: string;
  service?: string;
  actionId?: string;
  riskLevel?: RiskLevel | null;
  resolvedMode?: ApprovalMode | null;
  baseMode?: ApprovalMode | null;
  matchedPolicyId?: string | null;
  matchedGrantId?: string | null;
  matchedOverrideId?: string | null;
  status?: PolicyInvocationRecord["status"] | null;
  sessionId?: string | null;
  workflowExecutionId?: string | null;
  userId?: string | null;
  orgId?: string | null;
  params?: unknown;
  result?: unknown;
  error?: string | null;
  durationMs?: number | null;
  startedAt?: number | null;
  createdAt?: number;
}

/**
 * Fire-and-forget audit write. NEVER throws (a failed audit write must not
 * break a tool call or a workflow node) — every error is logged and
 * swallowed. Dedups on the PK via `onConflictDoNothing`: a deterministic id
 * makes a replay double-fire a no-op; a random id records every distinct
 * emission.
 */
export async function persistInvocationAudit(db: AppDb, row: AuditInvocationRow): Promise<void> {
  try {
    const params = row.params === undefined ? null : capAuditField(row.params);
    const result = row.result === undefined ? null : capAuditField(row.result);
    const error =
      row.error != null && row.error.length > POLICY_AUDIT_FIELD_CAP
        ? row.error.slice(0, POLICY_AUDIT_FIELD_CAP)
        : (row.error ?? null);

    await db
      .insert(actionInvocations)
      .values({
        invocationId: row.invocationId,
        createdAt: row.createdAt ?? Date.now(),
        service: row.service ?? null,
        actionId: row.actionId ?? null,
        riskLevel: row.riskLevel ?? null,
        resolvedMode: row.resolvedMode ?? null,
        baseMode: row.baseMode ?? null,
        matchedPolicyId: row.matchedPolicyId ?? null,
        matchedGrantId: row.matchedGrantId ?? null,
        matchedOverrideId: row.matchedOverrideId ?? null,
        status: row.status ?? null,
        sessionId: row.sessionId ?? null,
        workflowExecutionId: row.workflowExecutionId ?? null,
        userId: row.userId ?? null,
        orgId: row.orgId ?? null,
        params: params ? params.value : null,
        paramsTruncated: params ? params.truncated : null,
        result: result ? result.value : null,
        resultTruncated: result ? result.truncated : null,
        error,
        durationMs: row.durationMs ?? null,
        startedAt: row.startedAt ?? null,
      })
      .onConflictDoNothing();
  } catch (err) {
    console.error(`policy audit write failed for invocation ${row.invocationId}:`, err);
  }
}

/**
 * Stamp the execution OUTCOME onto an existing audit row (workflow path: the
 * decision row is written by `enforceWorkflowPolicy` BEFORE execution; this
 * fills in `status`/`result`/`error`/`durationMs` after `action.execute`
 * settles). Fire-and-forget like `persistInvocationAudit` — never throws. A
 * replayed node re-stamps the same values; idempotent.
 */
export async function updateInvocationOutcome(
  db: AppDb,
  invocationId: string,
  orgId: string,
  outcome: {
    status: "completed" | "error" | "approved" | "denied" | "cancelled" | "timeout";
    result?: unknown;
    error?: string;
    durationMs?: number;
    startedAt?: number;
    resolvedBy?: string;
  },
): Promise<void> {
  try {
    const result = outcome.result === undefined ? null : capAuditField(outcome.result);
    const error =
      outcome.error != null && outcome.error.length > POLICY_AUDIT_FIELD_CAP
        ? outcome.error.slice(0, POLICY_AUDIT_FIELD_CAP)
        : (outcome.error ?? null);
    await db
      .update(actionInvocations)
      .set({
        status: outcome.status,
        result: result ? result.value : null,
        resultTruncated: result ? result.truncated : null,
        error,
        durationMs: outcome.durationMs ?? null,
        ...(outcome.startedAt !== undefined ? { startedAt: outcome.startedAt } : {}),
        ...(outcome.resolvedBy !== undefined ? { resolvedBy: outcome.resolvedBy } : {}),
      })
      // Org-scoped: `invocationId` embeds the workflow node id, which the
      // workflow AUTHOR controls — without the orgId predicate a crafted
      // node id could collide with (and overwrite) another org's row.
      .where(and(eq(actionInvocations.invocationId, invocationId), eq(actionInvocations.orgId, orgId)));
  } catch (err) {
    console.error(`policy audit outcome update failed for invocation ${invocationId}:`, err);
  }
}

/** Deterministic audit PK for a gated session invocation — dedup key is
 *  `(sessionId, queueItemId, resumeKey, gateOrdinal)`: a restart replay
 *  re-emits with the SAME queueItemId (the suspended turn mirrors it) and the
 *  SAME gateOrdinal → same id → no-op; a genuine repeat — same turn (ordinal
 *  increments) or a later turn (queueItemId differs, ordinal resets) — mints
 *  a new id. `queueItemId` is in the key because `gateOrdinal` is scoped to
 *  `(queueItemId, resumeKey)` and resets per turn; without it, two turns
 *  gating on the identical (tool, args) pair collided and the second row was
 *  silently dropped (spec Deviations T6 #4, fixed). */
export function gatedAuditId(
  sessionId: string,
  queueItemId: string | undefined,
  resumeKey: string,
  gateOrdinal: number,
): string {
  return `pol:gate:${sessionId}:${queueItemId ?? ""}:${resumeKey}:${gateOrdinal}`;
}

// ── Engine PolicyResolver ──────────────────────────────────────────

export interface PolicyResolverDeps {
  db: AppDb;
  actionPluginByService: Map<string, { plugin: ValetPlugin; actionPlugin: ActionPlugin }>;
  clock?: () => number;
}

/**
 * Assemble the engine's `PolicyResolver` port (session/interactive path). One
 * instance is shared across every session build — all per-invocation context
 * (org/user/session/service) rides in on `PolicyResolveInput`, so the resolver
 * holds no session state of its own.
 */
export function buildPolicyResolver(deps: PolicyResolverDeps): PolicyResolver {
  const clock = deps.clock ?? Date.now;

  const pluginDefaultFor = (service: string): ApprovalMode | undefined =>
    deps.actionPluginByService.get(service)?.actionPlugin.defaultApprovalMode;

  return {
    async resolve(input: PolicyResolveInput): Promise<PolicyDecision> {
      // Without an org context there are no org policies/grants/overrides to
      // consult — fall through to the pure core with empty rows so the plugin
      // default / risk default still applies (byte-identical to a real load
      // that returns nothing).
      if (!input.orgId) {
        return resolvePolicyDecision(
          { policies: [], grants: [], overrides: [] },
          {
            service: input.service,
            actionId: input.actionId,
            riskLevel: input.riskLevel,
            params: input.params,
            appliesIn: input.appliesIn,
            sessionId: input.sessionId,
            now: clock(),
          },
          pluginDefaultFor(input.service),
        );
      }

      const decision = await resolveActionPolicy(deps.db, {
        orgId: input.orgId,
        teamId: input.teamId,
        userId: input.userId,
        service: input.service,
        actionId: input.actionId,
        riskLevel: input.riskLevel,
        params: input.params,
        appliesIn: input.appliesIn,
        sessionId: input.sessionId,
        pluginDefault: pluginDefaultFor(input.service),
        now: clock(),
      });

      if (decision.mode !== "require_approval") return decision;

      // Offer the two escalation actions on the gate. `onResolution`
      // enforces the admin check for `always_allow`; the engine strips the
      // `approves` flag before opening the gate.
      return {
        ...decision,
        extraGateActions: [
          { id: GATE_ACTION_APPROVE_SESSION, label: "Approve for this session", approves: true },
          { id: GATE_ACTION_ALWAYS_ALLOW, label: "Always allow (org)", approves: true },
        ],
      };
    },

    async onResolution(
      input: PolicyResolveInput,
      decision: PolicyDecision,
      resolution: DecisionResolution,
    ): Promise<void> {
      // Binding carry-forward #2: a `resolver_error` decision is synthetic —
      // the engine minted it when `resolve()` threw; the resolver never
      // produced it, so it carries no real provenance to act on. NO-OP (log).
      if (decision.provenance.source === "resolver_error") {
        console.warn(
          `policy onResolution: skipping side effects for synthetic resolver_error decision (${input.service}.${input.actionId})`,
        );
        return;
      }
      if (!input.orgId) return;

      const now = clock();
      if (resolution.actionId === GATE_ACTION_APPROVE_SESSION) {
        if (!input.sessionId) return;
        await writeSessionGrant(deps.db, input.sessionId, {
          orgId: input.orgId,
          service: input.service,
          actionId: input.actionId,
          grantedBy: resolution.resolvedBy,
          now,
        });
      } else if (resolution.actionId === GATE_ACTION_ALWAYS_ALLOW) {
        // Throws (AlwaysAllowNotAdminError) for a non-admin resolver — the
        // engine catches it and fails the approval closed.
        await writeAlwaysAllowPolicy(deps.db, {
          orgId: input.orgId,
          actionId: input.actionId,
          grantedBy: resolution.resolvedBy,
          now,
        });
      }
      // Plain "approve" (or any other resolution) is a one-shot allow — no
      // durable write.
    },

    async onInvocation(record: PolicyInvocationRecord): Promise<void> {
      const createdAt = clock();
      const durationMs = record.durationMs ?? null;
      const startedAt = durationMs != null ? createdAt - durationMs : null;
      await persistInvocationAudit(deps.db, {
        createdAt,
        // Gated rows (a gate opened → gateOrdinal present) dedup on
        // (sessionId, resumeKey, gateOrdinal); every other emission gets a
        // fresh id so genuine repeats are all recorded.
        invocationId:
          record.gateOrdinal !== undefined
            ? gatedAuditId(record.sessionId, record.queueItemId, record.resumeKey, record.gateOrdinal)
            : `pol:call:${randomUUID()}`,
        service: record.service,
        actionId: record.actionId,
        riskLevel: record.riskLevel,
        resolvedMode: record.resolvedMode,
        baseMode: record.provenance.baseMode,
        matchedPolicyId: record.provenance.matchedPolicyId ?? null,
        matchedGrantId: record.provenance.matchedGrantId ?? null,
        matchedOverrideId: record.provenance.matchedOverrideId ?? null,
        status: record.status,
        sessionId: record.sessionId,
        workflowExecutionId: null,
        userId: record.userId ?? null,
        orgId: record.orgId ?? null,
        params: record.params,
        result: record.result,
        error: record.error ?? null,
        durationMs,
        startedAt,
      });
    },
  };
}
