import { describe, it, expect } from "vitest";
import {
  applyPrune,
  estimateTokens,
  estimateEntryTokens,
  extractFileContext,
  planPrune,
  selectCutPoint,
  tailBudget,
  turns,
  usableTokens,
  type MessageEntry,
  type SessionEntry,
} from "../src/index.js";

const MODEL = {
  id: "fake",
  name: "fake",
  api: "anthropic-messages" as const,
  provider: "anthropic" as const,
  baseUrl: "",
  reasoning: false,
  input: ["text"] as ("text" | "image")[],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 8_000,
};

function user(id: string, content: string): MessageEntry {
  return {
    id,
    sessionId: "s",
    threadId: "t",
    parentId: null,
    type: "message",
    role: "user",
    content,
    createdAt: 1,
  };
}

function assistant(id: string, content: string, parts?: MessageEntry["parts"]): MessageEntry {
  return {
    id,
    sessionId: "s",
    threadId: "t",
    parentId: null,
    type: "message",
    role: "assistant",
    content,
    parts,
    createdAt: 1,
  };
}

describe("compaction: estimateTokens / estimateEntryTokens", () => {
  it("estimateTokens approximates 4 chars per token", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("a".repeat(40))).toBe(10);
  });

  it("counts text content, parts text, and tool args/results", () => {
    const e = assistant("a", "ignored", [
      { type: "text", text: "a".repeat(40) },
      {
        type: "tool_call",
        callId: "c",
        toolName: "x",
        status: "completed",
        args: { p: "y".repeat(20) },
        result: "z".repeat(80),
      },
    ]);
    // 40 (text) + ~30 (args json: {"p":"yyyy..."} ~= 30 chars) + 80 (result) ~= ~37 tokens
    const tokens = estimateEntryTokens(e);
    expect(tokens).toBeGreaterThan(30);
    expect(tokens).toBeLessThan(50);
  });

  it("ignores elided tool results", () => {
    const e = assistant("a", "", [
      {
        type: "tool_call",
        callId: "c",
        toolName: "x",
        status: "completed",
        result: "z".repeat(80),
        elided: true,
      },
    ]);
    expect(estimateEntryTokens(e)).toBe(0);
  });
});

describe("compaction: usableTokens / tailBudget", () => {
  it("usableTokens defaults reserve to min(20k, maxTokens)", () => {
    expect(usableTokens(MODEL)).toBe(100_000 - 8_000);
  });

  it("reserveTokens overrides", () => {
    expect(usableTokens(MODEL, { reserveTokens: 50_000 })).toBe(50_000);
  });

  it("tailBudget = clamp(usable * 0.25, 2k, 8k)", () => {
    expect(tailBudget(100_000)).toBe(8_000);
    expect(tailBudget(20_000)).toBe(5_000);
    expect(tailBudget(4_000)).toBe(2_000);
  });
});

describe("compaction: turns", () => {
  it("segments by user-message boundaries", () => {
    const entries = [
      user("u1", "first"),
      assistant("a1", "ans"),
      user("u2", "second"),
      assistant("a2", "ans"),
    ];
    const t = turns(entries);
    expect(t).toHaveLength(2);
    expect(t[0]).toMatchObject({ start: 0, end: 2, id: "u1" });
    expect(t[1]).toMatchObject({ start: 2, end: 4, id: "u2" });
  });

  it("returns no turns when there are no user messages", () => {
    expect(turns([assistant("a", "x")])).toEqual([]);
  });
});

