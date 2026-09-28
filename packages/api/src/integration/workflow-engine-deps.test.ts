/**
 * Integration test: `buildWorkflowEngineDeps` (Phase 5 plan Task 10, Task 7
 * of the node-completion plan) over a real `EngineHost` + real Anthropic
 * call.
 *
 *  - `createSession -> prompt -> awaitResult` round-trips one trivial
 *    session-node turn and asserts duplicate-`dispatchId` idempotency.
 *  - `llm node end-to-end through a run` drives a real
 *    `trigger -> llm -> stop` definition through the actual `LocalRunHost`
 *    (no stub), asserting the `llm` node's checkpoint carries a real
 *    completion with `outputSchema`-validated `output` — i.e. Task 7's
 *    `llmComplete` seam (pi-ai `getModel` + `completeSimple`) actually
 *    drives a node to completion, not just a bare API call.
 *
 * Real-provider cases skip without `ANTHROPIC_API_KEY`. A keyless HTTP
 * regression verifies repeated orchestrator runs with a substituted model transport.
 */
import { describe, it, expect, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as piAi from "@earendil-works/pi-ai/compat";
import { fauxAssistantMessage } from "@valet/engine/test-helpers";
import { bootTestApi } from "./_setup.js";
import { buildWorkflowEngineDeps } from "../workflows/engine-deps.js";
import { sessionThreads, workflowDefinitions } from "../schema/index.js";
import { LOCAL_ORG, LOCAL_USER } from "../providers/node.js";
import type {
  CreateWorkflowResponse,
  GetWorkflowRunResponse,
  StartWorkflowRunResponse,
} from "../wire/types.js";

const describeIfKey = process.env.ANTHROPIC_API_KEY ? describe : describe.skip;
const MODEL = "claude-haiku-4-5";

describeIfKey("api integration: workflow engine-deps", () => {
  it(
    "createSession -> prompt -> awaitResult round-trips a real turn; duplicate dispatchId returns the original receipt",
    async () => {
      const api = await bootTestApi();
      try {
        const { db, engineHost, engineStore, workflowStore, actionPluginByService, engineCredentials } = api.providers;

        const workflowId = "wf_engine_deps_test";
        const runId = "wfrun_engine_deps_test";
        const now = Date.now();
        await db
          .insert(workflowDefinitions)
          .values({
            id: workflowId,
            orgId: LOCAL_ORG.id,
            ownerType: "user",
            ownerId: LOCAL_USER.id,
            name: "engine-deps-test",
            definition: { version: "dag/v1", nodes: [], edges: [] },
            createdAt: now,
            updatedAt: now,
          });
        await workflowStore.createRun(
          runId,
          { workflowId, definitionVersionId: "v1" },
          { version: "dag/v1", nodes: [], edges: [] },
          "v1",
          { ownerType: "user", ownerId: LOCAL_USER.id },
        );

        const deps = buildWorkflowEngineDeps({
          host: engineHost,
          store: workflowStore,
          db,
          engineStore,
          actionPluginByService,
          credentials: engineCredentials,
        });

        const sessionId = `wf:${runId}:node1`;
        const created = await deps.createSession({ id: sessionId, purpose: "workflow" });
        expect(created.id).toBe(sessionId);

        const dispatchId = `workflow:${runId}:node1`;
        const promptText = "Reply with exactly the single word 'noted' and nothing else.";
        const receiptA = await deps.prompt(sessionId, promptText, { dispatchId });
        expect(receiptA.threadId).toBeTruthy();
        expect(receiptA.queueItemId).toBeTruthy();

        // Duplicate dispatch: same dispatchId + same content (the real
        // crash-retry shape — a workflow executor re-issuing an identical
        // prompt after a crash between dispatch and checkpoint). Must
        // return the ORIGINAL receipt, not create a second submission.
        const receiptB = await deps.prompt(sessionId, promptText, { dispatchId });
        expect(receiptB).toEqual(receiptA);

        const result = await deps.awaitResult(sessionId, receiptA.threadId, receiptA.queueItemId);
        expect(result.outcome).toBe("completed");

        const settled = await deps.isSettled(sessionId, receiptA.queueItemId);
        expect(settled).toBe(true);
      } finally {
        await api.cleanup();
      }
    },
    45_000,
  );

  it(
    "llm node end-to-end through a run: trigger -> llm -> stop, schema-validated output",
    async () => {
      const api = await bootTestApi();
      try {
        const definition = {
          version: "dag/v1",
          nodes: [
            { id: "trigger", type: "trigger" },
            {
              id: "llm1",
              type: "llm",
              model: MODEL,
              prompt:
                'Respond with ONLY JSON matching {"greeting": string} — a short one-word greeting. No other text.',
              outputSchema: {
                type: "object",
                properties: { greeting: { type: "string" } },
                required: ["greeting"],
              },
            },
            { id: "stop", type: "stop" },
          ],
          edges: [
            { from: "trigger", to: "llm1" },
            { from: "llm1", to: "stop" },
          ],
        };

        const createRes = await fetch(`${api.baseUrl}/api/workflows`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "llm-node-e2e", definition }),
        });
        expect(createRes.status).toBe(201);
        const created = (await createRes.json()) as CreateWorkflowResponse;

        const runRes = await fetch(`${api.baseUrl}/api/workflows/${created.id}/runs`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
        expect(runRes.status).toBe(201);
        const { runId } = (await runRes.json()) as StartWorkflowRunResponse;

        const start = Date.now();
        let detail: GetWorkflowRunResponse | undefined;
        while (Date.now() - start < 30_000) {
          const res = await fetch(`${api.baseUrl}/api/workflows/runs/${runId}`);
          detail = (await res.json()) as GetWorkflowRunResponse;
          if (detail.run.status === "settled") break;
          await new Promise((r) => setTimeout(r, 500));
        }

        expect(detail?.run.status).toBe("settled");
        expect(detail?.run.outcome).toBe("completed");

        const llmCheckpoint = detail?.checkpoints.find((cp) => cp.nodeId === "llm1");
        expect(llmCheckpoint?.status).toBe("completed");
        const result = llmCheckpoint?.result as
          | { text: string; output?: { greeting: string }; usage?: { totalTokens: number; costUsd: number } }
          | undefined;
        expect(typeof result?.text).toBe("string");
        expect(result?.text.length).toBeGreaterThan(0);
        expect(typeof result?.output?.greeting).toBe("string");
        expect(result?.output?.greeting.length).toBeGreaterThan(0);
        // Exercises the REAL llmComplete -> mapPiAiUsage wiring against a
        // live completion (the unit tests for mapPiAiUsage itself only
        // call it directly with hand-built fixtures) — a wrong field
        // reference in the wiring (e.g. passing the whole result instead
        // of result.usage) would pass every other assertion in this file.
        expect(result?.usage?.totalTokens).toBeGreaterThan(0);
        expect(result?.usage?.costUsd).toBeGreaterThan(0);
      } finally {
        await api.cleanup();
      }
    },
    45_000,
  );
});


