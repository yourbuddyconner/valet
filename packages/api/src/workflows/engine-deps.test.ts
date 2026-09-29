import { seedWorkspaceAssistant } from "../test-helpers/assistant-fixture.js";
/**
 * Unit tests for `buildWorkflowEngineDeps`'s Task 7/Task 6 seams:
 * `invokeAction` (now a real headless `ActionInvoker` with durable dedup —
 * plugin-system-v2 plan Task 6), `promptOrchestrator` (real `EngineHost`
 * orchestrator wiring, no LLM call required — `submitPrompt` returns before
 * the turn actually runs), and `llmComplete`'s no-network unknown-model
 * failure path. The key-gated real-Anthropic completion path is exercised
 * separately in `src/integration/workflow-engine-deps.test.ts`.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { Type } from "typebox";
import type { ActionPlugin, PluginAction, ValetPlugin } from "@valet/engine";
import type { WorkflowRunOrigin } from "@valet/workflow";
import type { Usage } from "@earendil-works/pi-ai/compat";
import * as piAi from "@earendil-works/pi-ai/compat";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@valet/engine/test-helpers";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { buildWorkflowEngineDeps, mapPiAiUsage } from "./engine-deps.js";
import { assistants, workflowDefinitions } from "../schema/index.js";
import { LOCAL_ORG, LOCAL_USER } from "../providers/node.js";
import { createLlmProvider } from "../services/llm-providers.js";
import { resolveDefaultAssistant } from "../assistants/service.js";

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
  vi.unstubAllEnvs();
});

async function seedRun(
  a: TestApi,
  runId: string,
  workflowId: string,
  origin?: WorkflowRunOrigin,
): Promise<void> {
  const { db, workflowStore } = a.providers;
  const now = Date.now();
  await db
    .insert(workflowDefinitions)
    .values({
      id: workflowId,
      orgId: LOCAL_ORG.id,
      ownerType: "user",
      ownerId: LOCAL_USER.id,
      name: "engine-deps-unit-test",
      definition: { version: "dag/v1", nodes: [], edges: [] },
      createdAt: now,
      updatedAt: now,
    });
  await workflowStore.createRun(
    runId,
    { workflowId, definitionVersionId: "v1", ...(origin ? { origin } : {}) },
    { version: "dag/v1", nodes: [], edges: [] },
    "v1",
    { ownerType: "user", ownerId: LOCAL_USER.id },
  );
}

/** Fixture `demo.ping` action — counts invocations and echoes whether a credential was resolved, so tests can assert dedup (no re-invocation) and the missing-credential-still-executes contract. */
function makeFixturePlugin(): { plugin: ValetPlugin; actionPlugin: ActionPlugin; calls: () => number } {
  let count = 0;
  const action: PluginAction = {
    id: "demo.ping",
    name: "ping",
    description: "ping",
    riskLevel: "low",
    parameters: Type.Object({ msg: Type.String() }),
    execute: async (args, ctx) => {
      count += 1;
      const credential = await ctx.credentials.get();
      return {
        success: true,
        data: { echoed: (args as { msg: string }).msg, hasCredential: credential !== null },
      };
    },
  };
  const actionPlugin: ActionPlugin = { service: "demo", actions: [action] };
  const plugin: ValetPlugin = { name: "demo", version: "0.0.1", actions: [actionPlugin] };
  return { plugin, actionPlugin, calls: () => count };
}