describe("compaction: selectCutPoint", () => {
  // Use a tokenize override to make the math easy: each entry "weighs" 100 tokens.
  const fixed = () => 100;

  it("keeps the last N turns when they fit the budget", () => {
    const entries = [
      user("u1", ""),
      assistant("a1", ""),
      user("u2", ""),
      assistant("a2", ""),
      user("u3", ""),
      assistant("a3", ""),
    ];
    // budget = 8000 (default) since usable = 100k - 8k = 92k → tailBudget min 8k.
    const cut = selectCutPoint({ entries, model: MODEL, tokenize: fixed });
    // Default tailTurns=2: keep u2/a2 + u3/a3 → cutIndex = 2
    expect(cut.cutIndex).toBe(2);
    expect(cut.tailStartId).toBe("u2");
    expect(cut.fallbackToFloor).toBe(false);
  });

  it("respects tailTurns=1", () => {
    const entries = [
      user("u1", ""),
      assistant("a1", ""),
      user("u2", ""),
      assistant("a2", ""),
    ];
    const cut = selectCutPoint({
      entries,
      model: MODEL,
      cfg: { tailTurns: 1 },
      tokenize: fixed,
    });
    expect(cut.cutIndex).toBe(2);
    expect(cut.tailStartId).toBe("u2");
  });

  it("splits a turn that's too big to fit the budget", () => {
    const entries = [
      user("u1", ""),
      assistant("a1", ""),
      user("u2", ""),
      assistant("a2", ""),
      assistant("a3", ""),
      assistant("a4", ""),
      assistant("a5", ""),
    ];
    // u2 turn is 5 entries × 100 = 500. budget < 500 forces a split.
    const cut = selectCutPoint({
      entries,
      model: MODEL,
      cfg: { tailTurns: 1, minPreserveRecentTokens: 200, maxPreserveRecentTokens: 200 },
      tokenize: fixed,
    });
    // Split point should be inside u2's turn.
    expect(cut.cutIndex).toBeGreaterThan(2);
    expect(cut.cutIndex).toBeLessThan(7);
    expect(cut.fallbackToFloor).toBe(false);
  });

  it("falls back to keeping just the last turn when nothing fits", () => {
    const entries = [
      user("u1", ""),
      // a single huge turn that can't be split below the floor
      assistant("a1", ""),
    ];
    const cut = selectCutPoint({
      entries,
      model: MODEL,
      cfg: { tailTurns: 1, minPreserveRecentTokens: 50, maxPreserveRecentTokens: 50 },
      tokenize: () => 500, // each entry 500, way over the 50-token budget
    });
    expect(cut.cutIndex).toBe(0);
    expect(cut.fallbackToFloor).toBe(true);
  });
});

describe("compaction: planPrune", () => {
  function tcResult(id: string, callId: string, toolName: string, resultLen: number, opts: { protected?: boolean; elided?: boolean } = {}): MessageEntry {
    return assistant(id, "", [
      {
        type: "tool_call",
        callId,
        toolName,
        status: "completed",
        args: { x: 1 },
        result: "z".repeat(resultLen),
        elided: opts.elided,
      },
    ]);
  }

  it("preserves recent tool outputs within the protect window", () => {
    // 30k tokens of recent tool output; protect window is 40k → nothing to elide.
    const entries = [
      user("u1", ""),
      tcResult("a1", "c1", "bash", 60_000), // ~15k tokens
      tcResult("a2", "c2", "bash", 60_000), // ~15k tokens, total ~30k
    ];
    const plan = planPrune({ entries });
    expect(plan.willCommit).toBe(false);
    expect(plan.savedTokens).toBe(0);
  });

  it("marks older tool outputs once cumulative exceeds protect window", () => {
    // 3 entries × ~24k tokens each = 72k cumulative → first two fit in protect window
    // (40k), the oldest one is older than the window → marked.
    const entries = [
      user("u1", ""),
      tcResult("a1", "c1", "bash", 100_000), // ~25k tokens, oldest
      tcResult("a2", "c2", "bash", 100_000), // ~25k
      tcResult("a3", "c3", "bash", 100_000), // ~25k, newest
    ];
    const plan = planPrune({ entries });
    expect(plan.willCommit).toBe(true);
    expect(plan.toElide.has("a1")).toBe(true);
    expect(plan.savedTokens).toBeGreaterThanOrEqual(20_000);
  });

  it("skips protected tools", () => {
    const entries = [
      user("u1", ""),
      tcResult("a1", "c1", "skill", 100_000), // protected by default
      tcResult("a2", "c2", "bash", 100_000),
      tcResult("a3", "c3", "bash", 100_000),
    ];
    const plan = planPrune({ entries });
    // a1 was protected, only a2 / a3 count toward the protect window. a2 sits at ~50k
    // cumulative, a3 at ~25k. So only a2 might be elided. Either way, "a1" is never in
    // the elision plan.
    expect(plan.toElide.has("a1")).toBe(false);
  });

  it("skips already-elided parts", () => {
    const entries = [
      user("u1", ""),
      tcResult("a1", "c1", "bash", 100_000, { elided: true }),
      tcResult("a2", "c2", "bash", 100_000),
      tcResult("a3", "c3", "bash", 100_000),
    ];
    const plan = planPrune({ entries });
    expect(plan.toElide.has("a1")).toBe(false);
  });

  it("doesn't commit if savings are below pruneMinimumTokens", () => {
    const entries = [
      user("u1", ""),
      tcResult("a1", "c1", "bash", 200_000), // ~50k tokens
      tcResult("a2", "c2", "bash", 200_000), // ~50k tokens, plenty in protect
    ];
    // Set pruneMinimumTokens very high → won't commit.
    const plan = planPrune({ entries, cfg: { pruneMinimumTokens: 1_000_000 } });
    expect(plan.willCommit).toBe(false);
  });
});

