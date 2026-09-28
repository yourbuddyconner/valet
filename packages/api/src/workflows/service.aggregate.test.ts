/**
 * DB-backed tests for `addAggregateNode` — the explicit fan-in node. Uses
 * the same PGlite harness as the other workflow service tests.
 *
 * The point of these is the template path per branch node type. A wrong
 * path does not fail: it renders empty, and the run reports success over a
 * hole. So each case asserts the exact string the node was written with.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RunHost, WorkflowDefinition, WorkflowNode } from "@valet/workflow";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import {
  addAggregateNode,
  aggregateSourcePath,
  createWorkflowDefinition,
  getWorkflowDefinition,
  listWorkflowVersions,
} from "./service.js";
import { PgWorkflowStore } from "./pg-store.js";
import type { AppDb } from "../lib/drizzle.js";
import type { WorkflowServiceDeps, WorkflowOwner } from "./service.js";
import { InMemoryCredentialStore, InMemorySessionStore } from "@valet/engine";

const stubRunHost: RunHost = {
  async start() {},
  async wake() {},
  async scheduleWake() {},
  async terminate() {},
  startHost() {},
  async stopHost() {},
};

let db: AppDb;
let cleanup: () => Promise<void>;
let deps: WorkflowServiceDeps;

const OWNER: WorkflowOwner = { userId: "user_agg", orgId: "org_agg" };
const OTHER: WorkflowOwner = { userId: "user_other", orgId: "org_agg" };

beforeAll(async () => {
  const boot = await freshTestPgDb();
  db = boot.appDb;
  cleanup = boot.cleanup;
  deps = {
    db,
    workflowStore: new PgWorkflowStore(boot.pgdb),
    workflowRunHost: stubRunHost,
    engineStore: new InMemorySessionStore(),
    credentials: new InMemoryCredentialStore(),
  };
});

afterAll(async () => {
  await cleanup();
});

/** Trigger → two llm branches, no join. The shape this feature exists for. */
function twoBranches(): WorkflowDefinition {
  return {
    version: "dag/v1",
    nodes: [
      { id: "start", type: "trigger" },
      { id: "risks", type: "llm", model: "test-model", prompt: "risks of {{ trigger.data.subject }}" },
      { id: "options", type: "llm", model: "test-model", prompt: "options for {{ trigger.data.subject }}" },
    ],
    edges: [
      { from: "start", to: "risks" },
      { from: "start", to: "options" },
    ],
    ui: {
      nodes: {
        start: { position: { x: 0, y: 100 } },
        risks: { position: { x: 200, y: 0 } },
        options: { position: { x: 200, y: 200 } },
      },
    },
  };
}

async function seed(name: string, definition: WorkflowDefinition): Promise<string> {
  const created = await createWorkflowDefinition(deps, OWNER, { name, definition });
  return created.id;
}

function asDefinition(value: unknown): WorkflowDefinition {
  if (typeof value !== "object" || value === null) throw new Error("stored definition is not an object");
  const obj = value as { nodes?: unknown; edges?: unknown };
  if (!Array.isArray(obj.nodes) || !Array.isArray(obj.edges)) throw new Error("stored definition has no nodes/edges");
  return value as WorkflowDefinition;
}

function nodeById(definition: WorkflowDefinition, id: string): WorkflowNode {
  const node = definition.nodes.find((n) => n.id === id);
  if (!node) throw new Error(`no node ${id}`);
  return node;
}

// ─── Path derivation ─────────────────────────────────────────────────────────

describe("aggregateSourcePath", () => {
  it("reads each node family at the field its executor actually writes", () => {
    expect(aggregateSourcePath({ id: "a", type: "llm", model: "m", prompt: "p" })).toBe("nodes.a.result.text");
    expect(
      aggregateSourcePath({ id: "a", type: "llm", model: "m", prompt: "p", outputSchema: { type: "object" } }),
    ).toBe("nodes.a.result.output");
    expect(aggregateSourcePath({ id: "b", type: "session", mode: "start", prompt: "p" })).toBe(
      "nodes.b.result.response",
    );
    expect(
      aggregateSourcePath({ id: "b", type: "session", mode: "start", prompt: "p", outputSchema: { type: "object" } }),
    ).toBe("nodes.b.result.output");
    expect(aggregateSourcePath({ id: "c", type: "thread", prompt: "p" })).toBe("nodes.c.result.response");
    expect(aggregateSourcePath({ id: "d", type: "workflow", workflowId: "wf_1" })).toBe("nodes.d.result.output");
    expect(
      aggregateSourcePath({
        id: "e",
        type: "foreach",
        items: "{{ trigger.data.rows }}",
        body: { id: "e_body", type: "set", values: {} },
      }),
    ).toBe("nodes.e.result.items");
    expect(aggregateSourcePath({ id: "f", type: "tool", service: "github", action: "search", params: {} })).toBe(
      "nodes.f.result",
    );
  });
});

// ─── collect mode ────────────────────────────────────────────────────────────

