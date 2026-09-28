/**
 * PATCH /api/sessions/:id — the `profile` half (V1 port #2, Terminal and VS
 * Code on assistant sessions).
 *
 * The profile decides whether the sandbox starts the terminal, the VS Code
 * server, and the auth gateway the browser proxies to. It was frozen at
 * creation, so an assistant session — which defaults to `headless` — could
 * never show those tabs. The value is now a session setting.
 *
 * The mechanism the tests pin: a live session froze its profile into
 * `SandboxCreateOpts` at build time, and the attachment reuses that object
 * on every re-provision. So a change has to evict the cached session AND
 * replace a running sandbox, or the container keeps serving the old shape.
 */
import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import {
  VirtualSandbox,
  type QueueItem,
  type Sandbox,
  type SandboxCapabilities,
  type SandboxCreateOpts,
  type SandboxProvider,
  type SandboxStatus,
} from "@valet/engine";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { agentSessions } from "../schema/index.js";
import type { PatchSessionResponse } from "../wire/types.js";

/** Records the `SandboxCreateOpts` of every provision — mirrors
 * `host.default-image.test.ts`'s recorder. */
class RecordingSandboxProvider implements SandboxProvider {
  readonly backend = "profile-switch-test";
  readonly createCalls: SandboxCreateOpts[] = [];
  private sandboxes = new Map<string, VirtualSandbox>();
  private nextId = 1;

  capabilities(): SandboxCapabilities {
    return {
      snapshot: "none",
      persistentWorkspace: false,
      tunnels: false,
      warmPool: false,
      hibernation: false,
      customImage: false,
      coldStartEstimateMs: 0,
    };
  }

  async create(opts: SandboxCreateOpts): Promise<Sandbox> {
    this.createCalls.push(opts);
    const id = `psw-${this.nextId++}`;
    const sb = new VirtualSandbox(id);
    this.sandboxes.set(id, sb);
    return sb;
  }

  async restore(id: string): Promise<Sandbox> {
    const sb = this.sandboxes.get(id);
    if (!sb) throw new Error(`sandbox not found: ${id}`);
    return sb;
  }

  async destroy(id: string): Promise<void> {
    const sb = this.sandboxes.get(id);
    if (sb) await sb.destroy?.();
    this.sandboxes.delete(id);
  }

  async status(id: string): Promise<SandboxStatus> {
    return this.sandboxes.has(id)
      ? { id, state: "ready", startedAt: Date.now() }
      : { id, state: "released" };
  }
}

const WORKSPACE = "/tmp/profile-switch";

async function seedSession(
  api: TestApi,
  opts: { id: string; userId: string; profile?: "headless" | "full" },
): Promise<void> {
  const now = Date.now();
  await api.providers.db.insert(agentSessions).values({
    id: opts.id,
    userId: opts.userId,
    orgId: "local-org",
    workspace: `${WORKSPACE}-${opts.id}`,
    status: "active",
    profile: opts.profile ?? "headless",
    ownerType: "user",
    ownerId: opts.userId,
    createdAt: now,
    updatedAt: now,
  });
}

async function warmSession(api: TestApi, id: string) {
  const session = await api.providers.engineHost.sessionFor(id, {
    userId: "local-user",
    orgId: "local-org",
    workspace: `${WORKSPACE}-${id}`,
    profile: "headless",
  });
  await session.attachment.ensureReady({ timeoutMs: 5_000 });
  return session;
}

async function admitQueued(api: TestApi, sessionId: string, threadId: string): Promise<void> {
  const now = Date.now();
  const { engineStore } = api.providers;
  await engineStore.saveThread(sessionId, {
    id: threadId,
    sessionId,
    key: `web:${threadId}`,
    status: "active",
    queueMode: "followup",
    createdAt: now,
    updatedAt: now,
  });
  const item: QueueItem = {
    id: "q-profile-1",
    threadId,
    content: "waiting in line",
    status: "queued",
    attemptCount: 0,
    maxAttempts: 10,
    timeoutAt: now + 3_600_000,
    createdAt: now,
    updatedAt: now,
  };
  await engineStore.admitSubmission(sessionId, threadId, item);
}

