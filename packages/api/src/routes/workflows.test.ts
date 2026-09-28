/**
 * `/api/workflows` route tests (Phase 5 plan Task 10, decision 18). Route
 * CRUD + validation-400 exercise the real store; run-start/approval/cancel
 * exercise a stub `RunHost` (see `../workflows/*` for the real
 * `LocalRunHost`/`SqliteWorkflowStore` wiring, covered by conformance suites
 * elsewhere) so these tests assert on the routes' own logic — request
 * shaping, owner scoping, signal writes — without paying for the poll loop.
 */
import type { RunHost, WorkflowDefinition } from "@valet/workflow";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveDefaultAssistant } from "../assistants/service.js";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { persistInvocationAudit } from "../policies/service.js";
import {
  actionInvocations,
  actionPolicies,
  assistants,
  orgs,
  runtimeGrants,
  workflowDefinitions,
  workflowRuns,
  workflowSchedules,
  workflowVersions,
} from "../schema/index.js";
import { setApprovedModels } from "../services/approved-models.js";
import { createLlmProvider } from "../services/llm-providers.js";
import { addMember, createTeam } from "../services/teams.js";
import type {
  CreateWorkflowResponse,
  CreateWorkflowScheduleResponse,
  DeleteWorkflowWebhookResponse,
  GetWorkflowRunResponse,
  ListWorkflowActionRequiredResponse,
  ListWorkflowRunsResponse,
  ListWorkflowSchedulesResponse,
  ListWorkflowsResponse,
  RetryWorkflowRunResponse,
  StartWorkflowRunResponse,
  WorkflowWebhookResponse,
} from "../wire/types.js";
import {
  cancelWorkflowRun, getWorkflowRunDetail,
  listWorkflowRuns, resolveWorkflowApproval
} from "../workflows/service.js";

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
  vi.unstubAllEnvs();
});

const VALID_DEFINITION = {
  version: "dag/v1",
  nodes: [
    { id: "trigger", type: "trigger" },
    { id: "stop", type: "stop" },
  ],
  edges: [{ from: "trigger", to: "stop" }],
};

const TEAM_ID_FILTER_ERROR =
  "teamId is not supported here. Filter by owner with ownerType=team and ownerId=<team id>.";

/** A `RunHost` stub that records every call instead of driving anything. */
class StubRunHost implements RunHost {
  started: Array<{ runId: string; params: unknown; owner?: { ownerType: string; ownerId: string } }> = [];
  woken: string[] = [];
  terminated: string[] = [];

  async start(
    runId: string,
    params: unknown,
    _definition: unknown,
    owner?: { ownerType: string; ownerId: string },
  ): Promise<void> {
    this.started.push({ runId, params, owner });
  }
  async wake(runId: string): Promise<void> {
    this.woken.push(runId);
  }
  async scheduleWake(): Promise<void> {}
  async terminate(runId: string): Promise<void> {
    this.terminated.push(runId);
  }
  startHost(): void {}
  async stopHost(): Promise<void> {}
}

async function createWorkflow(baseUrl: string, name = "test-workflow"): Promise<CreateWorkflowResponse> {
  const res = await fetch(`${baseUrl}/api/workflows`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, definition: VALID_DEFINITION }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as CreateWorkflowResponse;
}

describe("POST /api/workflows", () => {
  it("creates a definition and validates it", async () => {
    api = await bootTestApi();
    const created = await createWorkflow(api.baseUrl);
    expect(created.name).toBe("test-workflow");
    expect(created.definition).toEqual(VALID_DEFINITION);
    expect(created.id).toMatch(/^wf_/);
  });

  it("400s on an invalid definition with an errors array", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/workflows`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "bad", definition: { version: "dag/v1", nodes: [], edges: [] } }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; errors: string[] };
    expect(Array.isArray(body.errors)).toBe(true);
    expect(body.errors.length).toBeGreaterThan(0);
  });

  it("400s when definition is missing nodes/edges arrays", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/workflows`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "bad", definition: { version: "dag/v1" } }),
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/workflows + /:id", () => {
  it("lists only the caller's own definitions", async () => {
    api = await bootTestApi();
    await createWorkflow(api.baseUrl, "mine");
    await fetch(`${api.baseUrl}/api/workflows`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-valet-test-user-id": "test-member" },
      body: JSON.stringify({ name: "someone-elses", definition: VALID_DEFINITION }),
    });

    const res = await fetch(`${api.baseUrl}/api/workflows`);
    const { workflows } = (await res.json()) as ListWorkflowsResponse;
    expect(workflows.map((w) => w.name)).toEqual(["mine"]);
  });

  it("404s fetching another owner's definition by id", async () => {
    api = await bootTestApi();
    const created = await createWorkflow(api.baseUrl);

    const res = await fetch(`${api.baseUrl}/api/workflows/${created.id}`, {
      headers: { "x-valet-test-user-id": "test-member" },
    });
    expect(res.status).toBe(404);
  });
});

describe("GET /api/workflows?ownerType=&ownerId=", () => {
  const HALF_FILTER_ERROR = "Filter by owner with both ownerType and ownerId, or send neither.";

  /** A team-owned workflow, created the way a client creates one. */
  async function createTeamWorkflow(
    baseUrl: string,
    teamId: string,
    name: string,
  ): Promise<CreateWorkflowResponse> {
    const res = await fetch(`${baseUrl}/api/workflows`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, definition: VALID_DEFINITION, teamId }),
    });
    expect(res.status).toBe(201);
    return (await res.json()) as CreateWorkflowResponse;
  }

  it("returns the own-plus-teams union unchanged when neither param is given", async () => {
    api = await bootTestApi();
    const team = await createTeam(api.providers.db, { orgId: "local-org", name: "Platform", creatorUserId: "local-user" });
    await createWorkflow(api.baseUrl, "personal");
    await createTeamWorkflow(api.baseUrl, team.id, "team-owned");
    await fetch(`${api.baseUrl}/api/workflows`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-valet-test-user-id": "test-member" },
      body: JSON.stringify({ name: "someone-elses", definition: VALID_DEFINITION }),
    });

    const res = await fetch(`${api.baseUrl}/api/workflows`);
    expect(res.status).toBe(200);
    const { workflows } = (await res.json()) as ListWorkflowsResponse;
    expect(workflows.map((w) => w.name).sort()).toEqual(["personal", "team-owned"]);
  });

  it("narrows to one team the caller is on", async () => {
    api = await bootTestApi();
    const platform = await createTeam(api.providers.db, { orgId: "local-org", name: "Platform", creatorUserId: "local-user" });
    const growth = await createTeam(api.providers.db, { orgId: "local-org", name: "Growth", creatorUserId: "local-user" });
    await createWorkflow(api.baseUrl, "personal");
    await createTeamWorkflow(api.baseUrl, platform.id, "platform-wf");
    await createTeamWorkflow(api.baseUrl, growth.id, "growth-wf");

    const res = await fetch(`${api.baseUrl}/api/workflows?ownerType=team&ownerId=${platform.id}`);
    expect(res.status).toBe(200);
    const { workflows } = (await res.json()) as ListWorkflowsResponse;
    expect(workflows.map((w) => w.name)).toEqual(["platform-wf"]);
    expect(workflows.map((w) => w.ownerId)).toEqual([platform.id]);
  });

  it("narrows to the caller's own rows, dropping the teams", async () => {
    api = await bootTestApi();
    const team = await createTeam(api.providers.db, { orgId: "local-org", name: "Platform", creatorUserId: "local-user" });
    await createWorkflow(api.baseUrl, "personal");
    await createTeamWorkflow(api.baseUrl, team.id, "team-owned");

    const res = await fetch(`${api.baseUrl}/api/workflows?ownerType=user&ownerId=local-user`);
    expect(res.status).toBe(200);
    const { workflows } = (await res.json()) as ListWorkflowsResponse;
    expect(workflows.map((w) => w.name)).toEqual(["personal"]);
  });

  it("404s a team the caller is not on, and the error names neither the team nor its id", async () => {
    api = await bootTestApi();
    const team = await createTeam(api.providers.db, { orgId: "local-org", name: "Platform", creatorUserId: "local-user" });
    await createTeamWorkflow(api.baseUrl, team.id, "team-owned");

    const res = await fetch(`${api.baseUrl}/api/workflows?ownerType=team&ownerId=${team.id}`, {
      headers: { "x-valet-test-user-id": "test-member" },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("owner not found");
    expect(body.error).not.toContain(team.id);
    expect(body.error).not.toContain("Platform");
  });

  it("answers an owner that does not exist exactly as it answers one the caller may not reach", async () => {
    api = await bootTestApi();
    const team = await createTeam(api.providers.db, { orgId: "local-org", name: "Platform", creatorUserId: "local-user" });
    const asOutsider = { "x-valet-test-user-id": "test-member" };

    const forbidden = await fetch(`${api.baseUrl}/api/workflows?ownerType=team&ownerId=${team.id}`, {
      headers: asOutsider,
    });
    const missing = await fetch(`${api.baseUrl}/api/workflows?ownerType=team&ownerId=team_nonexistent`, {
      headers: asOutsider,
    });

    expect(forbidden.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual(await forbidden.json());
  });

  it("404s another user's rows, org admin included", async () => {
    api = await bootTestApi();
    await fetch(`${api.baseUrl}/api/workflows`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-valet-test-user-id": "test-member" },
      body: JSON.stringify({ name: "someone-elses", definition: VALID_DEFINITION }),
    });

    // `local-user` administers the org. Org administration is not a read
    // path into a member's personal workflows.
    const res = await fetch(`${api.baseUrl}/api/workflows?ownerType=user&ownerId=test-member`);
    expect(res.status).toBe(404);
  });

  // An org content source publishes to the whole org, so an org member reads
  // its mirrored workflows. Another org still reads as missing rather than as
  // forbidden, the same convention every owner-scoped route here follows.
  it("lists an org filter for the caller's own org, and 404s another org's", async () => {
    api = await bootTestApi();
    const now = Date.now();
    await api.providers.db.insert(workflowDefinitions).values({
      id: "wf_org_mirror",
      orgId: "local-org",
      ownerType: "org",
      ownerId: "local-org",
      name: "Org nightly",
      definition: VALID_DEFINITION,
      origin: "repo",
      createdAt: now,
      updatedAt: now,
    });

    const mine = await fetch(`${api.baseUrl}/api/workflows?ownerType=org&ownerId=local-org`);
    expect(mine.status).toBe(200);
    const body = (await mine.json()) as { workflows: Array<{ id: string }> };
    expect(body.workflows.map((w) => w.id)).toContain("wf_org_mirror");

    const other = await fetch(`${api.baseUrl}/api/workflows?ownerType=org&ownerId=some-other-org`);
    expect(other.status).toBe(404);
  });

  it("400s a half-given filter, naming the fix", async () => {
    api = await bootTestApi();
    const team = await createTeam(api.providers.db, { orgId: "local-org", name: "Platform", creatorUserId: "local-user" });

    const typeOnly = await fetch(`${api.baseUrl}/api/workflows?ownerType=team`);
    expect(typeOnly.status).toBe(400);
    expect(((await typeOnly.json()) as { error: string }).error).toBe(HALF_FILTER_ERROR);

    const idOnly = await fetch(`${api.baseUrl}/api/workflows?ownerId=${team.id}`);
    expect(idOnly.status).toBe(400);
    expect(((await idOnly.json()) as { error: string }).error).toBe(HALF_FILTER_ERROR);
  });

  it("400s an ownerType outside the three an owner column holds", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/workflows?ownerType=squad&ownerId=whatever`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("ownerType must be 'user', 'team' or 'org'.");
  });

  // `teamId` scopes the sibling listings (`/api/templates`,
  // `/api/credentials`), so a client reaches for it here too. This route used
  // to accept it and filter on nothing, which read as the whole union
  // presented as one team's workflows.
  it("400s a teamId filter instead of returning an unfiltered list", async () => {
    api = await bootTestApi();
    const team = await createTeam(api.providers.db, { orgId: "local-org", name: "Platform", creatorUserId: "local-user" });
    await createWorkflow(api.baseUrl, "personal");
    await createTeamWorkflow(api.baseUrl, team.id, "team-owned");

    const res = await fetch(`${api.baseUrl}/api/workflows?teamId=${team.id}`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; workflows?: unknown };
    expect(body.error).toBe(TEAM_ID_FILTER_ERROR);
    expect(body.workflows).toBeUndefined();
  });

  it("400s teamId beside a valid owner pair rather than choosing one of them", async () => {
    api = await bootTestApi();
    const team = await createTeam(api.providers.db, { orgId: "local-org", name: "Platform", creatorUserId: "local-user" });
    await createWorkflow(api.baseUrl, "personal");
    await createTeamWorkflow(api.baseUrl, team.id, "team-owned");

    const res = await fetch(
      `${api.baseUrl}/api/workflows?ownerType=user&ownerId=local-user&teamId=${team.id}`,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(TEAM_ID_FILTER_ERROR);
  });

  it("reads an empty teamId as unset, so a client that always sends the field still lists", async () => {
    api = await bootTestApi();
    await createWorkflow(api.baseUrl, "personal");

    const res = await fetch(`${api.baseUrl}/api/workflows?teamId=`);
    expect(res.status).toBe(200);
    const { workflows } = (await res.json()) as ListWorkflowsResponse;
    expect(workflows.map((w) => w.name)).toEqual(["personal"]);
  });
});

describe("team-owned workflows", () => {
  it("creates a team-owned workflow when the caller is a member", async () => {
    api = await bootTestApi();
    const team = await createTeam(api.providers.db, { orgId: "local-org", name: "Platform", creatorUserId: "local-user" });

    const res = await fetch(`${api.baseUrl}/api/workflows`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "team-wf", definition: VALID_DEFINITION, teamId: team.id }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as CreateWorkflowResponse;
    expect(body.ownerType).toBe("team");
    expect(body.ownerId).toBe(team.id);
  });

  it("404s creating a workflow under a team the caller isn't a member of", async () => {
    api = await bootTestApi();
    const team = await createTeam(api.providers.db, { orgId: "local-org", name: "Platform", creatorUserId: "test-member" });

    const res = await fetch(`${api.baseUrl}/api/workflows`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "team-wf", definition: VALID_DEFINITION, teamId: team.id }),
    });
    expect(res.status).toBe(404);
  });

  it("404s creating a workflow under an unknown teamId", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/workflows`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "team-wf", definition: VALID_DEFINITION, teamId: "team_nonexistent" }),
    });
    expect(res.status).toBe(404);
  });

  it("lists a team-owned workflow to every team member, not just its creator", async () => {
    api = await bootTestApi();
    const team = await createTeam(api.providers.db, { orgId: "local-org", name: "Platform", creatorUserId: "local-user" });
    await addMember(api.providers.db, { teamId: team.id, userId: "test-member", role: "member" });
    await fetch(`${api.baseUrl}/api/workflows`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "team-wf", definition: VALID_DEFINITION, teamId: team.id }),
    });

    const res = await fetch(`${api.baseUrl}/api/workflows`, {
      headers: { "x-valet-test-user-id": "test-member" },
    });
    const { workflows } = (await res.json()) as ListWorkflowsResponse;
    expect(workflows.map((w) => w.name)).toEqual(["team-wf"]);
  });

  it("404s listing/fetching a team-owned workflow for a non-member in the SAME org", async () => {
    api = await bootTestApi();
    const team = await createTeam(api.providers.db, { orgId: "local-org", name: "Platform", creatorUserId: "local-user" });
    const created = await fetch(`${api.baseUrl}/api/workflows`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "team-wf", definition: VALID_DEFINITION, teamId: team.id }),
    }).then((r) => r.json() as Promise<CreateWorkflowResponse>);

    const listRes = await fetch(`${api.baseUrl}/api/workflows`, {
      headers: { "x-valet-test-user-id": "test-member" },
    });
    const { workflows } = (await listRes.json()) as ListWorkflowsResponse;
    expect(workflows).toEqual([]);

    const getRes = await fetch(`${api.baseUrl}/api/workflows/${created.id}`, {
      headers: { "x-valet-test-user-id": "test-member" },
    });
    expect(getRes.status).toBe(404);
  });

  it("404s for a member who has since left the team — membership is re-checked live, not cached", async () => {
    const { removeMember } = await import("../services/teams.js");
    api = await bootTestApi();
    const team = await createTeam(api.providers.db, { orgId: "local-org", name: "Platform", creatorUserId: "local-user" });
    await addMember(api.providers.db, { teamId: team.id, userId: "test-member", role: "member" });
    const created = await fetch(`${api.baseUrl}/api/workflows`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "team-wf", definition: VALID_DEFINITION, teamId: team.id }),
    }).then((r) => r.json() as Promise<CreateWorkflowResponse>);

    await removeMember(api.providers.db, { teamId: team.id, userId: "test-member" });

    const res = await fetch(`${api.baseUrl}/api/workflows/${created.id}`, {
      headers: { "x-valet-test-user-id": "test-member" },
    });
    expect(res.status).toBe(404);
  });

  it("creating a workflow with teamId: null falls through to a personal workflow instead of 404ing", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/workflows`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "personal-wf", definition: VALID_DEFINITION, teamId: null }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as CreateWorkflowResponse;
    expect(body.ownerType).toBe("user");
    expect(body.ownerId).toBe("local-user");
  });

  it("deleting a team reaps an idle team-owned workflow with it", async () => {
    api = await bootTestApi();
    const team = await createTeam(api.providers.db, { orgId: "local-org", name: "Platform", creatorUserId: "local-user" });
    const created = await fetch(`${api.baseUrl}/api/workflows`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "team-wf", definition: VALID_DEFINITION, teamId: team.id }),
    });
    const { id: workflowId } = (await created.json()) as CreateWorkflowResponse;

    // The reap runs inside the delete transaction and reads `workflow_runs`
    // through it. Reading through the process-wide store instead waits on
    // that transaction forever on PGlite, so this request must return.
    const res = await fetch(`${api.baseUrl}/api/teams/${team.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    const left = await api.providers.db
      .select()
      .from(workflowDefinitions)
      .where(eq(workflowDefinitions.id, workflowId));
    expect(left).toHaveLength(0);
  });

  it("409s deleting a team whose workflow has an unsettled run", async () => {
    api = await bootTestApi();
    const team = await createTeam(api.providers.db, { orgId: "local-org", name: "Platform", creatorUserId: "local-user" });
    const created = await fetch(`${api.baseUrl}/api/workflows`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "team-wf", definition: VALID_DEFINITION, teamId: team.id }),
    });
    const { id: workflowId } = (await created.json()) as CreateWorkflowResponse;
    await api.providers.db.insert(workflowRuns).values({
      id: "run_team_live",
      workflowId,
      definitionVersionId: "v1",
      definition: VALID_DEFINITION,
      params: {},
      status: "running",
      ownerType: "team",
      ownerId: team.id,
      createdAt: 1_000,
      updatedAt: 1_000,
    });

    const res = await fetch(`${api.baseUrl}/api/teams/${team.id}`, { method: "DELETE" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; code?: string };
    expect(body.code).toBe("team_has_active_runs");
    const left = await api.providers.db
      .select()
      .from(workflowDefinitions)
      .where(eq(workflowDefinitions.id, workflowId));
    expect(left).toHaveLength(1);
  });
});

