/**
 * `POST /api/workflows/:id/preview` tests.
 *
 * The point of a preview is that it tells the truth, so most of these
 * assert on honesty rather than on output: a side-effecting node is
 * described and never invoked, an unresolved path is reported instead of
 * rendering quietly to null, and every value says whether it came from a
 * real run or from this preview's own pure execution.
 *
 * The `llm` node cases are the strongest of these. If the preview ever
 * executed one, the test would attempt a real completion.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import {
  collectTemplateFields,
  orderNodes,
  staticShape,
} from "./workflow-preview.js";
import type { CreateWorkflowResponse, PreviewWorkflowResponse } from "../wire/types.js";

let api: TestApi | undefined;

beforeEach(() => {
  // `POST /api/workflows` validates a model against the org's own model
  // set, so the subject definitions below save only while the org can
  // reach a provider for `MODEL`. Nothing here is about credentials — the
  // preview never runs an `llm` node — so one key stands in for the whole
  // org catalog.
  vi.stubEnv("ANTHROPIC_API_KEY", "test-anthropic-key");
});

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
  vi.unstubAllEnvs();
});

const MODEL = "claude-haiku-4-5";

async function createWorkflow(baseUrl: string, definition: unknown): Promise<CreateWorkflowResponse> {
  const res = await fetch(`${baseUrl}/api/workflows`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "preview-subject", definition }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as CreateWorkflowResponse;
}

async function preview(
  baseUrl: string,
  workflowId: string,
  body: unknown = {},
): Promise<PreviewWorkflowResponse> {
  const res = await fetch(`${baseUrl}/api/workflows/${workflowId}/preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as PreviewWorkflowResponse;
}

function nodeNamed(response: PreviewWorkflowResponse, nodeId: string) {
  const found = response.nodes.find((n) => n.nodeId === nodeId);
  expect(found, `no preview for node ${nodeId}`).toBeDefined();
  return found!;
}

/**
 * Trigger → set → if → stop. Every pure type, and one deliberate typo.
 * The typo reads a `trigger.data` field the schema does not declare: the
 * save-time validator statically rejects `trigger.<field>` (the payload-key
 * check in validate.ts), so a data-level miss is the shape only the
 * preview can catch. The editor-flow tests at the end of this file pin
 * both halves of that split.
 *
 * The validator reads only the FIRST segment after `trigger`. This fixture
 * does declare a `dataSchema`, so `username` is in fact knowably absent —
 * the validator simply does not read the schema yet. If it is ever taught
 * to, move this typo onto a trigger that declares no schema, or onto a
 * `nodes.<id>.result.<field>` read. Do NOT relax the rule to keep these
 * tests passing: the rule is what stops a path that resolves to nothing
 * from reaching a run.
 */
const PURE_DEFINITION = {
  version: "dag/v1",
  nodes: [
    {
      id: "trigger",
      type: "trigger",
      dataSchema: { email: { type: "string", required: true }, tier: { type: "string", default: "free" } },
    },
    {
      id: "build",
      type: "set",
      values: {
        greeting: "Hello {{trigger.data.email}}",
        tier: "{{trigger.data.tier}}",
        typo: "{{trigger.data.username}}",
      },
    },
    {
      id: "gate",
      type: "if",
      conditions: [{ left: "nodes.build.result.greeting", dataType: "string", operation: "isNotEmpty" }],
    },
    { id: "done", type: "stop" },
  ],
  edges: [
    { from: "trigger", to: "build" },
    { from: "build", to: "gate" },
    { from: "gate", to: "done", fromOutput: "true" },
  ],
};

/** Trigger → llm → orchestrator. Nothing here may ever be executed. */
const EFFECTFUL_DEFINITION = {
  version: "dag/v1",
  nodes: [
    { id: "trigger", type: "trigger", dataSchema: { topic: { type: "string" } } },
    { id: "draft", type: "llm", model: MODEL, prompt: "Write about {{trigger.data.topic}}" },
    { id: "hand-off", type: "thread", prompt: "Review: {{nodes.draft.result.response}}" },
  ],
  edges: [
    { from: "trigger", to: "draft" },
    { from: "draft", to: "hand-off" },
  ],
};

