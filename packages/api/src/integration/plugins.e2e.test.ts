/**
 * Plugin-system-v2 plan Task 16: exit-criteria integration tests.
 *
 * Four automated checks (brief: `.superpowers/sdd/task-16-brief.md`):
 *
 *   1. Key-gated orchestrator flow — real Anthropic, a fixture ValetPlugin
 *      (`demo.ping`, low risk) with a fixture credential saved for
 *      `local-user`; drives `list_tools` then `call_tool demo.ping` and
 *      asserts the settled thread's tool_call parts + final text. Also
 *      (ungated) asserts every plugin in the REAL `bundledPlugins` registry
 *      passes `validateValetPlugin` and the full set assembles without
 *      collision via `assemblePlugins([bundledPlugins])`.
 *   2. node_modules drop-in (ungated) — a tmp-dir fixture package loads via
 *      `loadNodeModulesPlugins`; a broken sibling package quarantines
 *      without killing the good load. Deliberately thin — Task 4's own
 *      `node-modules-loader.test.ts` covers loader internals in depth; this
 *      is one compact proof that the same loader is what boot wires up.
 *   3. Workflow tool node (ungated) — `trigger -> tool -> stop` (no
 *      session/llm nodes, so no model is needed) against the fixture
 *      service completes with the action result in the node checkpoint.
 *      Duplicate-invocation safety is asserted at the ActionInvoker level
 *      (`buildActionInvoker`, imported directly and driven with the SAME
 *      `invocationId` the real node minted) rather than via a full
 *      kill/restart harness — see the test body for why that's the
 *      disclosed, deliberately narrower choice for this task.
 *   4. Credential-unavailable UX (ungated) — `list_tools`'s output includes
 *      the `not connected` warning for a declared-but-unconnected
 *      fixture service, driven by calling the `list_tools` `ToolDef.execute`
 *      directly (via `pluginSessionExtras`) with a minimal `ToolContext`
 *      built from the booted providers — no model involved.
 */
import { decode } from "@toon-format/toon";
import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { validateValetPlugin, type PluginAction, type ToolContext, type ValetPlugin } from "@valet/engine";
import { Type } from "typebox";
import { bootTestApi, type TestApi } from "./_setup.js";
import { driveTurn } from "./_test-utils.js";
import { assemblePlugins, pluginSessionExtras } from "../plugins/assemble.js";
import { loadNodeModulesPlugins } from "../plugins/node-modules-loader.js";
import { buildActionInvoker } from "../plugins/action-invoker.js";
import { bundledPlugins } from "../plugins/registry.gen.js";
import { actionInvocations } from "../schema/index.js";
import type {
  CreateWorkflowResponse,
  EnsureWorkspaceRuntimeResponse,
  GetWorkflowRunResponse,
  ListMessagesResponse,
  StartWorkflowRunResponse,
} from "../wire/types.js";

const describeIfKey = process.env.ANTHROPIC_API_KEY ? describe : describe.skip;

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

// ── Fixture plugin: demo.ping ──────────────────────────────────────────────

const DEMO_PAYLOAD_PREFIX = "pong-fixture-";

interface DemoPingFixture {
  plugin: ValetPlugin;
  calls: () => number;
}

/** A minimal ValetPlugin exposing one low-risk action, `demo.ping`, whose
 * `execute` returns a distinctive payload (so we can grep for it in a
 * model's final text) and reports whether a credential was connected. */
function makeDemoPingPlugin(): DemoPingFixture {
  let calls = 0;
  const action: PluginAction = {
    id: "demo.ping",
    name: "Demo Ping",
    description: "Returns a fixture payload; used only by plugin system exit-criteria tests.",
    riskLevel: "low",
    parameters: Type.Object({}),
    execute: async (_args, ctx) => {
      calls += 1;
      const credential = await ctx.credentials.get();
      return {
        success: true,
        data: { payload: `${DEMO_PAYLOAD_PREFIX}${calls}`, hasCredential: credential !== null },
      };
    },
  };
  const plugin: ValetPlugin = {
    name: "demo",
    version: "0.0.1",
    actions: [{ service: "demo", actions: [action] }],
    credentials: [{ service: "demo", type: "api_key", configKeys: ["apiKey"], connectLabel: "Demo" }],
  };
  return { plugin, calls: () => calls };
}

// ── 1. Orchestrator lists and calls a ported action with a per-user credential ──

