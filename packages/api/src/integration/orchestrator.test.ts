/**
 * Integration test: the caller's default assistant (Phase 4 Task 7).
 *
 *   - POST /api/workspaces/user/runtime is idempotent: two calls, one engine session
 *     row, one `assistants` row.
 *   - GET /api/workspaces/user/runtime probes without creating.
 *   - The ensured session is `queueMode: 'steer'` (user principal, decision
 *     17) and its `systemContext` carries the assembled memory snapshot —
 *     asserted via `Session.options` (a public field on the engine's own
 *     `Session`), not by driving a real LLM turn.
 *   - Key-gated (real Anthropic + a create-counting sandbox provider): the
 *     orchestrator answers a prompt with ZERO `sandboxProvider.create` calls
 *     — proves the sandbox-less wake.
 */
import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { VirtualSandboxProvider, type Sandbox, type SandboxCreateOpts, type SandboxProvider } from "@valet/engine";
import { bootTestApi, type TestApi } from "./_setup.js";
import { driveTurn } from "./_test-utils.js";
import { EngineHost } from "../engine/host.js";
import { internalToken } from "../lib/internal-auth.js";
import { agentSessions, assistants } from "../schema/index.js";
import type { EnsureWorkspaceRuntimeResponse, WorkspaceRuntimeResponse } from "../wire/types.js";

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

