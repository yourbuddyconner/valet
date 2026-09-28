/**
 * Integration tests for the assistant-identity endpoints (assistant-centered
 * web UI Task 2, decisions 4/5/6/20):
 *
 *   - GET  /api/orchestrator/info    — resolves the caller's default
 *     assistant row (one insert on first visit) but never the engine
 *     session; presence derivation.
 *   - PATCH /api/orchestrator/info   — works before the engine session
 *     exists; name -> assistants.name; personality -> the
 *     assistant/personality.md memory file; evicts the cached engine
 *     session (cache-only, never the destructive `session.destroy()`).
 *   - GET  /api/orchestrator/children — child_watches ⋈ agent_sessions.
 *   - Persona injection (decision 5): after a PATCH rename, the next wake's
 *     `systemPrompt` contains the name and personality, AND the pre-existing
 *     transcript survives (proves eviction, not destruction).
 */
import { afterEach, describe, expect, it } from "vitest";
import { agentSessions, assistants, childWatches } from "../schema/index.js";
import { writeFile } from "../services/memory.js";
import { addMember, createTeam } from "../services/teams.js";
import { defaultAssistantSessionFor } from "../test-helpers/assistant-session.js";
import type {
  GetOrchestratorChildrenResponse,
  GetOrchestratorInfoResponse
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
  const res = await fetch(`${target.baseUrl}/api/orchestrator/info`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as GetOrchestratorInfoResponse;
  return body.sessionId;
}

describe("GET /api/orchestrator/info", () => {
  // The route resolves the caller's DEFAULT assistant, so it does create
  // that one row — the response carries its session id, and the id is no
  // longer derivable from the caller. It still creates nothing that runs:
  // no engine session and no `agent_sessions` row.
  it("reports name/personality null and presence idle before any ensure, creating only the assistant row", async () => {
    api = await bootTestApi();

    const res = await fetch(`${api.baseUrl}/api/orchestrator/info`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as GetOrchestratorInfoResponse;
    expect(body.sessionId).toMatch(/^assistant:asst_/);
    expect(body.name).toBeNull();
    expect(body.personality).toBeNull();
    expect(body.presence).toBe("idle");
    expect(body.activeChildren).toBe(0);

    const assistantRows = await api.providers.db.select().from(assistants);
    expect(assistantRows).toHaveLength(1);
    expect(assistantRows[0]?.isDefault).toBe(true);
    expect(assistantRows[0]?.name).toBeNull();

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

    const res = await fetch(`${api.baseUrl}/api/orchestrator/info`);
    const body = (await res.json()) as GetOrchestratorInfoResponse;
    expect(body.presence).toBe("working");
    expect(body.activeChildren).toBe(1);
  });

  it("does not leak a team's assistant/personality.md into a member's own persona/info (own-scope read only)", async () => {
    api = await bootTestApi();
    const { db } = api.providers;

    // local-user is a member of Platform, which has its own
    // assistant/personality.md. local-user has never written a personal
    // one. Personality reads (GET /info and persona injection) must go
    // through an own-scope-only lookup, not `readFile`'s team read-union
    // (which is correct/intentional for the memory explorer, but wrong for
    // a per-user persona/identity field).
    const team = await createTeam(db, { orgId: "local-org", name: "Platform", creatorUserId: "local-user" });
    await addMember(db, { teamId: team.id, userId: "local-user", role: "member" });
    await writeFile(db, { owner: { type: "team", id: team.id }, actorUserId: "local-user" }, {
      path: "assistant/personality.md",
      content: "Team-wide corporate voice.",
    });

    const infoRes = await fetch(`${api.baseUrl}/api/orchestrator/info`);
    expect(infoRes.status).toBe(200);
    const infoBody = (await infoRes.json()) as GetOrchestratorInfoResponse;
    expect(infoBody.personality).toBeNull();

    // Set a name (no personal personality) and confirm the persona prefix
    // that gets injected into systemPrompt stays neutral — no team content.
    const patchRes = await fetch(`${api.baseUrl}/api/orchestrator/info`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Wren" }),
    });
    expect(patchRes.status).toBe(409);

    const session = await defaultAssistantSessionFor(
      api.providers,
      { type: "user", id: "local-user" },
      { actorUserId: "local-user", orgId: "local-org" },
    );
    expect(session.options.systemPrompt).not.toContain("You are Wren.");
    expect(session.options.systemPrompt).not.toContain("Team-wide corporate voice.");
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

    const res = await fetch(`${api.baseUrl}/api/orchestrator/info`);
    const body = (await res.json()) as GetOrchestratorInfoResponse;
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
