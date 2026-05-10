/**
 * End-to-end dogfood script for `@valet/api`.
 *
 * Boots the server in-process (so we own its lifecycle), creates a session,
 * opens the WebSocket, posts a prompt, and prints every wire event in order
 * until `turn_end`. Verifies the file the agent was asked to write actually
 * landed on the host via the Docker bind mount.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-... pnpm --filter @valet/api dogfood
 *
 * Env knobs:
 *   PORT=8788                     server port
 *   VALET_DATA_DIR=/tmp/valet-dogfood/data  per-run data dir (auto-cleaned)
 *   VALET_WORKSPACE=/tmp/valet-dogfood/ws   workspace for the agent
 *   VALET_PROMPT="..."           override the dogfood prompt
 */
import { homedir } from "node:os";
import { mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { serve } from "@hono/node-server";
import { createApp } from "../src/app.js";
import { buildNodeProviders } from "../src/providers/node.js";
import type { WireEvent } from "../src/wire/types.js";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is required.");
  process.exit(1);
}

const PORT = Number.parseInt(process.env.PORT ?? "8788", 10);
const ROOT = process.env.VALET_DOGFOOD_ROOT ?? "/tmp/valet-dogfood";
const DATA_DIR = process.env.VALET_DATA_DIR ?? `${ROOT}/data`;
const WORKSPACE = process.env.VALET_WORKSPACE ?? `${ROOT}/ws`;
const PROMPT =
  process.env.VALET_PROMPT ??
  "use bash to write hello.txt with contents ok then read it back";
const FILE_NAME = "hello.txt";

// Fresh state per run.
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(WORKSPACE, { recursive: true });

const providers = await buildNodeProviders({
  dbPath: resolve(DATA_DIR, "app.db"),
  blobsRoot: resolve(DATA_DIR, "blobs"),
  encryptionKey: "dev",
  anthropicApiKey: ANTHROPIC_API_KEY,
});

process.env.VALET_LOCAL_AUTH = "1"; // auth stub
const { app, injectWebSocket } = createApp(providers);
const server = serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`[dogfood] server listening on http://localhost:${info.port}`);
});
injectWebSocket(server);

// ── Step 1: create session.

const createRes = await fetch(`http://localhost:${PORT}/api/sessions`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ workspace: WORKSPACE }),
});
if (!createRes.ok) {
  console.error("create session failed:", createRes.status, await createRes.text());
  await shutdown(1);
}
const { id: sessionId } = (await createRes.json()) as { id: string };
console.log(`[dogfood] session: ${sessionId}, workspace: ${WORKSPACE}`);

// ── Step 2: open WS, drive the prompt.

const events: WireEvent[] = [];
const ws = new WebSocket(`ws://localhost:${PORT}/api/sessions/${sessionId}/ws`);

const turnEnded = new Promise<void>((resolveTurn, rejectTurn) => {
  const t = setTimeout(() => rejectTurn(new Error("timeout waiting for turn_end")), 120_000);
  ws.onopen = () => console.log("[dogfood] ws connected");
  ws.onmessage = async (ev) => {
    const e = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString()) as WireEvent;
    events.push(e);
    summarize(e);
    if (e.type === "init") {
      // Send the prompt once we're subscribed.
      const r = await fetch(`http://localhost:${PORT}/api/sessions/${sessionId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: PROMPT }),
      });
      console.log(`[dogfood] post: ${r.status}`);
    }
    if (e.type === "turn_end") {
      clearTimeout(t);
      // Allow trailing status frames a moment to arrive before closing.
      await delay(300);
      resolveTurn();
    }
  };
  ws.onerror = (err) => {
    clearTimeout(t);
    const message = (err as { message?: string }).message ?? "unknown";
    rejectTurn(new Error(`ws error: ${message}`));
  };
});

try {
  await turnEnded;
} catch (err) {
  console.error("[dogfood] FAILED:", (err as Error).message);
  await shutdown(2);
}

// ── Step 3: assert the file landed on the host.

const filePath = resolve(WORKSPACE, FILE_NAME);
const ok = existsSync(filePath);
const contents = ok ? readFileSync(filePath, "utf8") : null;
console.log("");
console.log(`[dogfood] expect file at: ${filePath}`);
console.log(`[dogfood] file exists:    ${ok}`);
if (contents !== null) console.log(`[dogfood] file contents:  ${JSON.stringify(contents)}`);

const summary = {
  events: events.length,
  byType: events.reduce<Record<string, number>>((acc, e) => {
    acc[e.type] = (acc[e.type] ?? 0) + 1;
    return acc;
  }, {}),
  fileWritten: ok,
};
console.log("[dogfood] summary:", JSON.stringify(summary, null, 2));

await shutdown(ok ? 0 : 3);

// ── helpers ────────────────────────────────────────────────────────────────

function summarize(e: WireEvent) {
  let detail = "";
  switch (e.type) {
    case "text_delta":
      detail = JSON.stringify(e.delta);
      break;
    case "tool_start":
      detail = `${e.toolName} args=${JSON.stringify(e.args).slice(0, 200)}`;
      break;
    case "tool_end":
      detail = `${e.toolName} isError=${e.isError} result=${(e.result ?? "").slice(0, 200)}`;
      break;
    case "status":
      detail = e.status;
      break;
    case "turn_end":
      detail = e.reason;
      break;
    case "error":
      detail = `${e.code}: ${e.message}`;
      break;
  }
  console.log(`[ws] seq=${e.seq.toString().padStart(2, " ")} ${e.type}${detail ? "  " + detail : ""}`);
}

async function shutdown(code: number): Promise<never> {
  try {
    ws.close();
  } catch {}
  try {
    await providers.engineHost.destroyAll();
  } catch (err) {
    console.error("destroyAll failed:", err);
  }
  server.close(() => process.exit(code));
  setTimeout(() => process.exit(code), 5_000).unref();
  await new Promise(() => {}); // never resolves; satisfies `Promise<never>`
  throw new Error("unreachable");
}
