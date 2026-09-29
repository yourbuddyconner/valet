/**
 * `GET /api/workflows/:id/permissions` + `POST .../permissions/allow` route
 * tests. Definitions with tool nodes are inserted directly into the DB
 * (the save-time validator rejects services absent from the catalog, and
 * one test needs exactly such a node to assert the `unknown` mode).
 */
import { describe, it, expect, afterEach } from "vitest";
import { Type } from "typebox";
import type { PluginAction, ValetPlugin } from "@valet/engine";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { actionPolicies, actionPolicyOverrides, workflowActionGrants, workflowRuns, workflowDefinitions, workflowVersions } from "../schema/index.js";
import { createTeam } from "../services/teams.js";
import { resolveActionPolicy } from "../policies/service.js";
import { isRiskLevel } from "../policies/admin.js";
import type {
  AllowWorkflowPermissionsResponse,
  GetWorkflowPermissionsResponse,
} from "../wire/types.js";

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

function widgetAction(id: string, riskLevel: PluginAction["riskLevel"]): PluginAction {
  return {
    id,
    name: id,
    description: `fixture action ${id}`,
    riskLevel,
    parameters: Type.Object({}),
    execute: async () => ({ success: true, data: {} }),
  };
}

/** One service, two static actions: `deploy` (high risk → gates by risk
 * default) and `list` (low risk → allows by risk default). */
function widgetsPlugin(): ValetPlugin {
  return {
    name: "widgets",
    version: "0.0.1",
    actions: [
      {
        service: "widgets",
        actions: [widgetAction("deploy", "high"), widgetAction("list", "low"), widgetAction("purge", "critical")],
      },
    ],
  };
}

const DEFINITION = {
  version: "dag/v1",
  nodes: [
    { id: "trigger", type: "trigger" },
    { id: "ship", type: "tool", service: "widgets", action: "deploy", params: {} },
    { id: "inventory", type: "tool", service: "widgets", action: "list", params: {} },
    { id: "mystery", type: "tool", service: "unplugged", action: "thing", params: {} },
    // A foreach whose body is a gating tool action: the run gates on it
    // exactly like a top-level tool node, so the analysis must report it —
    // attributed to the foreach node's id, the card the editor draws.
    {
      id: "fanout",
      type: "foreach",
      items: "{{ trigger.data.items }}",
      body: { id: "fanout-body", type: "tool", service: "widgets", action: "purge", params: {} },
    },
    { id: "human", type: "approval", prompt: "ok to continue?" },
    { id: "stop", type: "stop" },
  ],
  edges: [
    { from: "trigger", to: "ship" },
    { from: "ship", to: "inventory" },
    { from: "inventory", to: "mystery" },
    { from: "mystery", to: "fanout" },
    { from: "fanout", to: "human" },
    { from: "human", to: "stop" },
  ],
};

async function insertWorkflow(
  localApi: TestApi,
  opts: { ownerId?: string; ownerType?: "user" | "team" } = {},
): Promise<string> {
  const now = Date.now();
  const id = `wf_perm_${now}_${Math.random().toString(36).slice(2, 8)}`;
  await localApi.providers.db.insert(workflowDefinitions).values({
    id,
    orgId: "local-org",
    name: "perm-test-wf",
    definition: DEFINITION,
    ownerType: opts.ownerType ?? "user",
    ownerId: opts.ownerId ?? "local-user",
    createdAt: now,
    updatedAt: now,
  });
  await localApi.providers.db.insert(workflowVersions).values({
    id: `wfv_${id}`,
    workflowId: id,
    version: 1,
    name: "perm-test-wf",
    definition: DEFINITION,
    createdAt: now,
  });
  return id;
}

function byNodeId(resp: GetWorkflowPermissionsResponse): Map<string, GetWorkflowPermissionsResponse["nodes"][number]> {
  return new Map(resp.nodes.map((n) => [n.nodeId, n]));
}

