import { describe, it, expect } from "vitest";
import { Type } from "typebox";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@mariozechner/pi-ai";
import {
  pluginCatalogTools,
  Engine,
  InMemoryCredentialStore,
  InMemoryEventBus,
  InMemorySessionStore,
  VirtualSandboxProvider,
  type ActionPlugin,
  type BusEvent,
  type PluginAction,
  type PluginActionContext,
  type PluginActionResult,
} from "../src/index.js";

function makeMockPlugin(): {
  plugin: ActionPlugin;
  calls: Array<{ id: string; args: unknown; ctx: PluginActionContext }>;
} {
  const calls: Array<{ id: string; args: unknown; ctx: PluginActionContext }> = [];

  const getIssue: PluginAction = {
    id: "github.get_issue",
    name: "Get Issue",
    description: "Read an issue.",
    riskLevel: "low",
    parameters: Type.Object({
      owner: Type.String(),
      repo: Type.String(),
      issueNumber: Type.Integer(),
    }),
    execute: async (args, ctx): Promise<PluginActionResult> => {
      calls.push({ id: getIssue.id, args, ctx });
      return { success: true, data: { number: 42, title: "Test issue" } };
    },
  };

  const createIssue: PluginAction = {
    id: "github.create_issue",
    name: "Create Issue",
    description: "Create a new issue.",
    riskLevel: "medium",
    parameters: Type.Object({
      owner: Type.String(),
      repo: Type.String(),
      title: Type.String(),
      body: Type.Optional(Type.String()),
    }),
    execute: async (args, ctx) => {
      calls.push({ id: createIssue.id, args, ctx });
      return { success: true, data: { number: 99, html_url: "https://x" } };
    },
  };

  const deleteRepo: PluginAction = {
    id: "github.delete_repo",
    name: "Delete Repo",
    description: "Permanently delete a repo.",
    riskLevel: "critical",
    parameters: Type.Object({ owner: Type.String(), repo: Type.String() }),
    execute: async (args, ctx) => {
      calls.push({ id: deleteRepo.id, args, ctx });
      return { success: true, data: { deleted: true } };
    },
  };

  const plugin: ActionPlugin = {
    service: "github",
    actions: [getIssue, createIssue, deleteRepo],
  };
  return { plugin, calls };
}

function makeEngine() {
  const store = new InMemorySessionStore();
  const bus = new InMemoryEventBus();
  const credentials = new InMemoryCredentialStore();
  const sandboxProvider = new VirtualSandboxProvider();
  const events: BusEvent[] = [];
  bus.subscribe({}, (e) => events.push(e));
  const engine = new Engine({ providers: { store, bus, credentials, sandboxProvider } });
  return { engine, events, credentials };
}

