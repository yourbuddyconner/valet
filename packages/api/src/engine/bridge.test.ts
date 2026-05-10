import { describe, expect, it } from "vitest";
import type { BusEvent, MessagePart as EngineMessagePart } from "@valet/engine";
import { busEventToWire, engineToWireParts } from "./bridge.js";

function ev(event: BusEvent["event"], threadId = "t1"): BusEvent {
  return { sessionId: "s1", threadId, userId: "u1", event, timestamp: 100 };
}

describe("engineToWireParts", () => {
  it("translates engine tool_call → wire tool_call (snake_case kind)", () => {
    const parts: EngineMessagePart[] = [
      { type: "tool_call", callId: "c1", toolName: "bash", status: "running" },
    ];
    expect(engineToWireParts(parts)).toEqual([
      { kind: "tool_call", callId: "c1", toolName: "bash", status: "running", args: undefined, result: undefined, error: undefined },
    ]);
  });

  it("drops thinking, attachment, error parts", () => {
    const parts: EngineMessagePart[] = [
      { type: "text", text: "hi" },
      { type: "thinking", text: "..." },
      { type: "error", message: "x" },
    ];
    expect(engineToWireParts(parts)).toEqual([{ kind: "text", text: "hi" }]);
  });

  it("returns [] for missing parts", () => {
    expect(engineToWireParts(undefined)).toEqual([]);
  });
});

describe("busEventToWire", () => {
  it("forwards message_start", () => {
    const out = busEventToWire(ev({ type: "message_start", threadId: "t1", messageId: "m1", role: "assistant" }));
    expect(out).toEqual([{ type: "message_start", threadId: "t1", messageId: "m1", role: "assistant" }]);
  });

  it("forwards text_delta with empty messageId placeholder", () => {
    const out = busEventToWire(ev({ type: "text_delta", threadId: "t1", text: "hello" }));
    expect(out).toEqual([{ type: "text_delta", threadId: "t1", messageId: "", delta: "hello" }]);
  });

  it("forwards tool_start", () => {
    const out = busEventToWire(ev({ type: "tool_start", threadId: "t1", tool: "bash", args: { cmd: "ls" } }));
    expect(out).toEqual([{ type: "tool_start", threadId: "t1", toolName: "bash", args: { cmd: "ls" } }]);
  });

  it("forwards tool_end with result + isError", () => {
    const out = busEventToWire(ev({ type: "tool_end", threadId: "t1", tool: "bash", result: "ok", isError: false }));
    expect(out).toEqual([{ type: "tool_end", threadId: "t1", toolName: "bash", result: "ok", isError: false }]);
  });

  it("forwards status events directly (engine status ⊆ wire status)", () => {
    const out = busEventToWire(ev({ type: "status", threadId: "t1", status: "thinking" }));
    expect(out).toEqual([{ type: "status", threadId: "t1", status: "thinking" }]);
  });

  it("forwards turn_end", () => {
    const out = busEventToWire(ev({ type: "turn_end", threadId: "t1", reason: "end_turn" }));
    expect(out).toEqual([{ type: "turn_end", threadId: "t1", reason: "end_turn" }]);
  });

  it("drops out-of-scope event types (decision_gate, compaction, ...)", () => {
    expect(busEventToWire(ev({ type: "thread_start", threadId: "t1" }))).toEqual([]);
    expect(busEventToWire(ev({ type: "compaction_start", threadId: "t1" }))).toEqual([]);
  });

  it("forwards model_switched (thread scope) with threadId preserved", () => {
    const out = busEventToWire(
      ev({
        type: "model_switched",
        threadId: "t1",
        fromModel: "claude-haiku-4-5",
        toModel: "claude-opus-4-7",
        reason: "tool:switch_model",
      }),
    );
    expect(out).toEqual([
      {
        type: "model_switched",
        threadId: "t1",
        fromModel: "claude-haiku-4-5",
        toModel: "claude-opus-4-7",
        reason: "tool:switch_model",
      },
    ]);
  });

  it("forwards model_switched (session scope) with threadId normalized to undefined", () => {
    // Session.setModel emits with an empty threadId to signal session
    // scope; the bridge normalizes it so clients can distinguish from a
    // thread-level switch by checking threadId presence.
    const out = busEventToWire({
      sessionId: "s1",
      threadId: undefined,
      userId: "u1",
      timestamp: 100,
      event: {
        type: "model_switched",
        threadId: "" as unknown as string,
        fromModel: "claude-haiku-4-5",
        toModel: "claude-opus-4-7",
        reason: "set_via_api",
      },
    });
    expect(out).toEqual([
      {
        type: "model_switched",
        threadId: undefined,
        fromModel: "claude-haiku-4-5",
        toModel: "claude-opus-4-7",
        reason: "set_via_api",
      },
    ]);
  });
});
