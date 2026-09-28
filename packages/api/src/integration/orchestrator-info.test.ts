/** Workspace runtime info, child presence, and retired identity-write coverage. */
import { afterEach, describe, expect, it } from "vitest";
import { agentSessions, assistants, childWatches } from "../schema/index.js";
import { writeFile } from "../services/memory.js";
import { addMember, createTeam } from "../services/teams.js";
import { defaultAssistantSessionFor } from "../test-helpers/assistant-session.js";
import type {
  GetOrchestratorChildrenResponse,
  WorkspaceRuntimeInfoResponse
} from "../wire/types.js";
import { bootTestApi, type TestApi } from "./_setup.js";

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

/** The caller's default assistant session id. An assistant addresses its
 * session by its own generated id, so no test can spell it as a literal any
 * more — every seeding helper below asks the API for it first. */
async function assistantSessionIdFor(target: TestApi): Promise<string> {
  const res = await fetch(`${target.baseUrl}/api/workspaces/user/runtime/info`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as WorkspaceRuntimeInfoResponse;
  return body.sessionId;
}

describe("GET /api/workspaces/user/runtime/info", () => {
  // The route resolves the caller's DEFAULT assistant, so it does create
  // that one row — the response carries its session id, and the id is no
  // longer derivable from the caller. It still creates nothing that runs:
  // no engine session and no `agent_sessions` row.
  it("reports name/personality null and presence idle before any ensure, creating only the assistant row", async () => {
    api = await bootTestApi();

    const res = await fetch(`${api.baseUrl}/api/workspaces/user/runtime/info`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as WorkspaceRuntimeInfoResponse;
    expect(body.sessionId).toMatch(/^assistant:asst_/);
    expect(body.presence).toBe("idle");
    expect(body.activeChildren).toBe(0);

    const assistantRows = await api.providers.db.select().from(assistants);
    expect(assistantRows).toHaveLength(1);
    expect(assistantRows[0]).toBeDefined();

    // Nothing that runs was created.
    expect(await api.providers.db.select().from(agentSessions)).toHaveLength(0);
    expect(api.providers.engineHost.isLive(body.sessionId)).toBe(false);
  });

  it("presence is 'working' when child_watches has an unsettled row for this assistant", async () => {
    api = await bootTestApi();
    const { db } = api.providers;

    const sessionId = await assistantSessionIdFor(api);
    const now = Date.now();
    await db
      .insert(childWatches)
      .values({
        childSessionId: "child-1",
        queueItemId: "qi-1",
        parentSessionId: sessionId,
        parentThreadId: "th-1",
        actorUserId: "local-user",
        orgId: "local-org",
        settled: false,
        createdAt: now,
      });

    const res = await fetch(`${api.baseUrl}/api/workspaces/user/runtime/info`);
    const body = (await res.json()) as WorkspaceRuntimeInfoResponse;
    expect(body.presence).toBe("working");
    expect(body.activeChildren).toBe(1);
  });

  it("returns only runtime state and exposes no identity customization", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/workspaces/user/runtime/info`);
    const body = (await res.json()) as WorkspaceRuntimeInfoResponse;
    expect(Object.keys(body).sort()).toEqual(["activeChildren", "presence", "sessionId"]);
    expect((await fetch(`${api.baseUrl}/api/orchestrator/info`)).status).toBe(404);
  });

  it("settled child_watches rows don't count toward activeChildren/presence", async () => {
    api = await bootTestApi();
    const { db } = api.providers;

    const sessionId = await assistantSessionIdFor(api);
    await db
      .insert(childWatches)
      .values({
        childSessionId: "child-1",
        queueItemId: "qi-1",
        parentSessionId: sessionId,
        parentThreadId: "th-1",
        actorUserId: "local-user",
        orgId: "local-org",
        settled: true,
        createdAt: Date.now(),
      });

    const res = await fetch(`${api.baseUrl}/api/workspaces/user/runtime/info`);
    const body = (await res.json()) as WorkspaceRuntimeInfoResponse;
    expect(body.presence).toBe("idle");
    expect(body.activeChildren).toBe(0);
  });
});

describe("GET /api/orchestrator/children", () => {
  it("lists child_watches rows joined to their agent_sessions title, newest first", async () => {
    api = await bootTestApi();
    const { db } = api.providers;

    const sessionId = await assistantSessionIdFor(api);
    const now = Date.now();
    await db
      .insert(agentSessions)
      .values([
        {
          id: "child-a",
          userId: "local-user",
          orgId: "local-org",
          workspace: "/tmp/child-a",
          title: "Fix the bug",
          status: "active",
          ownerType: "user",
          ownerId: "local-user",
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "child-b",
          userId: "local-user",
          orgId: "local-org",
          workspace: "/tmp/child-b",
          title: "Research thing",
          status: "active",
          ownerType: "user",
          ownerId: "local-user",
          createdAt: now,
          updatedAt: now,
        },
      ]);

    await db
      .insert(childWatches)
      .values([
        {
          childSessionId: "child-a",
          queueItemId: "qi-a",
          parentSessionId: sessionId,
          parentThreadId: "th-1",
          actorUserId: "local-user",
          orgId: "local-org",
          settled: true,
          createdAt: now,
        },
        {
          childSessionId: "child-b",
          queueItemId: "qi-b",
          parentSessionId: sessionId,
          parentThreadId: "th-1",
          actorUserId: "local-user",
          orgId: "local-org",
          settled: false,
          createdAt: now + 1,
        },
      ]);

    const res = await fetch(`${api.baseUrl}/api/orchestrator/children`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as GetOrchestratorChildrenResponse;

    expect(body.children).toHaveLength(2);
    // Newest first.
    expect(body.children[0]).toMatchObject({
      sessionId: "child-b",
      title: "Research thing",
      parentThreadId: "th-1",
      status: "running",
    });
    expect(body.children[1]).toMatchObject({
      sessionId: "child-a",
      title: "Fix the bug",
      parentThreadId: "th-1",
      status: "settled",
    });
  });

  it("only returns children watched by the caller's own assistant", async () => {
    api = await bootTestApi();
    const { db } = api.providers;

    const now = Date.now();
    await db
      .insert(agentSessions)
      .values({
        id: "other-child",
        userId: "local-user",
        orgId: "local-org",
        workspace: "/tmp/other-child",
        title: "Someone else's child",
        status: "active",
        ownerType: "user",
        ownerId: "local-user",
        createdAt: now,
        updatedAt: now,
      });
    await db
      .insert(childWatches)
      .values({
        childSessionId: "other-child",
        queueItemId: "qi-other",
        parentSessionId: "assistant:asst_someone_else",
        parentThreadId: "th-1",
        actorUserId: "someone-else",
        orgId: "local-org",
        settled: false,
        createdAt: now,
      });

    const res = await fetch(`${api.baseUrl}/api/orchestrator/children`);
    const body = (await res.json()) as GetOrchestratorChildrenResponse;
    expect(body.children).toHaveLength(0);
  });
});
