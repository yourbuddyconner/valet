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
import type { AppEnv } from "./env.js";
import type { Providers } from "./providers/types.js";
import { providersMiddleware } from "./middleware/providers.js";
import { authMiddleware } from "./middleware/auth.js";
import { authRouter } from "./routes/auth.js";
import { sessionsRouter } from "./routes/sessions.js";

export function createApp(providers: Providers) {
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

  return app;
}

export type App = ReturnType<typeof createApp>;
