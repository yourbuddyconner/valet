import { describe, expect, it } from "vitest";
import {
  grantPolicyKey,
  resolvePolicyDecision,
  type ActionPolicyOverrideRow,
  type ActionPolicyRow,
  type PolicyResolutionInput,
  type PolicyResolutionRows,
  type RuntimeGrantRow,
} from "./resolution.js";

const NOW = 1_000_000;

function baseInput(overrides: Partial<PolicyResolutionInput> = {}): PolicyResolutionInput {
  return {
    service: "gmail",
    actionId: "gmail.send_email",
    riskLevel: "high",
    params: { to: "a@example.com" },
    appliesIn: "session",
    sessionId: "sess_1",
    now: NOW,
    ...overrides,
  };
}

function orgPolicy(overrides: Partial<ActionPolicyRow> = {}): ActionPolicyRow {
  return {
    id: "apol_default",
    principalType: "org",
    service: null,
    actionId: null,
    riskLevel: null,
    mode: "allow",
    paramMatchers: [],
    appliesIn: "any",
    expiresAt: null,
    revokedAt: null,
    updatedAt: NOW,
    ...overrides,
  };
}

function grant(overrides: Partial<RuntimeGrantRow> = {}): RuntimeGrantRow {
  return {
    id: "rg_default",
    sessionId: "sess_1",
    workflowExecutionId: null,
    policyKey: grantPolicyKey("gmail", "gmail.send_email"),
    revokedAt: null,
    ...overrides,
  };
}

function override(overrides: Partial<ActionPolicyOverrideRow> = {}): ActionPolicyOverrideRow {
  return {
    id: "apo_default",
    service: null,
    actionId: null,
    riskLevel: null,
    mode: "allow",
    paramMatchers: [],
    updatedAt: NOW,
    ...overrides,
  };
}

function rows(partial: Partial<PolicyResolutionRows> = {}): PolicyResolutionRows {
  return { policies: [], grants: [], overrides: [], ...partial };
}

describe("resolvePolicyDecision — rung 5: risk default (no rows, no plugin default)", () => {
  it("low/medium risk defaults to allow", () => {
    const low = resolvePolicyDecision(rows(), baseInput({ riskLevel: "low" }), undefined);
    expect(low).toEqual({ mode: "allow", provenance: { baseMode: "allow", source: "risk_default" } });

    const medium = resolvePolicyDecision(rows(), baseInput({ riskLevel: "medium" }), undefined);
    expect(medium.mode).toBe("allow");
  });

  it("high/critical risk defaults to require_approval", () => {
    const high = resolvePolicyDecision(rows(), baseInput({ riskLevel: "high" }), undefined);
    expect(high).toEqual({
      mode: "require_approval",
      provenance: { baseMode: "require_approval", source: "risk_default" },
    });

    const critical = resolvePolicyDecision(rows(), baseInput({ riskLevel: "critical" }), undefined);
    expect(critical.mode).toBe("require_approval");
  });
});

describe("resolvePolicyDecision — rung 4: plugin default", () => {
  it("wins over risk default when no org policy matches", () => {
    const decision = resolvePolicyDecision(rows(), baseInput({ riskLevel: "high" }), "allow");
    expect(decision).toEqual({ mode: "allow", provenance: { baseMode: "allow", source: "plugin_default" } });
  });
});

