/**
 * Integration test: tool_call rendering survives a WebSocket reload.
 *
 * Boots a real `createApp(providers)` against an in-memory sqlite + virtual
 * sandbox, runs a real Anthropic-backed turn that calls a tool, then opens a
 * FRESH WebSocket connection (simulating a page reload) and asserts the
 * init frame contains the completed tool_call.
 *
 * Regression guard for two compounding bugs we shipped a fix for:
 *   1. The init frame stripped `parts: []` from every persisted message.
 *   2. The engine persisted tool_call parts at message_end with
 *      `status: "running"` and never re-persisted on tool completion.
 *
 * Either bug alone produces the same symptom: tool cards appear during the
 * live turn, then vanish on reload.
 *
 * Skipped when `ANTHROPIC_API_KEY` is not set so CI without a key still
 * passes.
 */
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import {
  InMemoryCredentialStore,
  InMemoryEventBus,
  VirtualSandboxProvider,
} from "@valet/engine";
import { SqliteSessionStore, applyEngineMigrations } from "@valet/store-sqlite";
import { applyAppMigrations, buildAppDb } from "../lib/drizzle.js";
import { EngineHost } from "../engine/host.js";
import { FsBlobStore } from "../providers/blob-fs.js";
import { createApp } from "../app.js";
import type { CreateSessionResponse, WireEvent } from "../wire/types.js";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const describeIfKey = ANTHROPIC_API_KEY ? describe : describe.skip;

