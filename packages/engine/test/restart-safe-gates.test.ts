import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider, Type } from "@mariozechner/pi-ai";
import {
  Engine,
  InMemoryEventBus,
  SqliteSessionStore,
  VirtualSandboxProvider,
  type ToolDef,
  type BusEvent,
  type DecisionGate,
} from "../src/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "..", "migrations", "sqlite");

function applyMigrations(db: Database.Database): void {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    const statements = sql.split(/-->\s*statement-breakpoint/);
    for (const stmt of statements) {
      const trimmed = stmt.trim();
      if (trimmed) db.exec(trimmed);
    }
  }
}

const approvalTool: ToolDef = {
  name: "do_thing",
  description: "approval-gated",
  parameters: Type.Object({ arg: Type.String() }),
  execute: async (args, ctx) => {
    const r = await ctx.requestDecision({
      type: "approval",
      title: "ok?",
      resumeKey: `do_thing:${args.arg}`,
    });
    return { text: `did with ${r.actionId}` };
  },
};

describe("restart-safe gates: full restart cycle", () => {
  it("survives engine teardown and restoreSession resumes", async () => {
    const sqlite = new Database(":memory:");
    applyMigrations(sqlite);
    const db = drizzle(sqlite);
    const store = new SqliteSessionStore(db);
    const sandboxProvider = new VirtualSandboxProvider();

    // ── Engine v1: open gate, then "crash" ──────────────────────
    const faux1 = registerFauxProvider({ provider: "restart" });
    faux1.setResponses([
      fauxAssistantMessage([fauxToolCall("do_thing", { arg: "x" }, { id: "tc1" })], {
        stopReason: "toolUse",
      }),
    ]);

    const bus1 = new InMemoryEventBus();
    const engine1 = new Engine({ providers: { store, bus: bus1, sandboxProvider } });
    const SESSION_ID = "sess-restart";
    const session1 = await engine1.createSession({
      id: SESSION_ID,
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: faux1.getModel(),
      tools: [approvalTool],
    });
    void session1.prompt("please do");

    const gate = await new Promise<DecisionGate>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("gate timeout")), 2000);
      const unsub = bus1.subscribe({}, (e) => {
        if (e.event.type === "decision_gate") {
          clearTimeout(t);
          unsub();
          resolve(e.event.gate);
        }
      });
    });

    expect(gate.status).toBe("pending");
    const persistedGates = await store.listDecisionGates(SESSION_ID);
    expect(persistedGates).toHaveLength(1);
    const suspended = await store.getSuspendedTurn(SESSION_ID, gate.threadId);
    expect(suspended?.toolName).toBe("do_thing");
    expect(suspended?.toolArgs).toEqual({ arg: "x" });
    expect(suspended?.resumeKey).toBe("do_thing:x");

    // "Crash"
    faux1.unregister();

    // ── Engine v2: restoreSession + resolve ─────────────────────
    const faux2 = registerFauxProvider({ provider: "restart-v2" });
    faux2.setResponses([fauxAssistantMessage("all done after restart")]);

    const bus2 = new InMemoryEventBus();
    const events2: BusEvent[] = [];
    bus2.subscribe({}, (e) => events2.push(e));
    const engine2 = new Engine({ providers: { store, bus: bus2, sandboxProvider } });
    const session2 = await engine2.restoreSession({
      sessionId: SESSION_ID,
      options: {
        userId: "u1",
        orgId: "o1",
        workspace: "/",
        sandbox: {},
        model: faux2.getModel(),
        tools: [approvalTool],
      },
    });

    await session2.resolveDecision(gate.id, {
      actionId: "approve",
      resolvedBy: "u1",
      resolvedAt: Date.now(),
    });

    // Wait for replay continuation to land its message_end
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("post-restart turn timeout")), 3000);
      const unsub = bus2.subscribe({}, (e) => {
        if (e.event.type === "message_end") {
          clearTimeout(t);
          unsub();
          resolve();
        }
      });
    });

    const finalEntries = await session2.readEntries("web:default");
    const lastAssistant = finalEntries
      .filter((e) => e.type === "message" && e.role === "assistant")
      .at(-1);
    expect(
      lastAssistant && lastAssistant.type === "message" && lastAssistant.content,
    ).toBe("all done after restart");

    // SuspendedTurnState was cleared
    expect(await store.getSuspendedTurn(SESSION_ID, gate.threadId)).toBeNull();

    // Gate is now resolved
    const finalGate = await store.getDecisionGate(SESSION_ID, gate.id);
    expect(finalGate?.status).toBe("resolved");

    faux2.unregister();
  });
});
