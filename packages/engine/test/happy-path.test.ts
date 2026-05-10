import { describe, it, expect } from "vitest";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider, Type } from "@mariozechner/pi-ai";
import {
  Engine,
  InMemoryEventBus,
  InMemorySessionStore,
  VirtualSandboxProvider,
  type BusEvent,
  type ToolDef,
} from "../src/index.js";

function makeEngine() {
  const store = new InMemorySessionStore();
  const bus = new InMemoryEventBus();
  const sandboxProvider = new VirtualSandboxProvider();
  const events: BusEvent[] = [];
  bus.subscribe({}, (e) => events.push(e));
  const engine = new Engine({
    providers: { store, bus, sandboxProvider },
  });
  return { engine, store, bus, events, sandboxProvider };
}

describe("engine: single-thread happy path", () => {
  it("runs prompt -> assistant text response and persists to store", async () => {
    const faux = registerFauxProvider({ provider: "happy1" });
    faux.setResponses([fauxAssistantMessage("hello, world")]);

    const { engine, store, events } = makeEngine();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/workspace",
      sandbox: {},
      model: faux.getModel(),
    });

    const receipt = await session.prompt("say hi");
    expect(receipt.threadId).toBeTruthy();

    // Wait until idle (status event with idle)
    await waitForStatus(events, receipt.threadId, "idle");

    const entries = await session.readEntries("web:default");
    const messages = entries.filter((e) => e.type === "message");
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: "user", content: "say hi" });
    expect(messages[1]).toMatchObject({ role: "assistant", content: "hello, world" });

    // Bus emitted the lifecycle events
    const types = events.map((e) => e.event.type);
    expect(types).toContain("thread_start");
    expect(types).toContain("text_delta");
    expect(types).toContain("turn_end");

    // Session persisted in store
    expect(await store.getSession(session.id)).not.toBeNull();

    faux.unregister();
  });

  it("runs prompt -> tool call -> tool result -> end_turn", async () => {
    const faux = registerFauxProvider({ provider: "happy2" });
    faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall("write", { path: "/tmp/note.txt", content: "ok" }, { id: "tc1" })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("done"),
    ]);

    const { engine, events } = makeEngine();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
    });

    const receipt = await session.prompt("write a note");
    await waitForStatus(events, receipt.threadId, "idle");

    // The write tool ran against the virtual sandbox
    const fileContent = await session.sandbox.readFile("/tmp/note.txt");
    expect(fileContent).toBe("ok");

    // tool_start and tool_end events landed
    const tools = events.map((e) => e.event).filter((e) => e.type === "tool_start" || e.type === "tool_end");
    expect(tools.map((t) => t.type)).toEqual(["tool_start", "tool_end"]);

    faux.unregister();
  });

  it("invokes a custom ToolDef with ToolContext", async () => {
    const faux = registerFauxProvider({ provider: "happy3" });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("greet", { who: "world" }, { id: "tc2" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("ok"),
    ]);

    let receivedCtx: { userId?: string; threadId?: string } | undefined;
    const greet: ToolDef = {
      name: "greet",
      description: "greets",
      parameters: Type.Object({ who: Type.String() }),
      execute: async (args, ctx) => {
        receivedCtx = { userId: ctx.userId, threadId: ctx.threadId };
        return { text: `hello ${(args as { who: string }).who}` };
      },
    };

    const { engine, events } = makeEngine();
    const session = await engine.createSession({
      userId: "u-custom",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
      tools: [greet],
    });

    const receipt = await session.prompt("greet world");
    await waitForStatus(events, receipt.threadId, "idle");

    expect(receivedCtx?.userId).toBe("u-custom");
    expect(receivedCtx?.threadId).toBe(receipt.threadId);

    faux.unregister();
  });
});

async function waitForStatus(events: BusEvent[], threadId: string, status: string, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const found = events.some(
        (e) =>
          e.event.type === "status" &&
          e.event.threadId === threadId &&
          e.event.status === status,
      );
      if (found) return resolve();
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(`timed out waiting for status=${status}`));
      }
      setTimeout(tick, 5);
    };
    tick();
  });
}
