/**
 * Wire protocol — REST + WebSocket shapes shared between server and web.
 *
 * Single source of truth: the web package imports these types via the
 * `@valet/api/wire` subpath export. No build step — Vite resolves source TS.
 *
 * Stability rules:
 *   - REST request/response shapes are versioned implicitly by the route path.
 *   - WS frames have a discriminated `type`. Add new types; don't repurpose.
 *   - WS frames carry a monotonically-increasing `seq` (per session) so the
 *     client can dedupe on reconnect with `lastSeq`.
 */

// ── Common ────────────────────────────────────────────────────────────────

export interface User {
  id: string;
  email: string;
  name?: string;
}

export interface ApiError {
  error: string;
  code?: string;
}

// ── REST: auth ────────────────────────────────────────────────────────────

export interface MeResponse {
  user: User;
}

// ── REST: sessions ────────────────────────────────────────────────────────

export type SessionStatus = "active" | "archived" | "deleted";

export interface SessionSummary {
  id: string;
  workspace: string;
  status: SessionStatus;
  title?: string;
  createdAt: number;
  updatedAt: number;
}

export interface SessionDetail extends SessionSummary {
  messageCount: number;
  /** Session-default model id. Threads inherit when they have no override. */
  model?: string;
}

export interface CreateSessionRequest {
  workspace: string;
  title?: string;
  /** Optional first user prompt; if set, server enqueues immediately after creation. */
  initialPrompt?: string;
}

export interface ListSessionsResponse {
  sessions: SessionSummary[];
}

export type CreateSessionResponse = SessionDetail;
export type GetSessionResponse = SessionDetail;

// ── REST: threads ─────────────────────────────────────────────────────────

export interface ThreadSummary {
  id: string;
  sessionId: string;
  title?: string;
  createdAt: number;
  /** Thread-level model override. Falls back to the session default when undefined. */
  model?: string;
}

export interface ListThreadsResponse {
  threads: ThreadSummary[];
}

export interface CreateThreadRequest {
  /** Optional title — not currently persisted by the engine; reserved. */
  title?: string;
}

export type CreateThreadResponse = ThreadSummary;

/**
 * Patch a thread's settings. Currently only `model` is mutable; pass
 * `null` to clear the override and fall back to the session default.
 */
export interface PatchThreadRequest {
  model?: string | null;
}

export type PatchThreadResponse = ThreadSummary;

/**
 * Patch a session's settings. Currently only `model` is mutable; this is
 * the session default that threads inherit when they have no override.
 */
export interface PatchSessionRequest {
  model?: string;
}

export type PatchSessionResponse = SessionDetail;

// ── REST: messages ────────────────────────────────────────────────────────

export type MessageRole = "user" | "assistant" | "tool" | "system";

/**
 * Discriminated union for message parts. Mirrors the engine's MessagePart
 * one-to-one for `text` and `tool_call` so the bridge is mechanical.
 * `thinking` and `attachment` parts from the engine are dropped on the wire
 * (the UI doesn't render them in the agent loop).
 */
export type MessagePart =
  | { kind: "text"; text: string }
  | {
      kind: "tool_call";
      callId: string;
      toolName: string;
      status: "running" | "completed" | "error";
      args?: unknown;
      result?: unknown;
      error?: string;
    };

export interface Message {
  id: string;
  sessionId: string;
  threadId: string | null;
  role: MessageRole;
  content: string;
  parts: MessagePart[];
  createdAt: number;
}

export interface ListMessagesResponse {
  messages: Message[];
  hasMore: boolean;
  nextCursor?: string;
}

export interface SendPromptRequest {
  text: string;
  /** Target thread id. If omitted, server uses the session's default thread. */
  threadId?: string;
}

export interface SendPromptResponse {
  /** ID for client-side optimistic placeholder; the actual user-message row created server-side. */
  messageId: string;
  threadId: string;
}

// ── WebSocket events ──────────────────────────────────────────────────────

/**
 * `WireEvent` is the discriminated union the client receives on the WS.
 * Shape designed for the agent loop only: deltas + tool lifecycle + status.
 *
 * Engine emits richer events (compaction, decision gates, model switches)
 * — those that the loop UI needs to render are surfaced here; the rest are
 * dropped by the bridge.
 */
export type WireEvent =
  // `init` carries only session metadata. The client fetches messages via
  // GET /messages?threadId=… (REST is the authoritative source for thread
  // history). Earlier versions sent the default thread's messages here, but
  // that wiped non-default-thread state on every WS reconnect.
  | { seq: number; ts: number; type: "init"; session: SessionDetail }
  | { seq: number; ts: number; type: "message_start"; threadId: string; messageId: string; role: MessageRole }
  | { seq: number; ts: number; type: "text_delta"; threadId: string; messageId: string; delta: string }
  | {
      seq: number;
      ts: number;
      type: "message_update";
      threadId: string;
      messageId: string;
      parts: MessagePart[];
      content?: string;
    }
  | {
      seq: number;
      ts: number;
      type: "message_end";
      threadId: string;
      messageId: string;
      reason: "end_turn" | "error" | "abort";
    }
  | {
      seq: number;
      ts: number;
      type: "tool_start";
      threadId: string;
      toolName: string;
      callId?: string;
      args?: Record<string, unknown>;
    }
  | {
      seq: number;
      ts: number;
      type: "tool_end";
      threadId: string;
      toolName: string;
      callId?: string;
      result: string;
      isError: boolean;
    }
  | {
      seq: number;
      ts: number;
      type: "status";
      threadId: string;
      status: "idle" | "queued" | "thinking" | "tool_calling" | "streaming" | "blocked_on_decision_gate" | "error";
    }
  | {
      seq: number;
      ts: number;
      type: "turn_end";
      threadId: string;
      reason: "end_turn" | "error" | "abort";
    }
  | {
      seq: number;
      ts: number;
      type: "error";
      threadId?: string;
      code: string;
      message: string;
      recoverable: boolean;
    }
  | {
      seq: number;
      ts: number;
      type: "model_switched";
      /** Present when scope === thread; absent for session-level switches. */
      threadId?: string;
      fromModel: string;
      toModel: string;
      reason: string;
    }
  | { seq: number; ts: number; type: "ping" };

export type WireEventType = WireEvent["type"];

// ── WebSocket: client → server frames ────────────────────────────────────

export interface ClientHello {
  type: "subscribe";
  /** If set, server replays buffered events with seq > lastSeq. */
  lastSeq?: number;
}

export interface ClientPong {
  type: "pong";
}

export type ClientFrame = ClientHello | ClientPong;
