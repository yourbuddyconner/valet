import { describe, it, expect, beforeEach } from "vitest";
import type {
  DecisionGate,
  MessageEntry,
  QueueState,
  SessionData,
  SessionEntry,
  SessionStore,
  SuspendedTurnState,
  ThreadData,
} from "../index.js";

export interface StoreContractContext {
  factory: () => SessionStore | Promise<SessionStore>;
  teardown?: (store: SessionStore) => void | Promise<void>;
}

export function runSessionStoreContract(name: string, ctx: StoreContractContext) {
  describe(`SessionStore contract: ${name}`, () => {
    let store: SessionStore;

    beforeEach(async () => {
      store = await ctx.factory();
    });

    function newSession(overrides: Partial<SessionData> = {}): SessionData {
      return {
        id: "sess-1",
        userId: "u1",
        orgId: "o1",
        workspace: "/",
        purpose: "interactive",
        status: "running",
        createdAt: 1,
        updatedAt: 1,
        ...overrides,
      };
    }

    function newThread(sessionId: string, key = "web:default", id = "th-1"): ThreadData {
      return {
        id,
        sessionId,
        key,
        status: "active",
        queueMode: "followup",
        createdAt: 1,
        updatedAt: 1,
      };
    }

    function msg(id: string, role: "user" | "assistant", content: string, ts: number): MessageEntry {
      return {
        id,
        sessionId: "sess-1",
        threadId: "th-1",
        parentId: null,
        type: "message",
        role,
        content,
        createdAt: ts,
      };
    }

    it("saveSession + getSession round-trips", async () => {
      const s = newSession();
      await store.saveSession(s);
      const loaded = await store.getSession(s.id);
      expect(loaded).toMatchObject({ id: "sess-1", userId: "u1", status: "running" });
    });

    it("listSessions filters by userId", async () => {
      await store.saveSession(newSession({ id: "a", userId: "u1" }));
      await store.saveSession(newSession({ id: "b", userId: "u2" }));
      const list = await store.listSessions("u1");
      expect(list.map((s) => s.id)).toEqual(["a"]);
    });

    it("saveThread + listThreads round-trips", async () => {
      await store.saveSession(newSession());
      await store.saveThread("sess-1", newThread("sess-1", "task:A", "th-1"));
      await store.saveThread("sess-1", newThread("sess-1", "task:B", "th-2"));
      const threads = await store.listThreads("sess-1");
      expect(threads.length).toBe(2);
      expect(threads.map((t) => t.key).sort()).toEqual(["task:A", "task:B"]);
    });

    it("appendEntries + getEntries returns entries in insertion order", async () => {
      await store.saveSession(newSession());
      await store.saveThread("sess-1", newThread("sess-1"));
      await store.appendEntries("sess-1", "th-1", [
        msg("e-1", "user", "hi", 10),
        msg("e-2", "assistant", "hello", 20),
      ]);
      const loaded = await store.getEntries("sess-1", "th-1");
      expect(loaded).toHaveLength(2);
      expect(loaded[0]).toMatchObject({ id: "e-1", type: "message", role: "user", content: "hi" });
      expect(loaded[1]).toMatchObject({ id: "e-2", type: "message", role: "assistant" });
    });

    it("updateEntry replaces an existing entry in place", async () => {
      await store.saveSession(newSession());
      await store.saveThread("sess-1", newThread("sess-1"));
      await store.appendEntries("sess-1", "th-1", [
        msg("e-1", "user", "original", 10),
      ]);
      const updated: MessageEntry = {
        id: "e-1",
        sessionId: "sess-1",
        threadId: "th-1",
        parentId: null,
        type: "message",
        role: "user",
        content: "rewritten",
        createdAt: 10,
      };
      await store.updateEntry("sess-1", "th-1", updated);
      const loaded = await store.getEntries("sess-1", "th-1");
      expect(loaded).toHaveLength(1);
      expect(loaded[0]).toMatchObject({ id: "e-1", content: "rewritten" });
    });

    it("round-trips tool_call parts with full fidelity (args, status, result)", async () => {
      // Regression guard: tool_call parts must survive serialization with
      // their nested args + result intact. A bug in a store impl that
      // dropped or coerced these fields would manifest as tool cards going
      // missing on reload.
      await store.saveSession(newSession());
      await store.saveThread("sess-1", newThread("sess-1"));
      const entry: MessageEntry = {
        id: "e-1",
        sessionId: "sess-1",
        threadId: "th-1",
        parentId: null,
        type: "message",
        role: "assistant",
        content: "running write",
        parts: [
          { type: "text", text: "running write" },
          {
            type: "tool_call",
            callId: "tc1",
            toolName: "write",
            status: "running",
            args: { path: "/tmp/x.txt", content: "ok" },
          },
        ],
        createdAt: 10,
      };
      await store.appendEntries("sess-1", "th-1", [entry]);
      const loaded = await store.getEntries("sess-1", "th-1");
      expect(loaded).toHaveLength(1);
      const reloaded = loaded[0];
      expect(reloaded.type).toBe("message");
      if (reloaded.type !== "message") throw new Error("unreachable");
      expect(reloaded.parts).toHaveLength(2);
      const tcPart = reloaded.parts?.[1];
      expect(tcPart).toMatchObject({
        type: "tool_call",
        callId: "tc1",
        toolName: "write",
        status: "running",
        args: { path: "/tmp/x.txt", content: "ok" },
      });
    });

    it("updateEntry transitions a tool_call from running → completed (with result)", async () => {
      // The bug we're guarding: engine persists at message_end with
      // status="running", then tool_execution_end mutates the in-memory
      // part — without an updateEntry call, the store stays stale.
      await store.saveSession(newSession());
      await store.saveThread("sess-1", newThread("sess-1"));
      const before: MessageEntry = {
        id: "e-1",
        sessionId: "sess-1",
        threadId: "th-1",
        parentId: null,
        type: "message",
        role: "assistant",
        content: "",
        parts: [
          {
            type: "tool_call",
            callId: "tc1",
            toolName: "bash",
            status: "running",
            args: { command: "echo hi" },
          },
        ],
        createdAt: 10,
      };
      await store.appendEntries("sess-1", "th-1", [before]);

      // Mirror what the engine does: mutate the part, persist via updateEntry.
      const after: MessageEntry = {
        ...before,
        parts: [
          {
            type: "tool_call",
            callId: "tc1",
            toolName: "bash",
            status: "completed",
            args: { command: "echo hi" },
            result: { text: "hi\n" },
          },
        ],
      };
      await store.updateEntry("sess-1", "th-1", after);

      const loaded = await store.getEntries("sess-1", "th-1");
      expect(loaded).toHaveLength(1);
      const reloaded = loaded[0];
      if (reloaded.type !== "message") throw new Error("unreachable");
      const tc = reloaded.parts?.[0];
      expect(tc).toMatchObject({
        type: "tool_call",
        status: "completed",
        result: { text: "hi\n" },
      });
    });

    it("updateEntry throws NotFoundError when no matching entry exists", async () => {
      await store.saveSession(newSession());
      await store.saveThread("sess-1", newThread("sess-1"));
      const ghost: MessageEntry = {
        id: "ghost",
        sessionId: "sess-1",
        threadId: "th-1",
        parentId: null,
        type: "message",
        role: "user",
        content: "x",
        createdAt: 1,
      };
      await expect(store.updateEntry("sess-1", "th-1", ghost)).rejects.toThrow(
        /not found/,
      );
    });

    it("appendEntries persists decision_gate entries", async () => {
      await store.saveSession(newSession());
      await store.saveThread("sess-1", newThread("sess-1"));
      const gate: DecisionGate = {
        id: "g-1",
        sessionId: "sess-1",
        threadId: "th-1",
        type: "approval",
        status: "pending",
        title: "ok?",
        actions: [{ id: "approve", label: "Approve" }],
        createdAt: 100,
        updatedAt: 100,
      };
      await store.saveDecisionGate("sess-1", "th-1", gate);
      await store.appendEntries("sess-1", "th-1", [
        {
          id: "e-g",
          sessionId: "sess-1",
          threadId: "th-1",
          parentId: null,
          type: "decision_gate",
          gate,
          createdAt: 100,
        },
      ]);
      const loaded = await store.getEntries("sess-1", "th-1");
      const gateEntry = loaded.find((e) => e.type === "decision_gate");
      expect(gateEntry).toBeDefined();
      expect(gateEntry && gateEntry.type === "decision_gate" && gateEntry.gate.id).toBe("g-1");
    });

    it("saveQueueState + getQueueState round-trips", async () => {
      await store.saveSession(newSession());
      await store.saveThread("sess-1", newThread("sess-1"));
      const qs: QueueState = {
        threadId: "th-1",
        mode: "followup",
        status: "running",
        activeItemId: "q-1",
        pending: [],
      };
      await store.saveQueueState("sess-1", "th-1", qs);
      const loaded = await store.getQueueState("sess-1", "th-1");
      expect(loaded).toMatchObject({ threadId: "th-1", status: "running", activeItemId: "q-1" });
    });

    it("saveDecisionGate + listDecisionGates + getDecisionGate", async () => {
      await store.saveSession(newSession());
      await store.saveThread("sess-1", newThread("sess-1"));
      const gate: DecisionGate = {
        id: "g-1",
        sessionId: "sess-1",
        threadId: "th-1",
        type: "approval",
        status: "pending",
        title: "x",
        actions: [],
        createdAt: 1,
        updatedAt: 1,
      };
      await store.saveDecisionGate("sess-1", "th-1", gate);
      const list = await store.listDecisionGates("sess-1");
      expect(list).toHaveLength(1);
      const single = await store.getDecisionGate("sess-1", "g-1");
      expect(single?.title).toBe("x");
    });

    it("saveSuspendedTurn + getSuspendedTurn + clearSuspendedTurn", async () => {
      await store.saveSession(newSession());
      await store.saveThread("sess-1", newThread("sess-1"));
      const sus: SuspendedTurnState = {
        sessionId: "sess-1",
        threadId: "th-1",
        queueItemId: "q-1",
        gateId: "g-1",
        model: "faux/faux-1",
        toolCallId: "tc-1",
        toolName: "do_thing",
        toolArgs: { arg: "x" },
        resumeKey: "do_thing:x",
        attempt: 1,
        createdAt: 1,
      };
      await store.saveSuspendedTurn("sess-1", "th-1", sus);
      expect(await store.getSuspendedTurn("sess-1", "th-1")).toMatchObject({
        toolName: "do_thing",
        toolArgs: { arg: "x" },
      });
      await store.clearSuspendedTurn("sess-1", "th-1");
      expect(await store.getSuspendedTurn("sess-1", "th-1")).toBeNull();
    });

    it("updateDecisionGateEntry patches the matching entry", async () => {
      await store.saveSession(newSession());
      await store.saveThread("sess-1", newThread("sess-1"));
      const gate: DecisionGate = {
        id: "g-1",
        sessionId: "sess-1",
        threadId: "th-1",
        type: "approval",
        status: "pending",
        title: "x",
        actions: [],
        createdAt: 1,
        updatedAt: 1,
      };
      await store.saveDecisionGate("sess-1", "th-1", gate);
      await store.appendEntries("sess-1", "th-1", [
        {
          id: "e-g",
          sessionId: "sess-1",
          threadId: "th-1",
          parentId: null,
          type: "decision_gate",
          gate,
          createdAt: 1,
        },
      ]);
      await store.updateDecisionGateEntry("sess-1", "th-1", "g-1", {
        gate: { ...gate, status: "resolved" },
        resolution: { actionId: "approve", resolvedBy: "u1", resolvedAt: 5 },
      });
      const entries = await store.getEntries("sess-1", "th-1");
      const e = entries.find((x) => x.type === "decision_gate");
      expect(e && e.type === "decision_gate" && e.gate.status).toBe("resolved");
      expect(e && e.type === "decision_gate" && e.resolution?.actionId).toBe("approve");
    });

    it("deleteSession removes the session", async () => {
      await store.saveSession(newSession());
      await store.deleteSession("sess-1");
      expect(await store.getSession("sess-1")).toBeNull();
    });
  });
}
