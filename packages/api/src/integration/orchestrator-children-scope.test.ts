/**
 * Integration test: `GET /api/orchestrator/children?sessionId=` scopes the
 * children list to ONE assistant session, so a team assistant's runs nest
 * under it in the chat thread tree instead of borrowing the caller's personal
 * children (or vanishing). Authority is the assistant's owner, checked without
 * materializing the assistant's engine session. Ungated — no Anthropic key.
 */
import { describe, it, expect, afterEach } from "vitest";
import { bootTestApi, type TestApi } from "./_setup.js";
import { agentSessions, childWatches } from "../schema/index.js";
import type {
  GetOrchestratorChildrenResponse,
  WorkspaceRuntimeInfoResponse,
} from "../wire/types.js";

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

/** The caller's default assistant session id. An assistant addresses its
 * session by its own generated id, so no test can spell it as a literal. */
async function assistantSessionIdFor(target: TestApi): Promise<string> {
  const res = await fetch(`${target.baseUrl}/api/workspaces/user/runtime/info`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as WorkspaceRuntimeInfoResponse;
  return body.sessionId;
}

async function seedChild(parentSessionId: string, id: string): Promise<void> {
  const { db } = api!.providers;
  const now = Date.now();
  await db.insert(agentSessions).values({
    id,
    userId: "local-user",
    orgId: "local-org",
    workspace: `/tmp/${id}`,
    title: `Child ${id}`,
    status: "active",
    ownerType: "user",
    ownerId: "local-user",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(childWatches).values({
    childSessionId: id,
    queueItemId: `qi-${id}`,
    parentSessionId,
    parentThreadId: "th-1",
    actorUserId: "local-user",
    orgId: "local-org",
    settled: true,
    createdAt: now,
  });
}

describe("GET /api/orchestrator/children?sessionId=", () => {
  it("lists the named assistant's children, scoped to that parent", async () => {
    api = await bootTestApi();
    const parent = await assistantSessionIdFor(api);
    await seedChild(parent, "child-scoped");

    const res = await fetch(
      `${api.baseUrl}/api/orchestrator/children?sessionId=${encodeURIComponent(parent)}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as GetOrchestratorChildrenResponse;
    expect(body.children.map((ch) => ch.sessionId)).toContain("child-scoped");
  });

  it("404s for a session the caller cannot view", async () => {
    api = await bootTestApi();
    const res = await fetch(
      `${api.baseUrl}/api/orchestrator/children?sessionId=assistant:asst_not_mine`,
    );
    // Existence-hiding: an unknown or unreachable parent is "not found", not
    // an empty list — an empty list would confirm the id is real.
    expect(res.status).toBe(404);
  });

  it("without the param still reads the caller's own default assistant", async () => {
    api = await bootTestApi();
    const parent = await assistantSessionIdFor(api);
    await seedChild(parent, "child-default");

    const res = await fetch(`${api.baseUrl}/api/orchestrator/children`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as GetOrchestratorChildrenResponse;
    expect(body.children.map((ch) => ch.sessionId)).toContain("child-default");
  });
});
