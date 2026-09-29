import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { ExitCode } from "../exit.js";
import { parseGlobalFlags } from "../output.js";
import {
  consumeSend,
  outcomeToExit,
  renderGate,
  renderToolEnd,
  renderToolStart,
  resolvePromptText,
  runSend,
  type SendClient,
  type SendDeps,
  type StreamFn,
} from "./send.js";
import type { DecisionGate, SendPromptRequest, WireEvent } from "../../wire/types.js";

// ── event builders ─────────────────────────────────────────────────────────

function settled(
  outcome: Extract<WireEvent, { type: "submission.settled" }>["outcome"],
  queueItemId = "q1",
  threadId = "t1",
): WireEvent {
  return { seq: 1, ts: 1, type: "submission.settled", sessionId: "s1", threadId, queueItemId, outcome };
}
function textDelta(delta: string, threadId = "t1"): WireEvent {
  return { seq: 1, ts: 1, type: "text_delta", threadId, messageId: "m1", delta };
}
function toolStart(toolName: string, threadId = "t1"): WireEvent {
  return { seq: 1, ts: 1, type: "tool_start", threadId, toolName };
}
function toolEnd(toolName: string, isError: boolean, threadId = "t1"): WireEvent {
  return { seq: 1, ts: 1, type: "tool_end", threadId, toolName, result: "", isError };
}
const GATE: DecisionGate = {
  id: "gate_1",
  sessionId: "s1",
  threadId: "t1",
  type: "approval",
  title: "Approve write?",
  body: "write hello.txt",
  actions: [
    { id: "approve", label: "Approve" },
    { id: "deny", label: "Deny", style: "danger" },
  ],
  status: "pending",
  createdAt: 1,
  updatedAt: 1,
};
function gateEvent(threadId = "t1"): WireEvent {
  return { seq: 1, ts: 1, type: "decision_gate", threadId, gate: GATE };
}
function turnEnd(threadId = "t1"): WireEvent {
  return { seq: 1, ts: 1, type: "turn_end", threadId, reason: "end_turn" };
}

function makeStream(events: WireEvent[]): StreamFn {
  return () =>
    (async function* () {
      for (const e of events) yield e;
    })();
}

function stubDeps(events: WireEvent[], overrides: Partial<SendClient> = {}): {
  deps: SendDeps;
  sent: { id: string; body: SendPromptRequest }[];
  ensureCalls: number;
} {
  const sent: { id: string; body: SendPromptRequest }[] = [];
  let ensureCalls = 0;
  const client: SendClient = {
    getThread: () => Promise.resolve({ sessionId: "s1" }),
    ensureOrchestrator: () => {
      ensureCalls += 1;
      return Promise.resolve({ sessionId: "orch_1" });
    },
    sendPrompt: (id, body) => {
      sent.push({ id, body });
      return Promise.resolve({ messageId: "q1", threadId: "t1", activityAt: 1 });
    },
    ...overrides,
  };
  return {
    deps: { client, stream: makeStream(events), url: "http://x", apiKey: undefined },
    sent,
    get ensureCalls() {
      return ensureCalls;
    },
  };
}

let outSpy: MockInstance;
let errSpy: MockInstance;
beforeEach(() => {
  outSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  errSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
});
afterEach(() => vi.restoreAllMocks());
const stdout = (): string => outSpy.mock.calls.map((c) => String(c[0])).join("");
const stderr = (): string => errSpy.mock.calls.map((c) => String(c[0])).join("");

// ── pure helpers ─────────────────────────────────────────────────────────

describe("outcomeToExit", () => {
  it("maps completed and merged to OK", () => {
    expect(outcomeToExit("completed")).toBe(ExitCode.OK);
    expect(outcomeToExit("merged")).toBe(ExitCode.OK);
  });
  it("maps failed, aborted, superseded to TurnError", () => {
    expect(outcomeToExit("failed")).toBe(ExitCode.TurnError);
    expect(outcomeToExit("aborted")).toBe(ExitCode.TurnError);
    expect(outcomeToExit("superseded")).toBe(ExitCode.TurnError);
  });
});

