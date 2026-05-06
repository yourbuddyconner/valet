import { describe, it, expect } from "vitest";
import {
  fauxAssistantMessage,
  fauxToolCall,
  registerFauxProvider,
  Type,
} from "@mariozechner/pi-ai";
import {
  Engine,
  InMemoryEventBus,
  VirtualSandboxProvider,
  type BusEvent,
  type DecisionGate,
  type SessionStore,
  type ToolDef,
} from "../index.js";

const approvalParams = Type.Object({ arg: Type.String() });
const approvalTool: ToolDef<typeof approvalParams> = {
  name: "do_thing",
  description: "approval-gated",
  parameters: approvalParams,
  execute: async (args, ctx) => {
    const r = await ctx.requestDecision({
      type: "approval",
      title: "ok?",
      resumeKey: `do_thing:${args.arg}`,
    });
    return { text: `did with ${r.actionId}` };
  },
};

/**
 * Contract: any persistent SessionStore must support a full
 * teardown-and-restore cycle with a pending decision gate.
 *
 * Flow:
 * 1. Engine v1 prompts a tool that opens a gate, then "crashes".
 * 2. Engine v2 restoreSession()s on the same store, then resolves the
 *    gate.
 * 3. The agent replays the suspended tool, runs the continuation turn,
 *    and the result is persisted.
 *
 * Stores that pass `runSessionStoreContract` should also pass this.
 */
export function runRestartSafeGatesContract(
  name: string,
  factory: () => SessionStore | Promise<SessionStore>,
): void {
  describe(`restart-safe gates contract: ${name}`, () => {
    it("survives engine teardown and restoreSession resumes", async () => {
      const store = await factory();
      const sandboxProvider = new VirtualSandboxProvider();

      const faux1 = registerFauxProvider({ provider: `restart-${name}-1` });
      faux1.setResponses([
        fauxAssistantMessage([fauxToolCall("do_thing", { arg: "x" }, { id: "tc1" })], {
          stopReason: "toolUse",
        }),
      ]);

      const bus1 = new InMemoryEventBus();
      const engine1 = new Engine({ providers: { store, bus: bus1, sandboxProvider } });
      const SESSION_ID = `sess-restart-${name}`;
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

      faux1.unregister();

      const faux2 = registerFauxProvider({ provider: `restart-${name}-2` });
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

      expect(await store.getSuspendedTurn(SESSION_ID, gate.threadId)).toBeNull();

      const finalGate = await store.getDecisionGate(SESSION_ID, gate.id);
      expect(finalGate?.status).toBe("resolved");

      faux2.unregister();
    });
  });
}
