import { describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { Engine, InMemoryEventStream, InMemorySessionStore, VirtualSandboxProvider } from "../src/index.js";

describe("keyed thread creation", () => {
  it("coalesces concurrent creation and permits retry after persistence failure", async () => {
    const faux = registerFauxProvider({ provider: "keyed-creation" });
    const store = new InMemorySessionStore();
    const session = await new Engine({ providers: { store, stream: new InMemoryEventStream(), sandboxProvider: new VirtualSandboxProvider() } }).createSession({ userId: "u", orgId: "o", workspace: "/", sandbox: {}, model: faux.getModel() });
    try {
      const save = vi.spyOn(store, "saveThread");
      const threads = await Promise.all(Array.from({ length: 10 }, () => session.createThread("workflow:wf")));
      expect(new Set(threads).size).toBe(1);
      expect(save).toHaveBeenCalledTimes(1);
      expect((await store.listThreads(session.id)).filter(thread => thread.key === "workflow:wf")).toHaveLength(1);
      save.mockRejectedValueOnce(new Error("offline"));
      await expect(session.createThread("workflow:retry")).rejects.toThrow("offline");
      expect((await session.createThread("workflow:retry")).key).toBe("workflow:retry");
    } finally { session.suspendTimers(); faux.unregister(); }
  });
  it("adopts a durable winner when another host creates the key first", async () => {
    const faux = registerFauxProvider({ provider: "keyed-winner" });
    const store = new InMemorySessionStore();
    const providers = { store, stream: new InMemoryEventStream(), sandboxProvider: new VirtualSandboxProvider() };
    const options = { userId: "u", orgId: "o", workspace: "/", sandbox: {}, model: faux.getModel() };
    const original = await new Engine({ providers }).createSession(options);
    const restored = await new Engine({ providers }).restoreSession({ sessionId: original.id, options });
    try {
      const winner = await original.createThread("workflow:wf");
      vi.spyOn(store, "saveThread").mockRejectedValueOnce(new Error("unique session key"));
      const adopted = await restored.createThread("workflow:wf");
      expect(adopted.id).toBe(winner.id);
      expect(await restored.threadByKey("workflow:wf")).toBe(adopted);
    } finally { original.suspendTimers(); restored.suspendTimers(); faux.unregister(); }
  });
  it("adds host context only to the matching thread's model prompt", async () => {
    const faux = registerFauxProvider({ provider: "keyed-context" });
    const prompts: string[] = [];
    faux.setResponses([context => { prompts.push(JSON.stringify(context.messages)); return fauxAssistantMessage("done"); }, context => { prompts.push(JSON.stringify(context.messages)); return fauxAssistantMessage("done"); }]);
    const session = await new Engine({ providers: { store: new InMemorySessionStore(), stream: new InMemoryEventStream(), sandboxProvider: new VirtualSandboxProvider() } }).createSession({
      userId: "u", orgId: "o", workspace: "/", sandbox: {}, model: faux.getModel(),
      threadSystemContext: thread => thread.key === "workflow:wf" ? "Edit workflow wf" : undefined,
    });
    try {
      for (const key of ["workflow:wf", "web:other"]) {
        const thread = await session.createThread(key);
        const receipt = await thread.submitPrompt("help", {});
        await thread.awaitResult(receipt.queueItemId);
      }
      expect(prompts[0]).toContain("Edit workflow wf");
      expect(prompts[1]).not.toContain("Edit workflow wf");
    } finally { session.suspendTimers(); faux.unregister(); }
  });

});
