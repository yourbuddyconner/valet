import { describe, it, expect } from "vitest";
import { Type, fauxAssistantMessage, registerFauxProvider, type Context, type StreamOptions } from "@mariozechner/pi-ai";
import {
  Engine,
  InMemoryEventBus,
  InMemorySessionStore,
  VirtualSandboxProvider,
  loadRoleFromMarkdown,
  loadSkillFromMarkdown,
  type BusEvent,
} from "../src/index.js";

function makeEngine() {
  const store = new InMemorySessionStore();
  const bus = new InMemoryEventBus();
  const sandboxProvider = new VirtualSandboxProvider();
  const events: BusEvent[] = [];
  bus.subscribe({}, (e) => events.push(e));
  const engine = new Engine({ providers: { store, bus, sandboxProvider } });
  return { engine, store, bus, events };
}

async function waitForIdle(events: BusEvent[], threadId: string, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (
    !events.some(
      (e) =>
        e.event.type === "status" && e.event.threadId === threadId && e.event.status === "idle",
    )
  ) {
    if (Date.now() - start > timeoutMs) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("roles: per-prompt overlay reaches the LLM via systemPrompt", () => {
  it("a prompt-level role concatenates onto the base systemPrompt for that one turn", async () => {
    const observed: { systemPrompt?: string } = {};
    const faux = registerFauxProvider({ provider: "roles-overlay" });
    // Capture the system prompt the LLM sees by inspecting context in a
    // response factory. The faux provider passes us the full Context.
    faux.setResponses([
      (ctx: Context, _opts: StreamOptions | undefined, _state, model) => {
        observed.systemPrompt = ctx.systemPrompt;
        return {
          role: "assistant" as const,
          content: [{ type: "text", text: "ack" }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: {
            input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop" as const,
          timestamp: Date.now(),
        };
      },
      // Second response for the bare-prompt run below.
      fauxAssistantMessage("ack"),
    ]);

    const reviewerRole = loadRoleFromMarkdown(`---
name: reviewer
description: Code reviewer persona
---

You are a careful code reviewer. Always cite file paths.
`);

    const { engine, events } = makeEngine();
    const session = await engine.createSession({
      userId: "u",
      orgId: "o",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
      systemPrompt: "Base instructions.",
      roles: [reviewerRole],
    });
    const receipt = await session.thread().submitPrompt("review this", { role: "reviewer" });
    await waitForIdle(events, receipt.threadId);

    expect(observed.systemPrompt).toContain("Base instructions.");
    expect(observed.systemPrompt).toContain("You are a careful code reviewer");

    // Now a turn WITHOUT the role — base system prompt should be intact, no overlay.
    const observed2: { systemPrompt?: string } = {};
    faux.setResponses([
      (ctx: Context, _opts, _state, model) => {
        observed2.systemPrompt = ctx.systemPrompt;
        return {
          role: "assistant" as const,
          content: [{ type: "text", text: "ack2" }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: {
            input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop" as const,
          timestamp: Date.now(),
        };
      },
    ]);
    const r2 = await session.thread().submitPrompt("plain", {});
    await new Promise((r) => setTimeout(r, 50));
    while (
      !events.some(
        (e) =>
          e.event.type === "status" &&
          e.event.threadId === r2.threadId &&
          e.event.status === "idle" &&
          // ensure we're looking at the SECOND idle event
          events.indexOf(e) > events.findIndex((x) => x.event.type === "turn_end"),
      )
    ) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(observed2.systemPrompt).toBe("Base instructions.");
    expect(observed2.systemPrompt).not.toContain("careful code reviewer");

    faux.unregister();
  });

  it("unknown role name emits an error event and runs without overlay", async () => {
    const observed: { systemPrompt?: string } = {};
    const faux = registerFauxProvider({ provider: "roles-unknown" });
    faux.setResponses([
      (ctx: Context, _opts, _state, model) => {
        observed.systemPrompt = ctx.systemPrompt;
        return {
          role: "assistant" as const,
          content: [{ type: "text", text: "ack" }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: {
            input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop" as const,
          timestamp: Date.now(),
        };
      },
    ]);
    const { engine, events } = makeEngine();
    const session = await engine.createSession({
      userId: "u",
      orgId: "o",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
      systemPrompt: "base",
    });
    const receipt = await session.thread().submitPrompt("go", { role: "ghost" });
    await waitForIdle(events, receipt.threadId);

    const errorEvent = events.find(
      (e) =>
        e.event.type === "error" && (e.event as { code: string }).code === "role_not_found",
    );
    expect(errorEvent).toBeDefined();
    expect(observed.systemPrompt).toBe("base"); // ran without overlay
    faux.unregister();
  });
});

describe("thread.skill: render template + submit as a normal prompt", () => {
  it("renders {{var}} placeholders in skill content with provided args", async () => {
    const captured: string[] = [];
    const faux = registerFauxProvider({ provider: "skills-render" });
    faux.setResponses([
      (ctx: Context, _opts, _state, model) => {
        const last = ctx.messages.at(-1);
        if (last?.role === "user") {
          const block = last.content;
          const text = typeof block === "string" ? block : (block[0] as { text: string }).text;
          captured.push(text);
        }
        return {
          role: "assistant" as const,
          content: [{ type: "text", text: "ack" }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: {
            input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop" as const,
          timestamp: Date.now(),
        };
      },
    ]);

    const skill = loadSkillFromMarkdown(`---
name: research
description: Research a topic
---

Research {{topic}} and report on {{angle}} in 3 bullets.
`);
    const { engine, events } = makeEngine();
    const session = await engine.createSession({
      userId: "u",
      orgId: "o",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
      skills: [skill],
    });
    const receipt = await session.thread().skill("research", {
      args: { topic: "lithium-ion batteries", angle: "safety" },
    });
    await waitForIdle(events, receipt.threadId);

    expect(captured).toHaveLength(1);
    expect(captured[0]).toContain("Research lithium-ion batteries");
    expect(captured[0]).toContain("report on safety");
    faux.unregister();
  });

  it("rejects unknown skill names", async () => {
    const faux = registerFauxProvider({ provider: "skills-unknown" });
    const { engine } = makeEngine();
    const session = await engine.createSession({
      userId: "u",
      orgId: "o",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
    });
    await expect(session.thread().skill("ghost", {})).rejects.toThrow(/not registered/);
    faux.unregister();
  });

  it("validates args against argsSchema and rejects bad input", async () => {
    const faux = registerFauxProvider({ provider: "skills-validate" });
    const skill = loadSkillFromMarkdown(
      `---
name: fetch
description: fetch a doc by id
---

Fetch document {{id}}.
`,
      "plugin",
      undefined,
      Type.Object({ id: Type.Integer({ minimum: 1 }) }),
    );
    const { engine } = makeEngine();
    const session = await engine.createSession({
      userId: "u",
      orgId: "o",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
      skills: [skill],
    });
    await expect(session.thread().skill("fetch", { args: { id: "not-a-number" } })).rejects.toThrow(
      /failed validation/,
    );
    faux.unregister();
  });
});