async function waitForIdle(events: BusEvent[], threadId: string, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (
    !events.some(
      (e) => e.event.type === "status" && e.event.threadId === threadId && e.event.status === "idle",
    )
  ) {
    if (Date.now() - start > timeoutMs) throw new Error("timeout waiting for idle");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("pluginCatalogTools: registration", () => {
  it("returns exactly two engine-visible tools regardless of plugin count", () => {
    const { plugin } = makeMockPlugin();
    const tools = pluginCatalogTools({ plugins: [plugin] });
    expect(tools.map((t) => t.name).sort()).toEqual(["call_tool", "list_tools"]);
  });

  it("two plugins still produce just list_tools + call_tool", () => {
    const a = makeMockPlugin();
    const b = makeMockPlugin();
    const tools = pluginCatalogTools({
      plugins: [
        { ...a.plugin, service: "github" },
        { ...b.plugin, service: "gmail" },
      ],
    });
    expect(tools.map((t) => t.name).sort()).toEqual(["call_tool", "list_tools"]);
  });
});

describe("pluginCatalogTools: list_tools", () => {
  it("returns the catalog with TypeBox parameters preserved as JSON Schema", async () => {
    const { plugin } = makeMockPlugin();
    const tools = pluginCatalogTools({ plugins: [plugin] });

    const faux = registerFauxProvider({ provider: "list1" });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("list_tools", {}, { id: "t1" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("done"),
    ]);

    const { engine, events } = makeEngine();
    const session = await engine.createSession({
      userId: "u",
      orgId: "o",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
      tools,
    });
    const receipt = await session.prompt("list");
    await waitForIdle(events, receipt.threadId);

    const toolEnd = events.find((e) => e.event.type === "tool_end");
    if (!toolEnd || toolEnd.event.type !== "tool_end") throw new Error("no tool_end");
    const payload = JSON.parse(toolEnd.event.result) as {
      tools: Array<{
        tool_id: string;
        riskLevel: string;
        params: { type: string; properties: Record<string, { type: string }> };
      }>;
      total: number;
    };
    expect(payload.total).toBe(3);
    const ids = payload.tools.map((t) => t.tool_id).sort();
    expect(ids).toEqual([
      "github.create_issue",
      "github.delete_repo",
      "github.get_issue",
    ]);
    const getIssue = payload.tools.find((t) => t.tool_id === "github.get_issue");
    expect(getIssue?.params.type).toBe("object");
    expect(getIssue?.params.properties.issueNumber.type).toBe("integer");

    faux.unregister();
  });

  it("filters by service and substring query", async () => {
    const { plugin } = makeMockPlugin();
    const tools = pluginCatalogTools({ plugins: [plugin] });

    const faux = registerFauxProvider({ provider: "list2" });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("list_tools", { query: "delete" }, { id: "t2" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("done"),
    ]);

    const { engine, events } = makeEngine();
    const session = await engine.createSession({
      userId: "u",
      orgId: "o",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
      tools,
    });
    const receipt = await session.prompt("find delete tool");
    await waitForIdle(events, receipt.threadId);

    const toolEnd = events.find((e) => e.event.type === "tool_end");
    if (!toolEnd || toolEnd.event.type !== "tool_end") throw new Error("no tool_end");
    const payload = JSON.parse(toolEnd.event.result) as {
      tools: Array<{ tool_id: string }>;
    };
    expect(payload.tools.map((t) => t.tool_id)).toEqual(["github.delete_repo"]);

    faux.unregister();
  });

  it("emits a warning when a service has no credential", async () => {
    const { plugin } = makeMockPlugin();
    const tools = pluginCatalogTools({ plugins: [plugin] });

    const faux = registerFauxProvider({ provider: "list3" });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("list_tools", {}, { id: "t3" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("done"),
    ]);

    const { engine, events } = makeEngine();
    const session = await engine.createSession({
      userId: "u",
      orgId: "o",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
      tools,
    });
    const receipt = await session.prompt("list");
    await waitForIdle(events, receipt.threadId);

    const toolEnd = events.find((e) => e.event.type === "tool_end");
    if (!toolEnd || toolEnd.event.type !== "tool_end") throw new Error("no tool_end");
    const payload = JSON.parse(toolEnd.event.result) as {
      warnings?: Array<{ service: string; reason: string }>;
    };
    expect(payload.warnings?.[0]?.service).toBe("github");

    faux.unregister();
  });
});

describe("pluginCatalogTools: call_tool", () => {
  it("dispatches by tool_id and returns rendered data with credentials available", async () => {
    const { plugin, calls } = makeMockPlugin();
    const tools = pluginCatalogTools({ plugins: [plugin] });

    const faux = registerFauxProvider({ provider: "call1" });
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall(
            "call_tool",
            {
              tool_id: "github.get_issue",
              params: { owner: "o", repo: "r", issueNumber: 42 },
              summary: "fetch issue 42",
            },
            { id: "tc1" },
          ),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("ok"),
    ]);

    const { engine, events, credentials } = makeEngine();
    await credentials.save({ type: "user", id: "u" }, "github", {
      type: "oauth2",
      accessToken: "ghp_secret",
    });
    const session = await engine.createSession({
      userId: "u",
      orgId: "o",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
      tools,
    });
    const receipt = await session.prompt("get issue");
    await waitForIdle(events, receipt.threadId);

    expect(calls).toHaveLength(1);
    expect(calls[0].id).toBe("github.get_issue");
    expect(calls[0].args).toEqual({ owner: "o", repo: "r", issueNumber: 42 });
    expect(calls[0].ctx.actionId).toBe("github.get_issue");
    expect(calls[0].ctx.service).toBe("github");
    expect(calls[0].ctx.summary).toBe("fetch issue 42");

    // Plugin called credentials.get() with no arg → defaults to "github"
    const cred = await calls[0].ctx.credentials.get();
    expect(cred?.accessToken).toBe("ghp_secret");

    const toolEnd = events.find((e) => e.event.type === "tool_end");
    if (!toolEnd || toolEnd.event.type !== "tool_end") throw new Error("no tool_end");
    expect(toolEnd.event.result).toContain("Test issue");
    expect(toolEnd.event.result).toContain("42");

    faux.unregister();
  });

  it("unknown tool_id → tool result text reports it without dispatching", async () => {
    const { plugin, calls } = makeMockPlugin();
    const tools = pluginCatalogTools({ plugins: [plugin] });

    const faux = registerFauxProvider({ provider: "call2" });
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall(
            "call_tool",
            { tool_id: "github.does_not_exist", params: {}, summary: "should fail" },
            { id: "tc-bad" },
          ),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("ack"),
    ]);

    const { engine, events } = makeEngine();
    const session = await engine.createSession({
      userId: "u",
      orgId: "o",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
      tools,
    });
    const receipt = await session.prompt("call missing tool");
    await waitForIdle(events, receipt.threadId);

    expect(calls).toHaveLength(0);
    const toolEnd = events.find((e) => e.event.type === "tool_end");
    expect(
      toolEnd && toolEnd.event.type === "tool_end" && toolEnd.event.result,
    ).toContain("unknown tool_id");

    faux.unregister();
  });

  it("PluginActionResult.success=false → tool result surfaces the error text", async () => {
    const failing: ActionPlugin = {
      service: "test",
      actions: [
        {
          id: "test.fail",
          name: "Fail",
          description: "always fails",
          riskLevel: "low",
          parameters: Type.Object({}),
          execute: async () => ({ success: false, error: "boom 500" }),
        },
      ],
    };
    const tools = pluginCatalogTools({ plugins: [failing] });

    const faux = registerFauxProvider({ provider: "call3" });
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall(
            "call_tool",
            { tool_id: "test.fail", params: {}, summary: "trigger fail" },
            { id: "tc-fail" },
          ),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("ack"),
    ]);

    const { engine, events } = makeEngine();
    const session = await engine.createSession({
      userId: "u",
      orgId: "o",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
      tools,
    });
    const receipt = await session.prompt("trigger fail");
    await waitForIdle(events, receipt.threadId);

    const toolEnd = events.find((e) => e.event.type === "tool_end");
    expect(
      toolEnd && toolEnd.event.type === "tool_end" && toolEnd.event.result,
    ).toContain("boom 500");

    faux.unregister();
  });

  it("critical-risk action opens an approval gate; deny short-circuits to denial text", async () => {
    const { plugin, calls } = makeMockPlugin();
    const tools = pluginCatalogTools({ plugins: [plugin] });

    const faux = registerFauxProvider({ provider: "call4" });
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall(
            "call_tool",
            {
              tool_id: "github.delete_repo",
              params: { owner: "o", repo: "r" },
              summary: "delete the repo",
            },
            { id: "tc-del" },
          ),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("acknowledged"),
    ]);

    const { engine, events } = makeEngine();
    const session = await engine.createSession({
      userId: "u",
      orgId: "o",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
      tools,
    });
    void session.prompt("delete the repo");

    const start = Date.now();
    while (!events.some((e) => e.event.type === "decision_gate")) {
      if (Date.now() - start > 2000) throw new Error("gate timeout");
      await new Promise((r) => setTimeout(r, 5));
    }
    const gate = events.find((e) => e.event.type === "decision_gate");
    if (!gate || gate.event.type !== "decision_gate") throw new Error("no gate");
    await session.resolveDecision(gate.event.gate.id, {
      actionId: "deny",
      resolvedBy: "u",
      resolvedAt: Date.now(),
    });

    const start2 = Date.now();
    while (
      !events.some(
        (e) => e.event.type === "tool_end" && e.event.tool === "call_tool",
      )
    ) {
      if (Date.now() - start2 > 2000) throw new Error("tool_end timeout");
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(calls).toHaveLength(0);
    const toolEnd = events.find((e) => e.event.type === "tool_end");
    expect(
      toolEnd && toolEnd.event.type === "tool_end" && toolEnd.event.result,
    ).toContain("did not approve");

    faux.unregister();
  });
});
