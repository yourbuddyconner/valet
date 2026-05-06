import { describe, it, expect } from "vitest";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider, Type } from "@mariozechner/pi-ai";
import {
  Engine,
  InMemoryEventBus,
  InMemorySessionStore,
  VirtualSandboxProvider,
  type BusEvent,
  type DecisionGate,
  type ToolDef,
} from "../src/index.js";

function makeEngine() {
  const store = new InMemorySessionStore();
  const bus = new InMemoryEventBus();
  const sandboxProvider = new VirtualSandboxProvider();
  const events: BusEvent[] = [];
  bus.subscribe({}, (e) => events.push(e));
  const engine = new Engine({ providers: { store, bus, sandboxProvider } });
  return { engine, store, events };
}

/** A tool whose execute() requests a decision and returns its result text. */
function approvalTool(): ToolDef {
  return {
    name: "do_thing",
    description: "Do a sensitive thing, gated by approval.",
    parameters: Type.Object({ arg: Type.String() }),
    execute: async (args, ctx) => {
      const resolution = await ctx.requestDecision({
        type: "approval",
        title: "approve do_thing?",
        body: `arg=${args.arg}`,
        resumeKey: `do_thing:${args.arg}`,
      });
      if (resolution.actionId === "approve") {
        return { text: `did the thing with arg=${args.arg}` };
      }
      return { text: `denied` };
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1500): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("decision gates: pending -> resolved", () => {
  it("opens a gate, the turn pauses, resolution resumes the turn", async () => {
    const faux = registerFauxProvider({ provider: "gate-resolved" });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("do_thing", { arg: "x" }, { id: "tc1" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("all done"),
    ]);

    const { engine, events } = makeEngine();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
      tools: [approvalTool()],
    });

    void session.prompt("please do thing");

    // Wait until we observe a decision_gate event
    await waitFor(() => events.some((e) => e.event.type === "decision_gate"));
    const gateEvent = events.find((e) => e.event.type === "decision_gate")!;
    const gate: DecisionGate = (gateEvent.event as { gate: DecisionGate }).gate;
    expect(gate.type).toBe("approval");
    expect(gate.status).toBe("pending");

    // The DAG should contain a decision_gate entry
    const entries = await session.readEntries("web:default");
    const gateEntries = entries.filter((e) => e.type === "decision_gate");
    expect(gateEntries).toHaveLength(1);

    // The thread is blocked
    const blocked = events.some(
      (e) => e.event.type === "status" && e.event.status === "blocked_on_decision_gate",
    );
    expect(blocked).toBe(true);

    // Resolve approve → turn should resume and complete
    await session.resolveDecision(gate.id, {
      actionId: "approve",
      resolvedBy: "u1",
      resolvedAt: Date.now(),
    });

    await waitFor(() =>
      events.some((e) => e.event.type === "status" && e.event.status === "idle"),
    );

    // The assistant emitted a "all done" final message
    const allEntries = await session.readEntries("web:default");
    const messages = allEntries.filter((e) => e.type === "message");
    expect(messages.at(-1)).toMatchObject({ role: "assistant", content: "all done" });

    // The gate event was emitted as resolved
    const resolved = events.find((e) => e.event.type === "decision_gate_resolved");
    expect(resolved).toBeTruthy();

    faux.unregister();
  });
});

describe("decision gates: pending -> withdrawn (abort)", () => {
  it("aborting the thread withdraws the pending gate", async () => {
    const faux = registerFauxProvider({ provider: "gate-withdrawn" });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("do_thing", { arg: "y" }, { id: "tc2" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("would never reach this"),
    ]);

    const { engine, events } = makeEngine();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
      tools: [approvalTool()],
    });

    void session.prompt("please do thing");
    await waitFor(() => events.some((e) => e.event.type === "decision_gate"));

    await session.abort();

    const withdrawn = events.find((e) => e.event.type === "decision_gate_withdrawn");
    expect(withdrawn).toBeTruthy();
    expect((withdrawn!.event as { reason: string }).reason).toBe("abort");

    faux.unregister();
  });
});

describe("decision gates: pending -> expired", () => {
  it("a gate with a past expiresAt fires expired and rejects the tool", async () => {
    const faux = registerFauxProvider({ provider: "gate-expired" });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("expiring", {}, { id: "tcE" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("never reached"),
    ]);

    const expiringTool: ToolDef = {
      name: "expiring",
      description: "expires fast",
      parameters: Type.Object({}),
      execute: async (_args, ctx) => {
        await ctx.requestDecision({
          type: "approval",
          title: "expire me",
          expiresAt: Date.now() + 30, // expires 30ms from now
        });
        return { text: "should not reach" };
      },
    };

    const { engine, events } = makeEngine();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
      tools: [expiringTool],
    });

    void session.prompt("trigger");
    await waitFor(() => events.some((e) => e.event.type === "decision_gate_expired"), 2000);

    faux.unregister();
  });
});

describe("decision gates: steer cancels pending gate", () => {
  it("a steer prompt withdraws the pending gate with reason=steer", async () => {
    const faux = registerFauxProvider({ provider: "gate-steer" });
    // First prompt: tool call that opens a gate
    // Second prompt (after steer): a simple text response
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("do_thing", { arg: "z" }, { id: "tc3" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("after steer"),
    ]);

    const { engine, events } = makeEngine();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
      tools: [approvalTool()],
    });

    void session.prompt("first");
    await waitFor(() => events.some((e) => e.event.type === "decision_gate"));

    // Steer
    await session.thread().submitPrompt("second", { queueMode: "steer" });

    await waitFor(() => events.some((e) => e.event.type === "decision_gate_withdrawn"));
    const withdrawn = events.find((e) => e.event.type === "decision_gate_withdrawn");
    expect((withdrawn!.event as { reason: string }).reason).toBe("steer");

    faux.unregister();
  });
});
