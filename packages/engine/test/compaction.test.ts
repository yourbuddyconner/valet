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

describe("compaction: auto-continue", () => {
  it("after proactive compaction, runs an auto-continue turn tagged with compaction_continue", async () => {
    const faux = registerFauxProvider({
      provider: "compact-autocontinue",
      models: [{ id: "tiny", name: "tiny", contextWindow: 50, maxTokens: 5 }],
    });
    faux.setResponses([
      // Third user prompt → assistant response (triggers proactive compaction).
      fauxAssistantMessage("third response"),
      // Summarizer one-shot.
      fauxAssistantMessage(
        "## Goal\n- t\n\n## Constraints & Preferences\n- (none)\n\n## Progress\n### Done\n- (none)\n\n### In Progress\n- (none)\n\n### Blocked\n- (none)\n\n## Key Decisions\n- (none)\n\n## Next Steps\n- (none)\n\n## Critical Context\n- (none)\n\n## Relevant Files\n- (none)",
      ),
      // Auto-continue turn → assistant response.
      fauxAssistantMessage("continued from where I left off"),
    ]);
    const { engine, store, events } = makeEngine();
    const session = await engine.createSession({
      userId: "u",
      orgId: "o",
      workspace: "/",
      sandbox: {},
      model: faux.getModel("tiny")!,
      compaction: { tailTurns: 1 },
    });
    const thread = session.thread();
    await store.appendEntries(session.id, thread.id, [
      {
        id: "u-1",
        sessionId: session.id,
        threadId: thread.id,
        parentId: null,
        type: "message",
        role: "user",
        content: "first prompt",
        createdAt: 1,
      },
      {
        id: "a-1",
        sessionId: session.id,
        threadId: thread.id,
        parentId: "u-1",
        type: "message",
        role: "assistant",
        content: "first response",
        createdAt: 2,
      },
    ]);

    const receipt = await session.prompt("third prompt");
    // Wait for two turn_ends after the prompt: the original third turn,
    // then the auto-continue turn.
    await waitFor(
      () =>
        events.filter(
          (e) => e.event.type === "turn_end" && e.event.threadId === receipt.threadId,
        ).length >= 2,
    );

    const entries = await store.getEntries(session.id, thread.id);
    const userEntries = entries.filter(
      (e) => e.type === "message" && e.role === "user",
    );
    // The auto-continue user message should be present and tagged.
    const autoContinue = userEntries.find(
      (e) => e.type === "message" && e.metadata?.compaction_continue === true,
    );
    expect(autoContinue).toBeDefined();
    if (autoContinue?.type === "message") {
      expect(autoContinue.content).toContain("Continue if you have next steps");
    }
    // And the assistant's continuation response should follow it.
    const lastAssistant = entries
      .filter((e) => e.type === "message" && e.role === "assistant")
      .at(-1);
    expect(lastAssistant?.type === "message" && lastAssistant.content).toBe(
      "continued from where I left off",
    );

    faux.unregister();
  });

  it("autoContinue: false suppresses the synthetic follow-up", async () => {
    const faux = registerFauxProvider({
      provider: "compact-autocontinue-off",
      models: [{ id: "tiny", name: "tiny", contextWindow: 50, maxTokens: 5 }],
    });
    faux.setResponses([
      fauxAssistantMessage("third response"),
      fauxAssistantMessage(
        "## Goal\n- t\n\n## Constraints & Preferences\n- (none)\n\n## Progress\n### Done\n- (none)\n\n### In Progress\n- (none)\n\n### Blocked\n- (none)\n\n## Key Decisions\n- (none)\n\n## Next Steps\n- (none)\n\n## Critical Context\n- (none)\n\n## Relevant Files\n- (none)",
      ),
    ]);
    const { engine, store, events } = makeEngine();
    const session = await engine.createSession({
      userId: "u",
      orgId: "o",
      workspace: "/",
      sandbox: {},
      model: faux.getModel("tiny")!,
      compaction: { tailTurns: 1, autoContinue: false },
    });
    const thread = session.thread();
    await store.appendEntries(session.id, thread.id, [
      {
        id: "u-1",
        sessionId: session.id,
        threadId: thread.id,
        parentId: null,
        type: "message",
        role: "user",
        content: "first prompt",
        createdAt: 1,
      },
      {
        id: "a-1",
        sessionId: session.id,
        threadId: thread.id,
        parentId: "u-1",
        type: "message",
        role: "assistant",
        content: "first response",
        createdAt: 2,
      },
    ]);

    const receipt = await session.prompt("third prompt");
    await waitFor(
      () =>
        events.some(
          (e) =>
            e.event.type === "compaction_end" && e.event.threadId === receipt.threadId,
        ),
    );
    // Wait a bit longer to make sure no follow-up turn fires.
    await new Promise((r) => setTimeout(r, 100));

    const entries = await store.getEntries(session.id, thread.id);
    const synthetic = entries.find(
      (e) => e.type === "message" && e.metadata?.compaction_continue === true,
    );
    expect(synthetic).toBeUndefined();

    faux.unregister();
  });
});