describe("buildWorkflowEngineDeps: invokeAction", () => {
  it("happy path: resolves the fixture action and returns {ok:true, result}", async () => {
    const fixture = makeFixturePlugin();
    api = await bootTestApi({ plugins: [fixture.plugin] });
    const { db, engineHost, engineStore, workflowStore, actionPluginByService, engineCredentials } = api.providers;
    const deps = buildWorkflowEngineDeps({
      host: engineHost,
      store: workflowStore,
      db,
      engineStore,
      actionPluginByService,
      credentials: engineCredentials,
    });

    const runId = "wfrun_invoke_happy";
    await seedRun(api, runId, "wf_invoke_happy");

    const result = await deps.invokeAction({
      service: "demo",
      action: "ping",
      params: { msg: "hello" },
      invocationId: `workflow:${runId}:node1`,
    });

    expect(result).toEqual({ ok: true, result: { echoed: "hello", hasCredential: false } });
    expect(fixture.calls()).toBe(1);
  });

  it("is idempotent by invocationId: a duplicate call executes the action ONCE and returns the identical original result", async () => {
    const fixture = makeFixturePlugin();
    api = await bootTestApi({ plugins: [fixture.plugin] });
    const { db, engineHost, engineStore, workflowStore, actionPluginByService, engineCredentials } = api.providers;
    const deps = buildWorkflowEngineDeps({
      host: engineHost,
      store: workflowStore,
      db,
      engineStore,
      actionPluginByService,
      credentials: engineCredentials,
    });

    const runId = "wfrun_invoke_dup";
    await seedRun(api, runId, "wf_invoke_dup");
    const req = {
      service: "demo",
      action: "ping",
      params: { msg: "dup" },
      invocationId: `workflow:${runId}:node1`,
    };

    const first = await deps.invokeAction(req);
    const second = await deps.invokeAction(req);

    expect(second).toEqual(first);
    expect(fixture.calls()).toBe(1);
  });

  it("unknown action: returns a stable {ok:false} that is also deduped (never invokes execute)", async () => {
    const fixture = makeFixturePlugin();
    api = await bootTestApi({ plugins: [fixture.plugin] });
    const { db, engineHost, engineStore, workflowStore, actionPluginByService, engineCredentials } = api.providers;
    const deps = buildWorkflowEngineDeps({
      host: engineHost,
      store: workflowStore,
      db,
      engineStore,
      actionPluginByService,
      credentials: engineCredentials,
    });

    const runId = "wfrun_invoke_unknown";
    await seedRun(api, runId, "wf_invoke_unknown");
    const req = {
      service: "demo",
      action: "does_not_exist",
      params: {},
      invocationId: `workflow:${runId}:node1`,
    };

    const first = await deps.invokeAction(req);
    const second = await deps.invokeAction(req);

    expect(first).toEqual({ ok: false, error: "unknown action: demo.does_not_exist" });
    expect(second).toEqual(first);
    expect(fixture.calls()).toBe(0);
  });

  it("param validation failure: missing required param returns {ok:false} and never invokes execute", async () => {
    const fixture = makeFixturePlugin();
    api = await bootTestApi({ plugins: [fixture.plugin] });
    const { db, engineHost, engineStore, workflowStore, actionPluginByService, engineCredentials } = api.providers;
    const deps = buildWorkflowEngineDeps({
      host: engineHost,
      store: workflowStore,
      db,
      engineStore,
      actionPluginByService,
      credentials: engineCredentials,
    });

    const runId = "wfrun_invoke_badparams";
    await seedRun(api, runId, "wf_invoke_badparams");

    const result = await deps.invokeAction({
      service: "demo",
      action: "ping",
      params: {},
      invocationId: `workflow:${runId}:node1`,
    });

    expect(result.ok).toBe(false);
    expect(fixture.calls()).toBe(0);
  });

  it("missing credential: the action still executes and sees credentials.get() === null", async () => {
    const fixture = makeFixturePlugin();
    api = await bootTestApi({ plugins: [fixture.plugin] });
    const { db, engineHost, engineStore, workflowStore, actionPluginByService, engineCredentials } = api.providers;
    const deps = buildWorkflowEngineDeps({
      host: engineHost,
      store: workflowStore,
      db,
      engineStore,
      actionPluginByService,
      credentials: engineCredentials,
    });

    const runId = "wfrun_invoke_nocred";
    await seedRun(api, runId, "wf_invoke_nocred");

    const result = await deps.invokeAction({
      service: "demo",
      action: "ping",
      params: { msg: "no creds here" },
      invocationId: `workflow:${runId}:node1`,
    });

    expect(result).toEqual({ ok: true, result: { echoed: "no creds here", hasCredential: false } });
    expect(fixture.calls()).toBe(1);
  });

  it("a team-owned run resolves a direct team credential, not the clicker's", async () => {
    const fixture = makeFixturePlugin();
    api = await bootTestApi({ plugins: [fixture.plugin] });
    const { db, engineHost, engineStore, workflowStore, actionPluginByService, engineCredentials } = api.providers;
    const { createTeam } = await import("../services/teams.js");
    const team = await createTeam(db, {
      orgId: LOCAL_ORG.id,
      name: "engine-deps-team",
      creatorUserId: LOCAL_USER.id,
    });
    await engineCredentials.save({ type: "team", id: team.id }, "demo", {
      type: "api_key",
      apiKey: "team-demo-key",
    });

    const now = Date.now();
    const workflowId = "wf_invoke_team";
    const runId = "wfrun_invoke_team";
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      orgId: LOCAL_ORG.id,
      ownerType: "team",
      ownerId: team.id,
      name: "team-engine-deps",
      definition: { version: "dag/v1", nodes: [], edges: [] },
      createdAt: now,
      updatedAt: now,
    });
    await workflowStore.createRun(
      runId,
      { workflowId, definitionVersionId: "v1" },
      { version: "dag/v1", nodes: [], edges: [] },
      "v1",
      { ownerType: "team", ownerId: team.id, actorUserId: LOCAL_USER.id },
    );

    const deps = buildWorkflowEngineDeps({
      host: engineHost,
      store: workflowStore,
      db,
      engineStore,
      actionPluginByService,
      credentials: engineCredentials,
    });
    const result = await deps.invokeAction({
      service: "demo",
      action: "ping",
      params: { msg: "team" },
      invocationId: `workflow:${runId}:node1`,
    });
    expect(result).toEqual({ ok: true, result: { echoed: "team", hasCredential: true } });
  });
});