describeIfKey("api integration: plugin system exit criteria — orchestrator flow (key-gated)", () => {
  it(
    "list_tools then call_tool demo.ping surfaces the fixture payload in the settled thread",
    async () => {
      const fixture = makeDemoPingPlugin();
      api = await bootTestApi({ plugins: [fixture.plugin] });

      // Fixture credential for local-user — exercises the
      // credential-connected path (ctx.credentials.get() !== null) inside
      // demo.ping's execute.
      await api.providers.engineCredentials.save({ type: "user", id: "local-user" }, "demo", {
        type: "api_key",
        apiKey: "fixture-demo-key",
      });

      const ensureRes = await fetch(`${api.baseUrl}/api/workspaces/user/runtime`, { method: "POST" });
      expect(ensureRes.status).toBe(200);
      const { sessionId } = (await ensureRes.json()) as EnsureWorkspaceRuntimeResponse;

      await driveTurn({
        baseUrl: api.baseUrl,
        wsUrl: api.wsUrl,
        sessionId,
        prompt:
          "Use the list_tools tool (no filters) to see what plugin tools are available, then use " +
          "call_tool to invoke the tool_id 'demo.ping' with an empty params object and summary " +
          "'exit criteria check'. After it returns, reply with a sentence that includes the exact " +
          "'payload' string value from the tool's JSON result, verbatim.",
        timeoutMs: 90_000,
      });

      const msgRes = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/messages`);
      expect(msgRes.status).toBe(200);
      const { messages } = (await msgRes.json()) as ListMessagesResponse;

      const toolCallNames = messages
        .flatMap((m) => m.parts)
        .filter((p) => p.kind === "tool_call")
        .map((p) => (p.kind === "tool_call" ? p.toolName : never()));

      expect(toolCallNames).toContain("list_tools");
      expect(toolCallNames).toContain("call_tool");

      const completedCallTool = messages
        .flatMap((m) => m.parts)
        .find((p) => p.kind === "tool_call" && p.toolName === "call_tool" && p.status === "completed");
      expect(
        completedCallTool,
        `no completed call_tool part; tool calls seen: ${JSON.stringify(toolCallNames)}`,
      ).toBeDefined();

      const finalText = messages
        .filter((m) => m.role === "assistant")
        .flatMap((m) => m.parts)
        .filter((p) => p.kind === "text")
        .map((p) => (p.kind === "text" ? p.text : ""))
        .join("\n");
      expect(finalText).toContain(DEMO_PAYLOAD_PREFIX);

      expect(fixture.calls()).toBe(1);
    },
    90_000,
  );
});

function never(): never {
  throw new Error("unreachable: narrowed to tool_call above");
}

// ── 1b. Real bundled registry validates + assembles cleanly (ungated) ─────

describe("api integration: plugin system exit criteria — bundled registry (ungated)", () => {
  it("every bundled plugin passes validateValetPlugin and the set assembles without collision", () => {
    expect(bundledPlugins.length).toBeGreaterThan(0);
    for (const plugin of bundledPlugins) {
      const result = validateValetPlugin(plugin);
      expect(result.ok, `plugin "${plugin.name}" failed validateValetPlugin: ${JSON.stringify(!result.ok && result.issues)}`).toBe(true);
    }

    const { plugins, actionPluginByService } = assemblePlugins([bundledPlugins]);
    expect(plugins).toHaveLength(bundledPlugins.length);
    expect(actionPluginByService.size).toBeGreaterThan(0);
  });
});

// ── 2. node_modules drop-in: good plugin loads, broken sibling quarantines ──

describe("api integration: plugin system exit criteria — node_modules drop-in (ungated)", () => {
  it("boot-level composition: a good drop-in plugin loads while a broken sibling quarantines", async () => {
    const root = await mkdtemp(join(tmpdir(), "valet-plugins-e2e-nm-"));
    try {
      const goodDir = join(root, "good-dropin-plugin");
      await mkdir(goodDir, { recursive: true });
      await writeFile(
        join(goodDir, "package.json"),
        JSON.stringify({ name: "good-dropin-plugin", version: "1.0.0", valet: { plugin: "plugin.mjs" } }),
      );
      await writeFile(
        join(goodDir, "plugin.mjs"),
        `export default { name: "good-dropin-plugin", version: "1.0.0", actions: [] };\n`,
      );

      const badDir = join(root, "broken-dropin-plugin");
      await mkdir(badDir, { recursive: true });
      await writeFile(
        join(badDir, "package.json"),
        JSON.stringify({ name: "broken-dropin-plugin", version: "1.0.0", valet: { plugin: "plugin.mjs" } }),
      );
      await writeFile(join(badDir, "plugin.mjs"), `throw new Error("drop-in plugin is broken");\n`);

      const result = await loadNodeModulesPlugins({ searchPaths: [root] });

      expect(result.plugins.map((p) => p.name)).toEqual(["good-dropin-plugin"]);
      expect(result.quarantined).toHaveLength(1);
      expect(result.quarantined[0]?.pkg).toBe("broken-dropin-plugin");
      expect(result.quarantined[0]?.reason).toMatch(/drop-in plugin is broken/);

      // Boot-level composition: the loaded plugin assembles cleanly
      // alongside the bundled registry, same as `providers/node.ts` does at
      // real boot (`assemblePlugins([bundledPlugins, nodeModulesResult.plugins])`).
      const { plugins } = assemblePlugins([bundledPlugins, result.plugins]);
      expect(plugins.map((p) => p.name)).toContain("good-dropin-plugin");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ── 3. Workflow tool node + duplicate-invocation safety (ungated) ─────────

describe("api integration: plugin system exit criteria — workflow tool node (ungated)", () => {
  it(
    "a tool node against the fixture service completes with the action result in the node checkpoint",
    async () => {
      const fixture = makeDemoPingPlugin();
      api = await bootTestApi({ plugins: [fixture.plugin] });

      const definition = {
        version: "dag/v1",
        nodes: [
          { id: "trigger", type: "trigger" },
          { id: "call", type: "tool", service: "demo", action: "ping", params: {} },
          { id: "done", type: "stop" },
        ],
        edges: [
          { from: "trigger", to: "call" },
          { from: "call", to: "done" },
        ],
      };

      const createRes = await fetch(`${api.baseUrl}/api/workflows`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "e2e-tool-node", definition }),
      });
      expect(createRes.status).toBe(201);
      const { id: workflowId } = (await createRes.json()) as CreateWorkflowResponse;

      const startRes = await fetch(`${api.baseUrl}/api/workflows/${workflowId}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(startRes.status).toBe(201);
      const { runId } = (await startRes.json()) as StartWorkflowRunResponse;

      // No session/llm node in this definition — nothing waits on a model,
      // so the run settles fast. Poll briefly rather than assuming
      // synchronous completion (the host still drives it through its own
      // poll loop).
      const settled = await poll(
        async () => {
          const r = await fetch(`${api!.baseUrl}/api/workflows/runs/${runId}`);
          expect(r.status).toBe(200);
          return (await r.json()) as GetWorkflowRunResponse;
        },
        (r) => r.run.status === "settled",
        15_000,
      );

      expect(settled.run.outcome).toBe("completed");
      const callCheckpoint = settled.checkpoints.find((c) => c.nodeId === "call" && c.status === "completed");
      expect(callCheckpoint).toBeDefined();
      const result = callCheckpoint?.result as { payload?: unknown; hasCredential?: unknown } | undefined;
      expect(typeof result?.payload).toBe("string");
      expect((result?.payload as string).startsWith(DEMO_PAYLOAD_PREFIX)).toBe(true);
      expect(fixture.calls()).toBe(1);

      // ── Duplicate-invocation safety ──
      //
      // Design choice (disclosed per brief): rather than building a full
      // kill/restart harness to force the workflow host itself to re-drive
      // the "call" node (the way `workflow-run.e2e.test.ts` does for
      // session/approval/wait nodes), dedup is asserted directly at the
      // ActionInvoker level — the exact primitive the tool node executor's
      // `engine.invokeAction` calls into (see `nodes/tool.ts`'s doc comment
      // and `workflows/engine-deps.ts`'s `invokeAction` method, both of
      // which route through `buildActionInvoker`). We reconstruct that same
      // invoker against the REAL `providers.db` / `providers.actionPluginByService`
      // / `providers.engineCredentials` the booted app used, then call it a
      // second time with the SAME `invocationId` the real run already
      // minted (`workflow:{runId}:call`, the tool executor's documented
      // convention with no iteration suffix at iteration 0). The node
      // completion itself was already asserted once at the run level above
      // — this second call only needs to prove no re-execution and no
      // second `action_invocations` row.
      const invocationId = `workflow:${runId}:call`;
      const invoke = buildActionInvoker({
        db: api.providers.db,
        credentials: api.providers.engineCredentials,
        actionPluginByService: api.providers.actionPluginByService,
      });

      const replay = await invoke(
        { service: "demo", action: "ping", params: {}, invocationId },
        { userId: "local-user", orgId: "local-org", owner: { type: "user", id: "local-user" } },
      );

      expect(replay).toEqual({ ok: true, result: { payload: `${DEMO_PAYLOAD_PREFIX}1`, hasCredential: false } });
      // Still exactly one execute() call total — the replay above did NOT
      // re-invoke the fixture action.
      expect(fixture.calls()).toBe(1);

      const invocationRows = await api.providers.db
        .select()
        .from(actionInvocations)
        .where(eq(actionInvocations.invocationId, invocationId));
      expect(invocationRows).toHaveLength(1);
    },
    30_000,
  );
});