describe("POST /api/workflows/:id/preview — pure nodes", () => {
  it("executes set and if for real, and says so", async () => {
    api = await bootTestApi();
    const created = await createWorkflow(api.baseUrl, PURE_DEFINITION);

    const body = await preview(api.baseUrl, created.id, { input: { email: "a@example.com" } });

    const build = nodeNamed(body, "build");
    expect(build.fidelity).toBe("executed");
    expect(build.describedReason).toBeUndefined();
    expect(build.output).toEqual({ greeting: "Hello a@example.com", tier: "free", typo: null });

    const gate = nodeNamed(body, "gate");
    expect(gate.fidelity).toBe("executed");
    expect(gate.output).toMatchObject({ result: true, matched: [0] });
    expect(gate.warnings.join(" ")).toContain("fromOutput 'true'");
  });

  it("feeds an executed node's real output to the nodes after it", async () => {
    api = await bootTestApi();
    const created = await createWorkflow(api.baseUrl, PURE_DEFINITION);

    const body = await preview(api.baseUrl, created.id, { input: { email: "a@example.com" } });

    // `gate` reads `nodes.build.result.greeting`, which only exists because
    // the preview executed `build` first.
    expect(nodeNamed(body, "gate").unresolved).toEqual([]);
    expect(body.sample.fromPreview).toContain("build");
    expect(body.sample.kind).toBe("sample_only");
  });

  it("reports a path that resolves to nothing, and names the keys that are there", async () => {
    api = await bootTestApi();
    const created = await createWorkflow(api.baseUrl, PURE_DEFINITION);

    const body = await preview(api.baseUrl, created.id, { input: { email: "a@example.com" } });

    const build = nodeNamed(body, "build");
    const miss = build.unresolved.find((u) => u.path === "trigger.data.username");
    expect(miss).toBeDefined();
    expect(miss?.field).toBe("values.typo");
    expect(miss?.resolvedPrefix).toBe("trigger.data");
    expect(miss?.availableKeys).toContain("email");
    expect(miss?.message).toContain("resolved to nothing");
    // Every user-facing message names what to do about it.
    expect(miss?.message).toContain("Correct the path");

    // The good paths on the same node are not reported.
    expect(build.unresolved.map((u) => u.path)).toEqual(["trigger.data.username"]);
  });

  it("reports the resolved value of every templated field", async () => {
    api = await bootTestApi();
    const created = await createWorkflow(api.baseUrl, PURE_DEFINITION);

    const body = await preview(api.baseUrl, created.id, { input: { email: "a@example.com" } });

    const fields = nodeNamed(body, "build").fields;
    expect(fields.find((f) => f.field === "values.greeting")?.resolved).toBe("Hello a@example.com");
    // A single-expression miss renders as null, which is exactly the
    // failure mode this preview exists to make visible.
    expect(fields.find((f) => f.field === "values.typo")?.resolved).toBeNull();
    expect(fields.find((f) => f.field === "values.typo")?.unresolvedPaths).toEqual(["trigger.data.username"]);
  });

  it("applies the declared dataSchema, and reports missing required input", async () => {
    api = await bootTestApi();
    const created = await createWorkflow(api.baseUrl, PURE_DEFINITION);

    const body = await preview(api.baseUrl, created.id, {});

    expect(body.sample.inputErrors.map((e) => e.field)).toEqual(["email"]);
    // The default still applies, so the rest of the preview stays useful.
    expect(nodeNamed(body, "build").output).toMatchObject({ tier: "free" });
  });

  it("says the run ends at a stop node", async () => {
    api = await bootTestApi();
    const created = await createWorkflow(api.baseUrl, PURE_DEFINITION);

    const body = await preview(api.baseUrl, created.id, { input: { email: "a@example.com" } });

    const stop = nodeNamed(body, "done");
    expect(stop.fidelity).toBe("executed");
    expect(stop.warnings.join(" ")).toContain("run ends at this node");
  });
});

