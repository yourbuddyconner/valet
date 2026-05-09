import { describe, expect, it } from "vitest";
import type { BusEvent, MessagePart as EngineMessagePart } from "@valet/engine";
import { busEventToClient, engineToUiParts } from "./bridge.js";

function ev(event: BusEvent["event"], threadId = "t1"): BusEvent {
  return { sessionId: "s1", threadId, userId: "u1", event, timestamp: 100 };
}

describe("engineToUiParts", () => {
  it("translates engine tool_call → ui tool-call (kebab)", () => {
    const parts: EngineMessagePart[] = [
      { type: "tool_call", callId: "c1", toolName: "bash", status: "running" },
    ];
    expect(engineToUiParts(parts)).toEqual([
      { type: "tool-call", callId: "c1", toolName: "bash", status: "running" },
    ]);
  });

  it("drops thinking and attachment parts", () => {
    const parts: EngineMessagePart[] = [
      { type: "text", text: "hi" },
      { type: "thinking", text: "..." },
      { type: "attachment", attachment: { kind: "image", mimeType: "image/png", url: "x" } as never },
    ];
    expect(engineToUiParts(parts)).toEqual([{ type: "text", text: "hi" }]);
  });

  it("preserves error parts", () => {
    expect(
      engineToUiParts([{ type: "error", message: "boom" }]),
    ).toEqual([{ type: "error", message: "boom" }]);
  });
});

describe("busEventToClient", () => {
  it("maps text_delta to chunk", () => {
    expect(
      busEventToClient(ev({ type: "text_delta", threadId: "t1", text: "hello" })),
    ).toEqual({ type: "chunk", content: "hello" });
  });

  it("maps message_update to message.updated with translated parts", () => {
    const out = busEventToClient(
      ev({
        type: "message_update",
        threadId: "t1",
        messageId: "m1",
        content: "ok",
        parts: [{ type: "text", text: "ok" }],
      }),
    );
    expect(out).toEqual({
      type: "message.updated",
      data: {
        id: "m1",
        role: "assistant",
        content: "ok",
        parts: [{ type: "text", text: "ok" }],
        threadId: "t1",
        createdAt: 100,
      },
    });
  });

  it("turn_end yields idle agentStatus", () => {
    expect(busEventToClient(ev({ type: "turn_end", threadId: "t1", reason: "end_turn" }))).toEqual({
      type: "agentStatus",
      status: "idle",
    });
  });

  it("tool_start yields tool_calling agentStatus with detail", () => {
    expect(
      busEventToClient(
        ev({ type: "tool_start", threadId: "t1", tool: "bash", args: { cmd: "ls" } }),
      ),
    ).toEqual({ type: "agentStatus", status: "tool_calling", detail: "bash" });
  });

  it("returns null for out-of-scope events", () => {
    expect(
      busEventToClient(
        ev({ type: "message_start", threadId: "t1", messageId: "m1", role: "assistant" }),
      ),
    ).toBeNull();
    expect(
      busEventToClient(ev({ type: "queue_state", threadId: "t1", state: {} as never })),
    ).toBeNull();
  });
});
