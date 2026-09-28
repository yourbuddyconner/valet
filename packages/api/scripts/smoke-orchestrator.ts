/**
 * Orchestrator smoke script for `@valet/api` — the fastest "is the agent loop
 * alive" check. Boots the server in-process (fresh PGlite, no sandbox — the
 * orchestrator is a sandbox-less wake), ensures the orchestrator session,
 * sends one prompt, and follows the WS until the turn ends. Asserts a
 * non-empty assistant reply.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-... pnpm --filter @valet/api smoke:orchestrator
 *
 * Env knobs:
 *   PORT=8789                                   server port
 *   VALET_SMOKE_ROOT=/tmp/valet-smoke-orchestrator  per-run scratch dir
 *   VALET_PROMPT="..."                          override the prompt
 *
 * Exit codes: 0 ok · 1 boot/config failure · 2 turn error/timeout · 3 empty reply.
 */
import { mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createApp } from "../src/app.js";
import { buildNodeProviders } from "../src/providers/node.js";
import type { WireEvent } from "../src/wire/types.js";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is required.");
  process.exit(1);
}

// Default: pre-allocate a free ephemeral port so the smoke NEVER collides
// with a running `make dev-local` on :8788 (which it could otherwise write
// into). Pre-allocated (not port 0) because `apiBaseUrl` must be known
// before the server binds.
const PORT = process.env.PORT !== undefined ? Number.parseInt(process.env.PORT, 10) : await getFreePort();

function getFreePort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const srv = createServer();
    srv.listen(0, () => {
      const addr = srv.address();
      if (addr === null || typeof addr === "string") {
        srv.close();
        rejectPort(new Error("could not allocate a port"));
        return;
      }
      srv.close(() => resolvePort(addr.port));
    });
    srv.on("error", rejectPort);
  });
}
const ROOT = process.env.VALET_SMOKE_ROOT ?? "/tmp/valet-smoke-orchestrator";
const PROMPT = process.env.VALET_PROMPT ?? "reply with the single word pong";

// Fresh state per run.
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });

const providers = await buildNodeProviders({
  pgDataDir: resolve(ROOT, "pg"),
  blobsRoot: resolve(ROOT, "blobs"),
  encryptionKey: "dev",
  anthropicApiKey: ANTHROPIC_API_KEY,
  apiBaseUrl: `http://127.0.0.1:${PORT}`,
});

process.env.VALET_LOCAL_AUTH = "1"; // auth stub
const { startServer } = createApp(providers);
let server!: ReturnType<typeof startServer>;
// Await the listen callback BEFORE any request — otherwise an early fetch can
// hit whatever process already owns the port.
const port = await new Promise<number>((resolveListen) => {
  server = startServer({
    port: PORT,
    onListen: (boundPort) => {
      console.log(`[smoke-orchestrator] server listening on http://localhost:${boundPort}`);
      resolveListen(boundPort);
    },
  });
});

// ── Step 1: ensure the orchestrator session.

const ensureRes = await fetch(`http://localhost:${port}/api/workspaces/user/runtime`, { method: "POST" });
if (!ensureRes.ok) {
  console.error("ensure orchestrator failed:", ensureRes.status, await ensureRes.text());
  await shutdown(1);
}
const { sessionId } = (await ensureRes.json()) as { sessionId: string };
console.log(`[smoke-orchestrator] orchestrator session: ${sessionId}`);

// ── Step 2: open WS, drive the prompt, collect the reply.

let reply = "";
const ws = new WebSocket(`ws://localhost:${port}/api/sessions/${sessionId}/ws`);

const turnEnded = new Promise<void>((resolveTurn, rejectTurn) => {
  const t = setTimeout(() => rejectTurn(new Error("timeout waiting for turn_end")), 120_000);
  ws.onopen = () => console.log("[smoke-orchestrator] ws connected");
  ws.onmessage = async (ev) => {
    const e = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString()) as WireEvent;
    if (e.type === "init") {
      const r = await fetch(`http://localhost:${port}/api/sessions/${sessionId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: PROMPT }),
      });
      console.log(`[smoke-orchestrator] post: ${r.status}`);
    }
    if (e.type === "text_delta") {
      reply += e.delta;
      process.stdout.write(e.delta);
    }
    if (e.type === "error") console.error(`\n[smoke-orchestrator] error: ${e.message}`);
    if (e.type === "turn_end") {
      clearTimeout(t);
      await delay(300);
      resolveTurn();
    }
  };
  ws.onerror = (err) => {
    clearTimeout(t);
    const message = err instanceof Error ? err.message : "unknown";
    rejectTurn(new Error(`ws error: ${message}`));
  };
});

try {
  await turnEnded;
} catch (err) {
  console.error("\n[smoke-orchestrator] FAILED:", err instanceof Error ? err.message : String(err));
  await shutdown(2);
}

console.log(`\n[smoke-orchestrator] reply length: ${reply.trim().length}`);
await shutdown(reply.trim().length > 0 ? 0 : 3);

// ── helpers ────────────────────────────────────────────────────────────────

async function shutdown(code: number): Promise<never> {
  try {
    ws.close();
  } catch {}
  try {
    await providers.engineHost.destroyAll();
  } catch (err) {
    console.error("destroyAll failed:", err);
  }
  void server.close().finally(() => process.exit(code));
  setTimeout(() => process.exit(code), 5_000).unref();
  await new Promise(() => {}); // never resolves; satisfies `Promise<never>`
  throw new Error("unreachable");
}