it("Thread nodes share context within a run, isolate separate runs, and expose durable thread IDs", async () => {
  const original = piAi.getApiProvider("anthropic-messages");
  const stream: piAi.ApiStreamSimpleFunction = () => {
    const events = piAi.createAssistantMessageEventStream();
    events.end(fauxAssistantMessage("workflow completed"));
    return events;
  };
  piAi.registerApiProvider({ api: "anthropic-messages", stream, streamSimple: stream }, "workflow-http-regression");
  vi.stubEnv("ANTHROPIC_API_KEY", "test-key-no-network");
  let cleanup: (() => Promise<void>) | undefined;
  try {
    const api = await bootTestApi();
    cleanup = api.cleanup;
    const create = await fetch(`${api.baseUrl}/api/workflows`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "repeated-thread-e2e", definition: {
        version: "dag/v1",
        nodes: [{ id: "trigger", type: "trigger" }, { id: "ask", type: "thread", prompt: "Complete this workflow." }, { id: "review", type: "thread", prompt: "Continue working in {{nodes.ask.result.threadId}}." }, { id: "stop", type: "stop" }],
        edges: [{ from: "trigger", to: "ask" }, { from: "ask", to: "review" }, { from: "review", to: "stop" }],
      } }),
    });
    expect(create.status).toBe(201);
    // Response types follow the API wire contract; assertions verify the fields used below.
    const workflow = await create.json() as CreateWorkflowResponse;
    const receipts: Array<{ runId: string; threadId: string; queueItemId: string; sessionId: string }> = [];
    for (let index = 0; index < 2; index++) {
      const start = await fetch(`${api.baseUrl}/api/workflows/${workflow.id}/runs`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
      });
      expect(start.status).toBe(201);
      const { runId } = await start.json() as StartWorkflowRunResponse;
      await vi.waitFor(async () => {
        const response = await fetch(`${api.baseUrl}/api/workflows/runs/${runId}`);
        const detail = await response.json() as GetWorkflowRunResponse;
        expect(detail.run.status).toBe("settled");
        expect(detail.run.outcome).toBe("completed");
        expect(detail.checkpoints.find((cp) => cp.nodeId === "ask")?.result).toMatchObject({ response: "workflow completed" });
      }, { timeout: 20_000, interval: 100 });
      const checkpoints = await api.providers.workflowStore.getCheckpoints(runId);
      const effects = checkpoints.find((cp) => cp.nodeId === "ask")?.effects;
      const receipt = effects?.receipt;
      if (typeof effects?.sessionId !== "string" || typeof receipt !== "object" || receipt === null || !("threadId" in receipt) || typeof receipt.threadId !== "string" || !("queueItemId" in receipt) || typeof receipt.queueItemId !== "string") {
        throw new Error("Workflow checkpoint must contain its durable submission receipt.");
      }
      expect(checkpoints.find((cp) => cp.nodeId === "ask")?.result).toMatchObject({ threadId: receipt.threadId });
      expect(checkpoints.find((cp) => cp.nodeId === "review")?.result).toMatchObject({
        threadId: receipt.threadId, sessionId: effects.sessionId, response: "workflow completed",
      });
      receipts.push({ runId, sessionId: effects.sessionId, threadId: receipt.threadId, queueItemId: receipt.queueItemId });
    }
    // One assistant, one thread per run: neither run can block or abort
    // the other.
    expect(receipts[0]?.sessionId).toBe(receipts[1]?.sessionId);
    expect(receipts[0]?.threadId).not.toBe(receipts[1]?.threadId);
    expect(receipts[0]?.queueItemId).not.toBe(receipts[1]?.queueItemId);
    for (const receipt of receipts) {
      expect((await api.providers.engineStore.getQueueItem(receipt.sessionId, receipt.queueItemId))?.status).toBe("settled");
      const threads = await api.providers.engineStore.listThreads(receipt.sessionId);
      expect(threads.filter((thread) => thread.key === `signal:workflow:${receipt.runId}`)).toHaveLength(1);
      // The settle hook archives the run's thread, so repeated runs do not
      // fill the assistant's thread list.
      const [mirror] = await api.providers.db
        .select().from(sessionThreads).where(eq(sessionThreads.id, receipt.threadId)).limit(1);
      expect(mirror?.archivedAt).toBeGreaterThan(0);
    }
  } finally {
    try {
      await cleanup?.();
    } finally {
      piAi.unregisterApiProviders("workflow-http-regression");
      if (original) piAi.registerApiProvider(original);
      vi.unstubAllEnvs();
    }
  }
}, 60_000);