describe("addAggregateNode: collect mode", () => {
  it("appends a set node reading every branch tip, and places it on the canvas", async () => {
    const id = await seed("collect-basic", twoBranches());
    const result = await addAggregateNode(deps, OWNER, id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.nodeId).toBe("aggregate");
    expect(result.sources).toEqual(["risks", "options"]);

    const definition = asDefinition(result.definition.definition);
    const node = nodeById(definition, "aggregate");
    expect(node.type).toBe("set");
    if (node.type !== "set") return;
    expect(node.values).toEqual({
      risks: "{{ nodes.risks.result.text }}",
      options: "{{ nodes.options.result.text }}",
    });

    // One edge per branch, and nothing that already existed was moved.
    expect(definition.edges).toEqual([
      { from: "start", to: "risks" },
      { from: "start", to: "options" },
      { from: "risks", to: "aggregate" },
      { from: "options", to: "aggregate" },
    ]);

    // Right of both branches, centred between them — visible without a hunt.
    expect(definition.ui?.nodes.aggregate).toEqual({ position: { x: 460, y: 100 } });
  });

  it("is an ordinary node afterwards: the reader can find it, edit it, and remove it", async () => {
    const id = await seed("collect-editable", twoBranches());
    const added = await addAggregateNode(deps, OWNER, id);
    expect(added.ok).toBe(true);

    // It is in the stored definition, not synthesised at run time.
    const fetched = await getWorkflowDefinition(deps, OWNER, id);
    const definition = asDefinition(fetched?.definition);
    expect(definition.nodes.map((n) => n.id)).toContain("aggregate");

    // And the save is a real version, so the insertion is undoable.
    const versions = await listWorkflowVersions(deps, OWNER, id);
    expect(versions?.map((v) => v.version)).toEqual([2, 1]);
  });

  it("derives the path from each branch's own node type, not from a single guess", async () => {
    const definition: WorkflowDefinition = {
      version: "dag/v1",
      nodes: [
        { id: "start", type: "trigger" },
        { id: "writer", type: "llm", model: "test-model", prompt: "write" },
        { id: "worker", type: "session", mode: "start", prompt: "work" },
        {
          id: "scored",
          type: "llm",
          model: "test-model",
          prompt: "score",
          outputSchema: { type: "object", properties: { score: { type: "number" } } },
        },
      ],
      edges: [
        { from: "start", to: "writer" },
        { from: "start", to: "worker" },
        { from: "start", to: "scored" },
      ],
    };
    const id = await seed("collect-mixed", definition);
    const result = await addAggregateNode(deps, OWNER, id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const node = nodeById(asDefinition(result.definition.definition), "aggregate");
    if (node.type !== "set") throw new Error("expected a set node");
    expect(node.values).toEqual({
      writer: "{{ nodes.writer.result.text }}",
      worker: "{{ nodes.worker.result.response }}",
      scored: "{{ nodes.scored.result.output }}",
    });
  });

  it("suffixes the id when the preferred one is taken", async () => {
    const base = twoBranches();
    const definition: WorkflowDefinition = {
      ...base,
      nodes: [...base.nodes, { id: "aggregate", type: "set", values: { note: "already here" } }],
      edges: [...base.edges, { from: "risks", to: "aggregate" }],
    };
    const id = await seed("collect-id-clash", definition);
    const result = await addAggregateNode(deps, OWNER, id, { sources: ["risks", "options"] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.nodeId).toBe("aggregate_2");
  });
});

// ─── summarize mode ──────────────────────────────────────────────────────────

describe("addAggregateNode: summarize mode", () => {
  it("writes an llm node whose prompt heads each branch and reads its real path", async () => {
    const id = await seed("summarize-basic", twoBranches());
    const result = await addAggregateNode(deps, OWNER, id, {
      mode: "summarize",
      model: "test-model",
      nodeId: "brief",
      instructions: "Answer in under 200 words.",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const node = nodeById(asDefinition(result.definition.definition), "brief");
    if (node.type !== "llm") throw new Error("expected an llm node");
    expect(node.model).toBe("test-model");
    expect(node.prompt).toContain("## risks");
    expect(node.prompt).toContain("{{ nodes.risks.result.text }}");
    expect(node.prompt).toContain("## options");
    expect(node.prompt).toContain("{{ nodes.options.result.text }}");
    expect(node.prompt).toContain("Answer in under 200 words.");
  });

  it("refuses without a model and names the two ways forward", async () => {
    const id = await seed("summarize-no-model", twoBranches());
    const result = await addAggregateNode(deps, OWNER, id, { mode: "summarize" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("model_required");
    if (!("message" in result)) throw new Error("expected a message");
    expect(result.message).toContain("Name the model");
    expect(result.message).toContain('mode "collect"');
  });
});

// ─── Refusals ────────────────────────────────────────────────────────────────

describe("addAggregateNode: refusals", () => {
  it("returns not_found for a workflow the caller does not own", async () => {
    const id = await seed("agg-not-mine", twoBranches());
    const result = await addAggregateNode(deps, OTHER, id);
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });

  it("refuses a single branch and says what to do instead", async () => {
    const definition: WorkflowDefinition = {
      version: "dag/v1",
      nodes: [
        { id: "start", type: "trigger" },
        { id: "only", type: "llm", model: "test-model", prompt: "one" },
      ],
      edges: [{ from: "start", to: "only" }],
    };
    const id = await seed("agg-one-branch", definition);
    const result = await addAggregateNode(deps, OWNER, id);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("no_branches");
    if (!("message" in result)) throw new Error("expected a message");
    expect(result.message).toContain("at least two branches");
  });

  it("names the unknown ids when the caller picks sources by hand", async () => {
    const id = await seed("agg-bad-sources", twoBranches());
    const result = await addAggregateNode(deps, OWNER, id, { sources: ["risks", "nope"] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("unknown_sources");
    if (!("message" in result)) throw new Error("expected a message");
    expect(result.message).toContain("nope");
  });

  it("leaves the workflow untouched when it refuses", async () => {
    const id = await seed("agg-untouched", twoBranches());
    await addAggregateNode(deps, OWNER, id, { sources: ["risks", "nope"] });
    const fetched = await getWorkflowDefinition(deps, OWNER, id);
    expect(asDefinition(fetched?.definition).nodes).toHaveLength(3);
    expect((await listWorkflowVersions(deps, OWNER, id))?.map((v) => v.version)).toEqual([1]);
  });
});