describe("POST /api/workflows/:id/preview — effectful nodes", () => {
  it("describes an llm node instead of calling the model", async () => {
    api = await bootTestApi();
    const created = await createWorkflow(api.baseUrl, EFFECTFUL_DEFINITION);

    const body = await preview(api.baseUrl, created.id, { input: { topic: "latency" } });

    const draft = nodeNamed(body, "draft");
    expect(draft.fidelity).toBe("described");
    expect(draft.output).toBeUndefined();
    expect(draft.describedReason).toContain(MODEL);
    // The prompt is still resolved: that is the part a person is checking.
    expect(draft.fields.find((f) => f.field === "prompt")?.resolved).toBe("Write about latency");
    expect(draft.outputShape.paths).toContain("nodes.draft.result.text");
  });

  it("rejects the retired orchestrator node type on workflow creation", async () => {
    api = await bootTestApi();
    const response = await fetch(`${api.baseUrl}/api/workflows`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Retired node", definition: {
        version: "dag/v1",
        nodes: [{ id: "start", type: "trigger" }, { id: "old", type: "orchestrator", prompt: "hello" }],
        edges: [{ from: "start", to: "old" }],
      } }),
    });
    expect(response.status).toBe(400);
  });

  it("describes a thread node and still reports its unresolved paths", async () => {
    api = await bootTestApi();
    const created = await createWorkflow(api.baseUrl, EFFECTFUL_DEFINITION);

    const body = await preview(api.baseUrl, created.id, { input: { topic: "latency" } });

    const handOff = nodeNamed(body, "hand-off");
    expect(handOff.fidelity).toBe("described");
    expect(handOff.output).toBeUndefined();
    expect(handOff.outputShape.paths).toContain("nodes.hand-off.result.threadId");
    // `draft` never ran, so its result is genuinely absent. The preview says
    // so rather than rendering the prompt with a hole in it and staying quiet.
    expect(handOff.unresolved.map((u) => u.path)).toEqual(["nodes.draft.result.response"]);
  });

  it("warns that wait.mode 'none' produces no response", async () => {
    api = await bootTestApi();
    const definition = {
      version: "dag/v1",
      nodes: [
        { id: "trigger", type: "trigger" },
        { id: "kick", type: "thread", prompt: "go", wait: { mode: "none" } },
      ],
      edges: [{ from: "trigger", to: "kick" }],
    };
    const created = await createWorkflow(api.baseUrl, definition);

    const kick = nodeNamed(await preview(api.baseUrl, created.id), "kick");
    expect(kick.warnings.join(" ")).toContain("wait.mode is 'none'");
    expect(kick.outputShape.paths).toContain("nodes.kick.result.threadId");
    expect(kick.outputShape.paths).not.toContain("nodes.kick.result.response");
    expect(kick.outputShape.note).toContain("until_idle");
  });
});

describe("POST /api/workflows/:id/preview — foreach", () => {
  const foreachDefinition = (items: string) => ({
    version: "dag/v1",
    nodes: [
      { id: "trigger", type: "trigger", dataSchema: { rows: { type: "array" } } },
      {
        id: "fan",
        type: "foreach",
        items,
        body: { id: "one", type: "llm", model: MODEL, prompt: "{{item}}" },
      },
    ],
    edges: [{ from: "trigger", to: "fan" }],
  });

  it("warns when the items expression does not resolve to a list", async () => {
    api = await bootTestApi();
    const created = await createWorkflow(api.baseUrl, foreachDefinition("{{trigger.data.rows}}"));

    const fan = nodeNamed(await preview(api.baseUrl, created.id, { input: {} }), "fan");
    expect(fan.warnings.join(" ")).toContain("not a list");
    expect(fan.warnings.join(" ")).toContain("outputSchema");
  });

  it("counts the items and names the ceiling that would drop rows", async () => {
    api = await bootTestApi();
    const created = await createWorkflow(api.baseUrl, foreachDefinition("{{trigger.data.rows}}"));
    const rows = Array.from({ length: 130 }, (_, i) => i);

    const fan = nodeNamed(await preview(api.baseUrl, created.id, { input: { rows } }), "fan");
    expect(fan.warnings.join(" ")).toContain("130 item(s)");
    expect(fan.warnings.join(" ")).toContain("30 item(s) would be dropped");
    expect(fan.warnings.join(" ")).toContain("Raise maxItems");
  });

  it("does not audit the loop body, whose aliases do not exist yet", async () => {
    api = await bootTestApi();
    const created = await createWorkflow(api.baseUrl, foreachDefinition("{{trigger.data.rows}}"));

    const fan = nodeNamed(await preview(api.baseUrl, created.id, { input: { rows: [1] } }), "fan");
    expect(fan.unresolved.map((u) => u.path)).toEqual([]);
    expect(fan.fields.map((f) => f.field)).toEqual(["items"]);
  });
});

