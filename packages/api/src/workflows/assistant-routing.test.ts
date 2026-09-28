import type { PluginActionContext } from "@valet/engine";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { assistants, sessionThreads, teamMembers, teams, workflowDefinitions } from "../schema/index.js";
import { workflowsActionPlugin } from "./actions.js";
import { buildWorkflowEngineDeps } from "./engine-deps.js";
import { copyWorkflowDefinition, createWorkflowDefinition, retryWorkflowRun, startWorkflowRun, updateWorkflowDefinition } from "./service.js";

let api: TestApi | undefined;
afterEach(async () => { await api?.cleanup(); api = undefined; });
const graph = { version: "dag/v1", nodes: [{ id: "start", type: "trigger" }, { id: "end", type: "stop" }], edges: [{ from: "start", to: "end" }] };
async function setup() {
  api = await bootTestApi();
  const p = api.providers;
  await p.db.insert(teams).values([
    { id: "team-a", orgId: "local-org", name: "A", createdAt: 1 },
    { id: "team-b", orgId: "local-org", name: "B", createdAt: 1 },
  ]);
  await p.db.insert(teamMembers).values([
    { teamId: "team-a", userId: "local-user", role: "admin" },
    { teamId: "team-b", userId: "local-user", role: "admin" },
  ]);
  await p.db.insert(assistants).values([
    { id: "default-a", orgId: "local-org", ownerType: "team", ownerId: "team-a", sessionId: "assistant:default-a", isDefault: true, createdAt: 1 },
    { id: "other", orgId: "local-org", ownerType: "team", ownerId: "team-b", sessionId: "assistant:other", isDefault: true, createdAt: 1 },
    { id: "personal", orgId: "local-org", ownerType: "user", ownerId: "local-user", sessionId: "assistant:personal", isDefault: true, createdAt: 1 },
  ]);
  return { api, p, deps: { db: p.db, workflowStore: p.workflowStore, workflowRunHost: p.workflowRunHost, credentials: p.engineCredentials, engineStore: p.engineStore } };
}
const owner = { userId: "local-user", orgId: "local-org" };