describe("resolvePolicyDecision — rung 3 + specificity (action > service > risk)", () => {
  it("an action-specific org policy wins over a service-level one", () => {
    const r = rows({
      policies: [
        orgPolicy({ id: "apol_service", service: "gmail", mode: "require_approval" }),
        orgPolicy({ id: "apol_action", actionId: "gmail.send_email", mode: "allow" }),
      ],
    });
    const decision = resolvePolicyDecision(r, baseInput(), undefined);
    expect(decision).toEqual({
      mode: "allow",
      provenance: { baseMode: "allow", matchedPolicyId: "apol_action", source: "org_policy" },
    });
  });

  it("a service-level org policy wins over a risk-level one", () => {
    const r = rows({
      policies: [
        orgPolicy({ id: "apol_risk", riskLevel: "high", mode: "allow" }),
        orgPolicy({ id: "apol_service", service: "gmail", mode: "require_approval" }),
      ],
    });
    const decision = resolvePolicyDecision(r, baseInput(), undefined);
    expect(decision.provenance.matchedPolicyId).toBe("apol_service");
    expect(decision.mode).toBe("require_approval");
  });

  it("a risk-level org policy applies when nothing more specific matches", () => {
    const r = rows({ policies: [orgPolicy({ id: "apol_risk", riskLevel: "high", mode: "require_approval" })] });
    const decision = resolvePolicyDecision(r, baseInput(), undefined);
    expect(decision).toEqual({
      mode: "require_approval",
      provenance: { baseMode: "require_approval", matchedPolicyId: "apol_risk", source: "org_policy" },
    });
  });
});

describe("resolvePolicyDecision — rung 0: org deny is absolute", () => {
  it("deny-beats-grant: an org deny short-circuits a matching live grant", () => {
    const r = rows({
      policies: [orgPolicy({ id: "apol_deny", actionId: "gmail.send_email", mode: "deny" })],
      grants: [grant()],
    });
    const decision = resolvePolicyDecision(r, baseInput(), undefined);
    expect(decision).toEqual({
      mode: "deny",
      provenance: { baseMode: "deny", matchedPolicyId: "apol_deny", source: "org_policy" },
    });
  });

  it("override-cannot-loosen-org-deny: a user override trying to allow doesn't beat it", () => {
    const r = rows({
      policies: [orgPolicy({ id: "apol_deny", actionId: "gmail.send_email", mode: "deny" })],
      overrides: [override({ id: "apo_allow", actionId: "gmail.send_email", mode: "allow" })],
    });
    const decision = resolvePolicyDecision(r, baseInput(), undefined);
    expect(decision.mode).toBe("deny");
    expect(decision.provenance.source).toBe("org_policy");
  });

  it("a more specific org allow beats a less specific org deny (specificity picks ONE org row)", () => {
    const r = rows({
      policies: [
        orgPolicy({ id: "apol_deny_service", service: "gmail", mode: "deny" }),
        orgPolicy({ id: "apol_allow_action", actionId: "gmail.send_email", mode: "allow" }),
      ],
    });
    const decision = resolvePolicyDecision(r, baseInput(), undefined);
    expect(decision).toEqual({
      mode: "allow",
      provenance: { baseMode: "allow", matchedPolicyId: "apol_allow_action", source: "org_policy" },
    });
  });
});

describe("resolvePolicyDecision — same-specificity tie-break (deterministic)", () => {
  it("deny-vs-allow tie at the same specificity resolves to deny (most restrictive wins)", () => {
    const r = rows({
      policies: [
        orgPolicy({ id: "apol_allow", actionId: "gmail.send_email", mode: "allow", updatedAt: NOW }),
        orgPolicy({ id: "apol_deny", actionId: "gmail.send_email", mode: "deny", updatedAt: NOW }),
      ],
    });
    const decision = resolvePolicyDecision(r, baseInput(), undefined);
    expect(decision.mode).toBe("deny");
    expect(decision.provenance.matchedPolicyId).toBe("apol_deny");
  });

  it("require_approval-vs-allow tie resolves to require_approval (order-independent)", () => {
    // Both orderings of the same two rows must pick require_approval — proving
    // the winner is not the DB encounter order.
    const forward = rows({
      policies: [
        orgPolicy({ id: "apol_allow", actionId: "gmail.send_email", mode: "allow", updatedAt: NOW }),
        orgPolicy({ id: "apol_req", actionId: "gmail.send_email", mode: "require_approval", updatedAt: NOW }),
      ],
    });
    const reversed = rows({
      policies: [
        orgPolicy({ id: "apol_req", actionId: "gmail.send_email", mode: "require_approval", updatedAt: NOW }),
        orgPolicy({ id: "apol_allow", actionId: "gmail.send_email", mode: "allow", updatedAt: NOW }),
      ],
    });
    expect(resolvePolicyDecision(forward, baseInput(), undefined).provenance.matchedPolicyId).toBe("apol_req");
    expect(resolvePolicyDecision(reversed, baseInput(), undefined).provenance.matchedPolicyId).toBe("apol_req");
  });

  it("same-mode tie breaks on newest updatedAt", () => {
    const r = rows({
      policies: [
        orgPolicy({ id: "apol_old", actionId: "gmail.send_email", mode: "allow", updatedAt: NOW - 10 }),
        orgPolicy({ id: "apol_new", actionId: "gmail.send_email", mode: "allow", updatedAt: NOW }),
      ],
    });
    const decision = resolvePolicyDecision(r, baseInput(), undefined);
    expect(decision.provenance.matchedPolicyId).toBe("apol_new");
  });
});