describe("POST /api/workflows/:id/preview — sample data", () => {
  it("resolves against the newest run that produced something", async () => {
    api = await bootTestApi();
    const created = await createWorkflow(api.baseUrl, EFFECTFUL_DEFINITION);

    const runId = "wfr_preview_sample";
    await api.providers.workflowStore.createRun(
      runId,
      { workflowId: created.id, definitionVersionId: "v1", input: {} },
      created.definition,
      "v1",
      { ownerType: "user", ownerId: "local-user" },
    );
    const claim = await api.providers.workflowStore.claimRun(runId, "test", 60_000);
    const attempt = claim?.attempt ?? 1;
    const write = async (nodeId: string, result: unknown) => {
      await api!.providers.workflowStore.putIntent({
        runId,
        nodeId,
        iteration: 0,
        status: "intent",
        attempt,
        createdAt: Date.now(),
      });
      await api!.providers.workflowStore.completeCheckpoint(runId, nodeId, 0, attempt, {
        runId,
        nodeId,
        iteration: 0,
        status: "completed",
        result,
        attempt,
        createdAt: Date.now(),
      });
    };
    await write("trigger", {
      type: "manual",
      timestamp: new Date().toISOString(),
      data: { topic: "caching" },
      metadata: {},
    });
    await write("draft", { text: "a real draft", usage: { totalTokens: 12 } });

    const body = await preview(api.baseUrl, created.id);

    expect(body.sample.kind).toBe("last_run");
    expect(body.sample.runId).toBe(runId);
    expect(body.sample.fromRun).toContain("draft");
    // The trigger payload comes from the run, so the llm prompt resolves.
    expect(nodeNamed(body, "draft").fields.find((f) => f.field === "prompt")?.resolved).toBe(
      "Write about caching",
    );
    // And the shape is now read off a real result rather than guessed.
    const shape = nodeNamed(body, "draft").outputShape;
    expect(shape.origin).toBe("observed");
    expect(shape.paths).toContain("nodes.draft.result.text");
  });

  it("names the sample fields that override the run's payload", async () => {
    api = await bootTestApi();
    const created = await createWorkflow(api.baseUrl, EFFECTFUL_DEFINITION);
    const runId = "wfr_preview_override";
    await api.providers.workflowStore.createRun(
      runId,
      { workflowId: created.id, definitionVersionId: "v1", input: {} },
      created.definition,
      "v1",
      { ownerType: "user", ownerId: "local-user" },
    );
    const claim = await api.providers.workflowStore.claimRun(runId, "test", 60_000);
    const attempt = claim?.attempt ?? 1;
    await api.providers.workflowStore.putIntent({
      runId,
      nodeId: "trigger",
      iteration: 0,
      status: "intent",
      attempt,
      createdAt: Date.now(),
    });
    await api.providers.workflowStore.completeCheckpoint(runId, "trigger", 0, attempt, {
      runId,
      nodeId: "trigger",
      iteration: 0,
      status: "completed",
      result: { type: "manual", timestamp: "now", data: { topic: "caching" }, metadata: {} },
      attempt,
      createdAt: Date.now(),
    });

    const body = await preview(api.baseUrl, created.id, { input: { topic: "latency" } });
    expect(nodeNamed(body, "trigger").warnings.join(" ")).toContain("topic");
    expect(nodeNamed(body, "draft").fields.find((f) => f.field === "prompt")?.resolved).toBe(
      "Write about latency",
    );
  });

  it("ignores run data when the caller asks for sample input alone", async () => {
    api = await bootTestApi();
    const created = await createWorkflow(api.baseUrl, EFFECTFUL_DEFINITION);
    const runId = "wfr_preview_ignored";
    await api.providers.workflowStore.createRun(
      runId,
      { workflowId: created.id, definitionVersionId: "v1", input: {} },
      created.definition,
      "v1",
      { ownerType: "user", ownerId: "local-user" },
    );

    const body = await preview(api.baseUrl, created.id, { sample: "none" });
    expect(body.sample.kind).toBe("sample_only");
    expect(body.sample.runId).toBeUndefined();
  });
});

