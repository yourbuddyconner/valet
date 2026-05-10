/**
 * Node entry point.
 *
 *   ANTHROPIC_API_KEY=sk-... VALET_LOCAL_AUTH=1 pnpm --filter @valet/api dev
 *
 * Boots the API on PORT (default 8787). Exits non-zero with a clear message
 * if required env vars are missing.
 */
import { serve } from "@hono/node-server";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createApp } from "./app.js";
import { buildNodeProviders } from "./providers/node.js";

const port = Number.parseInt(process.env.PORT ?? "8787", 10);
const dataDir = process.env.VALET_DATA_DIR ?? resolve(homedir(), ".valet");
const dbPath = process.env.VALET_DB_PATH ?? resolve(dataDir, "app.db");
const blobsRoot = process.env.VALET_BLOBS_DIR ?? resolve(dataDir, "blobs");
const encryptionKey = process.env.VALET_ENCRYPTION_KEY ?? "dev-key-not-secure";
const anthropicApiKey = process.env.ANTHROPIC_API_KEY;

if (!anthropicApiKey) {
  console.error(
    "ANTHROPIC_API_KEY is required for prompts to run. Set it before starting the server.",
  );
  process.exit(1);
}

const providers = await buildNodeProviders({
  dbPath,
  blobsRoot,
  encryptionKey,
  anthropicApiKey,
});

const { app, injectWebSocket } = createApp(providers);

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`@valet/api listening on http://localhost:${info.port}`);
  console.log(`  data dir: ${dataDir}`);
  console.log(`  db:       ${dbPath}`);
  console.log(`  blobs:    ${blobsRoot}`);
  console.log(
    `  auth:     ${process.env.VALET_LOCAL_AUTH === "1" ? "stub (VALET_LOCAL_AUTH=1)" : "DISABLED — set VALET_LOCAL_AUTH=1 for /api/* access"}`,
  );
});

// Attach the WS upgrade handler to the running http server.
injectWebSocket(server);

// ── Graceful shutdown — destroy live sandboxes so containers don't leak.

async function shutdown(signal: NodeJS.Signals) {
  console.log(`\nReceived ${signal}, destroying live sandboxes...`);
  try {
    await providers.engineHost.destroyAll();
  } catch (err) {
    console.error("destroyAll failed:", err);
  }
  server.close(() => process.exit(0));
  // Hard-exit if close() takes too long (containers can be slow to stop).
  setTimeout(() => process.exit(1), 5_000).unref();
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

// Last-resort guards. A single bad request must not take down the server
// and break every other live session. Real fixes belong in the route or WS
// handler that's swallowing the error; these are belt-and-braces so the dev
// experience doesn't get whiplashed when one slips through.
process.on("unhandledRejection", (reason) => {
  console.error("unhandledRejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("uncaughtException:", err);
});
