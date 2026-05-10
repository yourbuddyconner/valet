/**
 * `useSessionWebSocket(sessionId)` — opens a WS to the server, pipes wire
 * events into the stream store. Auto-reconnects with exponential backoff.
 *
 * Connection state and ingest live in `~/stores/stream`; this hook only
 * owns the socket lifecycle.
 */
import { useEffect, useRef } from "react";
import type { WireEvent } from "@valet/api/wire";
import { useStreamStore } from "~/stores/stream";

const MAX_RETRY_MS = 8_000;
const INITIAL_RETRY_MS = 500;

function wsUrl(sessionId: string): string {
  // Vite proxy upgrades /api → server, including WS (`ws: true`).
  // In production, the same /api path is served by the API directly.
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/api/sessions/${sessionId}/ws`;
}

export function useSessionWebSocket(sessionId: string) {
  const setConnection = useStreamStore((s) => s.setConnection);
  const ingest = useStreamStore((s) => s.ingest);
  const reset = useStreamStore((s) => s.reset);
  const cancelled = useRef(false);

  useEffect(() => {
    if (!sessionId) return;
    cancelled.current = false;
    reset(sessionId);
    setConnection(sessionId, "connecting");

    let socket: WebSocket | null = null;
    let retryDelay = INITIAL_RETRY_MS;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    function open() {
      if (cancelled.current) return;
      socket = new WebSocket(wsUrl(sessionId));
      socket.onopen = () => {
        retryDelay = INITIAL_RETRY_MS;
        setConnection(sessionId, "open");
      };
      socket.onmessage = (ev) => {
        try {
          const data = typeof ev.data === "string" ? ev.data : ev.data.toString();
          const wire = JSON.parse(data) as WireEvent;
          ingest(sessionId, wire);
        } catch (err) {
          console.error("ws parse failed:", err);
        }
      };
      socket.onerror = () => {
        // The matching onclose will trigger the reconnect.
        setConnection(sessionId, "error");
      };
      socket.onclose = () => {
        if (cancelled.current) return;
        setConnection(sessionId, "closed");
        retryTimer = setTimeout(open, retryDelay);
        retryDelay = Math.min(MAX_RETRY_MS, retryDelay * 2);
      };
    }

    open();

    return () => {
      cancelled.current = true;
      if (retryTimer) clearTimeout(retryTimer);
      socket?.close();
    };
    // We intentionally exclude the store actions from the dep list — Zustand
    // returns stable function refs per call but TypeScript can't prove that.
    // The hook only re-runs when sessionId changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);
}