describe("resolvePolicyDecision — rung 1: live runtime grant", () => {
  it("grant-quiets-require: a matching grant allows despite an org require_approval", () => {
    const r = rows({
      policies: [orgPolicy({ id: "apol_require", actionId: "gmail.send_email", mode: "require_approval" })],
      grants: [grant()],
    });
    const decision = resolvePolicyDecision(r, baseInput(), undefined);
    expect(decision).toEqual({
      mode: "allow",
      provenance: {
        baseMode: "require_approval",
        matchedGrantId: "rg_default",
        matchedPolicyId: "apol_require",
        source: "runtime_grant",
      },
    });
  });

  it("a grant for a different action does not match", () => {
    const r = rows({ grants: [grant({ policyKey: grantPolicyKey("gmail", "gmail.delete_email") })] });
    const decision = resolvePolicyDecision(r, baseInput(), undefined);
    expect(decision.provenance.source).not.toBe("runtime_grant");
  });

  it("a grant scoped to a different session does not match", () => {
    const r = rows({ grants: [grant({ sessionId: "sess_other" })] });
    const decision = resolvePolicyDecision(r, baseInput(), undefined);
    expect(decision.provenance.source).not.toBe("runtime_grant");
  });

  it("a workflow-scoped grant matches a workflow-mode invocation, not a session one", () => {
    const workflowGrant = grant({ sessionId: null, workflowExecutionId: "exec_1" });
    const sessionInput = baseInput();
    const workflowInput = baseInput({ appliesIn: "workflow", sessionId: undefined, workflowExecutionId: "exec_1" });

    expect(resolvePolicyDecision(rows({ grants: [workflowGrant] }), sessionInput, undefined).provenance.source).not.toBe(
      "runtime_grant",
    );
    expect(
      resolvePolicyDecision(rows({ grants: [workflowGrant] }), workflowInput, undefined).provenance.source,
    ).toBe("runtime_grant");
  });

  it("a revoked grant does not match", () => {
    const r = rows({ grants: [grant({ revokedAt: NOW - 1 })] });
    const decision = resolvePolicyDecision(r, baseInput(), undefined);
    expect(decision.provenance.source).not.toBe("runtime_grant");
  });
});

describe("resolvePolicyDecision — rung 2: per-user override", () => {
  it("override-can-tighten: a deny override wins over an org allow", () => {
    const r = rows({
      policies: [orgPolicy({ id: "apol_allow", actionId: "gmail.send_email", mode: "allow" })],
      overrides: [override({ id: "apo_deny", actionId: "gmail.send_email", mode: "deny" })],
    });
    const decision = resolvePolicyDecision(r, baseInput(), undefined);
    expect(decision).toEqual({
      mode: "deny",
      provenance: { baseMode: "allow", matchedOverrideId: "apo_deny", matchedPolicyId: "apol_allow", source: "override" },
    });
  });

  it("a live grant still outranks a deny override (grant beats override)", () => {
    const r = rows({
      overrides: [override({ id: "apo_deny", actionId: "gmail.send_email", mode: "deny" })],
      grants: [grant()],
    });
    const decision = resolvePolicyDecision(r, baseInput(), undefined);
    expect(decision.mode).toBe("allow");
    expect(decision.provenance.source).toBe("runtime_grant");
  });

  it("override specificity: action-level override wins over service-level", () => {
    const r = rows({
      overrides: [
        override({ id: "apo_service", service: "gmail", mode: "deny" }),
        override({ id: "apo_action", actionId: "gmail.send_email", mode: "allow" }),
      ],
    });
    const decision = resolvePolicyDecision(r, baseInput(), undefined);
    expect(decision.mode).toBe("allow");
    expect(decision.provenance.matchedOverrideId).toBe("apo_action");
  });
});

