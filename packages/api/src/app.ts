/**
 * Hono app factory. Wiring lives here; main.ts only handles boot + listen.
 *
 * Splitting `createApp(providers)` from `main.ts` keeps tests fast (build a
 * test app with stub providers, no node-server). It also keeps boot-time
 * I/O (open sqlite, build providers) out of the hot test path.
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { createNodeWebSocket } from "@hono/node-ws";
import type { AppEnv } from "./env.js";
import type { Providers } from "./providers/types.js";
import { providersMiddleware } from "./middleware/providers.js";
import { authMiddleware } from "./middleware/auth.js";
import { authRouter } from "./routes/auth.js";
import { sessionsRouter } from "./routes/sessions.js";
import { messagesRouter } from "./routes/messages.js";
import { registerWsRoutes } from "./routes/ws.js";

export interface CreatedApp {
  app: Hono<AppEnv>;
  /** Call after `serve()` to attach the WS upgrade handler to the http server. */
  injectWebSocket: ReturnType<typeof createNodeWebSocket>["injectWebSocket"];
}

export function createApp(providers: Providers): CreatedApp {
  const app = new Hono<AppEnv>();

  app.use("*", logger());
  app.use(
    "*",
    cors({
      origin: (origin) => origin ?? "*",
      credentials: true,
    }),
  );
  app.use("*", providersMiddleware(providers));

  // Public health check (no auth).
  app.get("/api/health", (c) =>
    c.json({ ok: true, service: "valet-api", ts: Date.now() }),
  );

  // Everything under /api/* requires auth (stub in dev; 401 otherwise).
  app.use("/api/*", authMiddleware);

  app.route("/api/auth", authRouter);
  app.route("/api/sessions", sessionsRouter);
  // Messages + threads share /api/sessions/:id/* — mounted under same prefix.
  app.route("/api/sessions", messagesRouter);

  // WebSocket — must be registered against the same Hono instance that
  // node-ws was constructed with. main.ts calls injectWebSocket(server)
  // after serve().
  const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });
  registerWsRoutes(app, upgradeWebSocket);

  // Final fallback for anything thrown out of a route handler. Without this,
  // Hono returns a generic 500 with the HTML error page; we want JSON.
  app.onError((err, c) => {
    console.error(`route error ${c.req.method} ${c.req.path}:`, err);
    return c.json(
      {
        error: err.message ?? "internal error",
        code: (err as NodeJS.ErrnoException).code,
      },
      500,
    );
  });

  return { app, injectWebSocket };
}

export type App = ReturnType<typeof createApp>["app"];
