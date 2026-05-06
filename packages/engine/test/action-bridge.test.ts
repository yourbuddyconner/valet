import { describe, it, expect } from "vitest";
import { z } from "zod";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@mariozechner/pi-ai";
import {
  actionBridgeTools,
  Engine,
  InMemoryCredentialStore,
  InMemoryEventBus,
  InMemorySessionStore,
  VirtualSandboxProvider,
  type BridgeActionContext,
  type BridgeActionDefinition,
  type BridgeActionResult,
  type BridgeActionSource,
  type BusEvent,
} from "../src/index.js";

function makeMockSource(): {
  source: BridgeActionSource;
  calls: Array<{ id: string; params: unknown; ctx: BridgeActionContext }>;
} {
  const calls: Array<{ id: string; params: unknown; ctx: BridgeActionContext }> = [];

  const definitions: BridgeActionDefinition[] = [
    {
      id: "github.get_issue",
      name: "Get Issue",
      description: "Read an issue.",
      riskLevel: "low",
      params: z.object({
        owner: z.string(),
        repo: z.string(),
        issueNumber: z.number().int(),
      }),
    },
    {
      id: "github.create_issue",
      name: "Create Issue",
      description: "Create a new issue.",
      riskLevel: "medium",
      params: z.object({
        owner: z.string(),
        repo: z.string(),
        title: z.string(),
        body: z.string().optional(),
      }),
    },
    {
      id: "github.delete_repo",
      name: "Delete Repo",
      description: "Permanently delete a repo.",
      riskLevel: "critical",
      params: z.object({ owner: z.string(), repo: z.string() }),
    },
  ];

  const source: BridgeActionSource = {
    listActions: () => definitions,
    execute: async (id, params, ctx): Promise<BridgeActionResult> => {
      calls.push({ id, params, ctx });
      if (id === "github.get_issue") {
        return { success: true, data: { number: 42, title: "Test issue" } };
      }
      if (id === "github.create_issue") {
        return { success: true, data: { number: 99, html_url: "https://x" } };
      }
      if (id === "github.delete_repo") {
        return { success: true, data: { deleted: true } };
      }
      return { success: false, error: "unknown action" };
    },
  };

  return { source, calls };
}

describe("actionBridgeTools: registration", () => {
  it("returns exactly two engine-visible tools regardless of source count", async () => {
    const { source } = makeMockSource();
    const tools = await actionBridgeTools({
      sources: [{ service: "github", actions: source }],
    });
    expect(tools.map((t) => t.name).sort()).toEqual(["call_tool", "list_tools"]);
  });

  it("two sources still produce just list_tools + call_tool", async () => {
    const a = makeMockSource();
    const b = makeMockSource();
    const tools = await actionBridgeTools({
      sources: [
        { service: "github", actions: a.source },
        { service: "gmail", actions: b.source },
      ],
    });
    expect(tools.map((t) => t.name).sort()).toEqual(["call_tool", "list_tools"]);
  });
});

describe("actionBridgeTools: list_tools", () => {
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

  it("returns the catalog with converted JSON Schema params", async () => {
    const { source } = makeMockSource();
    const tools = await actionBridgeTools({
      sources: [{ service: "github", actions: source }],
    });

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
      tools: Array<{ tool_id: string; riskLevel: string; params: { type: string; properties: Record<string, { type: string }> } }>;
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
    const { source } = makeMockSource();
    const tools = await actionBridgeTools({
      sources: [{ service: "github", actions: source }],
    });

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
    const { source } = makeMockSource();
    const tools = await actionBridgeTools({
      sources: [{ service: "github", actions: source }],
    });

    const faux = registerFauxProvider({ provider: "list3" });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("list_tools", {}, { id: "t3" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("done"),
    ]);

    const { engine, events } = makeEngine();
    // No credentials saved → list_tools should report a warning for github.
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

describe("actionBridgeTools: call_tool", () => {
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

  it("dispatches by tool_id and returns rendered data with credentials applied", async () => {
    const { source, calls } = makeMockSource();
    const tools = await actionBridgeTools({
      sources: [{ service: "github", actions: source }],
    });

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
    expect(calls[0].params).toEqual({ owner: "o", repo: "r", issueNumber: 42 });
    expect(calls[0].ctx.credentials.access_token).toBe("ghp_secret");

    const toolEnd = events.find((e) => e.event.type === "tool_end");
    if (!toolEnd || toolEnd.event.type !== "tool_end") throw new Error("no tool_end");
    expect(toolEnd.event.result).toContain("Test issue");
    expect(toolEnd.event.result).toContain("42");

    faux.unregister();
  });

  it("unknown tool_id → tool result text reports it without dispatching", async () => {
    const { source, calls } = makeMockSource();
    const tools = await actionBridgeTools({
      sources: [{ service: "github", actions: source }],
    });

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

  it("ActionResult.success=false → tool result surfaces the error text", async () => {
    const failing: BridgeActionSource = {
      listActions: () => [
        {
          id: "test.fail",
          name: "Fail",
          description: "always fails",
          riskLevel: "low",
          params: z.object({}),
        },
      ],
      execute: async () => ({ success: false, error: "boom 500" }),
    };
    const tools = await actionBridgeTools({
      sources: [{ service: "test", actions: failing }],
    });

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
    const { source, calls } = makeMockSource();
    const tools = await actionBridgeTools({
      sources: [{ service: "github", actions: source }],
    });

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

    // Wait for the gate, then deny it.
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("gate timeout")), 2000);
      const unsub = bus2Sub(events, () => {
        if (events.some((e) => e.event.type === "decision_gate")) {
          clearTimeout(t);
          unsub();
          resolve();
        }
      });
    });
    const gate = events.find((e) => e.event.type === "decision_gate");
    if (!gate || gate.event.type !== "decision_gate") throw new Error("no gate");
    await session.resolveDecision(gate.event.gate.id, {
      actionId: "deny",
      resolvedBy: "u",
      resolvedAt: Date.now(),
    });

    await waitForIdle(events, gate.threadId ?? "");
    expect(calls).toHaveLength(0);
    const toolEnd = events.find((e) => e.event.type === "tool_end");
    expect(
      toolEnd && toolEnd.event.type === "tool_end" && toolEnd.event.result,
    ).toContain("did not approve");

    faux.unregister();
  });
});

// Polling helper: subscribe-once + poll the events array. The bus is the one
// passed by makeEngine; events array shadows our subscription.
function bus2Sub(_events: BusEvent[], _cb: () => void): () => void {
  // Subscribers in InMemoryEventBus fire synchronously on publish, so the
  // simplest approach is: don't subscribe a second time; just poll.
  // We expose this helper to keep test bodies tidy.
  const interval = setInterval(_cb, 5);
  return () => clearInterval(interval);
}
