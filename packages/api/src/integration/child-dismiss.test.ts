/**
 * Integration test: dismiss a settled child from the orchestrator tree.
 *
 * Dismiss is app-side display state (`child_watches.dismissed_at`): a
 * dismissed watch leaves GET /api/sessions/:sessionId/children, but the child
 * session row and its history stay reachable from the Threads work view.
 * Only settled children can be dismissed. Ungated — no Anthropic key.
 */
import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { bootTestApi, type TestApi } from "./_setup.js";
import { agentSessions, childWatches } from "../schema/index.js";
import type {
  ChildWorkResponse,
  GetSessionResponse,
  WorkspaceRuntimeInfoResponse,
} from "../wire/types.js";

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

/** The caller's default assistant session id. An assistant addresses its
 * session by its own generated id, so no test can spell it as a literal —
 * ask the API for it, then seed the watch row against it. */
async function assistantSessionIdFor(target: TestApi): Promise<string> {
  const res = await fetch(`${target.baseUrl}/api/workspaces/user/runtime/info`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as WorkspaceRuntimeInfoResponse;
  return body.sessionId;
}

async function insertChild(opts: { id: string; settled: boolean }): Promise<void> {
  const { db } = api!.providers;
  const parentSessionId = await assistantSessionIdFor(api!);
  const now = Date.now();
  await db.insert(agentSessions).values({
    id: opts.id,
    userId: "local-user",
    orgId: "local-org",
    workspace: `/tmp/${opts.id}`,
    title: `Child ${opts.id}`,
    status: "active",
    ownerType: "user",
    ownerId: "local-user",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(childWatches).values({
    childSessionId: opts.id,
    queueItemId: `qi-${opts.id}`,
    parentSessionId,
    parentThreadId: "th-1",
    actorUserId: "local-user",
    orgId: "local-org",
    settled: opts.settled,
    createdAt: now,
  });
}

describe("POST /api/sessions/:sessionId/children/:childSessionId/dismiss", () => {
  it("hides a settled child from the list; the session row survives", async () => {
    api = await bootTestApi();
    await insertChild({ id: "child-a", settled: true });

    const before = (await (
      await fetch(`${api.baseUrl}/api/sessions/${encodeURIComponent(await assistantSessionIdFor(api))}/children`)
    ).json()) as ChildWorkResponse;
    expect(before.children.map((ch) => ch.sessionId)).toContain("child-a");

    const dismiss = await fetch(
      `${api.baseUrl}/api/sessions/${encodeURIComponent(await assistantSessionIdFor(api))}/children/child-a/dismiss`,
      { method: "POST" },
    );
    expect(dismiss.status).toBe(200);

    const after = (await (
      await fetch(`${api.baseUrl}/api/sessions/${encodeURIComponent(await assistantSessionIdFor(api))}/children`)
    ).json()) as ChildWorkResponse;
    expect(after.children.map((ch) => ch.sessionId)).not.toContain("child-a");

    // The watch row is marked dismissed, not deleted, and the child's
    // agent_sessions row is untouched.
    const watchRows = await api.providers.db
      .select()
      .from(childWatches)
      .where(eq(childWatches.childSessionId, "child-a"));
    expect(typeof watchRows[0]?.dismissedAt).toBe("number");
    const sessionRows = await api.providers.db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, "child-a"));
    expect(sessionRows[0]?.status).toBe("active");
    const detail = await (await fetch(`${api.baseUrl}/api/sessions/child-a`)).json() as GetSessionResponse;
    expect(detail.parentWork).toEqual({ sessionId: await assistantSessionIdFor(api), threadId: "th-1" });
    await api.providers.db.update(agentSessions).set({ ownerId: "test-member", userId: "test-member" }).where(eq(agentSessions.id, "child-a"));
    const moved = await fetch(`${api.baseUrl}/api/sessions/child-a`, { headers: { "x-valet-test-user-id": "test-member" } });
    expect(moved.status).toBe(200);
    expect(await moved.json()).not.toHaveProperty("parentWork");
  });

  it("a second dismiss is idempotent: the first dismissedAt timestamp survives", async () => {
    api = await bootTestApi();
    await insertChild({ id: "child-twice", settled: true });

    const first = await fetch(
      `${api.baseUrl}/api/sessions/${encodeURIComponent(await assistantSessionIdFor(api))}/children/child-twice/dismiss`,
      { method: "POST" },
    );
    expect(first.status).toBe(200);
    const rowsAfterFirst = await api.providers.db
      .select()
      .from(childWatches)
      .where(eq(childWatches.childSessionId, "child-twice"));
    const stamp = rowsAfterFirst[0]?.dismissedAt;
    expect(typeof stamp).toBe("number");

    await new Promise((r) => setTimeout(r, 10));
    const second = await fetch(
      `${api.baseUrl}/api/sessions/${encodeURIComponent(await assistantSessionIdFor(api))}/children/child-twice/dismiss`,
      { method: "POST" },
    );
    expect(second.status).toBe(200);
    const rowsAfterSecond = await api.providers.db
      .select()
      .from(childWatches)
      .where(eq(childWatches.childSessionId, "child-twice"));
    expect(rowsAfterSecond[0]?.dismissedAt).toBe(stamp);
  });

  it("refuses to dismiss a child that has not settled", async () => {
    api = await bootTestApi();
    await insertChild({ id: "child-b", settled: false });

    const dismiss = await fetch(
      `${api.baseUrl}/api/sessions/${encodeURIComponent(await assistantSessionIdFor(api))}/children/child-b/dismiss`,
      { method: "POST" },
    );
    expect(dismiss.status).toBe(409);

    const rows = await api.providers.db
      .select()
      .from(childWatches)
      .where(eq(childWatches.childSessionId, "child-b"));
    expect(rows[0]?.dismissedAt).toBeNull();
  });

  it("404s for a child that belongs to no watch of this orchestrator", async () => {
    api = await bootTestApi();
    const dismiss = await fetch(
      `${api.baseUrl}/api/sessions/${encodeURIComponent(await assistantSessionIdFor(api))}/children/nope/dismiss`,
      { method: "POST" },
    );
    expect(dismiss.status).toBe(404);
  });
});