describe("resolvePromptText", () => {
  it("joins positionals", () => {
    expect(resolvePromptText(parseGlobalFlags(["write", "hello.txt"]))).toBe("write hello.txt");
  });
  it("falls back to --text", () => {
    expect(resolvePromptText(parseGlobalFlags(["--text", "hi there"]))).toBe("hi there");
  });
  it("returns undefined for an empty prompt", () => {
    expect(resolvePromptText(parseGlobalFlags(["--session", "s"]))).toBeUndefined();
  });
});

describe("render helpers", () => {
  it("renderToolStart / renderToolEnd", () => {
    expect(renderToolStart("bash")).toContain("bash");
    expect(renderToolStart("bash")).toContain("running");
    expect(renderToolEnd("bash", false)).toContain("✓");
    expect(renderToolEnd("bash", true)).toContain("✗");
  });
  it("renderGate lists actions and the resolve hint", () => {
    const text = renderGate(GATE);
    expect(text).toContain("Approve write?");
    expect(text).toContain("approve");
    expect(text).toContain("deny");
    expect(text).toContain("valet gates resolve gate_1 <actionId> --thread t1");
  });
});

// ── consumeSend ────────────────────────────────────────────────────────────

const ctx = { sessionId: "s1", messageId: "q1", threadId: "t1", json: false };

describe("consumeSend", () => {
  it("streams deltas and returns OK on a matching completed settle", async () => {
    const { deps } = stubDeps([textDelta("hello "), textDelta("world"), settled("completed")]);
    const code = await consumeSend(deps, ctx);
    expect(code).toBe(ExitCode.OK);
    expect(stdout()).toContain("hello world");
  });

  it("returns TurnError on a failed settle", async () => {
    const { deps } = stubDeps([settled("failed")]);
    expect(await consumeSend(deps, ctx)).toBe(ExitCode.TurnError);
  });

  it("renders tool lifecycle lines", async () => {
    const { deps } = stubDeps([toolStart("bash"), toolEnd("bash", false), settled("completed")]);
    await consumeSend(deps, ctx);
    expect(stdout()).toContain("bash · running");
    expect(stdout()).toContain("✓ bash");
  });

  it("returns GatePending when a gate on our thread blocks the turn", async () => {
    const { deps } = stubDeps([textDelta("thinking"), gateEvent()]);
    const code = await consumeSend(deps, ctx);
    expect(code).toBe(ExitCode.GatePending);
    expect(stdout()).toContain("Approve write?");
  });

  it("ignores a settle for a different queueItemId", async () => {
    const { deps } = stubDeps([settled("failed", "other-q"), settled("completed", "q1")]);
    expect(await consumeSend(deps, ctx)).toBe(ExitCode.OK);
  });

  it("returns OK on turn_end for our thread (fallback when the settle frame is missed)", async () => {
    const { deps } = stubDeps([textDelta("hi"), turnEnd()]);
    expect(await consumeSend(deps, ctx)).toBe(ExitCode.OK);
  });

  it("waits past turn_end for the settle frame and maps its outcome", async () => {
    // The engine settles AFTER turn_end (settlement is post-turn bookkeeping),
    // so the settle frame trails turn_end on the stream. A failed settle after
    // turn_end must surface as TurnError, not be preempted by the fallback.
    const { deps } = stubDeps([textDelta("hi"), turnEnd(), settled("failed")]);
    expect(await consumeSend(deps, ctx)).toBe(ExitCode.TurnError);
  });

  it("maps a completed settle that trails turn_end", async () => {
    const { deps } = stubDeps([textDelta("hi"), turnEnd(), settled("completed")]);
    expect(await consumeSend(deps, ctx)).toBe(ExitCode.OK);
  });

  it("falls back to OK when no settle arrives within the grace window", async () => {
    // Stream hangs (never ends, never settles) after turn_end.
    const hang = new Promise<never>(() => {});
    const stream: StreamFn = () =>
      (async function* () {
        yield turnEnd();
        await hang;
      })();
    const { deps } = stubDeps([]);
    const code = await consumeSend({ ...deps, stream }, { ...ctx, settleGraceMs: 50 });
    expect(code).toBe(ExitCode.OK);
  });

  it("keeps consuming past a turn_end on another thread", async () => {
    const { deps } = stubDeps([turnEnd("other-t"), settled("failed")]);
    expect(await consumeSend(deps, ctx)).toBe(ExitCode.TurnError);
  });

  it("emits NDJSON of raw events in --json mode and returns the exit code", async () => {
    const { deps } = stubDeps([textDelta("x"), settled("completed")]);
    const code = await consumeSend(deps, { ...ctx, json: true });
    expect(code).toBe(ExitCode.OK);
    const lines = stdout().trim().split("\n");
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]) as WireEvent;
    const last = JSON.parse(lines[1]) as WireEvent;
    expect(first.type).toBe("text_delta");
    expect(last.type).toBe("submission.settled");
  });

  it("returns TurnError if the stream ends before settling", async () => {
    const { deps } = stubDeps([textDelta("half")]);
    const code = await consumeSend(deps, ctx);
    expect(code).toBe(ExitCode.TurnError);
    expect(stderr()).toContain("before the turn settled");
  });
});