describe("workflow workspace routing", () => {
  it("rejects cross-team, foreign-org, missing and malformed selections through HTTP, including updates", async () => {
    const { api, p } = await setup();
    for (const assistantId of ["other", "foreign", "missing", 42, ""]) {
      const res = await fetch(`${api.baseUrl}/api/workflows`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Rejected", teamId: "team-a", definition: { ...graph, assistantId } }) });
      expect(res.status).toBe(400);
    }
    expect(await p.db.select().from(workflowDefinitions)).toEqual([]);
    const res = await fetch(`${api.baseUrl}/api/workflows`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Chosen", teamId: "team-a", definition: graph }) });
    expect(res.status).toBe(201);
    const created = await res.json() as { id: string; ownerType: string; ownerId: string };
    expect(created).toMatchObject({ ownerType: "team", ownerId: "team-a" });
    const rejected = await fetch(`${api.baseUrl}/api/workflows/${created.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ definition: { ...graph, assistantId: "other" } }) });
    expect(rejected.status).toBe(400);
    const saved = await (await fetch(`${api.baseUrl}/api/workflows/${created.id}`)).json();
    expect(saved).toMatchObject({ definition: graph });
  });

  it("creates team-owned workflows without assistant routing and rejects explicit overrides", async () => {
    const { p, deps } = await setup();
    const save = workflowsActionPlugin(() => deps).actions.find((a) => a.id === "workflows.save_workflow");
    if (!save) throw new Error("Missing save action");
    // This action only reads identity fields; credentials and sandbox are unused.
    const ctx = { ...owner, sessionId: "assistant:default-a", owner: { type: "team", id: "team-a" }, actionId: "workflows.save_workflow", service: "workflows" } as PluginActionContext;
    expect((await save.execute({ name: "Implicit", definition: graph }, ctx)).success).toBe(true);
    expect((await save.execute({ name: "Explicit", definition: { ...graph, assistantId: "default-a" } }, ctx)).success).toBe(false);
    const rows = await p.db.select().from(workflowDefinitions);
    expect(rows.find((r) => r.name === "Implicit")).toMatchObject({ ownerType: "team", ownerId: "team-a", definition: graph });
    expect(rows.find((r) => r.name === "Explicit")).toBeUndefined();
    const implicit = rows.find((r) => r.name === "Implicit");
    if (!implicit) throw new Error("Missing implicit workflow");
    const teamContext = { ...ctx, userId: "team:team-a" };
    // An unattended team run carries the synthetic team principal as its
    // user id and no actor. That is the team assistant acting for itself.
    expect((await save.execute({ workflow_id: implicit.id, name: "Unattended", definition: graph }, teamContext)).success).toBe(true);
    expect((await save.execute({ workflow_id: implicit.id, name: "Edited", definition: graph }, {
      ...teamContext, actor: { id: "local-user" },
    })).success).toBe(true);
    expect((await save.execute({ workflow_id: implicit.id, name: "Scheduled", definition: graph }, {
      ...teamContext, sessionPurpose: "workflow",
    })).success).toBe(true);
    // A team assistant has team reach, not its first user's other teams.
    const other = await createWorkflowDefinition(deps, owner, { name: "Other", teamId: "team-b", definition: graph });
    expect((await save.execute({ workflow_id: other.id, definition: graph }, ctx)).success).toBe(false);
  });

  it("admits the team principal itself and still refuses a departed member", async () => {
    const { deps } = await setup();
    const plugin = workflowsActionPlugin(() => deps);
    const save = plugin.actions.find((a) => a.id === "workflows.save_workflow");
    const list = plugin.actions.find((a) => a.id === "workflows.list_workflows");
    if (!save || !list) throw new Error("Missing workflows actions");
    // What the scheduler, the event dispatcher, and the webhook route
    // produce: a run with no acting user, so the engine fills the tool
    // context's user id from the team assistant session's own principal.
    const machine = {
      userId: "team:team-a",
      orgId: "local-org",
      sessionId: "assistant:default-a",
      owner: { type: "team", id: "team-a" },
      sessionPurpose: "orchestrator",
      actionId: "workflows.save_workflow",
      service: "workflows",
    } as PluginActionContext;

    const saved = await save.execute({ name: "Unattended", definition: graph }, machine);
    expect(saved).toMatchObject({ success: true });
    const listed = await list.execute({}, { ...machine, actionId: "workflows.list_workflows" });
    expect(listed.success).toBe(true);
    expect(listed.data).toMatchObject({ workflows: [{ name: "Unattended" }] });
    if (typeof saved.data !== "object" || saved.data === null || !("workflowId" in saved.data)) {
      throw new Error(`Save did not return a workflow id: ${JSON.stringify(saved)}`);
    }
    const workflowId = String(saved.data.workflowId);

    // A person who left the team keeps no reach through the same assistant.
    const departed = { ...machine, userId: "departed-user" } as PluginActionContext;
    expect((await save.execute({ workflow_id: workflowId, definition: graph }, departed)).success).toBe(false);
    const departedList = await list.execute({}, { ...departed, actionId: "workflows.list_workflows" });
    expect(departedList.data).toMatchObject({ workflows: [] });
  });

  it("copies definitions across workspaces without carrying an assistant identity", async () => {
    const { deps } = await setup();
    const team = await createWorkflowDefinition(deps, owner, { name: "Source", teamId: "team-a", definition: graph });
    const personal = await copyWorkflowDefinition(deps, owner, team.id);
    expect(personal?.ownerType).toBe("user");
    expect(personal?.definition).toEqual(graph);
    if (!personal) throw new Error("Missing copy");
    const sameOwner = await copyWorkflowDefinition(deps, owner, personal.id);
    expect(sameOwner?.definition).toEqual(personal.definition);
    const otherTeam = await copyWorkflowDefinition(deps, owner, personal.id, { teamId: "team-b", name: "Destination" });
    expect(otherTeam).toMatchObject({ ownerType: "team", ownerId: "team-b", definition: graph });
  });

  it("persists only direct active assistant origins and revalidates ownership", async () => {
    const { p, deps } = await setup();
    const created = await createWorkflowDefinition(deps, owner, {
      name: "Origin", teamId: "team-a", definition: graph,
    });
    const session = await p.engineHost.assistantSessionFor(
      "default-a",
      { actorUserId: owner.userId, orgId: owner.orgId },
      { sessionId: "assistant:default-a" },
    );
    const thread = await session.createThread("web:origin");
    const start = vi.spyOn(p.workflowRunHost, "start").mockResolvedValue();
    const action = workflowsActionPlugin(() => deps).actions.find((candidate) => candidate.id === "workflows.start_run");
    if (!action) throw new Error("Missing start action");
    const ctx = {
      ...owner,
      sessionId: "assistant:default-a",
      threadId: thread.id,
      owner: { type: "team", id: "team-a" },
      actionId: "workflows.start_run",
      service: "workflows",
    } as PluginActionContext;

    expect((await action.execute({ workflow_id: created.id }, ctx)).success).toBe(true);
    expect(start.mock.calls[0]?.[1]).toMatchObject({
      origin: { assistantSessionId: "assistant:default-a", threadId: thread.id },
    });

    // A session that is no assistant's carries no origin. The action does
    // not decide that: it hands its session and thread to the service,
    // which is the only validator.
    expect((await action.execute({ workflow_id: created.id }, { ...ctx, sessionId: "child-session" })).success).toBe(true);
    expect(start.mock.calls[1]?.[1]).not.toHaveProperty("origin");

    // The service's thread checks reach the action path too.
    const archived = await session.createThread("web:archived-origin");
    await p.db.insert(sessionThreads).values({
      id: archived.id, sessionId: "assistant:default-a", createdAt: Date.now(), archivedAt: Date.now(),
    });
    expect((await action.execute({ workflow_id: created.id }, { ...ctx, threadId: archived.id })).success).toBe(true);
    expect(start.mock.calls[2]?.[1]).not.toHaveProperty("origin");
    expect(await startWorkflowRun(deps, owner, created.id, undefined, {
      assistantSessionId: "assistant:other", threadId: thread.id,
    })).toBeTruthy();
    expect(start.mock.calls[3]?.[1]).not.toHaveProperty("origin");
  });

  it("starts a team workflow from a personal assistant on the originating thread", async () => {
    const { p, deps } = await setup();
    const created = await createWorkflowDefinition(deps, owner, {
      name: "Personal to team", teamId: "team-a", definition: graph,
    });
    const session = await p.engineHost.assistantSessionFor(
      "personal",
      { actorUserId: owner.userId, orgId: owner.orgId },
      { sessionId: "assistant:personal" },
    );
    const thread = await session.createThread("web:personal-origin");
    vi.spyOn(p.workflowRunHost, "start").mockImplementation(async (id, params, definition, runOwner) => {
      await p.workflowStore.createRun(id, params, definition, params.definitionVersionId, runOwner);
    });
    const action = workflowsActionPlugin(() => deps).actions.find((candidate) => candidate.id === "workflows.start_run");
    if (!action) throw new Error("Missing start action");
    const result = await action.execute({ workflow_id: created.id }, {
      ...owner,
      sessionId: "assistant:personal",
      threadId: thread.id,
      owner: { type: "user", id: owner.userId },
      actionId: "workflows.start_run",
      service: "workflows",
    } as PluginActionContext);
    if (!result.success || typeof result.data !== "object" || result.data === null || !("runId" in result.data)) {
      throw new Error(`Run did not start: ${JSON.stringify(result)}`);
    }
    const runId = String(result.data.runId);
    const run = await p.workflowStore.getRun(runId);
    expect(run).toMatchObject({
      owner: { ownerType: "team", ownerId: "team-a" },
      actorUserId: "local-user",
      params: { origin: { assistantSessionId: "assistant:personal", threadId: thread.id } },
    });

    const engine = buildWorkflowEngineDeps({
      db: p.db, host: p.engineHost, store: p.workflowStore, engineStore: p.engineStore,
      actionPluginByService: p.actionPluginByService, credentials: p.engineCredentials,
    });
    const receipt = await engine.promptOrchestrator("continue", {
      dispatchId: `workflow:${runId}:node`,
      queueMode: "followup",
      ownerHint: { ownerType: "team", ownerId: "team-a" },
    });
    expect(receipt).toMatchObject({ sessionId: "assistant:personal", threadId: thread.id });
    await p.db.delete(teamMembers).where(eq(teamMembers.teamId, "team-a"));
    await expect(engine.promptOrchestrator("team-private follow-up", {
      dispatchId: `workflow:${runId}:after-removal`,
      queueMode: "followup",
      ownerHint: { ownerType: "team", ownerId: "team-a" },
    })).rejects.toThrow("no longer a team member");
  });

  it("drops an origin whose thread is archived and dispatches elsewhere", async () => {
    const { p, deps } = await setup();
    const created = await createWorkflowDefinition(deps, owner, {
      name: "Archived origin", teamId: "team-a", definition: graph,
    });
    const session = await p.engineHost.assistantSessionFor(
      "default-a", { actorUserId: owner.userId, orgId: owner.orgId }, { sessionId: "assistant:default-a" },
    );
    const thread = await session.createThread("web:origin");
    // What `PATCH /api/sessions/:id/threads/:threadId` writes: the engine
    // thread stays, and the app mirror row records the archive.
    await p.db.insert(sessionThreads).values({
      id: thread.id, sessionId: "assistant:default-a", createdAt: Date.now(), archivedAt: Date.now(),
    });
    vi.spyOn(p.workflowRunHost, "start").mockImplementation(async (id, params, definition, runOwner) => {
      await p.workflowStore.createRun(id, params, definition, params.definitionVersionId, runOwner);
    });

    const started = await startWorkflowRun(deps, owner, created.id, undefined, {
      assistantSessionId: "assistant:default-a", threadId: thread.id,
    });
    if (!started || !("runId" in started)) throw new Error("Run not started");
    const run = await p.workflowStore.getRun(started.runId);
    expect(run?.params).not.toHaveProperty("origin");

    const engine = buildWorkflowEngineDeps({
      db: p.db, host: p.engineHost, store: p.workflowStore, engineStore: p.engineStore,
      actionPluginByService: p.actionPluginByService, credentials: p.engineCredentials,
    });
    const receipt = await engine.promptOrchestrator("report", {
      dispatchId: `workflow:${started.runId}:node1`, queueMode: "followup",
      ownerHint: { ownerType: "team", ownerId: "team-a" },
    });
    expect(receipt.threadId).not.toBe(thread.id);
  });

  it("retries a run whose origin thread is gone, without the origin", async () => {
    const { p, deps } = await setup();
    const created = await createWorkflowDefinition(deps, owner, {
      name: "Gone origin", teamId: "team-a", definition: graph,
    });
    const runId = "wfrun_origin_gone";
    await p.workflowStore.createRun(
      runId,
      {
        workflowId: created.id,
        definitionVersionId: "v1",
        input: { type: "manual", timestamp: "2026-09-14T00:00:00.000Z", data: {}, metadata: {} },
        origin: { assistantSessionId: "assistant:default-a", threadId: "th-deleted" },
      },
      created.definition,
      "v1",
      { ownerType: "team", ownerId: "team-a" },
    );
    await p.workflowStore.settleRun(runId, "failed");
    vi.spyOn(p.workflowRunHost, "start").mockImplementation(async (id, params, definition, runOwner) => {
      await p.workflowStore.createRun(id, params, definition, params.definitionVersionId, runOwner);
    });

    const retried = await retryWorkflowRun(deps, owner, runId);
    if (typeof retried === "string" || !("runId" in retried)) throw new Error(`Retry refused: ${JSON.stringify(retried)}`);
    const run = await p.workflowStore.getRun(retried.runId);
    expect(run?.params).not.toHaveProperty("origin");

    // The retry must also be able to dispatch: the missing thread used to
    // throw at the first orchestrator node.
    const engine = buildWorkflowEngineDeps({
      db: p.db, host: p.engineHost, store: p.workflowStore, engineStore: p.engineStore,
      actionPluginByService: p.actionPluginByService, credentials: p.engineCredentials,
    });
    const receipt = await engine.promptOrchestrator("report", {
      dispatchId: `workflow:${retried.runId}:node1`, queueMode: "followup",
      ownerHint: { ownerType: "team", ownerId: "team-a" },
    });
    expect(receipt.threadId).toBeTruthy();
  });

  it("routes every node and repair to the owning workspace and preserves the manual actor", async () => {
    const { p, deps } = await setup();
    const created = await createWorkflowDefinition(deps, owner, { name: "Pinned", teamId: "team-a", definition: graph });
    const unchanged = await updateWorkflowDefinition(deps, owner, created.id, { definition: graph });
    expect(unchanged).toMatchObject({ definition: graph });
    const start = vi.spyOn(p.workflowRunHost, "start").mockImplementation(async (id, params, definition, runOwner) => {
      await p.workflowStore.createRun(id, params, definition, params.definitionVersionId, runOwner);
    });
    const started = await startWorkflowRun(deps, owner, created.id);
    if (!started || !("runId" in started)) throw new Error("Run not started");
    expect(start.mock.calls[0]?.[3]).toEqual({ ownerType: "team", ownerId: "team-a", actorUserId: "local-user" });
    await updateWorkflowDefinition(deps, owner, created.id, { name: "Edited after run started", definition: graph });
    const hostSpy = vi.spyOn(p.engineHost, "assistantSessionFor");
    const engine = buildWorkflowEngineDeps({ db: p.db, host: p.engineHost, store: p.workflowStore, engineStore: p.engineStore, actionPluginByService: p.actionPluginByService, credentials: p.engineCredentials });
    for (const node of ["one", "two", "one:repair"]) {
      const receipt = await engine.promptOrchestrator("hello", { dispatchId: `workflow:${started.runId}:${node}`, queueMode: "followup", ownerHint: { ownerType: "team", ownerId: "team-a" } });
      expect(receipt.sessionId).toBe("assistant:default-a");
    }
    expect(hostSpy).toHaveBeenCalledWith("default-a", { actorUserId: "local-user", orgId: "local-org" }, { sessionId: "assistant:default-a" });
    const run = await p.workflowStore.getRun(started.runId);
    expect(run?.definition).toEqual(graph);
    expect(run?.owner).toEqual({ ownerType: "team", ownerId: "team-a" });

  });
});
