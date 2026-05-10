/**
 * WebSocket event stream — `GET /api/sessions/:id/ws`.
 *
 * Subscribes to the engine bus for a given session, maps each BusEvent to a
 * wire event via the bridge, and pushes to the connected client. Adds a
 * monotonic per-session `seq` and a `ts` timestamp on the way out.
 *
 * v1 semantics:
 *   - One subscriber = one socket = one session.
 *   - No replay buffer (yet). On reconnect, clients refetch via the REST
 *     /messages endpoint to recover state, then live events stream from
 *     "now" — `lastSeq` in the client hello is currently ignored.
 *   - Periodic ping every 30s; client should reply with `pong`. The server
 *     does not enforce idle timeout in v1.
 */
import type { Hono } from "hono";
import type { UpgradeWebSocket } from "hono/ws";
import { and, eq } from "drizzle-orm";
import type { AppEnv } from "../env.js";
import { agentSessions } from "../schema/index.js";
import { busEventToWire, type WireEventDraft } from "../engine/bridge.js";
import type { ClientFrame, WireEvent } from "../wire/types.js";
import type { BusEvent } from "@valet/engine";

const PING_INTERVAL_MS = 30_000;

export function registerWsRoutes(
  app: Hono<AppEnv>,
  upgradeWebSocket: UpgradeWebSocket,
) {
  app.get(
    "/api/sessions/:id/ws",
    upgradeWebSocket((c) => {
      const sessionId = c.req.param("id");
      const providers = c.var.providers;
      const userId = c.var.user.id;

      let seq = 0;
      let pingTimer: ReturnType<typeof setInterval> | undefined;
      let unsubscribe: (() => void) | undefined;
      // Track the most recent assistant messageId per thread so text_delta
      // events can be tagged with a real id (engine emits deltas without one).
      const activeMessageByThread = new Map<string, string>();

      const send = (ws: { send: (data: string) => void }, draftEvent: WireEventDraft) => {
        const ev = { ...draftEvent, seq: ++seq, ts: Date.now() } as WireEvent;
        try {
          ws.send(JSON.stringify(ev));
        } catch (err) {
          console.error("ws send failed:", err);
        }
      };

      return {
        async onOpen(_evt, ws) {
          // Wrap the whole handshake in try/catch — any throw here would
          // become an unhandled rejection and crash the entire server
          // process, killing every other live session. We instead emit an
          // error frame and close the socket gracefully.
          try {
            // Verify session ownership before subscribing.
            const row = await providers.db
              .select()
              .from(agentSessions)
              .where(and(eq(agentSessions.id, sessionId), eq(agentSessions.userId, userId)))
              .get();
            if (!row) {
              ws.close(4040, "session not found");
              return;
            }

            // Materialize the engine session so the bus is set up + the
            // default thread exists (so the client can immediately POST
            // /threads or /messages without race against the engine).
            // We DO NOT read the persisted entries here — the client loads
            // history per-thread via REST so reconnects don't wipe the
            // currently-visible thread when it isn't the default.
            const engineSession = await providers.engineHost.sessionFor(sessionId, {
              userId: row.userId,
              orgId: row.orgId,
              workspace: row.workspace,
            });
            await engineSession.ensureDefaultThread();

            send(ws, {
              type: "init",
              session: {
                id: row.id,
                workspace: row.workspace,
                status: row.status as "active" | "archived" | "deleted",
                title: row.title ?? undefined,
                createdAt: row.createdAt,
                updatedAt: row.updatedAt,
                // Reserved field; populating accurately requires a count
                // query and the UI doesn't currently render this number.
                messageCount: 0,
              },
            });

            // Subscribe to the engine event bus for this session.
            unsubscribe = providers.eventBus.subscribe({ sessionId }, (busEvent: BusEvent) => {
              // Track active message id for delta tagging.
              if (busEvent.event.type === "message_start") {
                activeMessageByThread.set(busEvent.event.threadId, busEvent.event.messageId);
              }
              const drafts = busEventToWire(busEvent);
              for (const draft of drafts) {
                if (draft.type === "text_delta" && !draft.messageId) {
                  const filled = activeMessageByThread.get(draft.threadId);
                  if (filled) draft.messageId = filled;
                }
                send(ws, draft);
              }
            });

            // Periodic keepalive.
            pingTimer = setInterval(() => {
              send(ws, { type: "ping" });
            }, PING_INTERVAL_MS);
          } catch (err) {
            // Engine setup failed (e.g. workspace doesn't exist, Docker
            // unreachable). Surface as a wire error and close — never
            // throw past the handler, or it crashes the whole process.
            console.error("ws onOpen failed:", err);
            try {
              send(ws, {
                type: "error",
                code: "ws_open_failed",
                message: (err as Error).message ?? "failed to open session stream",
                recoverable: false,
              });
            } catch {}
            try {
              ws.close(1011, "internal error");
            } catch {}
          }
        },

        onMessage(evt) {
          // Best-effort parse; ignore unknowns.
          let frame: ClientFrame;
          try {
            const data = typeof evt.data === "string" ? evt.data : evt.data.toString();
            frame = JSON.parse(data) as ClientFrame;
          } catch {
            return;
          }
          // v1: subscribe is implicit on connect, pong is best-effort.
          if (frame.type === "subscribe" || frame.type === "pong") return;
        },

        onClose() {
          if (pingTimer) clearInterval(pingTimer);
          if (unsubscribe) unsubscribe();
        },

        onError(err) {
          console.error("ws error:", err);
        },
      };
    }),
  );
}
