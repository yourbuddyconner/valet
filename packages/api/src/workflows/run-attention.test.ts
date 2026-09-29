import { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { NodeCheckpoint, RunSettledInfo } from "@valet/workflow";
import { applyAppMigrations, buildAppDb, buildAppQueryable, type AppDb } from "../lib/drizzle.js";
import { notifications, sessionThreads, workflowDefinitions } from "../schema/index.js";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { LOCAL_ORG, LOCAL_USER } from "../providers/node.js";
import { buildWorkflowEngineDeps } from "./engine-deps.js";
import {
  buildRunSettledAttention,
  buildRunThreadArchive,
  failedNodeSummary,
  workflowApprovalHref,
} from "./run-attention.js";

function checkpoint(overrides: Partial<NodeCheckpoint> & { nodeId: string }): NodeCheckpoint {
  return {
    runId: "run-1",
    iteration: 0,
    status: "completed",
    attempt: 1,
    createdAt: 1_000,
    ...overrides,
  };
}

function settled(overrides: Partial<RunSettledInfo> = {}): RunSettledInfo {
  return {
    runId: "run-1",
    workflowId: "wf-1",
    outcome: "failed",
    owner: { ownerType: "user", ownerId: "u-1" },
    settledAt: 5_000,
    ...overrides,
  };
}

describe("failedNodeSummary", () => {
  it("names the failed nodes and their errors", () => {
    const summary = failedNodeSummary([
      checkpoint({ nodeId: "fetch", status: "completed" }),
      checkpoint({ nodeId: "call-api", status: "failed", error: "HTTP 500" }),
    ]);
    expect(summary).toBe("call-api: HTTP 500. Open the run to see the full error.");
  });

  it("labels a foreach body row with its iteration and counts the rest", () => {
    const summary = failedNodeSummary([
      checkpoint({ nodeId: "body", iteration: 1, status: "failed", error: "a" }),
      checkpoint({ nodeId: "body", iteration: 2, status: "failed", error: "b" }),
      checkpoint({ nodeId: "body", iteration: 3, status: "failed", error: "c" }),
    ]);
    expect(summary).toBe("body[1]: a; body[2]: b (+1 more). Open the run to see the full error.");
  });

  it("still directs the reader to the run when no checkpoint failed", () => {
    const summary = failedNodeSummary([checkpoint({ nodeId: "t" })]);
    expect(summary).toBe("Open the run to see why it stopped.");
  });

  it("truncates a long error rather than pasting a whole response body", () => {
    const summary = failedNodeSummary([checkpoint({ nodeId: "n", status: "failed", error: "x".repeat(500) })]);
    expect(summary).toContain("…");
    expect(summary.length).toBeLessThan(300);
  });
});

describe("buildRunSettledAttention", () => {
  let db: AppDb;
  let pglite: PGlite;

  const store = {
    getCheckpoints: async (): Promise<NodeCheckpoint[]> => [
      checkpoint({ nodeId: "call-api", status: "failed", error: "HTTP 500" }),
    ],
  };

  beforeAll(async () => {
    pglite = new PGlite();
    await applyAppMigrations(buildAppQueryable(pglite));
    db = buildAppDb(pglite);
  });

  afterAll(async () => {
    await pglite.close();
  });

  beforeEach(async () => {
    await buildAppQueryable(pglite).query(
      `TRUNCATE workflow_definitions, notifications RESTART IDENTITY CASCADE`,
    );
    await db.insert(workflowDefinitions).values({
      id: "wf-1",
      orgId: "org-1",
      ownerType: "user",
      ownerId: "u-1",
      name: "Customer artifacts",
      definition: { version: "dag/v1", nodes: [], edges: [] },
      createdAt: 1_000,
      updatedAt: 1_000,
    });
  });

  it("notifies the owner of a failed top-level run, naming the workflow and the failed node", async () => {
    await buildRunSettledAttention({ db, store })(settled());

    const rows = await db.select().from(notifications);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId: "u-1",
      kind: "notification",
      urgency: "high",
      title: "Workflow run failed: Customer artifacts",
      body: "call-api: HTTP 500. Open the run to see the full error.",
      href: "/workflows/runs/run-1",
    });
  });

  it("inserts once when the settle is reported twice", async () => {
    const notify = buildRunSettledAttention({ db, store });
    await notify(settled());
    await notify(settled());

    expect(await db.select().from(notifications)).toHaveLength(1);
  });

  it("stays silent for a child run, so a batch fan-out cannot flood the table", async () => {
    await buildRunSettledAttention({ db, store })(
      settled({ runId: "child-1", parentRunId: "run-1", parentNodeId: "call", parentIteration: 0 }),
    );

    expect(await db.select().from(notifications)).toHaveLength(0);
  });

  it("stays silent for a completed or cancelled run", async () => {
    const notify = buildRunSettledAttention({ db, store });
    await notify(settled({ outcome: "completed" }));
    await notify(settled({ outcome: "cancelled" }));

    expect(await db.select().from(notifications)).toHaveLength(0);
  });

  it("stays silent when the run recorded no owner", async () => {
    await buildRunSettledAttention({ db, store })(settled({ owner: undefined }));

    expect(await db.select().from(notifications)).toHaveLength(0);
  });

  it("falls back to the workflow id when the definition has been deleted", async () => {
    await buildRunSettledAttention({ db, store })(settled({ workflowId: "wf-gone" }));

    const rows = await db.select().from(notifications);
    expect(rows[0]?.title).toBe("Workflow run failed: wf-gone");
  });

  it("swallows a store fault, because a throw here would abandon the drive", async () => {
    const brokenStore = {
      getCheckpoints: async (): Promise<NodeCheckpoint[]> => {
        throw new Error("store unreachable");
      },
    };

    await expect(buildRunSettledAttention({ db, store: brokenStore })(settled())).resolves.toBeUndefined();
    expect(await db.select().from(notifications)).toHaveLength(0);
  });
});

