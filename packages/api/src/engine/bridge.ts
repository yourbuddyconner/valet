import type {
  BusEvent,
  DecisionGate as EngineDecisionGate,
  DecisionResolution as EngineDecisionResolution,
  MessagePart as EngineMessagePart,
} from "@valet/engine";
import type {
  DecisionGate as WireDecisionGate,
  DecisionResolution as WireDecisionResolution,
  MessagePart as WireMessagePart,
  WireEvent,
} from "../wire/types.js";

/**
 * Project an engine DecisionGate to its wire shape. Drops engine-only fields
 * (origin/refs/context) — the UI doesn't render those today, and surfacing
 * them now would commit us to a contract before we know what we want.
 */
export function engineGateToWire(g: EngineDecisionGate): WireDecisionGate {
  return {
    id: g.id,
    sessionId: g.sessionId,
    threadId: g.threadId,
    type: g.type,
    title: g.title,
    body: g.body,
    actions: g.actions,
    expiresAt: g.expiresAt,
    status: g.status,
    createdAt: g.createdAt,
    updatedAt: g.updatedAt,
  };
}

export function engineResolutionToWire(r: EngineDecisionResolution): WireDecisionResolution {
  return {
    actionId: r.actionId,
    value: r.value,
    resolvedBy: r.resolvedBy,
    resolvedAt: r.resolvedAt,
  };
}

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

    case "model_switched":
      return [
        {
          type: "model_switched",
          // Engine may emit threadId as an empty string for session-scope
          // switches; normalize to undefined so the client can detect
          // "session vs thread scope" cleanly.
          threadId: e.threadId || undefined,
          fromModel: e.fromModel,
          toModel: e.toModel,
          reason: e.reason,
        },
      ];

    case "decision_gate":
      return [
        {
          type: "decision_gate",
          threadId: e.threadId,
          gate: engineGateToWire(e.gate),
        },
      ];

    case "decision_gate_resolved":
      return [
        {
          type: "decision_gate_resolved",
          threadId: e.threadId,
          gateId: e.gateId,
          resolution: engineResolutionToWire(e.resolution),
        },
      ];

    case "decision_gate_expired":
      return [
        {
          type: "decision_gate_expired",
          threadId: e.threadId,
          gateId: e.gateId,
        },
      ];

    case "decision_gate_withdrawn":
      return [
        {
          type: "decision_gate_withdrawn",
          threadId: e.threadId,
          gateId: e.gateId,
          reason: e.reason,
        },
      ];

    // Out of agent-loop v1 scope — silently dropped. Future plans:
    // compaction events, child-task events, queue state, thread lifecycle.
    case "thread_start":
    case "queue_state":
    case "compaction_start":
    case "compaction_end":
    case "task_start":
    case "task_end":
      return [];
  }
}