describe("compaction: pruning persists via updateEntry", () => {
  it("pruned tool_call results are marked elided in the DAG, not just the live transcript", async () => {
    const faux = registerFauxProvider({
      provider: "compact-prune-persist",
      models: [{ id: "tiny", name: "tiny", contextWindow: 50, maxTokens: 5 }],
    });
    faux.setResponses([
      fauxAssistantMessage("trigger response"),
      fauxAssistantMessage(
        "## Goal\n- t\n\n## Constraints & Preferences\n- (none)\n\n## Progress\n### Done\n- (none)\n\n### In Progress\n- (none)\n\n### Blocked\n- (none)\n\n## Key Decisions\n- (none)\n\n## Next Steps\n- (none)\n\n## Critical Context\n- (none)\n\n## Relevant Files\n- (none)",
      ),
    ]);
    const { engine, store, events } = makeEngine();
    const session = await engine.createSession({
      userId: "u",
      orgId: "o",
      workspace: "/",
      sandbox: {},
      model: faux.getModel("tiny")!,
      compaction: {
        tailTurns: 1,
        // Tiny token thresholds so a moderately-sized fixture triggers pruning
        // even though we're working with chars, not real tokens.
        pruneProtectTokens: 200,
        pruneMinimumTokens: 200,
      },
    });
    const thread = session.thread();

    // Pre-populate the DAG with two prior turns whose assistant messages
    // contain large bash tool outputs (~3000 chars each ≈ 750 token estimate).
    const bigOutput = "x".repeat(3_000);
    await store.appendEntries(session.id, thread.id, [
      {
        id: "u-1",
        sessionId: session.id,
        threadId: thread.id,
        parentId: null,
        type: "message",
        role: "user",
        content: "first prompt",
        createdAt: 1,
      },
      {
        id: "a-1",
        sessionId: session.id,
        threadId: thread.id,
        parentId: "u-1",
        type: "message",
        role: "assistant",
        content: "",
        parts: [
          {
            type: "tool_call",
            callId: "tc-1",
            toolName: "bash",
            status: "completed",
            args: { command: "ls /large-dir" },
            result: bigOutput,
          },
        ],
        createdAt: 2,
      },
      {
        id: "u-2",
        sessionId: session.id,
        threadId: thread.id,
        parentId: "a-1",
        type: "message",
        role: "user",
        content: "second prompt",
        createdAt: 3,
      },
      {
        id: "a-2",
        sessionId: session.id,
        threadId: thread.id,
        parentId: "u-2",
        type: "message",
        role: "assistant",
        content: "",
        parts: [
          {
            type: "tool_call",
            callId: "tc-2",
            toolName: "bash",
            status: "completed",
            args: { command: "cat /large-file" },
            result: bigOutput,
          },
        ],
        createdAt: 4,
      },
    ]);

    const receipt = await session.prompt("third prompt");
    await waitFor(
      () =>
        events.some(
          (e) =>
            e.event.type === "compaction_end" && e.event.threadId === receipt.threadId,
        ),
    );

    // Re-load entries from the store and verify a-1's tool_call.result is elided.
    const entries = await store.getEntries(session.id, thread.id);
    const a1 = entries.find((e) => e.id === "a-1");
    expect(a1?.type).toBe("message");
    if (a1?.type === "message") {
      const tc = a1.parts?.[0];
      expect(tc?.type).toBe("tool_call");
      if (tc?.type === "tool_call") {
        expect(tc.elided).toBe(true);
        expect(tc.result).toEqual({ elided: true, reason: "pruned" });
      }
    }

    faux.unregister();
  });
});
