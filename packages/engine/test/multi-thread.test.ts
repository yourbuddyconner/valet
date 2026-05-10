import { describe, it, expect } from "vitest";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@mariozechner/pi-ai";
import {
  Engine,
  InMemoryEventBus,
  InMemorySessionStore,
  VirtualSandboxProvider,
  type BusEvent,
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

describe("multi-thread isolation", () => {
  it("two threads run concurrently with isolated histories", async () => {
    const faux = registerFauxProvider({ provider: "multi", tokensPerSecond: 50 });
    // Both threads send simple text prompts. Each gets one response.
    faux.setResponses([
      fauxAssistantMessage("ans-A"),
      fauxAssistantMessage("ans-B"),
    ]);

    const { engine, events } = makeEngine();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
    });

    const tA = session.thread("task:A");
    const tB = session.thread("task:B");

    // Submit to both threads simultaneously
    void tA.submitPrompt("hello A", {});
    void tB.submitPrompt("hello B", {});

    // Wait for both to complete (two turn_ends)
    await waitFor(
      () => events.filter((e) => e.event.type === "turn_end").length >= 2,
    );

    const aEntries = await tA.readEntries();
    const bEntries = await tB.readEntries();

    expect(aEntries.filter((e) => e.type === "message")).toHaveLength(2);
    expect(bEntries.filter((e) => e.type === "message")).toHaveLength(2);

    // Each thread sees only its own user prompt
    const aUser = aEntries.find((e) => e.type === "message" && e.role === "user");
    const bUser = bEntries.find((e) => e.type === "message" && e.role === "user");
    expect(aUser?.type === "message" && aUser.content).toBe("hello A");
    expect(bUser?.type === "message" && bUser.content).toBe("hello B");

    // The thread IDs are distinct
    expect(tA.id).not.toBe(tB.id);

    // Each event was tagged with the right thread
    const aThreadEvents = events.filter((e) => e.threadId === tA.id);
    const bThreadEvents = events.filter((e) => e.threadId === tB.id);
    expect(aThreadEvents.length).toBeGreaterThan(0);
    expect(bThreadEvents.length).toBeGreaterThan(0);

    faux.unregister();
  });

  it("aborting one thread does not affect another", async () => {
    const faux = registerFauxProvider({ provider: "multi-abort", tokensPerSecond: 5 });
    faux.setResponses([
      fauxAssistantMessage("very long stream that will be aborted on thread A"),
      fauxAssistantMessage("ans-B"),
    ]);

    const { engine, events } = makeEngine();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
    });

    const tA = session.thread("task:A");
    const tB = session.thread("task:B");

    void tA.submitPrompt("slow", {});
    void tB.submitPrompt("hello B", {});

    // Let both start
    await new Promise((r) => setTimeout(r, 30));

    await session.abort({ threadId: tA.id });

    // Wait for tB to complete normally
    await waitFor(() =>
      events.some(
        (e) =>
          e.threadId === tB.id &&
          e.event.type === "turn_end" &&
          (e.event as { reason: string }).reason === "end_turn",
      ),
    );

    // tA should have an aborted turn_end
    const aAborts = events.filter(
      (e) =>
        e.threadId === tA.id &&
        e.event.type === "turn_end" &&
        (e.event as { reason: string }).reason === "abort",
    );
    expect(aAborts.length).toBeGreaterThanOrEqual(1);

    // tB completed normally
    const bEntries = await tB.readEntries();
    const bAssistant = bEntries.find((e) => e.type === "message" && e.role === "assistant");
    expect(bAssistant?.type === "message" && bAssistant.content).toBe("ans-B");

    faux.unregister();
  });
});

describe("thread_read built-in tool", () => {
  it("thread A can read messages from thread B via thread_read", async () => {
    const faux = registerFauxProvider({ provider: "thread-read" });
    // Thread B will be primed with one back-and-forth.
    // Then thread A's first response will call thread_read on B.
    // Thread A's second response will be a text reply containing the read result.
    faux.setResponses([
      fauxAssistantMessage("B-said-this"), // B's response
      // A's first response: invokes thread_read on B
      fauxAssistantMessage(
        [fauxToolCall("thread_read", { key: "task:B", limit: 10 }, { id: "tr1" })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("A read B"), // A's final response
    ]);

    const { engine, events } = makeEngine();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
    });

    const tA = session.thread("task:A");
    const tB = session.thread("task:B");

    // Prime thread B
    await tB.submitPrompt("hello B", {});
    await waitFor(() =>
      events.some(
        (e) =>
          e.threadId === tB.id &&
          e.event.type === "turn_end" &&
          (e.event as { reason: string }).reason === "end_turn",
      ),
    );

    // Now run thread A which calls thread_read on B
    await tA.submitPrompt("read B", {});
    await waitFor(() => {
      const aDone = events.filter(
        (e) =>
          e.threadId === tA.id &&
          e.event.type === "turn_end" &&
          (e.event as { reason: string }).reason === "end_turn",
      );
      return aDone.length >= 1;
    });

    // tool_end should have been emitted with thread_read result text
    const toolEnds = events.filter(
      (e) => e.threadId === tA.id && e.event.type === "tool_end",
    );
    expect(toolEnds.length).toBeGreaterThanOrEqual(1);
    const lastToolEnd = toolEnds.at(-1);
    const result = (lastToolEnd!.event as { result: string }).result;
    expect(result).toContain("thread:task:B");
    expect(result).toContain("hello B");
    expect(result).toContain("B-said-this");

    faux.unregister();
  });
});