async function poll<T>(fn: () => Promise<T>, ok: (v: T) => boolean, timeoutMs: number, intervalMs = 200): Promise<T> {
  const start = Date.now();
  let last: T;
  for (;;) {
    last = await fn();
    if (ok(last)) return last;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`poll: timed out after ${timeoutMs}ms; last value: ${JSON.stringify(last)}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// ── 4. Credential-unavailable UX (ungated) ─────────────────────────────────

describe("api integration: plugin system exit criteria — credential-unavailable UX (ungated)", () => {
  it("list_tools hides a declared-but-unconnected service's tools, with a warning naming the fix", async () => {
    const fixture = makeDemoPingPlugin();
    api = await bootTestApi({ plugins: [fixture.plugin] });
    // Deliberately never save a credential for "demo" — the point of this
    // test is the unconnected path. The plugin declares a credential spec,
    // so assemble infers requiresCredential.

    const { tools } = pluginSessionExtras(api.providers.plugins);
    const listTools = tools.find((t) => t.name === "list_tools");
    expect(listTools).toBeDefined();

    const ctx = buildMinimalToolContext(api!);

    // Unfiltered listing: tools hidden, warning explains why + the fix.
    const result = await listTools!.execute({}, ctx);
    const parsed = decode(result.text) as {
      tools: Array<{ service: string }>;
      warnings?: Array<{ service: string; reason: string }>;
    };
    expect(parsed.tools.filter((t) => t.service === "demo")).toEqual([]);
    const demoWarning = parsed.warnings?.find((w) => w.service === "demo");
    expect(demoWarning?.reason, `warnings: ${JSON.stringify(parsed.warnings)}`).toMatch(
      /tools hidden/,
    );

    // Explicit service filter: schemas stay inspectable, warning persists.
    const filtered = await listTools!.execute({ service: "demo" }, ctx);
    const filteredParsed = decode(filtered.text) as {
      tools: Array<{ tool_id: string }>;
      warnings?: Array<{ service: string; reason: string }>;
    };
    expect(filteredParsed.tools.map((t) => t.tool_id)).toEqual(["demo.ping"]);
    expect(filteredParsed.warnings?.[0]?.reason).toBe("not connected");
  });
});

/** Minimal `ToolContext` sufficient to drive `list_tools`/`call_tool`
 * directly (no live session/thread/turn) — mirrors the shape
 * `../plugins/action-invoker.ts`'s `buildActionContext` builds for the same
 * "no live turn behind this call" situation. */
function buildMinimalToolContext(testApi: TestApi): ToolContext {
  const credentials = testApi.providers.engineCredentials;
  const owner = { type: "user" as const, id: "local-user" };
  return {
    userId: "local-user",
    orgId: "local-org",
    sessionId: "plugins-e2e-test",
    threadId: "plugins-e2e-test",
    credentials: {
      async get(service?: string) {
        if (!service) return null;
        const stored = await credentials.get(owner, service);
        if (!stored) return null;
        const accessToken = stored.accessToken ?? stored.apiKey ?? "";
        if (accessToken === "") return null;
        return {
          accessToken,
          refreshToken: stored.refreshToken,
          expiresAt: stored.expiresAt,
          scopes: stored.scopes,
          metadata: stored.metadata,
        };
      },
      request() {
        return Promise.reject(new Error("credential requests are not supported in this test context"));
      },
    },
    sandbox: {
      id: "plugins-e2e-test",
      readFile: () => {
        throw new Error("sandbox unavailable in this test context");
      },
      readBinary: () => {
        throw new Error("sandbox unavailable in this test context");
      },
      writeFile: () => {
        throw new Error("sandbox unavailable in this test context");
      },
      writeBinary: () => {
        throw new Error("sandbox unavailable in this test context");
      },
      readdir: () => {
        throw new Error("sandbox unavailable in this test context");
      },
      stat: () => {
        throw new Error("sandbox unavailable in this test context");
      },
      mkdir: () => {
        throw new Error("sandbox unavailable in this test context");
      },
      rm: () => {
        throw new Error("sandbox unavailable in this test context");
      },
      exec: () => {
        throw new Error("sandbox unavailable in this test context");
      },
    },
    signal: AbortSignal.timeout(30_000),
    requestDecision: () => Promise.reject(new Error("approvals are not available in this test context")),
    threadRead: () => Promise.reject(new Error("thread history is not available in this test context")),
    listThreads: () => Promise.reject(new Error("thread listing is not available in this test context")),
    setModel: () => Promise.reject(new Error("model switching is not available in this test context")),
  };
}