describe("resolvePolicyDecision — appliesIn filtering", () => {
  it("a session-only org policy does not apply to a workflow invocation", () => {
    const r = rows({
      policies: [
        orgPolicy({ id: "apol_session", actionId: "gmail.send_email", appliesIn: "session", mode: "deny" }),
      ],
    });
    const decision = resolvePolicyDecision(
      r,
      baseInput({ appliesIn: "workflow", sessionId: undefined, workflowExecutionId: "exec_1" }),
      undefined,
    );
    expect(decision.provenance.source).not.toBe("org_policy");
  });

  it("an appliesIn: any org policy applies to both session and workflow invocations", () => {
    const r = rows({
      policies: [orgPolicy({ id: "apol_any", actionId: "gmail.send_email", appliesIn: "any", mode: "deny" })],
    });
    const sessionDecision = resolvePolicyDecision(r, baseInput(), undefined);
    const workflowDecision = resolvePolicyDecision(
      r,
      baseInput({ appliesIn: "workflow", sessionId: undefined, workflowExecutionId: "exec_1" }),
      undefined,
    );
    expect(sessionDecision.mode).toBe("deny");
    expect(workflowDecision.mode).toBe("deny");
  });
});

describe("resolvePolicyDecision — expiry / revocation exclusion", () => {
  it("an expired org policy is ignored", () => {
    const r = rows({
      policies: [
        orgPolicy({ id: "apol_expired", actionId: "gmail.send_email", mode: "deny", expiresAt: NOW - 1 }),
      ],
    });
    const decision = resolvePolicyDecision(r, baseInput(), undefined);
    expect(decision.provenance.source).not.toBe("org_policy");
  });

  it("a not-yet-expired org policy still applies", () => {
    const r = rows({
      policies: [
        orgPolicy({ id: "apol_live", actionId: "gmail.send_email", mode: "deny", expiresAt: NOW + 1 }),
      ],
    });
    const decision = resolvePolicyDecision(r, baseInput(), undefined);
    expect(decision.mode).toBe("deny");
  });

  it("a revoked org policy is ignored", () => {
    const r = rows({
      policies: [
        orgPolicy({ id: "apol_revoked", actionId: "gmail.send_email", mode: "deny", revokedAt: NOW - 1 }),
      ],
    });
    const decision = resolvePolicyDecision(r, baseInput(), undefined);
    expect(decision.provenance.source).not.toBe("org_policy");
  });
});

describe("resolvePolicyDecision — param matchers", () => {
  it("an org policy with a non-matching paramMatcher is not a candidate", () => {
    const r = rows({
      policies: [
        orgPolicy({
          id: "apol_scoped",
          actionId: "gmail.send_email",
          mode: "deny",
          paramMatchers: [{ path: "to", op: "eq", value: "someone-else@example.com" }],
        }),
      ],
    });
    const decision = resolvePolicyDecision(r, baseInput(), undefined);
    expect(decision.provenance.source).not.toBe("org_policy");
  });

  it("an org policy with a matching paramMatcher applies", () => {
    const r = rows({
      policies: [
        orgPolicy({
          id: "apol_scoped",
          actionId: "gmail.send_email",
          mode: "deny",
          paramMatchers: [{ path: "to", op: "eq", value: "a@example.com" }],
        }),
      ],
    });
    const decision = resolvePolicyDecision(r, baseInput(), undefined);
    expect(decision.mode).toBe("deny");
  });

  it("an override with a non-matching paramMatcher is not a candidate", () => {
    const r = rows({
      overrides: [
        override({
          id: "apo_scoped",
          actionId: "gmail.send_email",
          mode: "deny",
          paramMatchers: [{ path: "to", op: "eq", value: "nope@example.com" }],
        }),
      ],
    });
    const decision = resolvePolicyDecision(r, baseInput(), undefined);
    expect(decision.provenance.source).not.toBe("override");
  });
});

