/**
 * Shared WebSocket / prompt helpers for API integration tests.
 *
 * Underscore-prefixed filename so vitest's `*.test.ts` glob doesn't pick it
 * up as a test.
 */
import type { WireEvent } from "../wire/types.js";

/**
 * Open a WS to the session, wait for `init`, post a prompt, wait for the
 * agent loop to fully settle, close. If `threadId` is provided it scopes
 * the prompt; otherwise the server uses the session's default thread.
 *
 * "Settle" semantics: the engine emits `turn_end` per *LLM round* — a
 * tool-use turn fires turn_end, the engine then runs the tool, then the
 * agent loops back for another LLM call which produces another turn_end.
 * Returning after the first turn_end would miss the follow-up text. We
 * instead resolve after `settleMs` of quiet (no new turn_end and no
 * non-idle status) following the most recent turn_end.
 */
export async function driveTurn({
  baseUrl,
  wsUrl,
  sessionId,
  prompt,
  threadId,
  timeoutMs = 60_000,
  settleMs = 3_000,
}: {
  baseUrl: string;
  wsUrl: string;
  sessionId: string;
  prompt: string;
  threadId?: string;
  timeoutMs?: number;
  settleMs?: number;
}): Promise<void> {
  const ws = new WebSocket(`${wsUrl}/api/sessions/${sessionId}/ws`);
  let posted = false;
  let sawTurnEnd = false;
  await new Promise<void>((resolve, reject) => {
    const overall = setTimeout(
      () => reject(new Error("driveTurn: overall timeout")),
      timeoutMs,
    );
    let settle: ReturnType<typeof setTimeout> | undefined;

    function done() {
      clearTimeout(overall);
      if (settle) clearTimeout(settle);
      resolve();
    }

    function armSettle() {
      if (settle) clearTimeout(settle);
      settle = setTimeout(done, settleMs);
    }

    ws.onmessage = async (ev) => {
      const data = typeof ev.data === "string" ? ev.data : ev.data.toString();
      const wire = JSON.parse(data) as WireEvent;
      if (wire.type === "init" && !posted) {
        posted = true;
        try {
          const r = await fetch(`${baseUrl}/api/sessions/${sessionId}/messages`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: prompt, threadId }),
          });
          if (!r.ok) {
            clearTimeout(overall);
            reject(new Error(`POST messages failed: ${r.status}`));
          }
        } catch (err) {
          clearTimeout(overall);
          reject(err as Error);
        }
        return;
      }

      // Any sign of agent activity cancels the settle timer.
      if (wire.type === "status" && wire.status !== "idle") {
        if (settle) {
          clearTimeout(settle);
          settle = undefined;
        }
      }
      if (wire.type === "message_start" || wire.type === "tool_start") {
        if (settle) {
          clearTimeout(settle);
          settle = undefined;
        }
      }

      if (wire.type === "turn_end") {
        sawTurnEnd = true;
        armSettle();
      }
      if (wire.type === "error") {
        clearTimeout(overall);
        if (settle) clearTimeout(settle);
        reject(new Error(`engine error: ${wire.code}: ${wire.message}`));
      }
    };
    ws.onerror = () => {
      clearTimeout(overall);
      if (settle) clearTimeout(settle);
      reject(new Error("ws error during driveTurn"));
    };
  });
  if (!sawTurnEnd) {
    throw new Error("driveTurn settled without ever seeing turn_end");
  }
  ws.close();
  // Brief extra pause so engine's persistence (appendEntries / updateEntry)
  // has time to land before the test asserts on stored state.
  await new Promise((r) => setTimeout(r, 200));
}

/**
 * Open a fresh WS and resolve with the first frame (always `init`).
 */
export async function captureInitFrame({
  wsUrl,
  sessionId,
}: {
  wsUrl: string;
  sessionId: string;
}): Promise<WireEvent> {
  const ws = new WebSocket(`${wsUrl}/api/sessions/${sessionId}/ws`);
  return await new Promise<WireEvent>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("captureInitFrame: timed out")),
      5_000,
    );
    ws.onmessage = (ev) => {
      const data = typeof ev.data === "string" ? ev.data : ev.data.toString();
      const wire = JSON.parse(data) as WireEvent;
      if (wire.type === "init") {
        clearTimeout(timeout);
        ws.close();
        resolve(wire);
      }
    };
    ws.onerror = () => {
      clearTimeout(timeout);
      reject(new Error("ws error during captureInitFrame"));
    };
  });
}
