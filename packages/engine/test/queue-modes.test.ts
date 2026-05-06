import { describe, it, expect } from "vitest";
import { fauxAssistantMessage, registerFauxProvider, type FauxResponseStep } from "@mariozechner/pi-ai";
import {
  Engine,
  InMemoryEventBus,
  InMemorySessionStore,
  VirtualSandboxProvider,
  type BusEvent,
  type EngineEvent,
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

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}

function idleCount(events: BusEvent[], threadId: string): number {
  return events.filter(
    (e) =>
      e.event.type === "status" &&
      (e.event as Extract<EngineEvent, { type: "status" }>).status === "idle" &&
      e.event.threadId === threadId,
  ).length;
}

describe("queue mode: followup (FIFO)", () => {
  it("processes prompts in order", async () => {
    const faux = registerFauxProvider({ provider: "fifo", tokensPerSecond: 50 });
    const responses: FauxResponseStep[] = [
      fauxAssistantMessage("a-done"),
      fauxAssistantMessage("b-done"),
      fauxAssistantMessage("c-done"),
    ];
    faux.setResponses(responses);

    const { engine, events } = makeEngine();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
    });

    const r1 = await session.prompt("a");
    await session.prompt("b");
    await session.prompt("c");

    await waitFor(() => idleCount(events, r1.threadId) >= 1 && (
      // wait until queue is fully drained — three turn_ends
      events.filter((e) => e.event.type === "turn_end").length === 3
    ));

    const entries = await session.readEntries("web:default");
    const userMessages = entries.filter((e) => e.type === "message" && e.role === "user");
    expect(userMessages.map((m) => m.type === "message" ? m.content : "")).toEqual(["a", "b", "c"]);

    const assistantMessages = entries.filter(
      (e) => e.type === "message" && e.role === "assistant",
    );
    expect(assistantMessages.map((m) => m.type === "message" ? m.content : "")).toEqual([
      "a-done",
      "b-done",
      "c-done",
    ]);

    faux.unregister();
  });
});

describe("queue mode: collect (buffered window)", () => {
  it("merges buffered prompts into one combined prompt", async () => {
    const faux = registerFauxProvider({ provider: "collect" });
    faux.setResponses([fauxAssistantMessage("merged-ack")]);

    const { engine, events } = makeEngine();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
      queueMode: "collect",
      collectWindowMs: 50, // fast for tests
    });

    const r1 = await session.prompt("first");
    await session.prompt("second");
    await session.prompt("third");

    await waitFor(() => events.some((e) => e.event.type === "turn_end"), 2000);

    const entries = await session.readEntries("web:default");
    const userMessages = entries.filter((e) => e.type === "message" && e.role === "user");
    // exactly one user message containing all three texts
    expect(userMessages).toHaveLength(1);
    const merged = userMessages[0].type === "message" ? userMessages[0].content : "";
    expect(merged).toContain("first");
    expect(merged).toContain("second");
    expect(merged).toContain("third");

    void r1; // silence unused
    faux.unregister();
  });
});

describe("queue mode: steer (abort + new)", () => {
  it("aborts the current turn and starts a new one immediately", async () => {
    // Slow first response so we can interrupt it
    const faux = registerFauxProvider({ provider: "steer", tokensPerSecond: 5 });
    faux.setResponses([
      fauxAssistantMessage("looooong response that gets aborted before it finishes"),
      fauxAssistantMessage("steered-response"),
    ]);

    const { engine, events } = makeEngine();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
    });

    void session.prompt("slow-first");
    // Let it start streaming a bit
    await new Promise((r) => setTimeout(r, 30));
    // Now steer: this should abort the current run.
    await session.thread().submitPrompt("steered", { queueMode: "steer" });

    await waitFor(() => events.some(
      (e) => e.event.type === "turn_end" && (e.event as { reason: string }).reason === "end_turn",
    ), 4000);

    // We expect at least one turn_end with reason=abort (the aborted first run)
    const aborts = events.filter(
      (e) => e.event.type === "turn_end" && (e.event as { reason: string }).reason === "abort",
    );
    expect(aborts.length).toBeGreaterThanOrEqual(1);

    // And the steered text must be in transcript as final assistant content
    const entries = await session.readEntries("web:default");
    const lastAssistant = entries
      .filter((e) => e.type === "message" && e.role === "assistant")
      .at(-1);
    expect(lastAssistant && lastAssistant.type === "message" && lastAssistant.content).toBe(
      "steered-response",
    );

    faux.unregister();
  });
});

describe("queue: pause + resume", () => {
  it("paused thread does not start the next prompt until resumed", async () => {
    const faux = registerFauxProvider({ provider: "pause-resume" });
    faux.setResponses([
      fauxAssistantMessage("first-done"),
      fauxAssistantMessage("second-done"),
    ]);

    const { engine, events } = makeEngine();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
    });

    // First prompt completes immediately; then pause; then queue another and confirm it doesn't run.
    await session.prompt("first");
    await waitFor(() => events.some((e) => e.event.type === "turn_end"));
    const turnEndsBefore = events.filter((e) => e.event.type === "turn_end").length;

    await session.pause();
    await session.prompt("second");

    // Give it a beat — should still not have a 2nd turn_end while paused.
    await new Promise((r) => setTimeout(r, 50));
    const turnEndsAfterPause = events.filter((e) => e.event.type === "turn_end").length;
    expect(turnEndsAfterPause).toBe(turnEndsBefore);

    await session.resume();
    await waitFor(() => events.filter((e) => e.event.type === "turn_end").length > turnEndsBefore);

    const entries = await session.readEntries("web:default");
    const assistants = entries.filter((e) => e.type === "message" && e.role === "assistant");
    expect(assistants.map((m) => m.type === "message" ? m.content : "")).toEqual([
      "first-done",
      "second-done",
    ]);

    faux.unregister();
  });
});
