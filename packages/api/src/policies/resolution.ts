/**
 * Pure precedence core for the org action-policy engine (action-policies
 * plan, Task 2). `resolvePolicyDecision` takes in-memory rows (already
 * fetched by a later task's service layer — T3-T5) plus one invocation's
 * resolution input and returns a `PolicyDecision`, with no I/O of its own.
 *
 * ADJUDICATED precedence order (binding — deliberately differs from the
 * original spec text, see `.superpowers/sdd/task-2-brief.md`):
 *
 *   (0) An org-policy deny is absolute. Among the `action_policies` rows
 *       with `principalType: "org"` that match this invocation, the single
 *       MOST SPECIFIC one (action > service > risk) wins; if its mode is
 *       "deny", that decision short-circuits everything below — neither a
 *       live runtime grant nor a per-user override can loosen it.
 *   Team rules use the same specificity ranking within their scope. Team
 *   deny is absolute after org deny. Other team rules cannot loosen a
 *   matching org rule. Team invocations load no personal overrides.
 *
 *   (1) A live runtime grant (`runtime_grants`, always `mode: "allow"`)
 *       quiets the invocation outright.
 *   (2) A per-user override (`action_policy_overrides`) wins next — this can
 *       be ANY mode, including "deny": a user's own standing deny is
 *       distinct from an org-level deny (0) and stays overridable by a
 *       subsequent live grant (1).
 *   (3) The org policy match from step (0), when its mode is allow or
 *       require_approval (not deny — that already short-circuited above).
 *   (4) The plugin's own `defaultApprovalMode`, passed in by the caller.
 *   (5) The engine's built-in risk default: low/medium → allow,
 *       high/critical → require_approval.
 *
 * Every rung applies its own filters before a row is even a candidate:
 * exactly one of (actionId > service > riskLevel) determines both whether a
 * row matches AND its specificity; `paramMatchers` (AND semantics, ported
 * matcher engine); org policies additionally filter on `appliesIn`
 * ("any"/"session"/"workflow") and `expiresAt`/`revokedAt`; runtime grants
 * are scoped to the live session or workflow execution via
 * `sessionId`/`workflowExecutionId` and `revokedAt`, and matched by an exact
 * `policyKey` (see `grantPolicyKey`) rather than the loose target fields —
 * grants are single-shot "yes, do this exact action" quiets, not general
 * targeting rules. `action_policy_overrides` rows have no `appliesIn` or
 * expiry — a user's override applies everywhere until replaced.
 *
 * `provenance.baseMode` always reports what rungs (3)-(5) would have
 * decided, even when a grant or override at a higher rung wins — so a host
 * audit sink / UI can explain "org policy said X, but you have a live grant
 * so it ran anyway."
 */
import type { ApprovalMode, PolicyProvenanceSource, RiskLevel } from "@valet/engine";
import { evaluateMatchers, type ParamMatcher } from "./matchers.js";

export type PolicyAppliesIn = "any" | "workflow" | "session";

/** Row shape `resolvePolicyDecision` needs from `action_policies` — a
 *  superset of the DB columns is fine, this is only what resolution reads. */
export interface ActionPolicyRow {
  id: string;
  principalType: "org" | "user" | "team";
  service: string | null;
  actionId: string | null;
  riskLevel: RiskLevel | null;
  mode: ApprovalMode;
  paramMatchers: ParamMatcher[];
  appliesIn: PolicyAppliesIn;
  expiresAt: number | null;
  revokedAt: number | null;
  /** Last-write timestamp (ms) — the final tie-break in `mostSpecific` when
   *  two rows share both specificity and mode-restrictiveness (newest wins). */
  updatedAt: number;
}

/** Row shape `resolvePolicyDecision` needs from `runtime_grants`. Grants are
 *  always `mode: "allow"` by schema (CHECK / literal type), so there is no
 *  `mode` field here to read. */
export interface RuntimeGrantRow {
  id: string;
  sessionId: string | null;
  workflowExecutionId: string | null;
  policyKey: string;
  revokedAt: number | null;
}

/** Row shape `resolvePolicyDecision` needs from `action_policy_overrides`. */
export interface ActionPolicyOverrideRow {
  id: string;
  service: string | null;
  actionId: string | null;
  riskLevel: RiskLevel | null;
  mode: ApprovalMode;
  paramMatchers: ParamMatcher[];
  /** Last-write timestamp (ms) — final tie-break in `mostSpecific`. */
  updatedAt: number;
}

export interface PolicyResolutionRows {
  workflowGrants?: { id: string; actionId: string }[];
  policies: ActionPolicyRow[];
  grants: RuntimeGrantRow[];
  overrides: ActionPolicyOverrideRow[];
}