describe("api integration: default assistant lifecycle", () => {
  // The probe reports no session id at all before the first ensure. The id
  // used to be derivable from the caller; it no longer is, because an
  // assistant addresses its session by its OWN id.
  it("GET /api/workspaces/user/runtime before any ensure reports exists: false and a null sessionId", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/workspaces/user/runtime`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as WorkspaceRuntimeResponse;
    expect(body.exists).toBe(false);
    expect(body.sessionId).toBeNull();

    // The probe creates nothing, the assistant row included.
    const assistantRows = await api.providers.db.select().from(assistants);
    expect(assistantRows).toHaveLength(0);
  });

  it("POST /api/workspaces/user/runtime is idempotent — two calls, one session row, one assistant row", async () => {
    api = await bootTestApi();

    const first = await fetch(`${api.baseUrl}/api/workspaces/user/runtime`, { method: "POST" });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as EnsureWorkspaceRuntimeResponse;
    expect(firstBody.sessionId).toMatch(/^assistant:asst_/);

    const second = await fetch(`${api.baseUrl}/api/workspaces/user/runtime`, { method: "POST" });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as EnsureWorkspaceRuntimeResponse;
    expect(secondBody.sessionId).toBe(firstBody.sessionId);

    const { db } = api.providers;
    const sessionRows = await db.select().from(agentSessions).where(eq(agentSessions.id, firstBody.sessionId));
    expect(sessionRows).toHaveLength(1);
    expect(sessionRows[0]?.title).toBe("Assistant");
    expect(sessionRows[0]?.ownerType).toBe("user");
    expect(sessionRows[0]?.ownerId).toBe("local-user");

    // One assistant, and it is the caller's default: the row a second
    // ensure resolves to instead of creating another.
    const assistantRows = await db
      .select()
      .from(assistants)
      .where(eq(assistants.sessionId, firstBody.sessionId));
    expect(assistantRows).toHaveLength(1);
    expect(assistantRows[0]).toBeDefined();
    expect(assistantRows[0]?.ownerType).toBe("user");
    expect(assistantRows[0]?.ownerId).toBe("local-user");
    expect(await db.select().from(assistants)).toHaveLength(1);

    const probe = await fetch(`${api.baseUrl}/api/workspaces/user/runtime`);
    const probeBody = (await probe.json()) as WorkspaceRuntimeResponse;
    expect(probeBody.exists).toBe(true);
    expect(probeBody.sessionId).toBe(firstBody.sessionId);
  });

  it("ensured session is queueMode 'steer' with the memory snapshot in systemContext", async () => {
    api = await bootTestApi();

    // Seed a pinned memory file before ensuring the assistant, so the
    // snapshot fragment isn't just the empty-memory default — proves the
    // real assembleMemorySnapshot ran, not a stub.
    const writeRes = await fetch(`${api.baseUrl}/api/memory`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "x-valet-internal": internalToken(),
        "x-valet-owner": "user:local-user",
        "x-valet-actor": "local-user",
      },
      body: JSON.stringify({
        path: "preferences/tone.md",
        content: "Keep replies terse and direct.",
        pinned: true,
      }),
    });
    expect(writeRes.status).toBe(200);

    const ensureRes = await fetch(`${api.baseUrl}/api/workspaces/user/runtime`, { method: "POST" });
    const { sessionId } = (await ensureRes.json()) as EnsureWorkspaceRuntimeResponse;

    const session = api.providers.engineHost.liveSession(sessionId);
    expect(session).not.toBeNull();
    expect(session?.options.queueMode).toBe("steer");
    expect(session?.options.purpose).toBe("orchestrator");
    expect(session?.options.owner).toEqual({ type: "user", id: "local-user" });

    const fragments = session?.options.systemContext ?? [];
    const snapshotFragment = fragments.find((f) => f.name === "memory-snapshot");
    expect(snapshotFragment).toBeDefined();
    expect(snapshotFragment?.content).toContain("Keep replies terse and direct.");
    expect(snapshotFragment?.content).toContain("preferences/tone.md");

    // Persona lands as the session systemPrompt.
    expect(session?.options.systemPrompt).toContain("personal assistant");
    expect(session?.options.systemPrompt).toContain("mem_search");
  });

  it("restoring an assistant id through the generic sessionFor chokepoint still wakes the full assistant config", async () => {
    api = await bootTestApi();

    // Create the assistant via the real ensure path first (so an engine row
    // + assistant row exist to restore from).
    const ensureRes = await fetch(`${api.baseUrl}/api/workspaces/user/runtime`, { method: "POST" });
    expect(ensureRes.status).toBe(200);
    const { sessionId } = (await ensureRes.json()) as EnsureWorkspaceRuntimeResponse;

    // Simulate boot restore: a *second* EngineHost, sharing the same
    // stores/db, with a cold in-process cache. `main.ts`'s boot-restore
    // loop (and messages.ts/ws.ts/sessions.ts) all call plain `sessionFor`
    // with generic { userId, orgId, workspace } — never
    // `assistantSessionFor` directly — so the regression this guards
    // against is `sessionFor` rehydrating an assistant id through the
    // generic `buildSession` path (no persona/snapshot/mem tools/steer).
    const restoreHost = new EngineHost({
      engineStore: api.providers.engineStore,
      sandboxProvider: api.providers.sandboxProvider,
      eventStream: api.providers.eventStream,
      engineCredentials: api.providers.engineCredentials,
      blobs: api.providers.blobs,
      db: api.providers.db,
      apiBaseUrl: api.baseUrl,
    });

    try {
      const restored = await restoreHost.sessionFor(sessionId, {
        userId: "local-user",
        orgId: "local-org",
        workspace: "/irrelevant-for-orchestrator-ids",
      });

      expect(restored.options.queueMode).toBe("steer");
      expect(restored.options.purpose).toBe("orchestrator");
      expect(restored.options.owner).toEqual({ type: "user", id: "local-user" });

      const fragments = restored.options.systemContext ?? [];
      expect(fragments.find((f) => f.name === "memory-snapshot")).toBeDefined();

      const toolNames = (restored.options.tools ?? []).map((t) => t.name);
      expect(toolNames).toEqual(
        expect.arrayContaining(["mem_write", "mem_patch", "mem_read", "mem_search", "mem_rm"]),
      );
    } finally {
      await restoreHost.destroyAll();
    }
  });
});

// ── Sandbox-less wake (key-gated: real Anthropic call) ──────────────────────

/** Counts `create()` calls while delegating everything else to a real
 * `VirtualSandboxProvider` — proves the assistant turn below never
 * provisions a sandbox. */
class CreateCountingSandboxProvider implements SandboxProvider {
  creates = 0;
  private readonly inner = new VirtualSandboxProvider();
  readonly backend = this.inner.backend;
  capabilities() {
    return this.inner.capabilities();
  }
  async create(opts: SandboxCreateOpts): Promise<Sandbox> {
    this.creates++;
    return this.inner.create(opts);
  }
  restore(id: string): Promise<Sandbox> {
    return this.inner.restore(id);
  }
  destroy(id: string): Promise<void> {
    return this.inner.destroy(id);
  }
  status(id: string) {
    return this.inner.status(id);
  }
}

const describeIfKey = process.env.ANTHROPIC_API_KEY ? describe : describe.skip;

describeIfKey("api integration: assistant sandbox-less wake", () => {
  it(
    "answers a prompt with zero sandboxProvider.create calls",
    async () => {
      const counter = new CreateCountingSandboxProvider();
      api = await bootTestApi({ sandboxProvider: counter });

      const ensureRes = await fetch(`${api.baseUrl}/api/workspaces/user/runtime`, { method: "POST" });
      expect(ensureRes.status).toBe(200);
      const { sessionId } = (await ensureRes.json()) as EnsureWorkspaceRuntimeResponse;

      await driveTurn({
        baseUrl: api.baseUrl,
        wsUrl: api.wsUrl,
        sessionId,
        prompt: "Reply with exactly the word 'ack' and nothing else. Do not use any tools.",
      });

      expect(counter.creates).toBe(0);
    },
    60_000,
  );
});