describe("buildWorkflowEngineDeps: promptOrchestrator", () => {
  it("ensures the owner's DEFAULT assistant session and admits a followup signal envelope", async () => {
    api = await bootTestApi();
    const { db, engineHost, engineStore, workflowStore, actionPluginByService, engineCredentials } = api.providers;
    const deps = buildWorkflowEngineDeps({
      host: engineHost,
      store: workflowStore,
      db,
      engineStore,
      actionPluginByService,
      credentials: engineCredentials,
    });

    const runId = "wfrun_orch_unit";
    await seedRun(api, runId, "wf_orch_unit");

    const dispatchId = `workflow:${runId}:node1`;
    const receipt = await deps.promptOrchestrator("please look into this", {
      dispatchId,
      queueMode: "followup",
      ownerHint: { ownerType: "user", ownerId: LOCAL_USER.id },
    });

    // An `orchestrator` node names an owner, so the dispatch lands on that
    // owner's default assistant — the row `resolveDefaultAssistant` created.
    const defaultAssistant = await resolveDefaultAssistant(db, "local-org", { type: "user", id: LOCAL_USER.id });
    expect(receipt.sessionId).toBe(defaultAssistant.sessionId);
    expect(defaultAssistant).toBeDefined();
    expect(receipt.threadId).toBeTruthy();
    expect(receipt.queueItemId).toBeTruthy();

    // The assistant session actually exists and is live.
    const session = engineHost.liveSession(receipt.sessionId);
    expect(session).not.toBeNull();

    // The queued item carries the followup queueMode and the SignalContent
    // envelope shape (kind/signalType/body/attributes) — never a raw string
    // prompt. `attributes.runId` is what lets the client render a link back
    // to the run instead of a bare "workflow.request" label.
    const item = await engineStore.getQueueItem(receipt.sessionId, receipt.queueItemId);
    expect(item).toBeDefined();
    expect(item?.dispatchId).toBe(dispatchId);
    expect(item?.content).toEqual({
      kind: "signal",
      signalType: "workflow.request",
      body: "please look into this",
      attributes: { runId: "wfrun_orch_unit" },
      tagName: "signal",
    });
  });

  it("routes a team-owned run to the team's default assistant", async () => {
    api = await bootTestApi();
    const { db, engineHost, engineStore, workflowStore, actionPluginByService, engineCredentials } = api.providers;
    const { createTeam } = await import("../services/teams.js");
    const team = await createTeam(db, {
      orgId: LOCAL_ORG.id,
      name: "orchestrator-routing-team",
      creatorUserId: LOCAL_USER.id,
    });
    const workflowId = "wf_orch_team";
    const runId = "wfrun_orch_team";
    const now = Date.now();
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      orgId: LOCAL_ORG.id,
      ownerType: "team",
      ownerId: team.id,
      name: "team-orchestrator-routing",
      definition: { version: "dag/v1", nodes: [], edges: [] },
      createdAt: now,
      updatedAt: now,
    });
    await workflowStore.createRun(
      runId,
      { workflowId, definitionVersionId: "v1" },
      { version: "dag/v1", nodes: [], edges: [] },
      "v1",
      { ownerType: "team", ownerId: team.id, actorUserId: LOCAL_USER.id },
    );
    const deps = buildWorkflowEngineDeps({
      host: engineHost,
      store: workflowStore,
      db,
      engineStore,
      actionPluginByService,
      credentials: engineCredentials,
    });

    const receipt = await deps.promptOrchestrator("review team work", {
      dispatchId: `workflow:${runId}:node1`,
      queueMode: "followup",
      ownerHint: { ownerType: "team", ownerId: team.id },
    });

    const teamDefault = await resolveDefaultAssistant(db, LOCAL_ORG.id, { type: "team", id: team.id });
    const personalDefault = await resolveDefaultAssistant(db, LOCAL_ORG.id, { type: "user", id: LOCAL_USER.id });
    expect(receipt.sessionId).toBe(teamDefault.sessionId);
    expect(receipt.sessionId).not.toBe(personalDefault.sessionId);
  });

  it("reuses the exact assistant thread recorded as the run origin", async () => {
    api = await bootTestApi();
    const { db, engineHost, engineStore, workflowStore, actionPluginByService, engineCredentials } = api.providers;
    const assistant = await resolveDefaultAssistant(db, "local-org", { type: "user", id: LOCAL_USER.id });
    const session = await engineHost.assistantSessionFor(
      assistant.id,
      { actorUserId: LOCAL_USER.id, orgId: "local-org" },
      { sessionId: assistant.sessionId },
    );
    const originThread = await session.createThread("web:origin");
    const runId = "wfrun_orch_origin";
    await seedRun(api, runId, "wf_orch_origin", {
      assistantSessionId: assistant.sessionId,
      threadId: originThread.id,
    });
    const deps = buildWorkflowEngineDeps({
      host: engineHost, store: workflowStore, db, engineStore, actionPluginByService, credentials: engineCredentials,
    });

    const receipt = await deps.promptOrchestrator("continue here", {
      dispatchId: `workflow:${runId}:node1`,
      queueMode: "followup",
      ownerHint: { ownerType: "user", ownerId: LOCAL_USER.id },
    });
    expect(receipt).toMatchObject({ sessionId: assistant.sessionId, threadId: originThread.id });
  });

  it("reuses a legacy orchestrator-prefixed origin session", async () => {
    api = await bootTestApi();
    const { db, engineHost, engineStore, workflowStore, actionPluginByService, engineCredentials } = api.providers;
    // Rows migrated from `orchestrator_identities` keep their legacy
    // session id. The assistants table is the authority on which session
    // ids are assistant sessions, so an origin must resolve through it.
    const legacySessionId = `orchestrator:user:${LOCAL_USER.id}`;
    await db.insert(assistants).values({
      id: "legacy-assistant",
      orgId: LOCAL_ORG.id,
      ownerType: "user",
      ownerId: LOCAL_USER.id,
      sessionId: legacySessionId,
      createdAt: Date.now(),
    });
    const session = await engineHost.assistantSessionFor(
      "legacy-assistant",
      { actorUserId: LOCAL_USER.id, orgId: LOCAL_ORG.id },
      { sessionId: legacySessionId },
    );
    const originThread = await session.createThread("web:legacy-origin");
    const runId = "wfrun_orch_legacy_origin";
    await seedRun(api, runId, "wf_orch_legacy_origin", {
      assistantSessionId: legacySessionId,
      threadId: originThread.id,
    });
    const deps = buildWorkflowEngineDeps({
      host: engineHost, store: workflowStore, db, engineStore, actionPluginByService, credentials: engineCredentials,
    });

    const receipt = await deps.promptOrchestrator("continue here", {
      dispatchId: `workflow:${runId}:node1`,
      queueMode: "followup",
      ownerHint: { ownerType: "user", ownerId: LOCAL_USER.id },
    });
    expect(receipt).toMatchObject({ sessionId: legacySessionId, threadId: originThread.id });
  });

  it("rejects a missing durable origin thread without creating a replacement", async () => {
    api = await bootTestApi();
    const { db, engineHost, engineStore, workflowStore, actionPluginByService, engineCredentials } = api.providers;
    const assistant = await resolveDefaultAssistant(db, "local-org", { type: "user", id: LOCAL_USER.id });
    const session = await engineHost.assistantSessionFor(
      assistant.id,
      { actorUserId: LOCAL_USER.id, orgId: "local-org" },
      { sessionId: assistant.sessionId },
    );
    const before = session.listThreads().length;
    const runId = "wfrun_orch_missing_origin";
    await seedRun(api, runId, "wf_orch_missing_origin", {
      assistantSessionId: assistant.sessionId,
      threadId: "th-missing-origin",
    });
    const deps = buildWorkflowEngineDeps({
      host: engineHost, store: workflowStore, db, engineStore, actionPluginByService, credentials: engineCredentials,
    });

    await expect(deps.promptOrchestrator("continue here", {
      dispatchId: `workflow:${runId}:node1`,
      queueMode: "followup",
      ownerHint: { ownerType: "user", ownerId: LOCAL_USER.id },
    })).rejects.toThrow("origin thread");
    expect(session.listThreads()).toHaveLength(before);
  });

  it("is idempotent by dispatchId: a duplicate dispatch returns the original receipt", async () => {
    api = await bootTestApi();
    const { db, engineHost, engineStore, workflowStore, actionPluginByService, engineCredentials } = api.providers;
    const deps = buildWorkflowEngineDeps({
      host: engineHost,
      store: workflowStore,
      db,
      engineStore,
      actionPluginByService,
      credentials: engineCredentials,
    });

    const runId = "wfrun_orch_dup";
    await seedRun(api, runId, "wf_orch_dup");

    const dispatchId = `workflow:${runId}:node1`;
    const opts = {
      dispatchId,
      queueMode: "followup" as const,
      ownerHint: { ownerType: "user", ownerId: LOCAL_USER.id },
    };

    const first = await deps.promptOrchestrator("noted please", opts);
    const second = await deps.promptOrchestrator("noted please", opts);

    expect(second).toEqual(first);
  });

  it("groups every prompt from the same run onto one thread", async () => {
    api = await bootTestApi();
    const { db, engineHost, engineStore, workflowStore, actionPluginByService, engineCredentials } = api.providers;
    const deps = buildWorkflowEngineDeps({
      host: engineHost,
      store: workflowStore,
      db,
      engineStore,
      actionPluginByService,
      credentials: engineCredentials,
    });

    const runId = "wfrun_orch_thread";
    await seedRun(api, runId, "wf_orch_thread");

    const first = await deps.promptOrchestrator("first node's ask", {
      dispatchId: `workflow:${runId}:node1`,
      queueMode: "followup",
      ownerHint: { ownerType: "user", ownerId: LOCAL_USER.id },
    });
    const second = await deps.promptOrchestrator("second node's ask", {
      dispatchId: `workflow:${runId}:node2`,
      queueMode: "followup",
      ownerHint: { ownerType: "user", ownerId: LOCAL_USER.id },
    });

    expect(second.threadId).toBe(first.threadId);
    expect(second.sessionId).toBe(first.sessionId);
  });

  it("gives every run its own thread on the one assistant", async () => {
    api = await bootTestApi();
    const { db, engineHost, engineStore, workflowStore, actionPluginByService, engineCredentials } = api.providers;
    const deps = buildWorkflowEngineDeps({ host: engineHost, store: workflowStore, db, engineStore,
      actionPluginByService, credentials: engineCredentials });
    await seedRun(api, "run_first", "wf_shared");
    await workflowStore.createRun("run_second", { workflowId: "wf_shared", definitionVersionId: "v1" },
      { version: "dag/v1", nodes: [], edges: [] }, "v1", { ownerType: "user", ownerId: LOCAL_USER.id });
    await seedRun(api, "run_other", "wf_other");
    const submit = (runId: string) => deps.promptOrchestrator("report", {
      dispatchId: `workflow:${runId}:node1`, queueMode: "followup",
      ownerHint: { ownerType: "user", ownerId: LOCAL_USER.id },
    });
    const [first, second] = await Promise.all([submit("run_first"), submit("run_second")]);
    // Two runs of ONE definition. Each keeps its own thread, so neither
    // waits behind the other's turn, gate, or Stop.
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.threadId).not.toBe(first.threadId);
    expect(second.queueItemId).not.toBe(first.queueItemId);
    const session = engineHost.liveSession(first.sessionId);
    expect(session?.threadById(first.threadId)?.key).toBe("signal:workflow:run_first");
    expect(session?.threadById(second.threadId)?.key).toBe("signal:workflow:run_second");
    expect(await submit("run_first")).toEqual(first);
    expect((await submit("run_other")).threadId).not.toBe(first.threadId);
    const item = await engineStore.getQueueItem(second.sessionId, second.queueItemId);
    expect(item?.content).toMatchObject({ attributes: { runId: "run_second" } });
  });

  it("aborts one run's thread and leaves another run's queued work alone", async () => {
    api = await bootTestApi();
    const { db, engineHost, engineStore, workflowStore, actionPluginByService, engineCredentials } = api.providers;
    const deps = buildWorkflowEngineDeps({ host: engineHost, store: workflowStore, db, engineStore,
      actionPluginByService, credentials: engineCredentials });
    await seedRun(api, "run_stopped", "wf_stop");
    await workflowStore.createRun("run_spared", { workflowId: "wf_stop", definitionVersionId: "v1" },
      { version: "dag/v1", nodes: [], edges: [] }, "v1", { ownerType: "user", ownerId: LOCAL_USER.id });
    const submit = (runId: string) => deps.promptOrchestrator("report", {
      dispatchId: `workflow:${runId}:node1`, queueMode: "followup",
      ownerHint: { ownerType: "user", ownerId: LOCAL_USER.id },
    });
    const stopped = await submit("run_stopped");
    const spared = await submit("run_spared");

    // The thread Stop button: `POST /threads/:id/abort` aborts the whole
    // thread. It must reach one run only.
    const session = engineHost.liveSession(stopped.sessionId);
    if (!session) throw new Error("Assistant session is not live");
    await session.abort({ threadId: stopped.threadId });

    expect((await engineStore.getQueueItem(stopped.sessionId, stopped.queueItemId))?.status).toBe("settled");
    expect((await engineStore.getQueueItem(spared.sessionId, spared.queueItemId))?.status).not.toBe("settled");
  });

  it("keeps a second run moving while the first parks on an approval gate", async () => {
    // The incident this reverts: a gate holds its thread's claim until
    // someone answers it (72 hours by default), and a thread runs its queue
    // in series. On a shared thread, the second run of the same workflow
    // waited behind the first run's unanswered approval.
    const faux = registerFauxProvider({ api: "anthropic-messages", provider: "anthropic" });
    vi.stubEnv("ANTHROPIC_API_KEY", "faux-key");
    try {
      const gated: PluginAction = {
        id: "demo.review",
        name: "review",
        description: "critical-risk fixture action, so calling it opens an approval gate",
        riskLevel: "critical",
        parameters: Type.Object({}),
        execute: async () => ({ success: true, data: { reviewed: true } }),
      };
      const plugin: ValetPlugin = {
        name: "demo", version: "0.0.1",
        actions: [{ service: "demo", actions: [gated] }],
      };
      api = await bootTestApi({ plugins: [plugin] });
      const { db, engineHost, engineStore, workflowStore, actionPluginByService, engineCredentials } = api.providers;
      const deps = buildWorkflowEngineDeps({ host: engineHost, store: workflowStore, db, engineStore,
        actionPluginByService, credentials: engineCredentials });
      await seedRun(api, "run_parked", "wf_gate");
      await workflowStore.createRun("run_next", { workflowId: "wf_gate", definitionVersionId: "v1" },
        { version: "dag/v1", nodes: [], edges: [] }, "v1", { ownerType: "user", ownerId: LOCAL_USER.id });
      const submit = (runId: string, text: string) => deps.promptOrchestrator(text, {
        dispatchId: `workflow:${runId}:node1`, queueMode: "followup",
        ownerHint: { ownerType: "user", ownerId: LOCAL_USER.id },
      });

      // The first run's turn calls the critical-risk action and blocks.
      faux.setResponses([
        fauxAssistantMessage(
          [fauxToolCall("call_tool", { tool_id: "demo.review", params: {}, summary: "review it" }, { id: "tc-gate" })],
          { stopReason: "toolUse" },
        ),
      ]);
      const parked = await submit("run_parked", "first run");
      await vi.waitFor(async () => {
        const gates = await engineStore.listDecisionGates(parked.sessionId, parked.threadId);
        expect(gates.filter((gate) => gate.status === "pending")).toHaveLength(1);
      }, { timeout: 15_000, interval: 50 });

      // The second run of the SAME workflow, dispatched while that gate is
      // open. Its own thread lets its turn run and settle.
      faux.appendResponses([fauxAssistantMessage("second run reported")]);
      const next = await submit("run_next", "second run");
      expect(next.sessionId).toBe(parked.sessionId);
      expect(next.threadId).not.toBe(parked.threadId);
      await vi.waitFor(async () => {
        expect((await engineStore.getQueueItem(next.sessionId, next.queueItemId))?.status).toBe("settled");
      }, { timeout: 15_000, interval: 50 });

      // The first run is still waiting for its answer, as it should be.
      expect((await engineStore.getQueueItem(parked.sessionId, parked.queueItemId))?.status).not.toBe("settled");
      const stillPending = await engineStore.listDecisionGates(parked.sessionId, parked.threadId);
      expect(stillPending.filter((gate) => gate.status === "pending")).toHaveLength(1);
    } finally {
      faux.unregister();
    }
  });

  it("keeps an existing per-run thread for retries after an upgrade", async () => {
    api = await bootTestApi();
    const { db, engineHost, engineStore, workflowStore, actionPluginByService, engineCredentials } = api.providers;
    const deps = buildWorkflowEngineDeps({ host: engineHost, store: workflowStore, db, engineStore,
      actionPluginByService, credentials: engineCredentials });
    await seedRun(api, "run_legacy", "wf_legacy");
    const assistant = await resolveDefaultAssistant(db, LOCAL_ORG.id, { type: "user", id: LOCAL_USER.id });
    const session = await engineHost.assistantSessionFor(assistant.id,
      { actorUserId: LOCAL_USER.id, orgId: LOCAL_ORG.id }, { sessionId: assistant.sessionId });
    const oldThread = session.thread("signal:workflow:run_legacy");
    const dispatchId = "workflow:run_legacy:node1";
    const original = await oldThread.submitPrompt({ kind: "signal", signalType: "workflow.request",
      body: "report", attributes: { runId: "run_legacy" } }, { dispatchId, queueMode: "followup" });
    const retried = await deps.promptOrchestrator("report", { dispatchId, queueMode: "followup",
      ownerHint: { ownerType: "user", ownerId: LOCAL_USER.id } });
    expect(retried).toEqual({ sessionId: session.id, threadId: oldThread.id, queueItemId: original.queueItemId });
  });

  it("throws a descriptive error for a run with no recorded owner", async () => {
    api = await bootTestApi();
    const { db, engineHost, engineStore, workflowStore, actionPluginByService, engineCredentials } = api.providers;
    const deps = buildWorkflowEngineDeps({
      host: engineHost,
      store: workflowStore,
      db,
      engineStore,
      actionPluginByService,
      credentials: engineCredentials,
    });

    const runId = "wfrun_orch_no_owner";
    const workflowId = "wf_orch_no_owner";
    const now = Date.now();
    await db
      .insert(workflowDefinitions)
      .values({
        id: workflowId,
        orgId: LOCAL_ORG.id,
        ownerType: "user",
        ownerId: LOCAL_USER.id,
        name: "no-owner-run",
        definition: { version: "dag/v1", nodes: [], edges: [] },
        createdAt: now,
        updatedAt: now,
      });
    await workflowStore.createRun(
      runId,
      { workflowId, definitionVersionId: "v1" },
      { version: "dag/v1", nodes: [], edges: [] },
      "v1",
      // no owner passed
    );

    await expect(
      deps.promptOrchestrator("hello", {
        dispatchId: `workflow:${runId}:node1`,
        queueMode: "followup",
        ownerHint: { ownerType: "user", ownerId: LOCAL_USER.id },
      }),
    ).rejects.toThrow(/no recorded owner/);
  });
});