describe("PUT /api/workflows/:id", () => {
  it("updates name and definition", async () => {
    api = await bootTestApi();
    const created = await createWorkflow(api.baseUrl);

    const res = await fetch(`${api.baseUrl}/api/workflows/${created.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "renamed" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as CreateWorkflowResponse;
    expect(body.name).toBe("renamed");
    expect(body.definition).toEqual(VALID_DEFINITION);
  });

  it("400s replacing with an invalid definition", async () => {
    api = await bootTestApi();
    const created = await createWorkflow(api.baseUrl);

    const res = await fetch(`${api.baseUrl}/api/workflows/${created.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ definition: { version: "dag/v1", nodes: [], edges: [] } }),
    });
    expect(res.status).toBe(400);
  });
});

describe("PATCH /api/workflows/:id/model", () => {
  const MODEL_DEFINITION = {
    version: "dag/v1",
    nodes: [
      { id: "trigger", type: "trigger" },
      { id: "draft", type: "llm", model: "s", prompt: "Draft" },
      { id: "review", type: "session", mode: "start", model: "m", prompt: "Review" },
      { id: "stop", type: "stop" },
    ],
    edges: [
      { from: "trigger", to: "draft" },
      { from: "draft", to: "review" },
      { from: "review", to: "stop" },
    ],
  };

  /** Callers stub a provider key first: a size tier only validates while one
   * of its targets holds a key (`resolvableTiers`). */
  async function createModelWorkflow(baseUrl: string): Promise<CreateWorkflowResponse> {
    const res = await fetch(`${baseUrl}/api/workflows`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "model-workflow", definition: MODEL_DEFINITION }),
    });
    expect(res.status).toBe(201);
    return (await res.json()) as CreateWorkflowResponse;
  }

  it("updates selected model-capable nodes and persists the tier", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-anthropic-key");
    api = await bootTestApi();
    const created = await createModelWorkflow(api.baseUrl);
    const res = await fetch(`${api.baseUrl}/api/workflows/${created.id}/model`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "l", nodeIds: ["draft"] }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ workflowId: created.id, model: "l", nodeIds: ["draft"] });

    const saved = await fetch(`${api.baseUrl}/api/workflows/${created.id}`).then(
      (response) => response.json() as Promise<CreateWorkflowResponse>,
    );
    const definition = saved.definition as WorkflowDefinition;
    const models = definition.nodes
      .filter((node) => node.type === "llm" || node.type === "session")
      .map((node) => [node.id, node.model]);
    expect(models).toEqual([["draft", "l"], ["review", "m"]]);
  });

  it("round-trips an active custom catalog model through creation, editing, and focused updates", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-anthropic-key");
    api = await bootTestApi();
    const provider = await createLlmProvider(api.providers.db, {
      orgId: "local-org", kind: "openai_compatible", name: "Custom",
      baseUrl: "https://models.example.test/v1", models: [{ id: "writer", name: "Writer" }],
    });
    await api.providers.engineCredentials.save({ type: "org", id: "local-org" }, `llm:${provider.id}`, {
      type: "api_key", apiKey: "test-custom-key",
    });
    const model = `${provider.id}/writer`;
    const definition = {
      ...MODEL_DEFINITION,
      nodes: MODEL_DEFINITION.nodes.map((node) => node.type === "llm" ? { ...node, model } : node),
    };
    const create = await fetch(`${api.baseUrl}/api/workflows`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "custom-model", definition }),
    });
    expect(create.status).toBe(201);
    const created = await create.json() as CreateWorkflowResponse;
    const edit = await fetch(`${api.baseUrl}/api/workflows/${created.id}`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ definition }),
    });
    expect(edit.status).toBe(200);
    const patch = await fetch(`${api.baseUrl}/api/workflows/${created.id}/model`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model }),
    });
    expect(patch.status).toBe(200);
    const saved = await fetch(`${api.baseUrl}/api/workflows/${created.id}`).then(
      (response) => response.json() as Promise<CreateWorkflowResponse>,
    );
    expect(saved.definition).toMatchObject({ nodes: [
      { id: "trigger" }, { id: "draft", model }, { id: "review", model }, { id: "stop" },
    ] });
  });

  it("rejects a concrete model that the org did not approve", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-anthropic-key");
    api = await bootTestApi();
    const created = await createModelWorkflow(api.baseUrl);
    await setApprovedModels(api.providers.db, "local-org", []);
    const res = await fetch(`${api.baseUrl}/api/workflows/${created.id}/model`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "anthropic/claude-haiku-4-5" }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("not approved") });
  });

  it("rejects unknown models and non-model-capable node ids without changing the workflow", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-anthropic-key");
    api = await bootTestApi();
    const created = await createModelWorkflow(api.baseUrl);
    for (const body of [
      { model: "not-a-model" },
      { model: "l", nodeIds: ["stop"] },
    ]) {
      const res = await fetch(`${api.baseUrl}/api/workflows/${created.id}/model`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
    }
    const saved = await fetch(`${api.baseUrl}/api/workflows/${created.id}`).then(
      (response) => response.json() as Promise<CreateWorkflowResponse>,
    );
    expect(saved.definition).toEqual(MODEL_DEFINITION);
  });
});

describe("model validation on full workflow saves", () => {
  function definitionWith(model: string): unknown {
    return {
      version: "dag/v1",
      nodes: [
        { id: "trigger", type: "trigger" },
        { id: "draft", type: "llm", model, prompt: "Draft" },
        { id: "stop", type: "stop" },
      ],
      edges: [
        { from: "trigger", to: "draft" },
        { from: "draft", to: "stop" },
      ],
    };
  }

  async function save(baseUrl: string, model: string): Promise<Response> {
    return fetch(`${baseUrl}/api/workflows`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: `save-${model}`, definition: definitionWith(model) }),
    });
  }

  it("saves a model the org approved and activated", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-anthropic-key");
    api = await bootTestApi();
    expect((await save(api.baseUrl, "anthropic/claude-haiku-4-5")).status).toBe(201);
  });

  it("rejects a model the org did not approve, as the model-only path does", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-anthropic-key");
    api = await bootTestApi();
    await setApprovedModels(api.providers.db, "local-org", ["anthropic/claude-opus-4-7"]);
    const res = await save(api.baseUrl, "anthropic/claude-haiku-4-5");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { errors: string[] };
    expect(body.errors.join(" ")).toContain("Settings > Models");
  });

  it("rejects a model whose provider the org disabled", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-anthropic-key");
    api = await bootTestApi();
    await createLlmProvider(api.providers.db, {
      orgId: "local-org",
      kind: "anthropic",
      name: "Anthropic",
      enabled: false,
    });
    expect((await save(api.baseUrl, "anthropic/claude-haiku-4-5")).status).toBe(400);
  });

  it("keeps a bare OpenAI id saveable while OpenAI is active", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-openai-key");
    api = await bootTestApi();
    expect((await save(api.baseUrl, "gpt-6-astra")).status).toBe(201);
  });
});