describe("buildRunThreadArchive", () => {
  let api: TestApi | undefined;
  afterEach(async () => { await api?.cleanup(); api = undefined; });

  /** Seeds one definition and one run of it, both owned by the local user. */
  async function seedRun(a: TestApi, runId: string, workflowId: string, origin?: { assistantSessionId: string; threadId: string }) {
    const now = Date.now();
    await a.providers.db.insert(workflowDefinitions).values({
      id: workflowId, orgId: LOCAL_ORG.id, ownerType: "user", ownerId: LOCAL_USER.id,
      name: "thread-archive-test", definition: { version: "dag/v1", nodes: [], edges: [] },
      createdAt: now, updatedAt: now,
    }).onConflictDoNothing();
    await a.providers.workflowStore.createRun(
      runId,
      { workflowId, definitionVersionId: "v1", ...(origin ? { origin } : {}) },
      { version: "dag/v1", nodes: [], edges: [] },
      "v1",
      { ownerType: "user", ownerId: LOCAL_USER.id },
    );
  }

  /** Records the receipt the orchestrator node persists after it dispatches. */
  async function recordDispatch(a: TestApi, runId: string, receipt: { sessionId: string; threadId: string; queueItemId: string }) {
    await a.providers.workflowStore.putIntent({
      runId, nodeId: "node1", iteration: 0, status: "intent", attempt: 1, createdAt: Date.now(),
      effects: {
        sessionId: receipt.sessionId,
        receipt: { threadId: receipt.threadId, queueItemId: receipt.queueItemId },
        repairAttempted: false,
      },
    });
  }

  function settledRun(runId: string, workflowId: string): RunSettledInfo {
    return {
      runId, workflowId, outcome: "completed",
      owner: { ownerType: "user", ownerId: LOCAL_USER.id }, settledAt: 5_000,
    };
  }

  it("archives the settled run's own thread and leaves a live run's thread alone", async () => {
    api = await bootTestApi();
    const { db, engineHost, engineStore, workflowStore, actionPluginByService, engineCredentials } = api.providers;
    const deps = buildWorkflowEngineDeps({
      host: engineHost, store: workflowStore, db, engineStore, actionPluginByService, credentials: engineCredentials,
    });
    await seedRun(api, "run_done", "wf_archive");
    await seedRun(api, "run_live", "wf_archive");
    const dispatch = (runId: string) => deps.promptOrchestrator("report", {
      dispatchId: `workflow:${runId}:node1`, queueMode: "followup",
      ownerHint: { ownerType: "user", ownerId: LOCAL_USER.id },
    });
    const done = await dispatch("run_done");
    const live = await dispatch("run_live");
    await recordDispatch(api, "run_done", done);
    await recordDispatch(api, "run_live", live);
    // The settled run reported before it stopped: its turn is over, so the
    // thread has nothing left to show and the archive may take it.
    await engineStore.forceSettle(done.sessionId, done.queueItemId, "failed");

    await buildRunThreadArchive({ db, store: workflowStore, engineStore })(settledRun("run_done", "wf_archive"));

    const rows = await db.select().from(sessionThreads);
    expect(rows).toEqual([
      expect.objectContaining({ id: done.threadId, sessionId: done.sessionId, archivedAt: 5_000 }),
    ]);
    expect(rows.find((r) => r.id === live.threadId)).toBeUndefined();
  });

  it("keeps the thread of a run that settled while its assistant turn is unsettled", async () => {
    // An orchestrator node with `wait: { mode: "none" }` completes its
    // checkpoint at dispatch, so the run can settle while the prompt is
    // still queued. Archiving here hides the thread before it carries the
    // report the person is waiting for.
    api = await bootTestApi();
    const { db, engineHost, engineStore, workflowStore, actionPluginByService, engineCredentials } = api.providers;
    const deps = buildWorkflowEngineDeps({
      host: engineHost, store: workflowStore, db, engineStore, actionPluginByService, credentials: engineCredentials,
    });
    await seedRun(api, "run_open", "wf_archive");
    const open = await deps.promptOrchestrator("report", {
      dispatchId: "workflow:run_open:node1", queueMode: "followup",
      ownerHint: { ownerType: "user", ownerId: LOCAL_USER.id },
    });
    await recordDispatch(api, "run_open", open);
    const item = await engineStore.getQueueItem(open.sessionId, open.queueItemId);
    expect(item?.status).not.toBe("settled");

    await buildRunThreadArchive({ db, store: workflowStore, engineStore })(settledRun("run_open", "wf_archive"));

    expect(await db.select().from(sessionThreads)).toEqual([]);
  });

  it("leaves the origin thread of an attended run in the sidebar", async () => {
    api = await bootTestApi();
    const { db, engineHost, engineStore, workflowStore, actionPluginByService, engineCredentials } = api.providers;
    const { resolveDefaultAssistant } = await import("../assistants/service.js");
    const assistant = await resolveDefaultAssistant(db, LOCAL_ORG.id, { type: "user", id: LOCAL_USER.id });
    const session = await engineHost.assistantSessionFor(
      assistant.id, { actorUserId: LOCAL_USER.id, orgId: LOCAL_ORG.id }, { sessionId: assistant.sessionId },
    );
    const originThread = await session.createThread("web:origin");
    await seedRun(api, "run_attended", "wf_attended", {
      assistantSessionId: assistant.sessionId, threadId: originThread.id,
    });
    const deps = buildWorkflowEngineDeps({
      host: engineHost, store: workflowStore, db, engineStore, actionPluginByService, credentials: engineCredentials,
    });
    const receipt = await deps.promptOrchestrator("report", {
      dispatchId: "workflow:run_attended:node1", queueMode: "followup",
      ownerHint: { ownerType: "user", ownerId: LOCAL_USER.id },
    });
    expect(receipt.threadId).toBe(originThread.id);
    await recordDispatch(api, "run_attended", receipt);

    await buildRunThreadArchive({ db, store: workflowStore, engineStore })(settledRun("run_attended", "wf_attended"));

    expect(await db.select().from(sessionThreads)).toEqual([]);
  });

  it("swallows a store fault, because a throw here would abandon the drive", async () => {
    api = await bootTestApi();
    const { db, engineStore } = api.providers;
    const brokenStore = {
      getCheckpoints: async (): Promise<NodeCheckpoint[]> => { throw new Error("store unreachable"); },
    };

    await expect(
      buildRunThreadArchive({ db, store: brokenStore, engineStore })(settledRun("run_broken", "wf_broken")),
    ).resolves.toBeUndefined();
    expect(await db.select().from(sessionThreads)).toEqual([]);
  });
});

describe("workflowApprovalHref", () => {
  it("deep-links to the run and encodes the gate target", () => {
    expect(workflowApprovalHref("run/1", "approve me")).toBe(
      "/workflows/runs/run%2F1?gate=approve%20me",
    );
  });
});