describe("resolvePolicyDecision — principalType: user rows in action_policies are not consulted", () => {
  it("a user-principal action_policies row never matches (not part of this precedence order)", () => {
    const r = rows({
      policies: [
        orgPolicy({ id: "apol_user", principalType: "user", actionId: "gmail.send_email", mode: "deny" }),
      ],
    });
    const decision = resolvePolicyDecision(r, baseInput(), undefined);
    expect(decision.provenance.source).toBe("risk_default");
  });
});

describe("team action policies", () => {
  const teamPolicy = (mode: ActionPolicyRow["mode"]) => orgPolicy({ id: "team-rule", principalType: "team", service: "gmail", mode });
  it("keeps org deny above team allow and runtime approval", () => {
    const result = resolvePolicyDecision(rows({ policies: [orgPolicy({ service: "gmail", mode: "deny" }), teamPolicy("allow")], grants: [grant()] }), baseInput(), undefined);
    expect(result).toMatchObject({ mode: "deny", provenance: { source: "org_policy" } });
  });
  it("keeps team deny above org allow and runtime approval", () => {
    const result = resolvePolicyDecision(rows({ policies: [orgPolicy({ service: "gmail", mode: "allow" }), teamPolicy("deny")], grants: [grant()] }), baseInput(), undefined);
    expect(result).toMatchObject({ mode: "deny", provenance: { source: "team_policy" } });
  });
  it("does not let team allow loosen org approval", () => {
    const result = resolvePolicyDecision(rows({ policies: [orgPolicy({ service: "gmail", mode: "require_approval" }), teamPolicy("allow")] }), baseInput(), undefined);
    expect(result).toMatchObject({ mode: "require_approval", provenance: { source: "org_policy" } });
  });
  it("lets team approval tighten an org allow and allows a scoped grant", () => {
    const policies = [orgPolicy({ service: "gmail", mode: "allow" }), teamPolicy("require_approval")];
    expect(resolvePolicyDecision(rows({ policies }), baseInput(), undefined)).toMatchObject({ mode: "require_approval", provenance: { source: "team_policy" } });
    expect(resolvePolicyDecision(rows({ policies, grants: [grant()] }), baseInput(), undefined).mode).toBe("allow");
  });
  it("honors expiry and session-only applicability on team rules", () => {
    const policies = [{ ...teamPolicy("deny"), appliesIn: "session" as const }, { ...teamPolicy("deny"), expiresAt: NOW }];
    expect(resolvePolicyDecision(rows({ policies }), baseInput({ appliesIn: "workflow" }), "allow").mode).toBe("allow");
  });
});


describe("durable workflow grants", () => {
  const workflowGrants = [{ id: "wf-grant", actionId: "gmail.send_email" }];
  it("never applies to a chat", () => {
    expect(resolvePolicyDecision(rows({ workflowGrants }), baseInput(), undefined).mode).toBe("require_approval");
    expect(resolvePolicyDecision(rows({ workflowGrants }), baseInput({ appliesIn: "workflow" }), undefined).mode).toBe("allow");
  });
  it.each(["deny", "require_approval"] as const)("preserves explicit %s policy", (mode) => {
    expect(resolvePolicyDecision(rows({ workflowGrants, policies: [orgPolicy({ actionId: "gmail.send_email", mode })] }), baseInput({ appliesIn: "workflow" }), undefined).mode).toBe(mode);
  });
  it("preserves a personal deny", () => {
    expect(resolvePolicyDecision(rows({ workflowGrants, overrides: [override({ actionId: "gmail.send_email", mode: "deny" })] }), baseInput({ appliesIn: "workflow" }), undefined).mode).toBe("deny");
  });
});