describe("POST /api/workflows/:id/runs", () => {
  it("starts a run against the stub host with an owner + definition snapshot", async () => {
    const stub = new StubRunHost();
    api = await bootTestApi({ workflowRunHost: stub });
    const created = await createWorkflow(api.baseUrl);

    const res = await fetch(`${api.baseUrl}/api/workflows/${created.id}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: { foo: "bar" } }),
    });
    expect(res.status).toBe(201);
    const { runId } = (await res.json()) as StartWorkflowRunResponse;
    expect(runId).toMatch(/^wfrun_/);

    expect(stub.started).toHaveLength(1);
    expect(stub.started[0].runId).toBe(runId);
    expect(stub.started[0].owner).toEqual({ ownerType: "user", ownerId: "local-user", actorUserId: "local-user" });
  });

  it("404s starting a run against another owner's workflow", async () => {
    const stub = new StubRunHost();
    api = await bootTestApi({ workflowRunHost: stub });
    const created = await createWorkflow(api.baseUrl);

    const res = await fetch(`${api.baseUrl}/api/workflows/${created.id}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-valet-test-user-id": "test-member" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
    expect(stub.started).toHaveLength(0);
  });

  const SCHEMA_DEFINITION = {
    version: "dag/v1",
    nodes: [
      {
        id: "trigger",
        type: "trigger",
        dataSchema: {
          name: { type: "string", required: true },
          retries: { type: "number", default: 3 },
        },
      },
      { id: "stop", type: "stop" },
    ],
    edges: [{ from: "trigger", to: "stop" }],
  };

  async function createSchemaWorkflow(baseUrl: string): Promise<CreateWorkflowResponse> {
    const res = await fetch(`${baseUrl}/api/workflows`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "schema-workflow", definition: SCHEMA_DEFINITION }),
    });
    expect(res.status).toBe(201);
    return (await res.json()) as CreateWorkflowResponse;
  }

  it("merges trigger dataSchema defaults into the run's trigger data", async () => {
    const stub = new StubRunHost();
    api = await bootTestApi({ workflowRunHost: stub });
    const created = await createSchemaWorkflow(api.baseUrl);

    const res = await fetch(`${api.baseUrl}/api/workflows/${created.id}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: { name: "deploy" } }),
    });
    expect(res.status).toBe(201);

    expect(stub.started).toHaveLength(1);
    const params = stub.started[0].params as { input: { data: Record<string, unknown> } };
    expect(params.input.data).toEqual({ name: "deploy", retries: 3 });
  });

  it("400s a run missing a required trigger input, naming the field", async () => {
    const stub = new StubRunHost();
    api = await bootTestApi({ workflowRunHost: stub });
    const created = await createSchemaWorkflow(api.baseUrl);

    const res = await fetch(`${api.baseUrl}/api/workflows/${created.id}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: {} }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; fields: Array<{ field: string; message: string }> };
    expect(body.fields.map((f) => f.field)).toEqual(["name"]);
    expect(body.error).toContain("name");
    expect(stub.started).toHaveLength(0);
  });

  it("400s a type mismatch against the trigger dataSchema", async () => {
    const stub = new StubRunHost();
    api = await bootTestApi({ workflowRunHost: stub });
    const created = await createSchemaWorkflow(api.baseUrl);

    const res = await fetch(`${api.baseUrl}/api/workflows/${created.id}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: { name: "deploy", retries: "three" } }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { fields: Array<{ field: string }> };
    expect(body.fields.map((f) => f.field)).toEqual(["retries"]);
    expect(stub.started).toHaveLength(0);
  });
});

describe("GET /api/workflows/runs/:runId + approvals + cancel", () => {
  it("reads back a run started through the real workflow store, drives approve + cancel via the stub host", async () => {
    const stub = new StubRunHost();
    api = await bootTestApi({ workflowRunHost: stub });
    const created = await createWorkflow(api.baseUrl);

    const startRes = await fetch(`${api.baseUrl}/api/workflows/${created.id}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const { runId } = (await startRes.json()) as StartWorkflowRunResponse;

    // The stub records `start()` but never actually calls `store.createRun` —
    // Task 10's route handler is responsible for that via the real host in
    // production; here we assert the route asked the host to start, and
    // separately exercise approval/cancel against a run the route itself
    // creates through the store when the host is real. Since this test
    // targets route logic, seed the run directly through the store the
    // route reads from.
    await api.providers.workflowStore.createRun(
      runId,
      { workflowId: created.id, definitionVersionId: "v1" },
      created.definition,
      "v1",
      { ownerType: "user", ownerId: "local-user" },
    );

    const getRes = await fetch(`${api.baseUrl}/api/workflows/runs/${runId}`);
    expect(getRes.status).toBe(200);
    const detail = (await getRes.json()) as GetWorkflowRunResponse;
    expect(detail.run.runId).toBe(runId);
    expect(detail.run.workflowId).toBe(created.id);
    expect(detail.checkpoints).toEqual([]);

    // Park the run on the approval signal before resolving — the new route
    // validates the run is actually waiting on this gate.
    await api.providers.workflowStore.parkRun(
      runId,
      1,
      [{ kind: "signal", signalType: "approval:some-node", nodeId: "some-node" }],
    );

    const approveRes = await fetch(`${api.baseUrl}/api/workflows/runs/${runId}/approvals/some-node`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approved: true, note: "looks good" }),
    });
    expect(approveRes.status).toBe(200);
    expect(await approveRes.json()).toEqual({ ok: true });
    expect(stub.woken).toContain(runId);

    const signals = await api.providers.workflowStore.listSignals(runId);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      signalId: "approval:some-node:resolution",
      signalType: "approval:some-node",
      payload: { approved: true, resolvedBy: "local-user", note: "looks good", resolvedVia: "web" },
    });

    const cancelRes = await fetch(`${api.baseUrl}/api/workflows/runs/${runId}/cancel`, { method: "POST" });
    expect(cancelRes.status).toBe(200);
    expect(await cancelRes.json()).toEqual({ ok: true });
    expect(stub.terminated).toContain(runId);
  });

  it("404s reading another owner's run", async () => {
    const stub = new StubRunHost();
    api = await bootTestApi({ workflowRunHost: stub });
    const created = await createWorkflow(api.baseUrl);
    const runId = "wfrun_cross_owner";
    await api.providers.workflowStore.createRun(
      runId,
      { workflowId: created.id, definitionVersionId: "v1" },
      created.definition,
      "v1",
      { ownerType: "user", ownerId: "test-member" },
    );

    const res = await fetch(`${api.baseUrl}/api/workflows/runs/${runId}`);
    expect(res.status).toBe(404);
  });

  it("retries a settled failed run with the original input; 409s while non-settled and after completion", async () => {
    const stub = new StubRunHost();
    api = await bootTestApi({ workflowRunHost: stub });
    const created = await createWorkflow(api.baseUrl);
    const assistant = await resolveDefaultAssistant(
      api.providers.db,
      "local-org",
      { type: "user", id: "local-user" },
    );
    const session = await api.providers.engineHost.assistantSessionFor(
      assistant.id,
      { actorUserId: "local-user", orgId: "local-org" },
      { sessionId: assistant.sessionId },
    );
    const thread = await session.createThread("web:retry-origin");
    const origin = { assistantSessionId: assistant.sessionId, threadId: thread.id };

    const runId = "wfrun_retry_me";
    await api.providers.workflowStore.createRun(
      runId,
      {
        workflowId: created.id,
        definitionVersionId: "v1",
        input: {
          type: "manual",
          timestamp: "2026-08-14T00:00:00.000Z",
          data: { foo: "bar" },
          metadata: {},
        },
        origin,
      },
      created.definition,
      "v1",
      { ownerType: "user", ownerId: "local-user" },
    );

    // Not settled yet → 409.
    const early = await fetch(`${api.baseUrl}/api/workflows/runs/${runId}/retry`, { method: "POST" });
    expect(early.status).toBe(409);

    await api.providers.workflowStore.settleRun(runId, "failed");

    const res = await fetch(`${api.baseUrl}/api/workflows/runs/${runId}/retry`, { method: "POST" });
    expect(res.status).toBe(201);
    const { runId: newRunId } = (await res.json()) as RetryWorkflowRunResponse;
    expect(newRunId).not.toBe(runId);

    const startedRetry = stub.started.find((s) => s.runId === newRunId);
    expect(startedRetry).toBeDefined();
    // The retry's trigger payload must carry the original run's input data.
    const params = startedRetry?.params as { input?: { data?: unknown } };
    expect(params.input?.data).toEqual({ foo: "bar" });
    expect((startedRetry?.params as { origin?: unknown }).origin).toEqual(origin);

    const staleRunId = "wfrun_retry_stale_origin";
    await api.providers.workflowStore.createRun(
      staleRunId,
      { workflowId: created.id, definitionVersionId: "v1", input: { type: "manual", data: {} }, origin },
      created.definition,
      "v1",
      { ownerType: "user", ownerId: "local-user" },
    );
    await api.providers.workflowStore.settleRun(staleRunId, "failed");
    await api.providers.db.update(assistants).set({ archivedAt: Date.now() }).where(eq(assistants.id, assistant.id));
    const staleRetry = await fetch(`${api.baseUrl}/api/workflows/runs/${staleRunId}/retry`, { method: "POST" });
    expect(staleRetry.status).toBe(201);
    const { runId: staleRetryId } = await staleRetry.json() as RetryWorkflowRunResponse;
    expect(stub.started.find((item) => item.runId === staleRetryId)?.params).not.toHaveProperty("origin");

    // A completed run is not retryable.
    const completedId = "wfrun_completed";
    await api.providers.workflowStore.createRun(
      completedId,
      { workflowId: created.id, definitionVersionId: "v1" },
      created.definition,
      "v1",
      { ownerType: "user", ownerId: "local-user" },
    );
    await api.providers.workflowStore.settleRun(completedId, "completed");
    const completedRes = await fetch(`${api.baseUrl}/api/workflows/runs/${completedId}/retry`, { method: "POST" });
    expect(completedRes.status).toBe(409);
  });

  it("400s a retry when the current trigger schema no longer accepts the original input", async () => {
    const stub = new StubRunHost();
    api = await bootTestApi({ workflowRunHost: stub });
    const created = await createWorkflow(api.baseUrl);

    const runId = "wfrun_schema_drift";
    await api.providers.workflowStore.createRun(
      runId,
      { workflowId: created.id, definitionVersionId: "v1" },
      created.definition,
      "v1",
      { ownerType: "user", ownerId: "local-user" },
    );
    await api.providers.workflowStore.settleRun(runId, "failed");

    // The definition gains a required input AFTER the original run — the
    // retry validates against the CURRENT definition, so it must 400.
    const updateRes = await fetch(`${api.baseUrl}/api/workflows/${created.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        definition: {
          ...VALID_DEFINITION,
          nodes: [
            { id: "trigger", type: "trigger", dataSchema: { name: { type: "string", required: true } } },
            { id: "stop", type: "stop" },
          ],
        },
      }),
    });
    expect(updateRes.status).toBe(200);

    const res = await fetch(`${api.baseUrl}/api/workflows/runs/${runId}/retry`, { method: "POST" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; fields: Array<{ field: string }> };
    expect(body.fields[0]?.field).toBe("name");
    expect(stub.started.find((s) => s.runId !== runId)).toBeUndefined();
  });

  it("404s retrying another owner's settled run", async () => {
    const stub = new StubRunHost();
    api = await bootTestApi({ workflowRunHost: stub });
    const created = await createWorkflow(api.baseUrl);
    const runId = "wfrun_cross_owner_retry";
    await api.providers.workflowStore.createRun(
      runId,
      { workflowId: created.id, definitionVersionId: "v1" },
      created.definition,
      "v1",
      { ownerType: "user", ownerId: "test-member" },
    );
    await api.providers.workflowStore.settleRun(runId, "failed");

    const res = await fetch(`${api.baseUrl}/api/workflows/runs/${runId}/retry`, { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("a team member manages a run started against a team-owned workflow (get/approve/cancel), matching a schedule/trigger fire's owner shape", async () => {
    const stub = new StubRunHost();
    api = await bootTestApi({ workflowRunHost: stub });
    const team = await createTeam(api.providers.db, { orgId: "local-org", name: "Platform", creatorUserId: "local-user" });
    await addMember(api.providers.db, { teamId: team.id, userId: "test-member", role: "member" });
    const created = await fetch(`${api.baseUrl}/api/workflows`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "team-wf", definition: VALID_DEFINITION, teamId: team.id }),
    }).then((r) => r.json() as Promise<CreateWorkflowResponse>);

    const runId = "wfrun_team_owned";
    // Mirrors what scheduler.ts / events/dispatcher.ts pass to
    // workflowRunHost.start: the fired run's owner is the WORKFLOW's own
    // owner, copied verbatim — not the schedule/trigger creator.
    await api.providers.workflowStore.createRun(
      runId,
      { workflowId: created.id, definitionVersionId: "v1" },
      VALID_DEFINITION,
      "v1",
      { ownerType: "team", ownerId: team.id },
    );

    const memberHeaders = { "x-valet-test-user-id": "test-member" };
    const getRes = await fetch(`${api.baseUrl}/api/workflows/runs/${runId}`, { headers: memberHeaders });
    expect(getRes.status).toBe(200);

    // Park the run on the approval signal first (required by the new route).
    await api.providers.workflowStore.parkRun(
      runId,
      1,
      [{ kind: "signal", signalType: "approval:some-node", nodeId: "some-node" }],
    );

    const approveRes = await fetch(`${api.baseUrl}/api/workflows/runs/${runId}/approvals/some-node`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...memberHeaders },
      body: JSON.stringify({ approved: true }),
    });
    expect(approveRes.status).toBe(200);
    expect(stub.woken).toContain(runId);

    const cancelRes = await fetch(`${api.baseUrl}/api/workflows/runs/${runId}/cancel`, {
      method: "POST",
      headers: memberHeaders,
    });
    expect(cancelRes.status).toBe(200);
    expect(stub.terminated).toContain(runId);
  });

  it("404s a team-owned run for a non-member in the SAME org", async () => {
    const stub = new StubRunHost();
    api = await bootTestApi({ workflowRunHost: stub });
    const team = await createTeam(api.providers.db, { orgId: "local-org", name: "Platform", creatorUserId: "local-user" });
    // A team-owned run needs a live definition: the store refuses one whose
    // definition is gone, so the run must belong to a real team workflow.
    const created = await fetch(`${api.baseUrl}/api/workflows`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "team wf", definition: VALID_DEFINITION, teamId: team.id }),
    });
    expect(created.status).toBe(201);
    const { id: workflowId } = (await created.json()) as { id: string };
    const runId = "wfrun_team_outsider";
    await api.providers.workflowStore.createRun(
      runId,
      { workflowId, definitionVersionId: "v1" },
      VALID_DEFINITION,
      "v1",
      { ownerType: "team", ownerId: team.id },
    );

    const res = await fetch(`${api.baseUrl}/api/workflows/runs/${runId}`, {
      headers: { "x-valet-test-user-id": "test-member" },
    });
    expect(res.status).toBe(404);
  });
});

describe("resolveWorkflowApproval — outcome coverage", () => {
  /** Bootstrap a test run. When `nodeType` is `"tool"` we insert the workflow
   * definition directly into the DB to bypass the save-time validator (which
   * rejects unknown services in environments without a plugin catalog). */
  async function setupRun(
    opts: { nodeType?: string; service?: string; action?: string } = {},
  ) {
    const stub = new StubRunHost();
    const localApi = await bootTestApi({ workflowRunHost: stub });
    const definition = {
      version: "dag/v1",
      nodes: [
        { id: "trigger", type: "trigger" },
        ...(opts.nodeType
          ? [{ id: "gate", type: opts.nodeType, service: opts.service, action: opts.action, params: {} }]
          : []),
        { id: "stop", type: "stop" },
      ],
      edges: [
        { from: "trigger", to: opts.nodeType ? "gate" : "stop" },
        ...(opts.nodeType ? [{ from: "gate", to: "stop" }] : []),
      ],
    };

    let wfId: string;
    if (opts.nodeType === "tool") {
      // Insert directly — the route's save-time validator rejects unknown
      // services (no plugin catalog in the test env). The run host / service
      // functions only read the definition from the run row, so this is safe.
      const now = Date.now();
      wfId = `wf_test_${now}`;
      await localApi.providers.db.insert(workflowDefinitions).values({
        id: wfId,
        orgId: "local-org",
        name: "test-wf",
        definition,
        ownerType: "user",
        ownerId: "local-user",
        createdAt: now,
        updatedAt: now,
      });
      await localApi.providers.db.insert(workflowVersions).values({
        id: `wfv_test_${now}`,
        workflowId: wfId,
        version: 1,
        name: "test-wf",
        definition,
        createdAt: now,
      });
    } else {
      const wfRes = await fetch(`${localApi.baseUrl}/api/workflows`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "test-wf", definition }),
      });
      expect(wfRes.status).toBe(201);
      wfId = ((await wfRes.json()) as CreateWorkflowResponse).id;
    }

    const wf = { id: wfId } as CreateWorkflowResponse;

    // Start the run via the route (so the route records it), then seed the
    // run in the store directly so approval/cancel reads can find it.
    const startRes = await fetch(`${localApi.baseUrl}/api/workflows/${wfId}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(startRes.status).toBe(201);
    const { runId } = (await startRes.json()) as StartWorkflowRunResponse;
    await localApi.providers.workflowStore.createRun(
      runId,
      { workflowId: wfId, definitionVersionId: "v1" },
      definition,
      "v1",
      { ownerType: "user", ownerId: "local-user" },
    );
    return { localApi, stub, wf, runId };
  }

  it("not parked → 409", async () => {
    const { localApi, runId } = await setupRun();
    api = localApi;
    const res = await fetch(`${localApi.baseUrl}/api/workflows/runs/${runId}/approvals/gate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approved: true }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("not parked") });
    // No DB writes on failure
    const signals = await localApi.providers.workflowStore.listSignals(runId);
    expect(signals).toHaveLength(0);
    const grants = await localApi.providers.db.select().from(runtimeGrants);
    expect(grants).toHaveLength(0);
    const policies = await localApi.providers.db.select().from(actionPolicies);
    expect(policies).toHaveLength(0);
  });

  it("unknown run → 404", async () => {
    const stub = new StubRunHost();
    api = await bootTestApi({ workflowRunHost: stub });
    const res = await fetch(`${api.baseUrl}/api/workflows/runs/no-such-run/approvals/gate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approved: true }),
    });
    expect(res.status).toBe(404);
    // No DB writes on failure
    const grants = await api.providers.db.select().from(runtimeGrants);
    expect(grants).toHaveLength(0);
    const policies = await api.providers.db.select().from(actionPolicies);
    expect(policies).toHaveLength(0);
  });

  it("already resolved → 409", async () => {
    const { localApi, runId } = await setupRun();
    api = localApi;
    await localApi.providers.workflowStore.parkRun(runId, 1, [
      { kind: "signal", signalType: "approval:gate", nodeId: "gate" },
    ]);
    // Seed an already-unconsumed signal
    await localApi.providers.workflowStore.insertSignal({
      runId,
      signalId: "approval:gate:resolution",
      signalType: "approval:gate",
      payload: { approved: true },
      createdAt: Date.now(),
    });
    const signalsBefore = await localApi.providers.workflowStore.listSignals(runId);
    const res = await fetch(`${localApi.baseUrl}/api/workflows/runs/${runId}/approvals/gate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approved: true }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("already been resolved") });
    // No additional DB writes on failure — signal count unchanged
    const signalsAfter = await localApi.providers.workflowStore.listSignals(runId);
    expect(signalsAfter).toHaveLength(signalsBefore.length);
    const grants = await localApi.providers.db.select().from(runtimeGrants);
    expect(grants).toHaveLength(0);
    const policies = await localApi.providers.db.select().from(actionPolicies);
    expect(policies).toHaveLength(0);
  });

  it("timed out → 409", async () => {
    const { localApi, runId } = await setupRun();
    api = localApi;
    await localApi.providers.workflowStore.parkRun(runId, 1, [
      { kind: "signal", signalType: "approval:gate", nodeId: "gate", timeoutAt: Date.now() - 1000 },
    ]);
    const res = await fetch(`${localApi.baseUrl}/api/workflows/runs/${runId}/approvals/gate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approved: true }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("timed out") });
    // No DB writes on failure
    const signals = await localApi.providers.workflowStore.listSignals(runId);
    expect(signals).toHaveLength(0);
    const grants = await localApi.providers.db.select().from(runtimeGrants);
    expect(grants).toHaveLength(0);
    const policies = await localApi.providers.db.select().from(actionPolicies);
    expect(policies).toHaveLength(0);
  });

  it("policy gate + scope=run → writes execution grant + 200", async () => {
    const { localApi, runId } = await setupRun({ nodeType: "tool", service: "widgets", action: "nuke" });
    api = localApi;
    await localApi.providers.workflowStore.parkRun(runId, 1, [
      { kind: "signal", signalType: "approval:gate", nodeId: "gate" },
    ]);
    const res = await fetch(`${localApi.baseUrl}/api/workflows/runs/${runId}/approvals/gate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approved: true, scope: "run" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    // Assert runtime_grants row was written
    const grants = await localApi.providers.db.select().from(runtimeGrants);
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ workflowExecutionId: runId, policyKey: "widgets.nuke" });
  });

  it("policy gate + scope=always + admin → writes org policy + 200", async () => {
    const { localApi, runId } = await setupRun({ nodeType: "tool", service: "widgets", action: "nuke" });
    api = localApi;
    await localApi.providers.workflowStore.parkRun(runId, 1, [
      { kind: "signal", signalType: "approval:gate", nodeId: "gate" },
    ]);
    const res = await fetch(`${localApi.baseUrl}/api/workflows/runs/${runId}/approvals/gate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approved: true, scope: "always" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    // Assert action_policies row written with the deterministic id
    const policies = await localApi.providers.db.select().from(actionPolicies);
    expect(policies.some((p) => p.id === "pol:approval:local-org:widgets.nuke")).toBe(true);
    // Assert runtime_grants row also written (scope=always implies scope=run grant too)
    const grants = await localApi.providers.db.select().from(runtimeGrants);
    expect(grants.some((g) => g.workflowExecutionId === runId && g.policyKey === "widgets.nuke")).toBe(true);
  });

  it("policy gate + scope=always + non-admin → 403", async () => {
    const stub = new StubRunHost();
    const localApi = await bootTestApi({ workflowRunHost: stub });
    api = localApi;
    // Insert a workflow definition owned by test-member directly (bypass validator).
    const now = Date.now();
    const memberWfId = `wf_nonAdmin_${now}`;
    const memberDef = {
      version: "dag/v1",
      nodes: [{ id: "trigger", type: "trigger" }, { id: "gate", type: "tool", service: "widgets", action: "nuke", params: {} }, { id: "stop", type: "stop" }],
      edges: [{ from: "trigger", to: "gate" }, { from: "gate", to: "stop" }],
    };
    await localApi.providers.db.insert(workflowDefinitions).values({
      id: memberWfId, orgId: "local-org", name: "member-wf", definition: memberDef,
      ownerType: "user", ownerId: "test-member", createdAt: now, updatedAt: now,
    });
    await localApi.providers.db.insert(workflowVersions).values({
      id: `wfv_nonAdmin_${now}`, workflowId: memberWfId, version: 1, name: "member-wf",
      definition: memberDef, createdAt: now,
    });
    const memberRunId = `wfrun_nonAdmin_${now}`;
    await localApi.providers.workflowStore.createRun(
      memberRunId,
      { workflowId: memberWfId, definitionVersionId: "v1" },
      memberDef, "v1",
      { ownerType: "user", ownerId: "test-member" },
    );
    await localApi.providers.workflowStore.parkRun(memberRunId, 1, [
      { kind: "signal", signalType: "approval:gate", nodeId: "gate" },
    ]);
    const res = await fetch(`${localApi.baseUrl}/api/workflows/runs/${memberRunId}/approvals/gate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-valet-test-user-id": "test-member" },
      body: JSON.stringify({ approved: true, scope: "always" }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("Ask an org admin") });
    // No policy row, no grant, no signal written on failure
    const signals = await localApi.providers.workflowStore.listSignals(memberRunId);
    expect(signals).toHaveLength(0);
    const grants = await localApi.providers.db.select().from(runtimeGrants);
    expect(grants).toHaveLength(0);
    const policies = await localApi.providers.db.select().from(actionPolicies);
    expect(policies).toHaveLength(0);
  });

  it("approval node (non-tool) + scope=run → 200 no grant written", async () => {
    const { localApi, runId } = await setupRun();
    api = localApi;
    // Park on a plain approval signal (no tool node in definition)
    await localApi.providers.workflowStore.parkRun(runId, 1, [
      { kind: "signal", signalType: "approval:manual", nodeId: "manual" },
    ]);
    const res = await fetch(`${localApi.baseUrl}/api/workflows/runs/${runId}/approvals/manual`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approved: true, scope: "run" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("denial on policy gate → 200", async () => {
    const { localApi, runId } = await setupRun({ nodeType: "tool", service: "widgets", action: "nuke" });
    api = localApi;
    await localApi.providers.workflowStore.parkRun(runId, 1, [
      { kind: "signal", signalType: "approval:gate", nodeId: "gate" },
    ]);
    const res = await fetch(`${localApi.baseUrl}/api/workflows/runs/${runId}/approvals/gate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approved: false }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("grantActions rejected → 400", async () => {
    const { localApi, runId } = await setupRun();
    api = localApi;
    const res = await fetch(`${localApi.baseUrl}/api/workflows/runs/${runId}/approvals/gate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approved: true, grantActions: [{ service: "x", actionId: "x.y" }] }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("grantActions") });
  });

  it("agent via → human_only for policy gate", async () => {
    const { localApi, runId, wf } = await setupRun({ nodeType: "tool", service: "widgets", action: "nuke" });
    api = localApi;
    await localApi.providers.workflowStore.parkRun(runId, 1, [
      { kind: "signal", signalType: "approval:gate", nodeId: "gate" },
    ]);
    const { db, workflowStore, workflowRunHost, engineStore, engineCredentials } = localApi.providers;
    const result = await resolveWorkflowApproval(
      { db, workflowStore, workflowRunHost, engineStore, credentials: engineCredentials },
      { userId: "local-user", orgId: "local-org" },
      { runId, nodeId: "gate", approved: true, via: "agent" },
    );
    expect(result).toBe("human_only");
  });

  it("foreach body gate: park on approval:body1:3, resolve with iteration: 3 → signal approval:body1:3:resolution", async () => {
    // Use an approval node (non-tool) to bypass the save-time validator for the
    // foreach body; the service looks up the node in run.definition, not the
    // workflow definition table, so we can seed any definition directly.
    const stub = new StubRunHost();
    const localApi = await bootTestApi({ workflowRunHost: stub });
    api = localApi;
    const now = Date.now();
    const wfId = `wf_foreach_${now}`;
    // A foreach definition whose body is a tool node with id "body1".
    const def = {
      version: "dag/v1",
      nodes: [
        { id: "trigger", type: "trigger" },
        {
          id: "loop",
          type: "foreach",
          items: "{{ trigger.data.items }}",
          body: { id: "body1", type: "approval", prompt: "approve this item?" },
        },
        { id: "stop", type: "stop" },
      ],
      edges: [
        { from: "trigger", to: "loop" },
        { from: "loop", to: "stop" },
      ],
    };
    await localApi.providers.db.insert(workflowDefinitions).values({
      id: wfId,
      orgId: "local-org",
      name: "foreach-wf",
      definition: def,
      ownerType: "user",
      ownerId: "local-user",
      createdAt: now,
      updatedAt: now,
    });
    await localApi.providers.db.insert(workflowVersions).values({
      id: `wfv_foreach_${now}`,
      workflowId: wfId,
      version: 1,
      name: "foreach-wf",
      definition: def,
      createdAt: now,
    });
    const runId = `wfrun_foreach_${now}`;
    await localApi.providers.workflowStore.createRun(
      runId,
      { workflowId: wfId, definitionVersionId: "v1" },
      def,
      "v1",
      { ownerType: "user", ownerId: "local-user" },
    );
    // Park on iteration 3 of the foreach body node.
    await localApi.providers.workflowStore.parkRun(runId, 1, [
      { kind: "signal", signalType: "approval:body1:3", nodeId: "body1" },
    ]);
    const res = await fetch(`${localApi.baseUrl}/api/workflows/runs/${runId}/approvals/body1`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approved: true, iteration: 3 }),
    });
    expect(res.status).toBe(200);
    const signals = await localApi.providers.workflowStore.listSignals(runId);
    expect(signals.some((s) => s.signalId === "approval:body1:3:resolution")).toBe(true);
  });

  it("org_mismatch: run's defining org has no membership for the caller → org_mismatch", async () => {
    const stub = new StubRunHost();
    const localApi = await bootTestApi({ workflowRunHost: stub });
    api = localApi;
    const { db, workflowStore, workflowRunHost, engineStore, engineCredentials } = localApi.providers;
    const now = Date.now();
    const wfId = `wf_mismatch_${now}`;
    // Insert a workflow that belongs to a different org ("other-org") that exists in DB
    // but "local-user" is not a member of.
    await db.insert(orgs).values({ id: "other-org", name: "Other Org", createdAt: now });
    const def = {
      version: "dag/v1",
      nodes: [
        { id: "trigger", type: "trigger" },
        { id: "gate", type: "tool", service: "widgets", action: "nuke", params: {} },
        { id: "stop", type: "stop" },
      ],
      edges: [{ from: "trigger", to: "gate" }, { from: "gate", to: "stop" }],
    };
    await db.insert(workflowDefinitions).values({
      id: wfId,
      orgId: "other-org", // different org
      name: "other-wf",
      definition: def,
      ownerType: "user",
      ownerId: "local-user",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(workflowVersions).values({
      id: `wfv_mismatch_${now}`,
      workflowId: wfId,
      version: 1,
      name: "other-wf",
      definition: def,
      createdAt: now,
    });
    const runId = `wfrun_mismatch_${now}`;
    await workflowStore.createRun(
      runId,
      { workflowId: wfId, definitionVersionId: "v1" },
      def,
      "v1",
      { ownerType: "user", ownerId: "local-user" },
    );
    await workflowStore.parkRun(runId, 1, [
      { kind: "signal", signalType: "approval:gate", nodeId: "gate" },
    ]);
    // "local-user" is in "local-org" but not in "other-org" → org_mismatch
    const result = await resolveWorkflowApproval(
      { db, workflowStore, workflowRunHost, engineStore, credentials: engineCredentials },
      { userId: "local-user", orgId: "local-org" },
      { runId, nodeId: "gate", approved: true, via: "web" },
    );
    expect(result).toBe("org_mismatch");
  });

  it("audit stamp: approve of tool-node gate stamps invocation row approved + resolvedBy", async () => {
    const { localApi, runId } = await setupRun({ nodeType: "tool", service: "widgets", action: "nuke" });
    api = localApi;
    const { db, workflowStore, workflowRunHost, engineStore, engineCredentials } = localApi.providers;
    // Seed a pending audit row the way the workflow enforcer does.
    const invId = `pol:wf:workflow:${runId}:gate`;
    await persistInvocationAudit(db, {
      invocationId: invId,
      orgId: "local-org",
      workflowExecutionId: runId,
      service: "widgets",
      actionId: "widgets.nuke",
      resolvedMode: "require_approval",
      status: "pending",
    });
    await localApi.providers.workflowStore.parkRun(runId, 1, [
      { kind: "signal", signalType: "approval:gate", nodeId: "gate" },
    ]);
    const result = await resolveWorkflowApproval(
      { db, workflowStore, workflowRunHost, engineStore, credentials: engineCredentials },
      { userId: "local-user", orgId: "local-org" },
      { runId, nodeId: "gate", approved: true, via: "web" },
    );
    expect(result).toBe("ok");
    const rows = await db
      .select({ status: actionInvocations.status, resolvedBy: actionInvocations.resolvedBy })
      .from(actionInvocations)
      .where(eq(actionInvocations.invocationId, invId));
    expect(rows[0]).toMatchObject({ status: "approved", resolvedBy: "local-user" });
  });

  it("resolution race: second sequential call with a different decision gets already_resolved and writes no grant or audit row", async () => {
    const { localApi, runId } = await setupRun({ nodeType: "tool", service: "widgets", action: "nuke" });
    api = localApi;
    const { db, workflowStore, workflowRunHost, engineStore, engineCredentials } = localApi.providers;
    const invId = `pol:wf:workflow:${runId}:gate`;
    await persistInvocationAudit(db, {
      invocationId: invId,
      orgId: "local-org",
      workflowExecutionId: runId,
      service: "widgets",
      actionId: "widgets.nuke",
      resolvedMode: "require_approval",
      status: "pending",
    });
    await workflowStore.parkRun(runId, 1, [
      { kind: "signal", signalType: "approval:gate", nodeId: "gate" },
    ]);

    // First resolution: approve with scope=run (writes a grant)
    const first = await resolveWorkflowApproval(
      { db, workflowStore, workflowRunHost, engineStore, credentials: engineCredentials },
      { userId: "local-user", orgId: "local-org" },
      { runId, nodeId: "gate", approved: true, scope: "run", via: "web" },
    );
    expect(first).toBe("ok");

    // Audit row must carry the first (approve) decision.
    const auditAfterFirst = await db
      .select({ status: actionInvocations.status, resolvedBy: actionInvocations.resolvedBy })
      .from(actionInvocations)
      .where(eq(actionInvocations.invocationId, invId));
    expect(auditAfterFirst[0]).toMatchObject({ status: "approved", resolvedBy: "local-user" });

    // Grant row must exist after first.
    const grantsAfterFirst = await db.select().from(runtimeGrants).where(eq(runtimeGrants.workflowExecutionId, runId));
    expect(grantsAfterFirst.length).toBeGreaterThan(0);

    // Second resolution: deny (simulates the racing loser arriving after the signal is stored)
    const second = await resolveWorkflowApproval(
      { db, workflowStore, workflowRunHost, engineStore, credentials: engineCredentials },
      { userId: "local-user", orgId: "local-org" },
      { runId, nodeId: "gate", approved: false, scope: "once", via: "web" },
    );
    expect(second).toBe("already_resolved");

    // Audit row must still carry the FIRST decision, not the loser's.
    const auditAfterSecond = await db
      .select({ status: actionInvocations.status })
      .from(actionInvocations)
      .where(eq(actionInvocations.invocationId, invId));
    expect(auditAfterSecond[0]?.status).toBe("approved");

    // Grant count must not have increased (loser wrote nothing).
    const grantsAfterSecond = await db.select().from(runtimeGrants).where(eq(runtimeGrants.workflowExecutionId, runId));
    expect(grantsAfterSecond.length).toBe(grantsAfterFirst.length);
  });

  it("cancelWorkflowRun stamps pending tool-gate audit rows as cancelled", async () => {
    const { localApi, runId } = await setupRun({ nodeType: "tool", service: "widgets", action: "nuke" });
    api = localApi;
    const { db, workflowStore, workflowRunHost, engineStore, engineCredentials } = localApi.providers;
    // Seed a pending gate audit row.
    const invId = `pol:wf:workflow:${runId}:gate`;
    await persistInvocationAudit(db, {
      invocationId: invId,
      orgId: "local-org",
      workflowExecutionId: runId,
      service: "widgets",
      actionId: "widgets.nuke",
      resolvedMode: "require_approval",
      status: "pending",
    });
    await workflowStore.parkRun(runId, 1, [
      { kind: "signal", signalType: "approval:gate", nodeId: "gate" },
    ]);
    const result = await cancelWorkflowRun({ db, workflowStore, workflowRunHost, engineStore, credentials: engineCredentials }, { userId: "local-user", orgId: "local-org" }, runId);
    expect(result).toBe("ok");
    const rows = await db
      .select({ status: actionInvocations.status })
      .from(actionInvocations)
      .where(eq(actionInvocations.invocationId, invId));
    expect(rows[0]?.status).toBe("cancelled");
  });
});

describe("GET /api/workflows/action-required", () => {
  it("shows org-owned gates only to org admins who can resolve them", async () => {
    api = await bootTestApi({ workflowRunHost: new StubRunHost() });
    const { db, workflowStore } = api.providers;
    const now = Date.now();
    const definition = {
      version: "dag/v1",
      nodes: [{ id: "review", type: "approval", prompt: "Approve org action?" }],
      edges: [],
    };
    await db.insert(workflowDefinitions).values({
      id: "wf_org_action", orgId: "local-org", name: "Org action", definition,
      ownerType: "org", ownerId: "local-org", createdAt: now, updatedAt: now,
    });
    await workflowStore.createRun(
      "wfrun_org_action", { workflowId: "wf_org_action", definitionVersionId: "v1" },
      definition, "v1", { ownerType: "org", ownerId: "local-org" },
    );
    await workflowStore.parkRun("wfrun_org_action", 1, [
      { kind: "signal", signalType: "approval:review", nodeId: "review" },
    ]);
    const memberHeaders = { "x-valet-test-user-id": "test-member" };
    const readable = await fetch(`${api.baseUrl}/api/workflows/runs/wfrun_org_action`, { headers: memberHeaders });
    expect(readable.status).toBe(200);
    const memberList = await fetch(`${api.baseUrl}/api/workflows/action-required`, { headers: memberHeaders });
    expect(await memberList.json()).toEqual({ items: [], count: 0 });
    const denied = await fetch(`${api.baseUrl}/api/workflows/runs/wfrun_org_action/approvals/review`, {
      method: "POST", headers: { ...memberHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ approved: true }),
    });
    expect(denied.status).toBe(404);
    const adminList = await fetch(`${api.baseUrl}/api/workflows/action-required`);
    expect(await adminList.json()).toMatchObject({ count: 1, items: [{ runId: "wfrun_org_action" }] });
  });

  // A run executes the definition it started with. Re-pinning the workflow
  // while a run waits for approval must not change the assistant the
  // approval screen names: that badge is beside a permission decision.
  it("reports workspace-owned approvals without assistant selection", async () => {
    api = await bootTestApi({ workflowRunHost: new StubRunHost() });
    const { db, workflowStore } = api.providers;
    const now = Date.now();
    const node = { id: "review", type: "approval", prompt: "Ship it?" };
    const snapshot = { version: "dag/v1", assistantId: "asst_snapshot", nodes: [node], edges: [] };
    const broken = { version: "dag/v1", assistantId: "   ", nodes: [node], edges: [] };

    async function park(workflowId: string, runId: string, definition: unknown) {
      await db.insert(workflowDefinitions).values({
        id: workflowId, orgId: "local-org", name: workflowId, definition,
        ownerType: "user", ownerId: "local-user", createdAt: now, updatedAt: now,
      });
      await workflowStore.createRun(
        runId, { workflowId, definitionVersionId: "v1" }, definition, "v1",
        { ownerType: "user", ownerId: "local-user" },
      );
      await workflowStore.parkRun(runId, 1, [
        { kind: "signal", signalType: "approval:review", nodeId: "review" },
      ]);
    }

    await park("wf_pinned", "wfrun_pinned", snapshot);
    await park("wf_broken", "wfrun_broken", broken);
    // The workflow moves to another assistant while the run waits.
    await db
      .update(workflowDefinitions)
      .set({ definition: { ...snapshot, assistantId: "asst_repinned" }, updatedAt: now + 1 })
      .where(eq(workflowDefinitions.id, "wf_pinned"));

    const res = await fetch(`${api.baseUrl}/api/workflows/action-required`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListWorkflowActionRequiredResponse;
    expect(body.items.find((item) => item.runId === "wfrun_pinned")?.assistantId).toBeUndefined();
    // A snapshot with an unusable id reports none, and the row still lists:
    // its approval is the only way that run ever settles.
    const brokenItem = body.items.find((item) => item.runId === "wfrun_broken");
    expect(brokenItem).toBeDefined();
    expect(brokenItem?.assistantId).toBeUndefined();
  });

  it("lists both gate classes and hides another user's gate", async () => {
    const stub = new StubRunHost();
    api = await bootTestApi({ workflowRunHost: stub });
    const { db, workflowStore } = api.providers;
    const now = Date.now();

    async function park(
      suffix: string,
      ownerId: string,
      node: Record<string, unknown>,
      effects?: Record<string, unknown>,
    ) {
      const workflowId = `wf_action_${suffix}`;
      const runId = `wfrun_action_${suffix}`;
      const definition = {
        version: "dag/v1",
        nodes: [{ id: "trigger", type: "trigger" }, node, { id: "stop", type: "stop" }],
        edges: [
          { from: "trigger", to: String(node.id) },
          { from: String(node.id), to: "stop" },
        ],
      };
      await db.insert(workflowDefinitions).values({
        id: workflowId,
        orgId: "local-org",
        name: `Action ${suffix}`,
        definition,
        ownerType: "user",
        ownerId,
        createdAt: now,
        updatedAt: now,
      });
      await workflowStore.createRun(
        runId,
        {
          workflowId,
          definitionVersionId: "v1",
          input: {
            type: "event",
            triggerId: "evt-1",
            timestamp: new Date(now).toISOString(),
            data: {},
            metadata: {},
          },
        },
        definition,
        "v1",
        { ownerType: "user", ownerId },
      );
      await workflowStore.putIntent({
        runId,
        nodeId: String(node.id),
        iteration: 0,
        attempt: 1,
        status: "intent",
        createdAt: now - 5_000,
        effects,
      });
      await workflowStore.parkRun(runId, 1, [
        {
          kind: "signal",
          signalType: `approval:${String(node.id)}`,
          nodeId: String(node.id),
        },
      ]);
      return runId;
    }

    await park("approval", "local-user", {
      id: "review",
      type: "approval",
      prompt: "Approve the release?",
    });
    await park(
      "policy",
      "local-user",
      {
        id: "send",
        type: "tool",
        service: "slack",
        action: "send_message",
        params: {},
        onDeny: "skip",
      },
      {
        riskLevel: "high",
        provenance: "org_policy",
        gateParams: { channel: "C123" },
      },
    );
    const hiddenRun = await park("hidden", "someone-else", {
      id: "private",
      type: "approval",
      prompt: "Private decision",
    });

    const res = await fetch(`${api.baseUrl}/api/workflows/action-required`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListWorkflowActionRequiredResponse;
    expect(body.count).toBe(2);
    expect(body.items.map((item) => item.gate.kind).sort()).toEqual(["approval", "policy_gate"]);
    expect(body.items.some((item) => item.runId === hiddenRun)).toBe(false);
    expect(body.items.find((item) => item.gate.kind === "approval")).toMatchObject({
      workflowName: "Action approval",
      trigger: { type: "event", triggerId: "evt-1" },
      gate: {
        nodeId: "review",
        prompt: "Approve the release?",
        waitingSince: now - 5_000,
      },
    });
    expect(body.items.find((item) => item.gate.kind === "policy_gate")).toMatchObject({
      gate: {
        nodeId: "send",
        service: "slack",
        action: "send_message",
        onDeny: "skip",
        gateParams: { channel: "C123" },
      },
    });

    const forbidden = await fetch(`${api.baseUrl}/api/workflows/runs/${hiddenRun}/approvals/private`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approved: true }),
    });
    expect(forbidden.status).toBe(404);
  });
});

describe("pendingGates + needsApproval wire", () => {
  it("(a) tool node park with gate effects → policy_gate entry with all fields populated verbatim", async () => {
    const stub = new StubRunHost();
    const localApi = await bootTestApi({ workflowRunHost: stub });
    api = localApi;
    const { db, workflowStore, workflowRunHost, engineStore, engineCredentials } = localApi.providers;
    const now = Date.now();
    const wfId = `wf_pg_a_${now}`;
    const def = {
      version: "dag/v1",
      nodes: [
        { id: "trigger", type: "trigger" },
        {
          id: "t1",
          type: "tool",
          service: "github",
          action: "create_pr",
          params: {},
          onDeny: "skip",
        },
        { id: "stop", type: "stop" },
      ],
      edges: [
        { from: "trigger", to: "t1" },
        { from: "t1", to: "stop" },
      ],
    };
    await db.insert(workflowDefinitions).values({
      id: wfId, orgId: "local-org", name: "pg-wf-a", definition: def,
      ownerType: "user", ownerId: "local-user", createdAt: now, updatedAt: now,
    });
    await db.insert(workflowVersions).values({
      id: `wfv_pg_a_${now}`, workflowId: wfId, version: 1, name: "pg-wf-a",
      definition: def, createdAt: now,
    });
    const runId = `wfrun_pg_a_${now}`;
    await workflowStore.createRun(
      runId,
      { workflowId: wfId, definitionVersionId: "v1" },
      def,
      "v1",
      { ownerType: "user", ownerId: "local-user" },
    );
    // Seed the intent checkpoint with gate effects.
    const gateParams = { repo: "valet", branch: "main" };
    await workflowStore.putIntent({
      runId,
      nodeId: "t1",
      iteration: 0,
      attempt: 1,
      status: "intent",
      createdAt: now,
      effects: {
        invocationId: `pol:wf:${runId}:t1`,
        gate: true,
        gateParams,
        gateItem: { item: 42 },
        riskLevel: "high",
        provenance: "inferred",
        timeoutAt: 123,
      },
    });
    await workflowStore.parkRun(runId, 1, [
      { kind: "signal", signalType: "approval:t1", nodeId: "t1", timeoutAt: 123 },
    ]);

    const detail = await getWorkflowRunDetail(
      { db, workflowStore, workflowRunHost, engineStore, credentials: engineCredentials },
      { userId: "local-user", orgId: "local-org" },
      runId,
    );
    expect(detail).not.toBeNull();
    expect(detail!.pendingGates).toHaveLength(1);
    const gate = detail!.pendingGates[0];
    expect(gate.kind).toBe("policy_gate");
    expect(gate.nodeId).toBe("t1");
    expect(gate.service).toBe("github");
    expect(gate.action).toBe("create_pr");
    expect(gate.onDeny).toBe("skip");
    expect(gate.riskLevel).toBe("high");
    expect(gate.provenance).toBe("inferred");
    expect(gate.timeoutAt).toBe(123);
    expect(gate.gateParams).toEqual(gateParams); // verbatim round-trip
    expect(gate.gateItem).toEqual({ item: 42 });
    expect(gate.iteration).toBeUndefined(); // top-level node, no iteration
    expect(gate.prompt).toBeUndefined();
  });

  it("(a) gateParamsTruncated is present when set in effects", async () => {
    const stub = new StubRunHost();
    const localApi = await bootTestApi({ workflowRunHost: stub });
    api = localApi;
    const { db, workflowStore, workflowRunHost, engineStore, engineCredentials } = localApi.providers;
    const now = Date.now();
    const wfId = `wf_pg_trunc_${now}`;
    const def = {
      version: "dag/v1",
      nodes: [
        { id: "trigger", type: "trigger" },
        { id: "t2", type: "tool", service: "svc", action: "act", params: {} },
        { id: "stop", type: "stop" },
      ],
      edges: [{ from: "trigger", to: "t2" }, { from: "t2", to: "stop" }],
    };
    await db.insert(workflowDefinitions).values({
      id: wfId, orgId: "local-org", name: "pg-trunc", definition: def,
      ownerType: "user", ownerId: "local-user", createdAt: now, updatedAt: now,
    });
    await db.insert(workflowVersions).values({
      id: `wfv_pg_trunc_${now}`, workflowId: wfId, version: 1, name: "pg-trunc",
      definition: def, createdAt: now,
    });
    const runId = `wfrun_pg_trunc_${now}`;
    await workflowStore.createRun(
      runId,
      { workflowId: wfId, definitionVersionId: "v1" },
      def,
      "v1",
      { ownerType: "user", ownerId: "local-user" },
    );
    await workflowStore.putIntent({
      runId,
      nodeId: "t2",
      iteration: 0,
      attempt: 1,
      status: "intent",
      createdAt: now,
      effects: {
        gate: true,
        gateParams: { truncated: true },
        gateParamsTruncated: true,
      },
    });
    await workflowStore.parkRun(runId, 1, [
      { kind: "signal", signalType: "approval:t2", nodeId: "t2" },
    ]);
    const detail = await getWorkflowRunDetail(
      { db, workflowStore, workflowRunHost, engineStore, credentials: engineCredentials },
      { userId: "local-user", orgId: "local-org" },
      runId,
    );
    expect(detail!.pendingGates[0].gateParamsTruncated).toBe(true);
  });

  it("(b) approval node park → kind=approval, prompt from definition, no gate fields", async () => {
    const stub = new StubRunHost();
    const localApi = await bootTestApi({ workflowRunHost: stub });
    api = localApi;
    const { db, workflowStore, workflowRunHost, engineStore, engineCredentials } = localApi.providers;
    const now = Date.now();
    const wfId = `wf_pg_b_${now}`;
    const def = {
      version: "dag/v1",
      nodes: [
        { id: "trigger", type: "trigger" },
        { id: "approval1", type: "approval", prompt: "Please review this action." },
        { id: "stop", type: "stop" },
      ],
      edges: [{ from: "trigger", to: "approval1" }, { from: "approval1", to: "stop" }],
    };
    await db.insert(workflowDefinitions).values({
      id: wfId, orgId: "local-org", name: "pg-wf-b", definition: def,
      ownerType: "user", ownerId: "local-user", createdAt: now, updatedAt: now,
    });
    await db.insert(workflowVersions).values({
      id: `wfv_pg_b_${now}`, workflowId: wfId, version: 1, name: "pg-wf-b",
      definition: def, createdAt: now,
    });
    const runId = `wfrun_pg_b_${now}`;
    await workflowStore.createRun(
      runId,
      { workflowId: wfId, definitionVersionId: "v1" },
      def,
      "v1",
      { ownerType: "user", ownerId: "local-user" },
    );
    await workflowStore.parkRun(runId, 1, [
      { kind: "signal", signalType: "approval:approval1", nodeId: "approval1" },
    ]);

    const detail = await getWorkflowRunDetail(
      { db, workflowStore, workflowRunHost, engineStore, credentials: engineCredentials },
      { userId: "local-user", orgId: "local-org" },
      runId,
    );
    expect(detail).not.toBeNull();
    expect(detail!.pendingGates).toHaveLength(1);
    const gate = detail!.pendingGates[0];
    expect(gate.kind).toBe("approval");
    expect(gate.nodeId).toBe("approval1");
    expect(gate.prompt).toBe("Please review this action.");
    expect(gate.service).toBeUndefined();
    expect(gate.action).toBeUndefined();
    expect(gate.gateParams).toBeUndefined();
    expect(gate.riskLevel).toBeUndefined();
    expect(gate.onDeny).toBeUndefined();
  });

  it("(c) listWorkflowRuns: approval-parked run → needsApproval=true; timer-parked → needsApproval absent", async () => {
    const stub = new StubRunHost();
    const localApi = await bootTestApi({ workflowRunHost: stub });
    api = localApi;
    const { workflowStore, workflowRunHost, db, engineStore, engineCredentials } = localApi.providers;

    // Create a workflow via the HTTP route (uses the default VALID_DEFINITION).
    const wfRes = await fetch(`${localApi.baseUrl}/api/workflows`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "pg-c-wf", definition: VALID_DEFINITION }),
    });
    expect(wfRes.status).toBe(201);
    const wf = (await wfRes.json()) as CreateWorkflowResponse;

    // Start run 1 — will become the approval-parked run.
    const approvalStartRes = await fetch(`${localApi.baseUrl}/api/workflows/${wf.id}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(approvalStartRes.status).toBe(201);
    const { runId: approvalRunId } = (await approvalStartRes.json()) as StartWorkflowRunResponse;
    await workflowStore.createRun(
      approvalRunId,
      { workflowId: wf.id, definitionVersionId: "v1" },
      VALID_DEFINITION, "v1",
      { ownerType: "user", ownerId: "local-user" },
    );
    await workflowStore.parkRun(approvalRunId, 1, [
      { kind: "signal", signalType: "approval:stop", nodeId: "stop" },
    ]);

    // Start run 2 — will become the timer-parked run.
    const timerStartRes = await fetch(`${localApi.baseUrl}/api/workflows/${wf.id}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(timerStartRes.status).toBe(201);
    const { runId: timerRunId } = (await timerStartRes.json()) as StartWorkflowRunResponse;
    await workflowStore.createRun(
      timerRunId,
      { workflowId: wf.id, definitionVersionId: "v1" },
      VALID_DEFINITION, "v1",
      { ownerType: "user", ownerId: "local-user" },
    );
    await workflowStore.parkRun(timerRunId, 1, [
      { kind: "timer", nodeId: "stop", wakeAt: Date.now() + 60000 },
    ]);

    const runs = await listWorkflowRuns(
      { db, workflowStore, workflowRunHost, engineStore, credentials: engineCredentials },
      { userId: "local-user", orgId: "local-org" },
      wf.id,
    );
    expect(runs).not.toBeNull();
    const approvalRun = runs!.runs.find((r) => r.runId === approvalRunId);
    const timerRun = runs!.runs.find((r) => r.runId === timerRunId);
    expect(approvalRun?.needsApproval).toBe(true);
    // Timer-parked run must NOT carry needsApproval (absent, not false).
    expect(timerRun?.needsApproval).toBeUndefined();
  });

  it("(d) checkpoint wire does NOT expose effects (selective exposure only)", async () => {
    const stub = new StubRunHost();
    const localApi = await bootTestApi({ workflowRunHost: stub });
    api = localApi;
    const { db, workflowStore, workflowRunHost, engineStore, engineCredentials } = localApi.providers;
    const now = Date.now();
    const wfId = `wf_pg_d_${now}`;
    const def = {
      version: "dag/v1",
      nodes: [
        { id: "trigger", type: "trigger" },
        { id: "t3", type: "tool", service: "svc", action: "act", params: {} },
        { id: "stop", type: "stop" },
      ],
      edges: [{ from: "trigger", to: "t3" }, { from: "t3", to: "stop" }],
    };
    await db.insert(workflowDefinitions).values({
      id: wfId, orgId: "local-org", name: "pg-wf-d", definition: def,
      ownerType: "user", ownerId: "local-user", createdAt: now, updatedAt: now,
    });
    await db.insert(workflowVersions).values({
      id: `wfv_pg_d_${now}`, workflowId: wfId, version: 1, name: "pg-wf-d",
      definition: def, createdAt: now,
    });
    const runId = `wfrun_pg_d_${now}`;
    await workflowStore.createRun(
      runId,
      { workflowId: wfId, definitionVersionId: "v1" },
      def, "v1",
      { ownerType: "user", ownerId: "local-user" },
    );
    await workflowStore.putIntent({
      runId,
      nodeId: "t3",
      iteration: 0,
      attempt: 1,
      status: "intent",
      createdAt: now,
      effects: { gate: true, gateParams: { secret: "internal" } },
    });
    await workflowStore.parkRun(runId, 1, [
      { kind: "signal", signalType: "approval:t3", nodeId: "t3" },
    ]);

    const detail = await getWorkflowRunDetail(
      { db, workflowStore, workflowRunHost, engineStore, credentials: engineCredentials },
      { userId: "local-user", orgId: "local-org" },
      runId,
    );
    expect(detail).not.toBeNull();
    // The checkpoints array must NOT expose effects.
    for (const cp of detail!.checkpoints) {
      expect(cp).not.toHaveProperty("effects");
    }
  });
});

describe("GET /api/workflows/:id/runs", () => {
  it("lists runs for an owned workflow", async () => {
    const stub = new StubRunHost();
    api = await bootTestApi({ workflowRunHost: stub });
    const created = await createWorkflow(api.baseUrl);
    const runId = "wfrun_list_test";
    await api.providers.workflowStore.createRun(
      runId,
      { workflowId: created.id, definitionVersionId: "v1" },
      created.definition,
      "v1",
      { ownerType: "user", ownerId: "local-user" },
    );

    const res = await fetch(`${api.baseUrl}/api/workflows/${created.id}/runs`);
    expect(res.status).toBe(200);
    const { runs } = (await res.json()) as ListWorkflowRunsResponse;
    expect(runs.map((r) => r.runId)).toEqual([runId]);
  });

  it("pages by cursor and rejects a limit outside the accepted range", async () => {
    const stub = new StubRunHost();
    api = await bootTestApi({ workflowRunHost: stub });
    const created = await createWorkflow(api.baseUrl);
    for (const runId of ["wfrun_page_a", "wfrun_page_b", "wfrun_page_c"]) {
      await api.providers.workflowStore.createRun(
        runId,
        { workflowId: created.id, definitionVersionId: "v1" },
        created.definition,
        "v1",
        { ownerType: "user", ownerId: "local-user" },
      );
    }

    const first = await fetch(`${api.baseUrl}/api/workflows/${created.id}/runs?limit=2`);
    const firstPage = (await first.json()) as ListWorkflowRunsResponse;
    expect(firstPage.runs).toHaveLength(2);
    expect(firstPage.nextCursor).toBeDefined();

    const second = await fetch(
      `${api.baseUrl}/api/workflows/${created.id}/runs?limit=2&cursor=${encodeURIComponent(firstPage.nextCursor ?? "")}`,
    );
    const secondPage = (await second.json()) as ListWorkflowRunsResponse;
    expect(secondPage.runs).toHaveLength(1);
    expect(secondPage.nextCursor).toBeUndefined();

    const seen = [...firstPage.runs, ...secondPage.runs].map((r) => r.runId);
    expect(new Set(seen).size).toBe(3);

    const bad = await fetch(`${api.baseUrl}/api/workflows/${created.id}/runs?limit=0`);
    expect(bad.status).toBe(400);
    const badCursor = await fetch(`${api.baseUrl}/api/workflows/${created.id}/runs?cursor=nonsense`);
    expect(badCursor.status).toBe(400);
  });
});

describe("run detail checkpoint links", () => {
  it("surfaces a failed session node's sessionId and a workflow node's childRunId", async () => {
    api = await bootTestApi({ workflowRunHost: new StubRunHost() });
    const created = await createWorkflow(api.baseUrl);
    const runId = "wfrun_links";
    await api.providers.workflowStore.createRun(
      runId,
      { workflowId: created.id, definitionVersionId: "v1" },
      created.definition,
      "v1",
      { ownerType: "user", ownerId: "local-user" },
    );
    const claimed = await api.providers.workflowStore.claimRun(runId, "test-owner", 30_000);
    if (!claimed) throw new Error("expected claim to succeed");
    await api.providers.workflowStore.completeCheckpoint(runId, "ask", 0, claimed.attempt, {
      runId,
      nodeId: "ask",
      iteration: 0,
      status: "failed",
      error: "session failed",
      // What `submission-node.ts` and `workflow-call.ts` actually persist.
      effects: { sessionId: "s_abc", receipt: { threadId: "t1", queueItemId: "q1" }, repairAttempted: false },
      attempt: claimed.attempt,
      createdAt: Date.now(),
    });
    await api.providers.workflowStore.completeCheckpoint(runId, "sub", 0, claimed.attempt, {
      runId,
      nodeId: "sub",
      iteration: 0,
      status: "completed",
      effects: { childRunId: "wfrun_sub_child" },
      attempt: claimed.attempt,
      createdAt: Date.now(),
    });

    const res = await fetch(`${api.baseUrl}/api/workflows/runs/${runId}`);
    expect(res.status).toBe(200);
    const detail = (await res.json()) as GetWorkflowRunResponse;
    const ask = detail.checkpoints.find((cp) => cp.nodeId === "ask");
    const sub = detail.checkpoints.find((cp) => cp.nodeId === "sub");
    expect(ask?.sessionId).toBe("s_abc");
    expect(sub?.childRunId).toBe("wfrun_sub_child");
    // The rest of the effects bag stays off the wire.
    expect(JSON.stringify(detail.checkpoints)).not.toContain("repairAttempted");
  });
});

describe("DELETE /api/workflows/:id with a run in flight", () => {
  it("deletes when finalization reserved the run outcome", async () => {
    api = await bootTestApi({ workflowRunHost: new StubRunHost() });
    const created = await createWorkflow(api.baseUrl, "terminalizing-history");
    const runId = "wfrun_terminalizing_delete";
    await api.providers.workflowStore.createRun(
      runId,
      { workflowId: created.id, definitionVersionId: "v1" },
      created.definition,
      "v1",
      { ownerType: "user", ownerId: "local-user" },
    );
    const claimed = await api.providers.workflowStore.claimRun(runId, "test-owner", 30_000);
    if (!claimed) throw new Error("expected claim to succeed");
    await api.providers.workflowStore.beginTerminalize(runId, claimed.attempt, "completed");

    const deleted = await fetch(`${api.baseUrl}/api/workflows/${created.id}`, { method: "DELETE" });
    expect(deleted.status).toBe(200);
    expect(await api.providers.workflowStore.getRun(runId)).toMatchObject({
      status: "terminalizing",
      outcome: "completed",
    });
  });

  it("409s while a run is not settled, then deletes once it settles", async () => {
    api = await bootTestApi({ workflowRunHost: new StubRunHost() });
    const created = await createWorkflow(api.baseUrl);
    const runId = "wfrun_active";
    await api.providers.workflowStore.createRun(
      runId,
      { workflowId: created.id, definitionVersionId: "v1" },
      created.definition,
      "v1",
      { ownerType: "user", ownerId: "local-user" },
    );

    const blocked = await fetch(`${api.baseUrl}/api/workflows/${created.id}`, { method: "DELETE" });
    expect(blocked.status).toBe(409);

    await api.providers.workflowStore.settleRun(runId, "completed");
    const deleted = await fetch(`${api.baseUrl}/api/workflows/${created.id}`, { method: "DELETE" });
    expect(deleted.status).toBe(200);
  });
});

describe("GET /api/workflows/runs", () => {
  /** Seeds one run, returning its id. */
  async function seedRun(
    testApi: TestApi,
    workflowId: string,
    runId: string,
    params: Record<string, unknown> = {},
  ): Promise<string> {
    await testApi.providers.workflowStore.createRun(
      runId,
      { workflowId, definitionVersionId: "v1", ...params },
      VALID_DEFINITION,
      "v1",
      { ownerType: "user", ownerId: "local-user" },
    );
    return runId;
  }

  it("resolves to the cross-workflow list, not to GET /:id with id='runs'", async () => {
    api = await bootTestApi({ workflowRunHost: new StubRunHost() });
    const res = await fetch(`${api.baseUrl}/api/workflows/runs`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListWorkflowRunsResponse;
    expect(body.runs).toEqual([]);
  });

  it("lists runs across every workflow the caller owns", async () => {
    api = await bootTestApi({ workflowRunHost: new StubRunHost() });
    const first = await createWorkflow(api.baseUrl, "wf-one");
    const second = await createWorkflow(api.baseUrl, "wf-two");
    await seedRun(api, first.id, "wfrun_cross_a");
    await seedRun(api, second.id, "wfrun_cross_b");

    const res = await fetch(`${api.baseUrl}/api/workflows/runs`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListWorkflowRunsResponse;
    expect(new Set(body.runs.map((r) => r.runId))).toEqual(
      new Set(["wfrun_cross_a", "wfrun_cross_b"]),
    );
  });

  it("returns a batch parent's children in one query via parentRunId", async () => {
    api = await bootTestApi({ workflowRunHost: new StubRunHost() });
    const created = await createWorkflow(api.baseUrl);
    await seedRun(api, created.id, "wfrun_batch_parent");
    await seedRun(api, created.id, "wfrun_batch_child_1", {
      parentRunId: "wfrun_batch_parent",
      parentNodeId: "fanout",
      parentIteration: 0,
    });
    await seedRun(api, created.id, "wfrun_batch_child_2", {
      parentRunId: "wfrun_batch_parent",
      parentNodeId: "fanout",
      parentIteration: 1,
    });

    const res = await fetch(`${api.baseUrl}/api/workflows/runs?parentRunId=wfrun_batch_parent`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListWorkflowRunsResponse;
    expect(new Set(body.runs.map((r) => r.runId))).toEqual(
      new Set(["wfrun_batch_child_1", "wfrun_batch_child_2"]),
    );
    expect(body.runs.every((r) => r.parentRunId === "wfrun_batch_parent")).toBe(true);
    expect(body.runs.map((r) => r.parentNodeId)).toEqual(["fanout", "fanout"]);
  });

  it("filters by status and rejects an unknown one", async () => {
    api = await bootTestApi({ workflowRunHost: new StubRunHost() });
    const created = await createWorkflow(api.baseUrl);
    await seedRun(api, created.id, "wfrun_status_pending");
    await seedRun(api, created.id, "wfrun_status_settled");
    await api.providers.workflowStore.settleRun("wfrun_status_settled", "completed");

    const res = await fetch(`${api.baseUrl}/api/workflows/runs?status=settled`);
    const body = (await res.json()) as ListWorkflowRunsResponse;
    expect(body.runs.map((r) => r.runId)).toEqual(["wfrun_status_settled"]);
    expect(body.runs[0].outcome).toBe("completed");

    const bad = await fetch(`${api.baseUrl}/api/workflows/runs?status=nope`);
    expect(bad.status).toBe(400);
  });

  it("404s a workflowId the caller cannot read, and hides its runs from an unfiltered list", async () => {
    api = await bootTestApi({ workflowRunHost: new StubRunHost() });
    const created = await createWorkflow(api.baseUrl);
    await seedRun(api, created.id, "wfrun_private");
    const headers = { "x-valet-test-user-id": "test-member" };

    const filtered = await fetch(
      `${api.baseUrl}/api/workflows/runs?workflowId=${created.id}`,
      { headers },
    );
    expect(filtered.status).toBe(404);

    const unfiltered = await fetch(`${api.baseUrl}/api/workflows/runs`, { headers });
    expect(unfiltered.status).toBe(200);
    const body = (await unfiltered.json()) as ListWorkflowRunsResponse;
    expect(body.runs).toEqual([]);
  });

  // `created_at` is an integer column. A value it cannot hold must answer 400
  // with the corrective action, never a 500 carrying a driver syntax error.
  it("400s a since or cursor value the run store cannot hold", async () => {
    api = await bootTestApi({ workflowRunHost: new StubRunHost() });
    const created = await createWorkflow(api.baseUrl);
    await seedRun(api, created.id, "wfrun_bounds");

    for (const query of ["since=1.5", "since=1e30", "since=-1", "cursor=1.5%3Awfrun_bounds"]) {
      const res = await fetch(`${api.baseUrl}/api/workflows/runs?${query}`);
      expect([query, res.status]).toEqual([query, 400]);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/millisecond timestamp|nextCursor/);
    }

    const ok = await fetch(`${api.baseUrl}/api/workflows/runs?since=0`);
    expect(ok.status).toBe(200);
  });

  it("400s a teamId filter, the same answer the definitions list gives", async () => {
    api = await bootTestApi({ workflowRunHost: new StubRunHost() });
    const created = await createWorkflow(api.baseUrl);
    await seedRun(api, created.id, "wfrun_team_filter");

    const res = await fetch(`${api.baseUrl}/api/workflows/runs?teamId=team_platform`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; runs?: unknown };
    expect(body.error).toBe(TEAM_ID_FILTER_ERROR);
    expect(body.runs).toBeUndefined();
  });
});

describe("POST/GET/DELETE /api/workflows/:id/webhook", () => {
  it("mints a hookId, then reads it back via GET", async () => {
    api = await bootTestApi();
    const created = await createWorkflow(api.baseUrl);

    const minted = await fetch(`${api.baseUrl}/api/workflows/${created.id}/webhook`, { method: "POST" });
    expect(minted.status).toBe(200);
    const mintedBody = (await minted.json()) as WorkflowWebhookResponse;
    expect(mintedBody.workflowId).toBe(created.id);
    expect(mintedBody.hookId).toMatch(/^[0-9a-f]{64}$/);

    const fetched = await fetch(`${api.baseUrl}/api/workflows/${created.id}/webhook`);
    expect(fetched.status).toBe(200);
    const fetchedBody = (await fetched.json()) as WorkflowWebhookResponse;
    expect(fetchedBody.hookId).toBe(mintedBody.hookId);
  });

  it("GET 404s when the workflow has no webhook yet", async () => {
    api = await bootTestApi();
    const created = await createWorkflow(api.baseUrl);

    const res = await fetch(`${api.baseUrl}/api/workflows/${created.id}/webhook`);
    expect(res.status).toBe(404);
  });

  it("POST/GET/DELETE all 404 against another owner's workflow", async () => {
    api = await bootTestApi();
    const created = await createWorkflow(api.baseUrl);
    const headers = { "x-valet-test-user-id": "test-member" };

    const post = await fetch(`${api.baseUrl}/api/workflows/${created.id}/webhook`, { method: "POST", headers });
    expect(post.status).toBe(404);

    const get = await fetch(`${api.baseUrl}/api/workflows/${created.id}/webhook`, { headers });
    expect(get.status).toBe(404);

    const del = await fetch(`${api.baseUrl}/api/workflows/${created.id}/webhook`, { method: "DELETE", headers });
    expect(del.status).toBe(404);
  });

  it("rotating changes the hookId", async () => {
    api = await bootTestApi();
    const created = await createWorkflow(api.baseUrl);

    const first = await fetch(`${api.baseUrl}/api/workflows/${created.id}/webhook`, { method: "POST" });
    const firstBody = (await first.json()) as WorkflowWebhookResponse;
    const second = await fetch(`${api.baseUrl}/api/workflows/${created.id}/webhook`, { method: "POST" });
    const secondBody = (await second.json()) as WorkflowWebhookResponse;
    expect(secondBody.hookId).not.toBe(firstBody.hookId);
  });

  it("DELETE removes an existing hook and returns deleted:true", async () => {
    api = await bootTestApi();
    const created = await createWorkflow(api.baseUrl);
    await fetch(`${api.baseUrl}/api/workflows/${created.id}/webhook`, { method: "POST" });

    const res = await fetch(`${api.baseUrl}/api/workflows/${created.id}/webhook`, { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as DeleteWorkflowWebhookResponse;
    expect(body.deleted).toBe(true);

    const afterDelete = await fetch(`${api.baseUrl}/api/workflows/${created.id}/webhook`);
    expect(afterDelete.status).toBe(404);
  });

  it("DELETE on an owned workflow with no hook returns deleted:false (not a 404 — the workflow itself is fine)", async () => {
    api = await bootTestApi();
    const created = await createWorkflow(api.baseUrl);

    const res = await fetch(`${api.baseUrl}/api/workflows/${created.id}/webhook`, { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as DeleteWorkflowWebhookResponse;
    expect(body.deleted).toBe(false);
  });
});

describe("GET/POST/DELETE /api/workflows/:id/schedules", () => {
  it("creates a schedule and lists it for that workflow only", async () => {
    api = await bootTestApi();
    const a = await createWorkflow(api.baseUrl, "with-schedule");
    const b = await createWorkflow(api.baseUrl, "without-schedule");

    const created = await fetch(`${api.baseUrl}/api/workflows/${a.id}/schedules`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "nightly", cron: "0 9 * * *" }),
    });
    expect(created.status).toBe(201);
    const schedule = (await created.json()) as CreateWorkflowScheduleResponse;
    expect(schedule.workflowId).toBe(a.id);
    expect(schedule.enabled).toBe(true);
    expect(schedule.timezone).toBe("UTC");
    expect(schedule.nextFireAt).toBeGreaterThan(Date.now());

    const listA = await fetch(`${api.baseUrl}/api/workflows/${a.id}/schedules`);
    const bodyA = (await listA.json()) as ListWorkflowSchedulesResponse;
    expect(bodyA.schedules.map((s) => s.scheduleId)).toEqual([schedule.scheduleId]);

    const listB = await fetch(`${api.baseUrl}/api/workflows/${b.id}/schedules`);
    const bodyB = (await listB.json()) as ListWorkflowSchedulesResponse;
    expect(bodyB.schedules).toEqual([]);
  });

  it("400s an invalid cron with the corrective error text", async () => {
    api = await bootTestApi();
    const created = await createWorkflow(api.baseUrl);
    const res = await fetch(`${api.baseUrl}/api/workflows/${created.id}/schedules`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "bad", cron: "every day at nine" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("cron");
  });

  it("404s schedule routes on another owner's workflow", async () => {
    api = await bootTestApi();
    const created = await createWorkflow(api.baseUrl);
    const asOther = { "x-valet-test-user-id": "test-member" };

    const list = await fetch(`${api.baseUrl}/api/workflows/${created.id}/schedules`, {
      headers: asOther,
    });
    expect(list.status).toBe(404);

    const post = await fetch(`${api.baseUrl}/api/workflows/${created.id}/schedules`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...asOther },
      body: JSON.stringify({ name: "sneaky", cron: "0 9 * * *" }),
    });
    expect(post.status).toBe(404);
  });

  it("DELETE removes only a schedule that belongs to that workflow", async () => {
    api = await bootTestApi();
    const a = await createWorkflow(api.baseUrl, "schedule-owner");
    const b = await createWorkflow(api.baseUrl, "other-workflow");

    const created = await fetch(`${api.baseUrl}/api/workflows/${a.id}/schedules`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "nightly", cron: "0 9 * * *" }),
    });
    const schedule = (await created.json()) as CreateWorkflowScheduleResponse;

    // Through the WRONG workflow's path: 404, row survives.
    const cross = await fetch(
      `${api.baseUrl}/api/workflows/${b.id}/schedules/${schedule.scheduleId}`,
      { method: "DELETE" },
    );
    expect(cross.status).toBe(404);

    const del = await fetch(
      `${api.baseUrl}/api/workflows/${a.id}/schedules/${schedule.scheduleId}`,
      { method: "DELETE" },
    );
    expect(del.status).toBe(200);
    const listA = await fetch(`${api.baseUrl}/api/workflows/${a.id}/schedules`);
    const bodyA = (await listA.json()) as ListWorkflowSchedulesResponse;
    expect(bodyA.schedules).toEqual([]);
  });

  it("400s a whitespace-only name and trims a valid one", async () => {
    api = await bootTestApi();
    const created = await createWorkflow(api.baseUrl);

    const blank = await fetch(`${api.baseUrl}/api/workflows/${created.id}/schedules`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "   ", cron: "0 9 * * *" }),
    });
    expect(blank.status).toBe(400);

    const padded = await fetch(`${api.baseUrl}/api/workflows/${created.id}/schedules`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "  nightly  ", cron: "0 9 * * *" }),
    });
    expect(padded.status).toBe(201);
    const schedule = (await padded.json()) as CreateWorkflowScheduleResponse;
    expect(schedule.name).toBe("nightly");
  });

  it("400s a non-object input (a schedule fires it into every run's trigger payload)", async () => {
    api = await bootTestApi();
    const created = await createWorkflow(api.baseUrl);

    for (const badInput of ["a string", 42, ["array"]]) {
      const res = await fetch(`${api.baseUrl}/api/workflows/${created.id}/schedules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "nightly", cron: "0 9 * * *", input: badInput }),
      });
      expect(res.status).toBe(400);
    }

    const ok = await fetch(`${api.baseUrl}/api/workflows/${created.id}/schedules`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "nightly", cron: "0 9 * * *", input: { key: "value" } }),
    });
    expect(ok.status).toBe(201);
  });

  it("deleting the workflow deletes its schedules too", async () => {
    api = await bootTestApi();
    const created = await createWorkflow(api.baseUrl);
    await fetch(`${api.baseUrl}/api/workflows/${created.id}/schedules`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "nightly", cron: "0 9 * * *" }),
    });

    const del = await fetch(`${api.baseUrl}/api/workflows/${created.id}`, { method: "DELETE" });
    expect(del.status).toBe(200);

    // The workflow is gone, so the schedules route 404s — assert against
    // the store directly to prove the row itself was deleted, not just
    // made unreachable through the now-404ing management route.
    const rows = await api.providers.db
      .select()
      .from(workflowSchedules)
      .where(eq(workflowSchedules.workflowId, created.id));
    expect(rows).toEqual([]);
  });
});

