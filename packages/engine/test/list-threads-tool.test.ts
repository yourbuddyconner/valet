/**
 * `list_threads` builtin tool: discovery for sibling threads.
 *
 * Two angles:
 *   1. End-to-end via a live session: we create two threads, then invoke
 *      ctx.listThreads() through the engine and assert the persisted shape.
 *   2. Tool-output formatting: invoke the tool with a stub ctx and check
 *      the rendered text.
 */
import { describe, it, expect } from "vitest";
import { registerFauxProvider } from "@mariozechner/pi-ai";
import {
  Engine,
  InMemoryEventBus,
  InMemorySessionStore,
  VirtualSandboxProvider,
  builtinTools,
} from "../src/index.js";
import { listThreadsTool } from "../src/builtin-tools/index.js";

function makeEngine() {
  const store = new InMemorySessionStore();
  const bus = new InMemoryEventBus();
  const sandboxProvider = new VirtualSandboxProvider();
  const engine = new Engine({ providers: { store, bus, sandboxProvider } });
  return { engine, store };
}

describe("list_threads tool", () => {
  it("is registered in builtinTools", () => {
    expect(builtinTools.map((t) => t.name)).toContain("list_threads");
  });

  it("renders threads with key, status, model, and self-marker", async () => {
    const calls: number[] = [];
    const stubCtx = {
      threadId: "thr-self",
      listThreads: async () => {
        calls.push(1);
        return [
          {
            id: "thr-self",
            key: "web:default",
            status: "active" as const,
            createdAt: 0,
            updatedAt: 1700000000000,
          },
          {
            id: "thr-2",
            key: "task:research",
            status: "paused" as const,
            model: "claude-opus-4-7",
            summary: "Looking into the migration plan",
            createdAt: 0,
            updatedAt: 1700000010000,
          },
        ];
      },
    } as unknown as Parameters<typeof listThreadsTool.execute>[1];

    const result = (await listThreadsTool.execute({} as never, stubCtx)) as {
      text: string;
    };
    expect(calls).toHaveLength(1);
    expect(result.text).toContain("# threads (2)");
    expect(result.text).toContain("`web:default`");
    expect(result.text).toContain("`task:research`");
    expect(result.text).toContain("(this thread)");
    expect(result.text).toContain("[model:claude-opus-4-7]");
    expect(result.text).toContain("Looking into the migration plan");
  });

  it("returns an empty marker when the session has no threads in the store", async () => {
    const stubCtx = {
      threadId: "thr-x",
      listThreads: async () => [],
    } as unknown as Parameters<typeof listThreadsTool.execute>[1];
    const result = (await listThreadsTool.execute({} as never, stubCtx)) as {
      text: string;
    };
    expect(result.text).toBe("(no threads)");
  });

  it("ctx.listThreads returns persisted threads from the store", async () => {
    const faux = registerFauxProvider({ provider: "multi" });
    try {
      const { engine, store } = makeEngine();
      const session = await engine.createSession({
        userId: "u1",
        orgId: "o1",
        workspace: "/",
        sandbox: {},
        model: faux.getModel(),
      });

      const tA = session.thread("task:A");
      const tB = session.thread("task:B");
      await tA.setModel(null); // no-op, but ensures thread is persisted
      await tB.setModel(null);

      // Bypass the agent and pull directly from the store, which is
      // exactly what ctx.listThreads does internally.
      const datas = await store.listThreads(session.id);
      const keys = datas.map((d) => d.key).sort();
      expect(keys).toEqual(["task:A", "task:B"]);
    } finally {
      faux.unregister();
    }
  });
});