/** One invocation's resolution input. Distinct from the engine's
 *  `PolicyResolveInput` (T1 seam) — a future host-side `PolicyResolver`
 *  adapts that shape into this one, adding `now` for determinism and
 *  `workflowExecutionId` for workflow-mode grant scoping (out of T1's
 *  session-mode-only scope). */
export interface PolicyResolutionInput {
  service: string;
  actionId: string;
  riskLevel: RiskLevel;
  params: Record<string, unknown> | undefined;
  appliesIn: "session" | "workflow";
  /** Required when `appliesIn === "session"` — scopes runtime-grant matching. */
  sessionId?: string;
  /** Required when `appliesIn === "workflow"` — scopes runtime-grant matching. */
  workflowExecutionId?: string;
  /** Caller-supplied clock reading (ms) — kept explicit so expiry edge cases
   *  are deterministic in tests; this module never calls `Date.now()`. */
  now: number;
}

export interface PolicyDecisionProvenance {
  /** What rungs (3)-(5) alone would have decided, regardless of which rung
   *  actually won. */
  baseMode: ApprovalMode;
  matchedPolicyId?: string;
  matchedGrantId?: string;
  matchedOverrideId?: string;
  source: PolicyProvenanceSource;
}

export interface PolicyDecision {
  mode: ApprovalMode;
  provenance: PolicyDecisionProvenance;
}

/**
 * Deterministic idempotency/match key for a runtime grant: exact
 * `service.actionId`, no param fingerprint, no wider service/risk-level
 * grants — a live grant only ever quiets the one exact action it was
 * minted for. Callers writing `runtime_grants.policyKey` (T3-T5) MUST use
 * this same function so their rows actually match here.
 *
 * `actionId` is canonically the fully-qualified `service.action` fqid (the
 * plugin-catalog convention both invocation paths resolve to); the prefix
 * check collapses it so the key never double-prefixes
 * (`github.github.create_issue`). A bare id still composes to the same key.
 */
export function grantPolicyKey(service: string, actionId: string): string {
  return actionId.startsWith(`${service}.`) ? actionId : `${service}.${actionId}`;
}

interface Targeted {
  service: string | null;
  actionId: string | null;
  riskLevel: unknown;
}

/** Rows `mostSpecific` ranks — target dimensions plus the two tie-break axes
 *  (mode-restrictiveness, then recency). Both `ActionPolicyRow` and
 *  `ActionPolicyOverrideRow` satisfy this. */
interface Rankable extends Targeted {
  mode: ApprovalMode;
  updatedAt: number;
}

/** action=3, service=2, riskLevel=1 — higher wins ties in `mostSpecific`. */
function targetSpecificity(row: Targeted): 1 | 2 | 3 {
  if (row.actionId !== null) return 3;
  if (row.service !== null) return 2;
  return 1;
}

/** Tie-break ordering within a single specificity tier: the most RESTRICTIVE
 *  mode wins so a duplicate-target org row can never be silently loosened by
 *  DB encounter order (deny > require_approval > allow). */
const MODE_RESTRICTIVENESS: Record<ApprovalMode, number> = { deny: 3, require_approval: 2, allow: 1 };

/** Positive when `a` should outrank `b`: higher specificity first, then more
 *  restrictive mode, then newer `updatedAt`. Fully deterministic — no reliance
 *  on `loadPolicyRows`' (unordered) DB encounter order, which duplicate-target
 *  org rows would otherwise let leak into the outcome. */
function comparePrecedence(a: Rankable, b: Rankable): number {
  const spec = targetSpecificity(a) - targetSpecificity(b);
  if (spec !== 0) return spec;
  const restr = MODE_RESTRICTIVENESS[a.mode] - MODE_RESTRICTIVENESS[b.mode];
  if (restr !== 0) return restr;
  return a.updatedAt - b.updatedAt;
}

function matchesTarget(
  row: { service: string | null; actionId: string | null; riskLevel: RiskLevel | null },
  input: Pick<PolicyResolutionInput, "service" | "actionId" | "riskLevel">,
): boolean {
  // Exactly one of these is non-null on any real row (one-of CHECK
  // constraint at the DB layer) — check action first (most specific).
  if (row.actionId !== null) return row.actionId === input.actionId;
  if (row.service !== null) return row.service === input.service;
  if (row.riskLevel !== null) return row.riskLevel === input.riskLevel;
  return false;
}

function matchesPolicyRow(row: ActionPolicyRow, input: PolicyResolutionInput): boolean {
  if (row.revokedAt !== null) return false;
  if (row.expiresAt !== null && row.expiresAt <= input.now) return false;
  if (row.appliesIn !== "any" && row.appliesIn !== input.appliesIn) return false;
  if (!matchesTarget(row, input)) return false;
  return evaluateMatchers(row.paramMatchers, input.params);
}