describe("GET /api/workflows/:id/permissions", () => {
  it("predicts per tool node; approval nodes are absent", async () => {
    api = await bootTestApi({ plugins: [widgetsPlugin()] });
    const wfId = await insertWorkflow(api);

    const res = await fetch(`${api.baseUrl}/api/workflows/${wfId}/permissions`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as GetWorkflowPermissionsResponse;
    const nodes = byNodeId(body);

    expect(body.nodes).toHaveLength(4);
    expect(nodes.get("ship")).toMatchObject({
      service: "widgets",
      action: "deploy",
      actionId: "widgets.deploy",
      riskLevel: "high",
      mode: "require_approval",
      provenance: "risk_default",
    });
    // The foreach body's tool action, attributed to the foreach node's id.
    expect(nodes.get("fanout")).toMatchObject({
      service: "widgets",
      action: "purge",
      actionId: "widgets.purge",
      riskLevel: "critical",
      mode: "require_approval",
      provenance: "risk_default",
    });
    expect(nodes.has("fanout-body")).toBe(false);
    expect(nodes.get("inventory")).toMatchObject({
      actionId: "widgets.list",
      riskLevel: "low",
      mode: "allow",
      provenance: "risk_default",
    });
    expect(nodes.get("mystery")).toMatchObject({
      service: "unplugged",
      action: "thing",
      actionId: null,
      mode: "unknown",
    });
    expect(nodes.has("human")).toBe(false);
  });

  it("an org deny surfaces as mode deny with org_policy provenance", async () => {
    api = await bootTestApi({ plugins: [widgetsPlugin()] });
    const wfId = await insertWorkflow(api);
    await api.providers.db.insert(actionPolicies).values({
      id: "pol_deny_deploy", orgId: "local-org", principalType: "org", principalId: "local-org",
      service: null, actionId: "widgets.deploy", riskLevel: null, mode: "deny",
      paramMatchers: [], appliesIn: "any", origin: "settings", managedBy: null,
      expiresAt: null, revokedAt: null, createdAt: 1, updatedAt: 1,
    });

    const res = await fetch(`${api.baseUrl}/api/workflows/${wfId}/permissions`);
    const body = (await res.json()) as GetWorkflowPermissionsResponse;
    expect(byNodeId(body).get("ship")).toMatchObject({ mode: "deny", provenance: "org_policy" });
  });

  it("another user's workflow → 404", async () => {
    api = await bootTestApi({ plugins: [widgetsPlugin()] });
    const wfId = await insertWorkflow(api, { ownerId: "someone-else" });
    const res = await fetch(`${api.baseUrl}/api/workflows/${wfId}/permissions`);
    expect(res.status).toBe(404);
  });
});

describe("team workflow permissions", () => {
  it("matches runtime team decisions and ignores personal overrides", async () => {
    api = await bootTestApi({ plugins: [widgetsPlugin()] });
    const team = await createTeam(api.providers.db, { orgId: "local-org", name: "Permissions team", creatorUserId: "local-user" });
    const wfId = await insertWorkflow(api, { ownerType: "team", ownerId: team.id });
    await api.providers.db.insert(actionPolicies).values([
      { id: "team-deny", orgId: "local-org", principalType: "team", principalId: team.id,
        actionId: "widgets.deploy", mode: "deny", paramMatchers: [], appliesIn: "workflow", origin: "admin", createdAt: 1, updatedAt: 1 },
      { id: "team-approval", orgId: "local-org", principalType: "team", principalId: team.id,
        actionId: "widgets.list", mode: "require_approval", paramMatchers: [], appliesIn: "workflow", origin: "admin", createdAt: 1, updatedAt: 1 },
    ]);
    await api.providers.db.insert(actionPolicyOverrides).values({
      id: "personal-allow", orgId: "local-org", userId: "local-user", service: "widgets",
      mode: "allow", paramMatchers: [], createdAt: 1, updatedAt: 1,
    });

    const response = await fetch(`${api.baseUrl}/api/workflows/${wfId}/permissions`);
    expect(response.status).toBe(200);
    const preview = (await response.json()) as GetWorkflowPermissionsResponse;
    const nodes = byNodeId(preview);
    expect(nodes.get("ship")).toMatchObject({ mode: "deny", provenance: "team_policy" });
    expect(nodes.get("inventory")).toMatchObject({ mode: "require_approval", provenance: "team_policy" });
    expect(nodes.get("fanout")).toMatchObject({ mode: "require_approval", provenance: "risk_default" });
    for (const node of preview.nodes) {
      if (!node.actionId) continue;
      if (!isRiskLevel(node.riskLevel)) throw new Error(`Invalid risk level for ${node.actionId}`);
      const runtime = await resolveActionPolicy(api.providers.db, {
        orgId: "local-org", teamId: team.id, userId: "local-user", service: node.service,
        actionId: node.actionId, riskLevel: node.riskLevel, params: {}, appliesIn: "workflow",
        workflowExecutionId: "team-preview-run", pluginDefault: undefined, now: Date.now(),
      });
      expect({ mode: node.mode, source: node.provenance }).toEqual({ mode: runtime.mode, source: runtime.provenance.source });
    }
    const personalId = await insertWorkflow(api);
    const personalResponse = await fetch(`${api.baseUrl}/api/workflows/${personalId}/permissions`);
    const personal = (await personalResponse.json()) as GetWorkflowPermissionsResponse;
    expect(byNodeId(personal).get("ship")).toMatchObject({ mode: "allow", provenance: "override" });
  });

  it("team admins grant only this workflow without changing personal overrides", async () => {
    api = await bootTestApi({ plugins: [widgetsPlugin()] });
    const team = await createTeam(api.providers.db, { orgId: "local-org", name: "Team", creatorUserId: "local-user" });
    const wfId = await insertWorkflow(api, { ownerType: "team", ownerId: team.id });
    const response = await fetch(`${api.baseUrl}/api/workflows/${wfId}/permissions/allow`, { method: "POST" });
    expect(response.status).toBe(200);
    expect(await api.providers.db.select().from(actionPolicyOverrides)).toHaveLength(0);
    expect(await api.providers.db.select().from(workflowActionGrants)).toHaveLength(2);
    const outsider = await fetch(`${api.baseUrl}/api/workflows/${wfId}/permissions/allow`, { method: "POST", headers: { "x-valet-test-user-id": "test-member" } });
    expect(outsider.status).toBe(404);
  });
});

describe("POST /api/workflows/:id/permissions/allow", () => {
  it("writes one workflow grant per gating action; the next preview allows", async () => {
    api = await bootTestApi({ plugins: [widgetsPlugin()] });
    const wfId = await insertWorkflow(api);

    const res = await fetch(`${api.baseUrl}/api/workflows/${wfId}/permissions/allow`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as AllowWorkflowPermissionsResponse;
    expect(body).toEqual({ allowed: ["widgets.deploy", "widgets.purge"], blocked: [] });

    const rows = await api.providers.db.select().from(workflowActionGrants);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.actionId).sort()).toEqual(["widgets.deploy", "widgets.purge"]);
    expect(rows.every((r) => r.ownerId === "local-user" && r.workflowId === wfId)).toBe(true);

    const preview = await fetch(`${api.baseUrl}/api/workflows/${wfId}/permissions`);
    const previewBody = (await preview.json()) as GetWorkflowPermissionsResponse;
    expect(byNodeId(previewBody).get("ship")).toMatchObject({ mode: "allow", provenance: "workflow_grant" });
    expect(byNodeId(previewBody).get("fanout")).toMatchObject({ mode: "allow", provenance: "workflow_grant" });
  });

  it("is idempotent — a second call updates the same workflow grant row", async () => {
    api = await bootTestApi({ plugins: [widgetsPlugin()] });
    const wfId = await insertWorkflow(api);

    const first = await fetch(`${api.baseUrl}/api/workflows/${wfId}/permissions/allow`, { method: "POST" });
    expect(first.status).toBe(200);
    // The gating set is empty on the second call (the overrides now allow
    // the actions), so the response allows nothing and writes nothing new.
    const second = await fetch(`${api.baseUrl}/api/workflows/${wfId}/permissions/allow`, { method: "POST" });
    expect(second.status).toBe(200);
    expect((await second.json()) as AllowWorkflowPermissionsResponse).toEqual({ allowed: [], blocked: [] });

    const rows = await api.providers.db.select().from(workflowActionGrants);
    expect(rows).toHaveLength(2);
  });

  it("an actionId outside the gating set → 400", async () => {
    api = await bootTestApi({ plugins: [widgetsPlugin()] });
    const wfId = await insertWorkflow(api);

    const res = await fetch(`${api.baseUrl}/api/workflows/${wfId}/permissions/allow`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actionIds: ["widgets.list"] }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("not a gating action") });
    const rows = await api.providers.db.select().from(workflowActionGrants);
    expect(rows).toHaveLength(0);
  });

  it("an org require_approval policy blocks the override (bounds check)", async () => {
    api = await bootTestApi({ plugins: [widgetsPlugin()] });
    const wfId = await insertWorkflow(api);
    await api.providers.db.insert(actionPolicies).values({
      id: "pol_gate_deploy", orgId: "local-org", principalType: "org", principalId: "local-org",
      service: null, actionId: "widgets.deploy", riskLevel: null, mode: "require_approval",
      paramMatchers: [], appliesIn: "any", origin: "settings", managedBy: null,
      expiresAt: null, revokedAt: null, createdAt: 1, updatedAt: 1,
    });

    const res = await fetch(`${api.baseUrl}/api/workflows/${wfId}/permissions/allow`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as AllowWorkflowPermissionsResponse;
    // The org policy pins widgets.deploy; widgets.purge stays self-serviceable.
    expect(body.allowed).toEqual(["widgets.purge"]);
    expect(body.blocked).toHaveLength(1);
    expect(body.blocked[0].actionId).toBe("widgets.deploy");
    const rows = await api.providers.db.select().from(workflowActionGrants);
    expect(rows).toHaveLength(1);
    expect(rows[0].actionId).toBe("widgets.purge");
  });

  it("a null body → 400, a bare-array body → 400, nothing written", async () => {
    api = await bootTestApi({ plugins: [widgetsPlugin()] });
    const wfId = await insertWorkflow(api);

    for (const raw of ["null", '["widgets.deploy"]']) {
      const res = await fetch(`${api.baseUrl}/api/workflows/${wfId}/permissions/allow`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: raw,
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: expect.stringContaining("JSON object") });
    }
    const rows = await api.providers.db.select().from(workflowActionGrants);
    expect(rows).toHaveLength(0);
  });

  it("unknown workflow → 404", async () => {
    api = await bootTestApi({ plugins: [widgetsPlugin()] });
    const res = await fetch(`${api.baseUrl}/api/workflows/wf_nope/permissions/allow`, { method: "POST" });
    expect(res.status).toBe(404);
  });
});


