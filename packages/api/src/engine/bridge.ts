import type { BusEvent, MessagePart as EngineMessagePart } from "@valet/engine";
import type { MessagePart as WireMessagePart, WireEvent } from "../wire/types.js";

/**
 * Translate engine MessagePart → wire MessagePart.
 *
 * Engine has more variants than the wire (thinking, attachment, error). The
 * agent-loop UI only renders text and tool_call; the rest are dropped.
 */
export function engineToWireParts(parts?: EngineMessagePart[]): WireMessagePart[] {
  if (!parts) return [];
  const out: WireMessagePart[] = [];
  for (const p of parts) {
    switch (p.type) {
      case "text":
        out.push({ kind: "text", text: p.text });
        break;
      case "tool_call":
        out.push({
          kind: "tool_call",
          callId: p.callId,
          toolName: p.toolName,
          status: p.status,
          args: p.args,
          result: p.result,
          error: p.error,
        });
        break;
      // thinking, attachment, error parts: dropped on the wire (UI ignores).
      case "thinking":
      case "attachment":
      case "error":
        break;
    }
  }
  return out;
}

/**
 * Map an engine BusEvent to zero or more wire events.
 *
 * The bridge is mechanical: each engine event type either translates 1:1, is
 * dropped, or produces a small ordered fan-out of wire events. Sequence
 * numbers and timestamps are added by the WebSocket dispatcher (`emitter()`)
 * — this function returns `Omit<WireEvent, "seq" | "ts">[]` so the dispatcher
 * stays the source of truth for ordering.
 */
/**
 * Distributive `Omit` so the discriminated union survives the narrowing.
 * Plain `Omit<WireEvent, ...>` collapses to a single intersection type;
 * `WireEvent extends infer T ? ...` distributes per variant.
 */
export type WireEventDraft = WireEvent extends infer T
  ? T extends WireEvent
    ? Omit<T, "seq" | "ts">
    : never
  : never;

export function busEventToWire(ev: BusEvent): WireEventDraft[] {
  const e = ev.event;
  switch (e.type) {
    case "message_start":
      return [
        {
          type: "message_start",
          threadId: e.threadId,
          messageId: e.messageId,
          role: e.role === "system" ? "system" : "assistant",
        },
      ];

    case "text_delta":
      // Wire delta carries messageId so the client can target the right row.
      // Engine's text_delta doesn't ship messageId; the client correlates by
      // the most recent message_start. We forward the delta verbatim and let
      // the consumer track the active messageId for that thread.
      return [
        {
          type: "text_delta",
          threadId: e.threadId,
          messageId: "", // filled in by dispatcher's per-thread state
          delta: e.text,
        },
      ];

    case "message_update":
      return [
        {
          type: "message_update",
          threadId: e.threadId,
          messageId: e.messageId,
          parts: engineToWireParts(e.parts),
          content: e.content,
        },
      ];

    case "message_end":
      return [
        {
          type: "message_end",
          threadId: e.threadId,
          messageId: e.messageId,
          reason: e.reason,
        },
      ];

    case "tool_start":
      return [
        {
          type: "tool_start",
          threadId: e.threadId,
          toolName: e.tool,
          args: e.args,
        },
      ];

    case "tool_end":
      return [
        {
          type: "tool_end",
          threadId: e.threadId,
          toolName: e.tool,
          result: e.result,
          isError: e.isError,
        },
      ];

    case "status":
      return [
        {
          type: "status",
          threadId: e.threadId,
          status: e.status,
        },
      ];

    case "turn_end":
      return [
        {
          type: "turn_end",
          threadId: e.threadId,
          reason: e.reason,
        },
      ];

    case "error":
      return [
        {
          type: "error",
          threadId: e.threadId,
          code: e.code,
          message: e.error,
          recoverable: e.recoverable,
        },
      ];

    // Out of agent-loop v1 scope — silently dropped. Adding any of these to
    // the wire is a future plan: decision gates, compaction events,
    // child-task events, model switches, queue state, thread lifecycle.
    case "thread_start":
    case "queue_state":
    case "compaction_start":
    case "compaction_end":
    case "task_start":
    case "task_end":
    case "decision_gate":
    case "decision_gate_resolved":
    case "decision_gate_expired":
    case "decision_gate_withdrawn":
    case "model_switched":
      return [];
  }
}