function matchesOverrideRow(row: ActionPolicyOverrideRow, input: PolicyResolutionInput): boolean {
  if (!matchesTarget(row, input)) return false;
  return evaluateMatchers(row.paramMatchers, input.params);
}

function matchesGrantRow(row: RuntimeGrantRow, input: PolicyResolutionInput): boolean {
  if (row.revokedAt !== null) return false;
  if (row.policyKey !== grantPolicyKey(input.service, input.actionId)) return false;
  if (input.appliesIn === "session") {
    return row.sessionId !== null && row.sessionId === input.sessionId;
  }
  return row.workflowExecutionId !== null && row.workflowExecutionId === input.workflowExecutionId;
}

/** Picks the single winning row by `comparePrecedence`: most specific first,
 *  then most restrictive mode, then newest `updatedAt`. Deterministic even
 *  when duplicate-target rows tie on specificity (loadPolicyRows has no
 *  ORDER BY, and duplicate-target org rows are creatable). */
function mostSpecific<T extends Rankable>(rows: T[]): T | undefined {
  let best: T | undefined;
  for (const row of rows) {
    if (best === undefined || comparePrecedence(row, best) > 0) best = row;
  }
  return best;
}

function riskDefault(riskLevel: RiskLevel): ApprovalMode {
  return riskLevel === "low" || riskLevel === "medium" ? "allow" : "require_approval";
}

/**
 * Pure precedence resolution — see module doc comment for the full rung
 * order. `pluginDefault` is the plugin's `defaultApprovalMode` (rung 4),
 * `undefined` when the plugin doesn't declare one.
 */
export function resolvePolicyDecision(
  rows: PolicyResolutionRows,
  input: PolicyResolutionInput,
  pluginDefault: ApprovalMode | undefined,
): PolicyDecision {
  const orgCandidates = rows.policies.filter((r) => r.principalType === "org" && matchesPolicyRow(r, input));
  const orgMatch = mostSpecific(orgCandidates);

  // Rung 0: org-policy deny is absolute — checked before grant/override so
  // neither can loosen it.
  if (orgMatch && orgMatch.mode === "deny") {
    return {
      mode: "deny",
      provenance: { baseMode: "deny", matchedPolicyId: orgMatch.id, source: "org_policy" },
    };
  }

  const teamMatch = mostSpecific(rows.policies.filter((r) => r.principalType === "team" && matchesPolicyRow(r, input)));
  if (teamMatch?.mode === "deny") {
    return { mode: "deny", provenance: { baseMode: "deny", matchedPolicyId: teamMatch.id, source: "team_policy" } };
  }
  // A team may tighten an org rule, but cannot loosen it. Session grants
  // still approve a require_approval rule; neither org nor team deny yields.
  const match = teamMatch && (!orgMatch || MODE_RESTRICTIVENESS[teamMatch.mode] >= MODE_RESTRICTIVENESS[orgMatch.mode]) ? teamMatch : orgMatch;

  // Honest base mode (rungs 3-5), computed up front so provenance can
  // report it even when a higher rung wins below.
  let baseMode: ApprovalMode;
  let baseSource: PolicyProvenanceSource;
  const basePolicyId = match?.id;
  if (match) {
    baseMode = match.mode;
    baseSource = match.principalType === "team" ? "team_policy" : "org_policy";
  } else if (pluginDefault) {
    baseMode = pluginDefault;
    baseSource = "plugin_default";
  } else {
    baseMode = riskDefault(input.riskLevel);
    baseSource = "risk_default";
  }

  // Rung 1: live runtime grant.
  const grant = rows.grants.find((r) => matchesGrantRow(r, input));
  if (grant) {
    return {
      mode: "allow",
      provenance: {
        baseMode,
        matchedGrantId: grant.id,
        matchedPolicyId: basePolicyId,
        source: "runtime_grant",
      },
    };
  }

  // Rung 2: per-user override (any mode).
  const override = mostSpecific(rows.overrides.filter((r) => matchesOverrideRow(r, input)));
  if (override) {
    return {
      mode: override.mode,
      provenance: {
        baseMode,
        matchedOverrideId: override.id,
        matchedPolicyId: basePolicyId,
        source: "override",
      },
    };
  }

  // Durable workflow permission never weakens an explicit org/team rule.
  const workflowGrant = input.appliesIn === "workflow" && !match
    ? rows.workflowGrants?.find((row) => row.actionId === input.actionId) : undefined;
  if (workflowGrant) return { mode: "allow", provenance: {
    baseMode, matchedGrantId: workflowGrant.id, source: "workflow_grant",
  } };

  // Rungs 3-5.
  return {
    mode: baseMode,
    provenance: { baseMode, matchedPolicyId: basePolicyId, source: baseSource },
  };
}