describe("workflow grant isolation", () => {
  it("applies across runs of one workflow, never other workflows or chats, and revokes", async () => {
    api = await bootTestApi({ plugins: [widgetsPlugin()] });
    const first = await insertWorkflow(api);
    const second = await insertWorkflow(api);
    expect((await fetch(`${api.baseUrl}/api/workflows/${first}/permissions/allow`, { method: "POST" })).status).toBe(200);
    for (const [runId, workflowId, expected] of [["run-a", first, "allow"], ["run-b", first, "allow"], ["run-c", second, "require_approval"]] as const) {
      await api.providers.db.insert(workflowRuns).values({ id: runId, workflowId, definitionVersionId: `wfv_${workflowId}`, definition: DEFINITION, params: {}, createdAt: 1, updatedAt: 1 });
      const result = await resolveActionPolicy(api.providers.db, { orgId: "local-org", userId: "local-user", service: "widgets", actionId: "widgets.deploy", riskLevel: "high", params: {}, appliesIn: "workflow", workflowExecutionId: runId, pluginDefault: undefined, now: Date.now() });
      expect(result.mode).toBe(expected);
    }
    const chat = await resolveActionPolicy(api.providers.db, { orgId: "local-org", userId: "local-user", service: "widgets", actionId: "widgets.deploy", riskLevel: "high", params: {}, appliesIn: "session", sessionId: "chat", pluginDefault: undefined, now: Date.now() });
    expect(chat.mode).toBe("require_approval");
    expect((await fetch(`${api.baseUrl}/api/workflows/${first}/permissions/allow`, { method: "DELETE" })).status).toBe(200);
    const preview = await fetch(`${api.baseUrl}/api/workflows/${first}/permissions`);
    expect(byNodeId(await preview.json()).get("ship")?.mode).toBe("require_approval");
  });
});
