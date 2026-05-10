/**
 * Per-session streaming state. The WS subscriber pipes wire events into this
 * store; the UI subscribes by sessionId and renders the derived message list.
 *
 * Why not just useReducer + context: the message list updates *frequently*
 * (every text_delta), and sub-trees (a single MessageItem) want to consume
 * just their slice. Zustand's selector subscriptions give us per-message
 * granularity for free.
 */
import { create } from "zustand";
import type { Message, MessagePart, WireEvent } from "@valet/api/wire";

export type ConnectionStatus = "idle" | "connecting" | "open" | "closed" | "error";

export type AgentStatus =
  | "idle"
  | "queued"
  | "thinking"
  | "tool_calling"
  | "streaming"
  | "blocked_on_decision_gate"
  | "error";

export interface SessionStreamState {
  /** Whether the WS is currently open. */
  conn: ConnectionStatus;
  /** Highest wire seq we've seen for this session. */
  lastSeq: number;
  /** Engine-reported agent status; mirrors the wire `status` event. */
  agentStatus: AgentStatus;
  /** Live message list. Server `init` seeds it; wire events mutate it. */
  messages: Message[];
  /** Last error message from the wire (if any). Cleared on successful turn_end. */
  error?: { code: string; message: string };
}

export interface StreamStore {
  bySession: Record<string, SessionStreamState>;
  // ── actions ────────────────────────────────────────────────────────────
  setConnection(sessionId: string, conn: ConnectionStatus): void;
  ingest(sessionId: string, ev: WireEvent): void;
  reset(sessionId: string): void;
  remove(sessionId: string): void;
}

const EMPTY: SessionStreamState = {
  conn: "idle",
  lastSeq: 0,
  agentStatus: "idle",
  messages: [],
};

function ensure(state: StreamStore, sessionId: string): SessionStreamState {
  return state.bySession[sessionId] ?? { ...EMPTY };
}

/**
 * Apply one wire event to a session slice. Pure: returns a new slice or
 * the same one if nothing changed.
 */
function reduce(slice: SessionStreamState, ev: WireEvent, sessionId: string): SessionStreamState {
  // Drop replays / out-of-order frames.
  if (ev.seq <= slice.lastSeq) return slice;

  const next: SessionStreamState = {
    ...slice,
    lastSeq: ev.seq,
  };

  switch (ev.type) {
    case "init": {
      next.messages = ev.messages;
      next.error = undefined;
      next.agentStatus = "idle";
      return next;
    }

    case "message_start": {
      // Begin a new message row. Engine emits this for assistant + system roles.
      const exists = slice.messages.some((m) => m.id === ev.messageId);
      if (exists) return next;
      const newMsg: Message = {
        id: ev.messageId,
        sessionId,
        threadId: ev.threadId,
        role: ev.role === "system" ? "system" : "assistant",
        content: "",
        parts: [],
        createdAt: ev.ts,
      };
      next.messages = [...slice.messages, newMsg];
      return next;
    }

    case "text_delta": {
      const idx = lastIndex(slice.messages, (m) => m.id === ev.messageId);
      if (idx < 0) return next;
      const m = slice.messages[idx];
      const parts = appendTextPart(m.parts, ev.delta);
      const updated = { ...m, parts, content: m.content + ev.delta };
      next.messages = replaceAt(slice.messages, idx, updated);
      return next;
    }

    case "message_update": {
      const idx = lastIndex(slice.messages, (m) => m.id === ev.messageId);
      if (idx < 0) return next;
      const m = slice.messages[idx];
      const updated: Message = {
        ...m,
        parts: ev.parts,
        content: ev.content ?? m.content,
      };
      next.messages = replaceAt(slice.messages, idx, updated);
      return next;
    }

    case "message_end": {
      // Just a marker. We could clear streaming flags here when we add them.
      return next;
    }

    case "tool_start": {
      // Add a tool_call part (running) to the latest assistant message.
      const idx = lastAssistantIndex(slice.messages, ev.threadId);
      if (idx < 0) return next;
      const m = slice.messages[idx];
      const part: MessagePart = {
        kind: "tool_call",
        callId: ev.callId ?? `${ev.toolName}_${ev.ts}`,
        toolName: ev.toolName,
        status: "running",
        args: ev.args,
      };
      next.messages = replaceAt(slice.messages, idx, { ...m, parts: [...m.parts, part] });
      return next;
    }

    case "tool_end": {
      const idx = lastAssistantIndex(slice.messages, ev.threadId);
      if (idx < 0) return next;
      const m = slice.messages[idx];
      // Find the most recent running tool_call with this name.
      let pidx = -1;
      for (let i = m.parts.length - 1; i >= 0; i--) {
        const p = m.parts[i];
        if (p.kind === "tool_call" && p.toolName === ev.toolName && p.status === "running") {
          pidx = i;
          break;
        }
      }
      if (pidx < 0) return next;
      const old = m.parts[pidx];
      if (old.kind !== "tool_call") return next;
      const updatedPart: MessagePart = {
        ...old,
        status: ev.isError ? "error" : "completed",
        result: ev.result,
        error: ev.isError ? ev.result : undefined,
      };
      const parts = replaceAt(m.parts, pidx, updatedPart);
      next.messages = replaceAt(slice.messages, idx, { ...m, parts });
      return next;
    }

    case "status": {
      next.agentStatus = ev.status;
      return next;
    }

    case "turn_end": {
      next.agentStatus = "idle";
      next.error = undefined;
      return next;
    }

    case "error": {
      next.error = { code: ev.code, message: ev.message };
      next.agentStatus = "error";
      return next;
    }

    case "ping": {
      return next;
    }
  }
}

// ── helpers ──────────────────────────────────────────────────────────────

function lastIndex<T>(arr: T[], pred: (t: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i])) return i;
  return -1;
}

function lastAssistantIndex(messages: Message[], threadId: string): number {
  return lastIndex(messages, (m) => m.role === "assistant" && m.threadId === threadId);
}

function replaceAt<T>(arr: T[], i: number, val: T): T[] {
  const out = arr.slice();
  out[i] = val;
  return out;
}

/**
 * Append a text delta to the trailing text part of `parts`. If the last part
 * isn't a text part, push a new text part with the delta as its content.
 */
function appendTextPart(parts: MessagePart[], delta: string): MessagePart[] {
  const last = parts[parts.length - 1];
  if (last && last.kind === "text") {
    return [...parts.slice(0, -1), { kind: "text", text: last.text + delta }];
  }
  return [...parts, { kind: "text", text: delta }];
}

// ── store ────────────────────────────────────────────────────────────────

export const useStreamStore = create<StreamStore>((set) => ({
  bySession: {},

  setConnection: (sessionId, conn) =>
    set((state) => ({
      bySession: { ...state.bySession, [sessionId]: { ...ensure(state, sessionId), conn } },
    })),

  ingest: (sessionId, ev) =>
    set((state) => {
      const slice = ensure(state, sessionId);
      const updated = reduce(slice, ev, sessionId);
      if (updated === slice) return state;
      return { bySession: { ...state.bySession, [sessionId]: updated } };
    }),

  reset: (sessionId) =>
    set((state) => ({ bySession: { ...state.bySession, [sessionId]: { ...EMPTY } } })),

  remove: (sessionId) =>
    set((state) => {
      const next = { ...state.bySession };
      delete next[sessionId];
      return { bySession: next };
    }),
}));

// ── selectors ────────────────────────────────────────────────────────────

export function useSessionStream(sessionId: string): SessionStreamState {
  return useStreamStore((s) => s.bySession[sessionId] ?? EMPTY);
}
