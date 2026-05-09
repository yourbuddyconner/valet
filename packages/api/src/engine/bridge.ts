import type { BusEvent, MessagePart as EngineMessagePart } from "@valet/engine";
import type { MessagePart as UiMessagePart } from "@valet/shared";

/**
 * Wire shapes the existing client (`packages/client/src/hooks/use-chat.ts`)
 * speaks. We only emit the subset the agent loop needs; UIs ignore unknowns.
 */
export type ClientWsMessage =
  | { type: "init"; session: ClientInitSession; data?: Record<string, unknown> }
  | { type: "message"; data: ClientMessageRow }
  | { type: "message.updated"; data: ClientMessageRow }
  | { type: "chunk"; content: string; messageId?: string }
  | {
      type: "agentStatus";
      status: "idle" | "thinking" | "tool_calling" | "streaming" | "error";
      detail?: string;
    }
  | { type: "error"; messageId: string; error?: string; content?: string }
  | { type: "messages.removed"; messageIds: string[] };

export interface ClientInitSession {
  id: string;
  status: "active" | "archived" | "deleted";
  workspace: string;
  title?: string;
  messages?: ClientMessageRow[];
}

export interface ClientMessageRow {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  parts?: UiMessagePart[];
  threadId?: string;
  createdAt: number;
}

/**
 * Translate the engine's MessagePart vocabulary to the UI's. The engine emits
 * `tool_call` (snake_case); the UI expects `tool-call` (kebab-case). The
 * status enums differ slightly. `thinking` and `attachment` parts are dropped
 * — the UI doesn't render them today.
 */
export function engineToUiParts(parts?: EngineMessagePart[]): UiMessagePart[] {
  if (!parts) return [];
  const out: UiMessagePart[] = [];
  for (const p of parts) {
    switch (p.type) {
      case "text":
        out.push({ type: "text", text: p.text });
        break;
      case "tool_call":
        out.push({
          type: "tool-call",
          callId: p.callId,
          toolName: p.toolName,
          status: p.status,
          args: p.args,
          result: p.result,
          error: p.error,
        });
        break;
      case "error":
        out.push({ type: "error", message: p.message });
        break;
      case "thinking":
      case "attachment":
        // Not rendered by the UI today; drop silently.
        break;
    }
  }
  return out;
}

/**
 * Map a single engine BusEvent to a client WS message. Returns null for
 * events the UI doesn't consume so callers can skip the send.
 */
export function busEventToClient(ev: BusEvent): ClientWsMessage | null {
  const e = ev.event;
  switch (e.type) {
    case "text_delta":
      // Streamed token: client appends optimistically, then reconciles when
      // the corresponding `message_update` lands.
      return { type: "chunk", content: e.text };

    case "message_update":
      return {
        type: "message.updated",
        data: {
          id: e.messageId,
          role: "assistant",
          content: e.content ?? "",
          parts: engineToUiParts(e.parts),
          threadId: e.threadId,
          createdAt: ev.timestamp,
        },
      };

    case "tool_start":
      return { type: "agentStatus", status: "tool_calling", detail: e.tool };

    case "tool_end":
      // Status returns to streaming/idle; the next message_update carries
      // the tool result. We just nudge the badge back.
      return { type: "agentStatus", status: "streaming" };

    case "status":
      // engine status ⊃ UI status. Map the agent-loop subset.
      switch (e.status) {
        case "idle":
        case "queued":
          return { type: "agentStatus", status: "idle" };
        case "thinking":
          return { type: "agentStatus", status: "thinking" };
        case "tool_calling":
          return { type: "agentStatus", status: "tool_calling" };
        case "streaming":
          return { type: "agentStatus", status: "streaming" };
        case "error":
          return { type: "agentStatus", status: "error" };
        case "blocked_on_decision_gate":
          // No matching UI status; surface as idle. (Decision gates are out
          // of scope for v1; the `interactive_prompt` family of events would
          // carry them otherwise.)
          return { type: "agentStatus", status: "idle" };
      }
      return null;

    case "turn_end":
      return { type: "agentStatus", status: "idle" };

    case "error":
      return {
        type: "error",
        messageId: ev.threadId ?? "",
        error: e.error,
      };

    case "message_start":
    case "message_end":
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
      // Out-of-scope event types — silently drop. The UI handles missing
      // events gracefully.
      return null;
  }
}