describe("buildWorkflowEngineDeps: llmComplete", () => {
  it.each([
    ["openai/gpt-6-astra", false], ["gpt-6-astra", false], ["gpt-6-astra", true],
  ] as const)("completes with supplemental model %s (Anthropic disabled: %s)", async (model, disableAnthropic) => {
    vi.stubEnv("OPENAI_API_KEY", "test-openai-key");
    const original = piAi.getApiProvider("openai-responses");
    if (!original) throw new Error("The OpenAI Responses transport must be registered.");
    const stream = vi.fn<piAi.ApiStreamSimpleFunction>(() => {
      const events = piAi.createAssistantMessageEventStream();
      events.end(fauxAssistantMessage("ok"));
      return events;
    });
    // API tests reuse modules across files. Override the transport so an
    // earlier import of engine-deps cannot bypass this test's fake response.
    piAi.registerApiProvider({ api: "openai-responses", stream, streamSimple: stream });
    try {
      api = await bootTestApi();
      const { db, engineHost, engineStore, workflowStore, actionPluginByService, engineCredentials } = api.providers;
      const deps = buildWorkflowEngineDeps({
        host: engineHost, store: workflowStore, db, engineStore,
        actionPluginByService, credentials: engineCredentials,
      });

      if (disableAnthropic) {
        await createLlmProvider(db, {
          orgId: LOCAL_ORG.id, kind: "anthropic", name: "Anthropic", enabled: false,
        });
      }
      const runId = `wfrun_llm_${model.includes("/") ? "namespaced" : "bare"}`;
      await seedRun(api, runId, `wf_llm_${model.includes("/") ? "namespaced" : "bare"}`);
      const result = await deps.llmComplete({ runId, model, prompt: "hi" });
      expect(result.text).toBe("ok");
      expect(stream).toHaveBeenCalledWith(expect.objectContaining({
        id: "gpt-6-astra", provider: "openai", contextWindow: 272_000,
        compat: expect.objectContaining({ supportsToolSearch: true }),
      }), expect.anything(), expect.anything());
    } finally {
      piAi.registerApiProvider(original);
    }
  });

  it.each(["error", "aborted"] as const)("rejects a provider %s response instead of returning empty success", async (stopReason) => {
    vi.stubEnv("OPENAI_API_KEY", "test-openai-key");
    const original = piAi.getApiProvider("openai-responses");
    if (!original) throw new Error("OpenAI transport is required");
    const stream = vi.fn<piAi.ApiStreamSimpleFunction>(() => {
      const events = piAi.createAssistantMessageEventStream();
      events.end({ ...fauxAssistantMessage(""), stopReason, errorMessage: "Provider rejected this model" });
      return events;
    });
    piAi.registerApiProvider({ api: "openai-responses", stream, streamSimple: stream });
    try {
      api = await bootTestApi();
      const { db, engineHost, engineStore, workflowStore, actionPluginByService, engineCredentials } = api.providers;
      const deps = buildWorkflowEngineDeps({ host: engineHost, store: workflowStore, db, engineStore, actionPluginByService, credentials: engineCredentials });
      const runId = `wfrun_provider_${stopReason}`;
      await seedRun(api, runId, `wf_provider_${stopReason}`);
      await expect(deps.llmComplete({ runId, model: "openai/gpt-6-astra", prompt: "hi" })).rejects.toThrow('Provider rejected this model');
    } finally { piAi.registerApiProvider(original); }
  });

  it("throws descriptively for an unknown model id, without any network call", async () => {
    api = await bootTestApi();
    const { db, engineHost, engineStore, workflowStore, actionPluginByService, engineCredentials } = api.providers;
    const deps = buildWorkflowEngineDeps({
      host: engineHost,
      store: workflowStore,
      db,
      engineStore,
      actionPluginByService,
      credentials: engineCredentials,
    });

    const runId = "wfrun_llm_unknown";
    await seedRun(api, runId, "wf_llm_unknown");
    await expect(
      deps.llmComplete({ runId, model: "definitely-not-a-real-model-id", prompt: "hi" }),
    ).rejects.toThrow(/unknown or unavailable model/);
  });
});

describe("mapPiAiUsage", () => {
  it("maps every field, not a subset — this is the fix for the completion usage that used to be silently discarded", () => {
    const usage: Usage = {
      input: 120,
      output: 30,
      cacheRead: 5,
      cacheWrite: 2,
      totalTokens: 157,
      cost: { input: 0.001, output: 0.002, cacheRead: 0.00001, cacheWrite: 0.00002, total: 0.00303 },
    };

    expect(mapPiAiUsage(usage)).toEqual({
      inputTokens: 120,
      outputTokens: 30,
      cacheReadTokens: 5,
      cacheWriteTokens: 2,
      totalTokens: 157,
      costUsd: 0.00303,
    });
  });

  it("passes through zeros unchanged (no accidental truthiness/default-value bugs)", () => {
    const usage: Usage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };

    expect(mapPiAiUsage(usage)).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
      costUsd: 0,
    });
  });
});