function patchProfile(api: TestApi, sessionId: string, profile: unknown) {
  return fetch(`${api.baseUrl}/api/sessions/${sessionId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ profile }),
  });
}

async function storedProfile(api: TestApi, sessionId: string): Promise<string | undefined> {
  const rows = await api.providers.db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId))
    .limit(1);
  return rows[0]?.profile;
}

describe("PATCH /api/sessions/:id — profile", () => {
  let api: TestApi | undefined;

  afterEach(async () => {
    await api?.cleanup();
    api = undefined;
  });

  it("raises a cold session to full without provisioning anything", async () => {
    const provider = new RecordingSandboxProvider();
    api = await bootTestApi({ sandboxProvider: provider });
    await seedSession(api, { id: "pf-cold", userId: "local-user" });

    const res = await patchProfile(api, "pf-cold", "full");
    expect(res.status).toBe(200);
    const body = (await res.json()) as PatchSessionResponse;
    expect(body.profile).toBe("full");
    expect(body.isWorkspaceRuntime).toBe(false);
    expect(await storedProfile(api, "pf-cold")).toBe("full");
    // Nothing was running, so nothing had to be replaced. The next
    // provision reads the row.
    expect(provider.createCalls).toEqual([]);
  });

  it("replaces a running sandbox so the new profile is live", async () => {
    const provider = new RecordingSandboxProvider();
    api = await bootTestApi({ sandboxProvider: provider });
    await seedSession(api, { id: "pf-live", userId: "local-user" });
    await warmSession(api, "pf-live");
    expect(provider.createCalls.map((c) => c.profile)).toEqual(["headless"]);

    const res = await patchProfile(api, "pf-live", "full");
    expect(res.status).toBe(200);

    // The second provision carries the new profile. Without the cache
    // eviction it would repeat "headless": the attachment reuses the
    // `SandboxCreateOpts` object captured at build time.
    expect(provider.createCalls).toHaveLength(2);
    expect(provider.createCalls[1]?.profile).toBe("full");
  });

  it("drops back to headless the same way", async () => {
    const provider = new RecordingSandboxProvider();
    api = await bootTestApi({ sandboxProvider: provider });
    await seedSession(api, { id: "pf-down", userId: "local-user", profile: "full" });
    await api.providers.engineHost
      .sessionFor("pf-down", {
        userId: "local-user",
        orgId: "local-org",
        workspace: `${WORKSPACE}-pf-down`,
        profile: "full",
      })
      .then((s) => s.attachment.ensureReady({ timeoutMs: 5_000 }));
    expect(provider.createCalls.map((c) => c.profile)).toEqual(["full"]);

    const res = await patchProfile(api, "pf-down", "headless");
    expect(res.status).toBe(200);
    expect(await storedProfile(api, "pf-down")).toBe("headless");
    expect(provider.createCalls[1]?.profile).toBe("headless");
  });

  it("treats an unchanged value as a no-op and never touches the sandbox", async () => {
    const provider = new RecordingSandboxProvider();
    api = await bootTestApi({ sandboxProvider: provider });
    await seedSession(api, { id: "pf-same", userId: "local-user" });
    await warmSession(api, "pf-same");

    const res = await patchProfile(api, "pf-same", "headless");
    expect(res.status).toBe(200);
    // One create, from the warm-up. A no-op patch must not cost a sandbox
    // restart just because a client re-sent the current value.
    expect(provider.createCalls).toHaveLength(1);
  });

  it("409s while a turn is unsettled, and writes nothing", async () => {
    const provider = new RecordingSandboxProvider();
    api = await bootTestApi({ sandboxProvider: provider });
    await seedSession(api, { id: "pf-busy", userId: "local-user" });
    await warmSession(api, "pf-busy");
    await admitQueued(api, "pf-busy", "th-pf-busy");

    const res = await patchProfile(api, "pf-busy", "full");
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/wait for it to finish/i);
    expect(await storedProfile(api, "pf-busy")).toBe("headless");
    expect(provider.createCalls).toHaveLength(1);
  });

  it("rejects a value that is not a profile", async () => {
    api = await bootTestApi();
    await seedSession(api, { id: "pf-bogus", userId: "local-user" });

    const res = await patchProfile(api, "pf-bogus", "gui");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("'headless' or 'full'");
    expect(await storedProfile(api, "pf-bogus")).toBe("headless");
  });

  it("404s for a session owned by a different user", async () => {
    api = await bootTestApi();
    await seedSession(api, { id: "pf-other", userId: "test-member" });

    const res = await patchProfile(api, "pf-other", "full");
    expect(res.status).toBe(404);
    expect(await storedProfile(api, "pf-other")).toBe("headless");
  });

  /**
   * The point of the whole item. An assistant session is built by
   * `buildAssistantSession`, which pinned `profile: "headless"` — so the
   * tab strip could never appear on the session most people use most.
   * The builder now reads the stored profile.
   *
   * It reads the ROW, not the caller's meta, because an assistant is woken
   * from several places (the web, a channel, a workflow) and only one of
   * them holds the row. Whichever wakes it first decides the cached build.
   */
  it("gives an assistant session the profile stored on its row", async () => {
    const provider = new RecordingSandboxProvider();
    api = await bootTestApi({ sandboxProvider: provider });

    const ensure = await fetch(`${api.baseUrl}/api/workspaces/user/runtime`, { method: "POST" });
    expect(ensure.status).toBe(200);
    const { sessionId } = (await ensure.json()) as { sessionId: string };
    expect(await storedProfile(api, sessionId)).toBe("headless");
    const detail = await fetch(`${api.baseUrl}/api/sessions/${encodeURIComponent(sessionId)}`);
    expect(((await detail.json()) as PatchSessionResponse).isWorkspaceRuntime).toBe(true);

    const res = await patchProfile(api, sessionId, "full");
    expect(res.status).toBe(200);
    expect(await storedProfile(api, sessionId)).toBe("full");

    // Wake it again through the ordinary route. The eviction above means
    // this is a fresh build, which is where the row is read.
    const woken = await api.providers.engineHost.sessionFor(sessionId, {
      userId: "local-user",
      orgId: "local-org",
      workspace: "unused-by-the-assistant-builder",
    });
    await woken.attachment.ensureReady({ timeoutMs: 5_000 });

    expect(provider.createCalls.map((c) => c.profile)).toEqual(["full"]);
  });

  it("reports the saved setting and the corrective action when the replacement fails", async () => {
    const provider = new RecordingSandboxProvider();
    let creates = 0;
    const failing = new Proxy(provider, {
      get(target, prop, receiver) {
        if (prop === "create") {
          return async (opts: SandboxCreateOpts) => {
            creates++;
            if (creates > 1) throw new Error("provider quota exhausted");
            return target.create(opts);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    api = await bootTestApi({ sandboxProvider: failing });
    await seedSession(api, { id: "pf-fail", userId: "local-user" });
    await warmSession(api, "pf-fail");

    const res = await patchProfile(api, "pf-fail", "full");
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/Replace sandbox/);
    // The setting is saved even though the sandbox did not restart. The
    // message says so, and names the action that finishes the job.
    expect(await storedProfile(api, "pf-fail")).toBe("full");
  });
});