describe("POST /api/workflows/:id/preview — request handling", () => {
  it("previews the unsaved definition the editor holds", async () => {
    api = await bootTestApi();
    const created = await createWorkflow(api.baseUrl, PURE_DEFINITION);

    const edited = {
      ...PURE_DEFINITION,
      nodes: PURE_DEFINITION.nodes.map((n) =>
        n.id === "build" ? { ...n, values: { greeting: "Hi {{trigger.data.email}}" } } : n,
      ),
    };
    const body = await preview(api.baseUrl, created.id, {
      definition: edited,
      input: { email: "b@example.com" },
    });

    expect(nodeNamed(body, "build").output).toEqual({ greeting: "Hi b@example.com" });
  });

  it("narrows to one node when asked", async () => {
    api = await bootTestApi();
    const created = await createWorkflow(api.baseUrl, PURE_DEFINITION);

    const body = await preview(api.baseUrl, created.id, {
      nodeId: "build",
      input: { email: "a@example.com" },
    });
    expect(body.nodes.map((n) => n.nodeId)).toEqual(["build"]);
  });

  it("rejects a node id the definition does not hold, and says what to send", async () => {
    api = await bootTestApi();
    const created = await createWorkflow(api.baseUrl, PURE_DEFINITION);

    const res = await fetch(`${api.baseUrl}/api/workflows/${created.id}/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nodeId: "nope" }),
    });
    expect(res.status).toBe(400);
    const error = ((await res.json()) as { error: string }).error;
    expect(error).toContain("omit nodeId");
  });

  it("rejects an invalid definition with the validator's own errors", async () => {
    api = await bootTestApi();
    const created = await createWorkflow(api.baseUrl, PURE_DEFINITION);

    const res = await fetch(`${api.baseUrl}/api/workflows/${created.id}/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ definition: { version: "dag/v1", nodes: [], edges: [] } }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; errors: string[] };
    expect(body.error).toBe("invalid workflow definition");
    expect(body.errors.length).toBeGreaterThan(0);
  });

  it("404s another owner's workflow", async () => {
    api = await bootTestApi();
    const created = await createWorkflow(api.baseUrl, PURE_DEFINITION);

    const res = await fetch(`${api.baseUrl}/api/workflows/${created.id}/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-valet-test-user-id": "test-member" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });
});

/**
 * The two halves of the editor's correction loop, which meet at the same
 * template path but are caught by different things. A path whose second
 * segment is not a trigger-payload key is knowably wrong without any data,
 * so the validator refuses it at save AND at preview. A path under
 * `trigger.data` can only be judged against data, so it saves, and the
 * preview is what tells the reader it resolves to nothing.
 */
describe("POST /api/workflows/:id/preview — the editor's correction loop", () => {
  const withTypo = (typo: string) => ({
    version: "dag/v1",
    nodes: [
      { id: "trigger", type: "trigger", dataSchema: { email: { type: "string", required: true } } },
      { id: "build", type: "set", values: { to: typo } },
    ],
    edges: [{ from: "trigger", to: "build" }],
  });

  it("previews an unsaved draft, reports the empty path, and saves the correction", async () => {
    api = await bootTestApi();
    const created = await createWorkflow(api.baseUrl, withTypo("{{trigger.data.email}}"));

    // 1. The editor holds an edit that is not saved yet.
    const draft = await preview(api.baseUrl, created.id, {
      definition: withTypo("{{trigger.data.emial}}"),
      input: { email: "a@example.com" },
    });

    // 2. The preview names the path, and the value it would have written.
    const build = nodeNamed(draft, "build");
    expect(build.unresolved.map((u) => u.path)).toEqual(["trigger.data.emial"]);
    expect(build.unresolved[0]?.message).toContain("Correct the path");
    expect(build.output).toEqual({ to: null });

    // 3. The reader corrects the path, and the same definition saves.
    const res = await fetch(`${api.baseUrl}/api/workflows/${created.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ definition: withTypo("{{trigger.data.email}}") }),
    });
    expect(res.status).toBe(200);

    // 4. And the saved definition previews with nothing left unresolved.
    const after = await preview(api.baseUrl, created.id, { input: { email: "a@example.com" } });
    expect(nodeNamed(after, "build").unresolved).toEqual([]);
    expect(nodeNamed(after, "build").output).toEqual({ to: "a@example.com" });
  });

  it("refuses a wrong trigger-payload key at preview and at save, with the same correction", async () => {
    api = await bootTestApi();
    const created = await createWorkflow(api.baseUrl, withTypo("{{trigger.data.email}}"));
    const bad = withTypo("{{trigger.email}}");

    const previewRes = await fetch(`${api.baseUrl}/api/workflows/${created.id}/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ definition: bad }),
    });
    expect(previewRes.status).toBe(400);
    const previewBody = (await previewRes.json()) as { error: string; errors: string[] };
    expect(previewBody.error).toBe("invalid workflow definition");
    // The message names the corrective action, not just the fault.
    expect(previewBody.errors.join(" ")).toContain('did you mean "trigger.data.email"');

    const saveRes = await fetch(`${api.baseUrl}/api/workflows/${created.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ definition: bad }),
    });
    expect(saveRes.status).toBe(400);
    const saveBody = (await saveRes.json()) as { error: string; errors: string[] };
    expect(saveBody.errors).toEqual(previewBody.errors);
  });
});