describe("compaction: applyPrune", () => {
  it("mutates tool_call parts to elided + placeholder result", () => {
    const entries: SessionEntry[] = [
      user("u1", ""),
      assistant("a1", "", [
        {
          type: "tool_call",
          callId: "c1",
          toolName: "bash",
          status: "completed",
          args: { cmd: "ls" },
          result: "very long output",
        },
      ]),
    ];
    const plan = {
      toElide: new Map([["a1", ["c1"]]]),
      savedTokens: 100_000,
      willCommit: true,
    };
    applyPrune(entries, plan);
    const a1 = entries[1];
    if (a1.type !== "message") throw new Error("expected message");
    const tc = a1.parts?.[0];
    expect(tc?.type).toBe("tool_call");
    if (tc?.type === "tool_call") {
      expect(tc.elided).toBe(true);
      expect(tc.result).toEqual({ elided: true, reason: "pruned" });
    }
  });

  it("is a no-op when willCommit=false", () => {
    const entries: SessionEntry[] = [
      user("u1", ""),
      assistant("a1", "", [
        {
          type: "tool_call",
          callId: "c1",
          toolName: "bash",
          status: "completed",
          result: "keep me",
        },
      ]),
    ];
    applyPrune(entries, { toElide: new Map([["a1", ["c1"]]]), savedTokens: 0, willCommit: false });
    const a1 = entries[1];
    if (a1.type !== "message") throw new Error("expected message");
    const tc = a1.parts?.[0];
    if (tc?.type === "tool_call") {
      expect(tc.elided).toBeUndefined();
      expect(tc.result).toBe("keep me");
    }
  });
});

describe("compaction: extractFileContext", () => {
  it("classifies read vs modified by tool name", () => {
    const entries: SessionEntry[] = [
      assistant("a1", "", [
        { type: "tool_call", callId: "c1", toolName: "read", status: "completed", args: { path: "/a.txt" } },
        { type: "tool_call", callId: "c2", toolName: "write", status: "completed", args: { path: "/b.txt" } },
        { type: "tool_call", callId: "c3", toolName: "edit", status: "completed", args: { path: "/c.txt" } },
        { type: "tool_call", callId: "c4", toolName: "grep", status: "completed", args: { path: "/d.txt" } },
      ]),
    ];
    const fc = extractFileContext(entries);
    expect(fc.read.sort()).toEqual(["/a.txt", "/d.txt"]);
    expect(fc.modified.sort()).toEqual(["/b.txt", "/c.txt"]);
  });

  it("dedupes paths", () => {
    const entries: SessionEntry[] = [
      assistant("a1", "", [
        { type: "tool_call", callId: "c1", toolName: "read", status: "completed", args: { path: "/a.txt" } },
        { type: "tool_call", callId: "c2", toolName: "read", status: "completed", args: { path: "/a.txt" } },
      ]),
    ];
    const fc = extractFileContext(entries);
    expect(fc.read).toEqual(["/a.txt"]);
  });
});