// ── runSend ──────────────────────────────────────────────────────────────

describe("runSend", () => {
  it("rejects an empty prompt with Usage", async () => {
    const { deps, sent } = stubDeps([]);
    const code = await runSend(deps, parseGlobalFlags([]));
    expect(code).toBe(ExitCode.Usage);
    expect(sent).toHaveLength(0);
  });

  it("defaults to the orchestrator and sends the joined prompt", async () => {
    const bundle = stubDeps([settled("completed")]);
    const code = await runSend(bundle.deps, parseGlobalFlags(["write", "hello.txt"]));
    expect(code).toBe(ExitCode.OK);
    expect(bundle.ensureCalls).toBe(1);
    expect(bundle.sent).toEqual([{ id: "orch_1", body: { text: "write hello.txt", threadId: undefined } }]);
  });

  it("resolves --thread without creating a runtime", async () => {
    const bundle = stubDeps([settled("completed")]);
    const code = await runSend(bundle.deps, parseGlobalFlags(["--thread", "t1", "--text", "hi"]));
    expect(code).toBe(ExitCode.OK);
    expect(bundle.ensureCalls).toBe(0);
    expect(bundle.sent).toEqual([{ id: "s1", body: { text: "hi", threadId: "t1" } }]);
  });

  it("rejects a session that does not own the selected thread", async () => {
    const bundle = stubDeps([]);
    const code = await runSend(bundle.deps, parseGlobalFlags(["--thread", "t1", "--session", "other", "--text", "hi"]));
    expect(code).toBe(ExitCode.Usage);
    expect(bundle.sent).toHaveLength(0);
  });

  it("uses --session override and skips ensureOrchestrator", async () => {
    const bundle = stubDeps([settled("completed")]);
    const code = await runSend(bundle.deps, parseGlobalFlags(["--session", "sess_9", "--text", "hi"]));
    expect(code).toBe(ExitCode.OK);
    expect(bundle.ensureCalls).toBe(0);
    expect(bundle.sent[0].id).toBe("sess_9");
  });
});


it("does not silently send to the default runtime when a target flag is empty", async () => {
  const bundle = stubDeps([]);
  for (const args of [["hello", "--thread"], ["hello", "--thread="], ["hello", "--session"]]) {
    expect(await runSend(bundle.deps, parseGlobalFlags(args))).toBe(ExitCode.Usage);
  }
  expect(bundle.sent).toEqual([]);
  expect(bundle.ensureCalls).toBe(0);
});