describe("preview shape table", () => {
  it("describes a tool node's output as unknown until it has run once", () => {
    const shape = staticShape({
      id: "post",
      type: "tool",
      service: "slack",
      action: "send_message",
      params: {},
    });
    expect(shape.origin).toBe("unknown");
    expect(shape.paths).toEqual(["nodes.post.result"]);
    expect(shape.note).toContain("slack.send_message");
  });

  it("puts a schema'd llm node's fields under output, not at the top", () => {
    const shape = staticShape({
      id: "classify",
      type: "llm",
      model: MODEL,
      prompt: "x",
      outputSchema: { type: "object", properties: { label: { type: "string" }, score: { type: "number" } } },
    });
    expect(shape.origin).toBe("declared");
    expect(shape.paths).toEqual([
      "nodes.classify.result.text",
      "nodes.classify.result.output.label",
      "nodes.classify.result.output.score",
    ]);
  });

  it("names the trigger contract on a trigger node", () => {
    const shape = staticShape({ id: "trigger", type: "trigger" });
    expect(shape.paths).toContain("trigger.data");
    expect(shape.note).toContain("trigger.data.<field>");
  });

  it("points a foreach reader at the per-item data key", () => {
    const shape = staticShape({
      id: "fan",
      type: "foreach",
      items: "{{trigger.data.rows}}",
      body: { id: "one", type: "set", values: {} },
    });
    expect(shape.paths).toContain("nodes.fan.result.items[0].data");
  });
});

describe("template field collection", () => {
  it("finds every template in a node, however deep", () => {
    const fields = collectTemplateFields({
      id: "post",
      type: "tool",
      service: "slack",
      action: "send_message",
      params: { channel: "#ops", blocks: [{ text: "{{trigger.data.title}}" }] },
      summary: "Post {{trigger.data.title}}",
    });
    expect(fields.map((f) => f.field).sort()).toEqual([
      "params.blocks[0].text",
      "summary",
    ]);
  });

  it("reads an if condition, which is a bare expression rather than a template", () => {
    const fields = collectTemplateFields({
      id: "gate",
      type: "if",
      conditions: [{ left: "nodes.x.result.count", dataType: "number", operation: "greaterThan", right: 3 }],
    });
    // The bare expression carries no braces, so the JSON walk does not see it.
    expect(fields).toEqual([]);
  });

  it("leaves a foreach body alone", () => {
    const fields = collectTemplateFields({
      id: "fan",
      type: "foreach",
      items: "{{trigger.data.rows}}",
      body: { id: "one", type: "set", values: { name: "{{item.name}}" } },
    });
    expect(fields.map((f) => f.field)).toEqual(["items"]);
  });
});

describe("node ordering", () => {
  it("puts a node after the nodes it reads", () => {
    const ordered = orderNodes({
      version: "dag/v1",
      nodes: [
        { id: "c", type: "stop" },
        { id: "b", type: "set", values: {} },
        { id: "a", type: "trigger" },
      ],
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "c" },
      ],
    });
    expect(ordered.map((n) => n.id)).toEqual(["a", "b", "c"]);
  });

  it("still answers for a definition with a cycle in it", () => {
    const ordered = orderNodes({
      version: "dag/v1",
      nodes: [
        { id: "a", type: "trigger" },
        { id: "b", type: "set", values: {} },
        { id: "c", type: "set", values: {} },
      ],
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "c" },
        { from: "c", to: "b" },
      ],
    });
    expect(ordered.map((n) => n.id).sort()).toEqual(["a", "b", "c"]);
  });
});
