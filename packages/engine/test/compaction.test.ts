import { describe, it, expect } from "vitest";
import {
  fauxAssistantMessage,
  registerFauxProvider,
} from "@mariozechner/pi-ai";
import {
  Engine,
  InMemoryEventBus,
  InMemorySessionStore,
  VirtualSandboxProvider,
  type BusEvent,
  type CompactionEntry,
} from "../src/index.js";

function makeEngine() {
  const store = new InMemorySessionStore();
  const bus = new InMemoryEventBus();
  const sandboxProvider = new VirtualSandboxProvider();
  const events: BusEvent[] = [];
  bus.subscribe({}, (e) => events.push(e));
  const engine = new Engine({ providers: { store, bus, sandboxProvider } });
  return { engine, store, bus, events };
}

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("compaction: proactive (token threshold)", () => {
  it("after a turn that pushes usage past usable, runs compaction and inserts a CompactionEntry", async () => {
    // Tiny model dimensions: usable = contextWindow - min(reserveCap, maxTokens) = 50 - 5 = 45.
    // Faux's prompt-length estimator + a small prompt easily exceeds 45 tokens.
    const faux2 = registerFauxProvider({
      provider: "compact-proactive",
      models: [
        {
          id: "tiny",
          name: "tiny",
          contextWindow: 50,
          maxTokens: 5,
        },
      ],
    });
    // Two responses: the third user turn's assistant response, then the
    // summarizer completion (one-shot completeSimple from compactThread).
    faux2.setResponses([
      fauxAssistantMessage("third response"),
      fauxAssistantMessage(
        "## Goal\n- test\n\n## Constraints & Preferences\n- (none)\n\n## Progress\n### Done\n- prior turns\n\n### In Progress\n- (none)\n\n### Blocked\n- (none)\n\n## Key Decisions\n- (none)\n\n## Next Steps\n- (none)\n\n## Critical Context\n- (none)\n\n## Relevant Files\n- (none)",
      ),
    ]);
    const { engine: engine2, store: store2, events: events2 } = makeEngine();
    const session2 = await engine2.createSession({
      userId: "u",
      orgId: "o",
      workspace: "/",
      sandbox: {},
      model: faux2.getModel("tiny")!,
      compaction: { tailTurns: 1 },
    });

    // Pre-populate two prior turns directly in the store so we have a
    // head to compact when the third turn triggers proactive compaction.
    const thread = session2.thread();
    await store2.appendEntries(session2.id, thread.id, [
      {
        id: "e-1",
        sessionId: session2.id,
        threadId: thread.id,
        parentId: null,
        type: "message",
        role: "user",
        content: "first prompt",
        createdAt: 1,
      },
      {
        id: "e-2",
        sessionId: session2.id,
        threadId: thread.id,
        parentId: "e-1",
        type: "message",
        role: "assistant",
        content: "first response",
        createdAt: 2,
      },
      {
        id: "e-3",
        sessionId: session2.id,
        threadId: thread.id,
        parentId: "e-2",
        type: "message",
        role: "user",
        content: "second prompt",
        createdAt: 3,
      },
      {
        id: "e-4",
        sessionId: session2.id,
        threadId: thread.id,
        parentId: "e-3",
        type: "message",
        role: "assistant",
        content: "second response",
        createdAt: 4,
      },
    ]);

    // Trigger the third turn — its response reports high usage, kicking
    // off compaction.
    const receipt = await session2.prompt("third prompt");
    await waitFor(
      () =>
        events2.some(
          (e) =>
            e.event.type === "compaction_end" && e.event.threadId === receipt.threadId,
        ),
    );

    // Verify a CompactionEntry was inserted.
    const entries = await store2.getEntries(session2.id, thread.id);
    const compactionEntries = entries.filter(
      (e): e is CompactionEntry => e.type === "compaction",
    );
    expect(compactionEntries).toHaveLength(1);
    const c = compactionEntries[0];
    expect(c.summary).toContain("## Goal");
    expect(c.summary).toContain("## Relevant Files");
    expect(c.coveredEntryIds).toContain("e-1");
    expect(c.coveredEntryIds).toContain("e-2");

    // compaction_start + compaction_end events fired for this thread.
    const compStart = events2.find((e) => e.event.type === "compaction_start");
    const compEnd = events2.find((e) => e.event.type === "compaction_end");
    expect(compStart).toBeDefined();
    expect(compEnd).toBeDefined();

    faux2.unregister();
  });
});

describe("compaction: rehydrate replaces covered entries with the summary", () => {
  it("entriesToAgentMessages drops covered entries and injects <previous-context>", async () => {
    const { entriesToAgentMessages } = await import("../src/thread.js");
    const summary = "## Goal\n- resumed task";
    const messages = entriesToAgentMessages(
      [
        {
          id: "u-1",
          sessionId: "s",
          threadId: "t",
          parentId: null,
          type: "message",
          role: "user",
          content: "old prompt",
          createdAt: 1,
        },
        {
          id: "a-1",
          sessionId: "s",
          threadId: "t",
          parentId: "u-1",
          type: "message",
          role: "assistant",
          content: "old answer",
          createdAt: 2,
        },
        {
          id: "c-1",
          sessionId: "s",
          threadId: "t",
          parentId: "a-1",
          type: "compaction",
          summary,
          coveredEntryIds: ["u-1", "a-1"],
          tokenCountBefore: 100,
          tokenCountAfter: 20,
          createdAt: 3,
        },
        {
          id: "u-2",
          sessionId: "s",
          threadId: "t",
          parentId: "c-1",
          type: "message",
          role: "user",
          content: "new prompt",
          createdAt: 4,
        },
      ],
      { api: "anthropic-messages", provider: "anthropic", id: "model" },
    );
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("user");
    if (messages[0].role === "user") {
      const text = messages[0].content[0];
      if (text.type === "text") expect(text.text).toContain("<previous-context>");
      if (text.type === "text") expect(text.text).toContain(summary);
    }
    expect(messages[1]).toMatchObject({ role: "user" });
    if (messages[1].role === "user") {
      const text = messages[1].content[0];
      if (text.type === "text") expect(text.text).toBe("new prompt");
    }
  });
});