describeIfKey("api integration: tool_call rendering survives WS reload", () => {
  it(
    "init frame after reconnect includes completed tool_call parts",
    async () => {
      // Auth stub must be on before any /api/* request lands.
      process.env.VALET_LOCAL_AUTH = "1";

      // ── Build providers: in-memory sqlite, virtual sandbox.
      const sqlite = new Database(":memory:");
      sqlite.pragma("journal_mode = WAL");
      sqlite.pragma("foreign_keys = ON");
      applyAppMigrations(sqlite);
      applyEngineMigrations(sqlite);

      // Seed the local-dev identity (mirrors buildNodeProviders).
      const now = Date.now();
      sqlite
        .prepare("INSERT OR IGNORE INTO orgs (id, name, created_at) VALUES (?, ?, ?)")
        .run("local-org", "Local Dev", now);
      sqlite
        .prepare(
          "INSERT OR IGNORE INTO users (id, email, name, role, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run("local-user", "local@dev", "Local Dev", "admin", now);
      sqlite
        .prepare(
          "INSERT OR IGNORE INTO org_members (org_id, user_id, role) VALUES (?, ?, ?)",
        )
        .run("local-org", "local-user", "admin");

      const blobsRoot = mkdtempSync(join(tmpdir(), "valet-reload-test-"));
      const workspaceRoot = mkdtempSync(join(tmpdir(), "valet-reload-ws-"));

      const db = buildAppDb(sqlite);
      const engineDb = drizzle(sqlite);
      const engineStore = new SqliteSessionStore(engineDb);
      const sandboxProvider = new VirtualSandboxProvider();
      const eventBus = new InMemoryEventBus();
      const engineCredentials = new InMemoryCredentialStore();
      const blobs = new FsBlobStore(blobsRoot);

      const engineHost = new EngineHost({
        engineStore,
        sandboxProvider,
        eventBus,
        engineCredentials,
        blobs,
        anthropicApiKey: ANTHROPIC_API_KEY,
      });

      const providers = {
        db,
        blobs,
        encryptionKey: "test-key",
        engineStore,
        sandboxProvider,
        eventBus,
        engineCredentials,
        engineHost,
      };

      const { app, injectWebSocket } = createApp(providers);
      const server = serve({ fetch: app.fetch, port: 0 });
      injectWebSocket(server);

      // Wait for `listen` to bind so server.address() has the assigned port.
      await new Promise<void>((resolve) =>
        server.on("listening", () => resolve()),
      );
      const address = server.address() as AddressInfo;
      const port = address.port;
      const baseUrl = `http://localhost:${port}`;
      const wsUrl = `ws://localhost:${port}`;

      try {
        // 1. Create a session.
        const createRes = await fetch(`${baseUrl}/api/sessions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workspace: workspaceRoot }),
        });
        expect(createRes.status).toBe(201);
        const { id: sessionId } = (await createRes.json()) as CreateSessionResponse;

        // 2. Drive a turn that should call the write tool.
        await driveTurn({ baseUrl, wsUrl, sessionId });

        // 3. Reload — open a fresh WS and capture the init frame.
        const initFrame = await captureInitFrame({ wsUrl, sessionId });

        // 4. Assert: the init frame's persisted messages include at least one
        //    assistant message whose parts have a completed tool_call. This
        //    fails if either bug regresses: init stripping parts (no parts
        //    visible) or engine forgetting to re-persist (tool_call stays
        //    status="running" with no result).
        expect(initFrame.type).toBe("init");
        if (initFrame.type !== "init") throw new Error("unreachable");
        const assistantWithCompletedTool = initFrame.messages.find(
          (m) =>
            m.role === "assistant" &&
            m.parts.some(
              (p) => p.kind === "tool_call" && p.status === "completed",
            ),
        );
        expect(
          assistantWithCompletedTool,
          `init frame had ${initFrame.messages.length} messages but none ` +
            `with a completed tool_call. Messages: ${JSON.stringify(
              initFrame.messages.map((m) => ({
                role: m.role,
                partKinds: m.parts.map((p) => `${p.kind}${p.kind === "tool_call" ? `(${p.status})` : ""}`),
              })),
              null,
              2,
            )}`,
        ).toBeDefined();

        const completedToolCall = assistantWithCompletedTool!.parts.find(
          (p) => p.kind === "tool_call" && p.status === "completed",
        );
        if (completedToolCall?.kind !== "tool_call") throw new Error("unreachable");
        expect(completedToolCall.result).toBeDefined();
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await engineHost.destroyAll();
        rmSync(blobsRoot, { recursive: true, force: true });
        rmSync(workspaceRoot, { recursive: true, force: true });
      }
    },
    // Real Anthropic call needs more than the package's 10s default.
    60_000,
  );
});

// ── helpers ────────────────────────────────────────────────────────────────

/**
 * Open a WS to the session, wait for `init`, post a prompt that should
 * trigger a write tool call, wait for `turn_end`, close.
 */
async function driveTurn({
  baseUrl,
  wsUrl,
  sessionId,
}: {
  baseUrl: string;
  wsUrl: string;
  sessionId: string;
}): Promise<void> {
  const ws = new WebSocket(`${wsUrl}/api/sessions/${sessionId}/ws`);
  let posted = false;
  const turnDone = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("driveTurn: timed out waiting for turn_end")),
      50_000,
    );
    ws.onmessage = async (ev) => {
      const data = typeof ev.data === "string" ? ev.data : ev.data.toString();
      const wire = JSON.parse(data) as WireEvent;
      if (wire.type === "init" && !posted) {
        posted = true;
        try {
          const r = await fetch(
            `${baseUrl}/api/sessions/${sessionId}/messages`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                // EngineHost's system prompt tells the model the workspace
                // is /workspace — match that here so the model picks a
                // path inside it. Virtual sandbox doesn't care about real
                // host paths so any value works.
                text:
                  "Use the write tool to write the exact text 'hello world' to /workspace/note.txt. After the tool succeeds, just reply 'done'.",
              }),
            },
          );
          if (!r.ok) {
            clearTimeout(timeout);
            reject(new Error(`POST messages failed: ${r.status}`));
          }
        } catch (err) {
          clearTimeout(timeout);
          reject(err as Error);
        }
      }
      if (wire.type === "turn_end") {
        clearTimeout(timeout);
        resolve();
      }
      if (wire.type === "error") {
        clearTimeout(timeout);
        reject(new Error(`engine error: ${wire.code}: ${wire.message}`));
      }
    };
    ws.onerror = () => {
      clearTimeout(timeout);
      reject(new Error("ws error during driveTurn"));
    };
  });
  await turnDone;
  ws.close();
  // Brief pause so engine's appendEntries/updateEntry calls settle to disk
  // before we open the reload connection.
  await new Promise((r) => setTimeout(r, 200));
}

/**
 * Open a fresh WS and resolve with the first frame (which is always `init`).
 */
async function captureInitFrame({
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
