import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArchivedAssistantError, resolveDefaultAssistant, retireAssistant, toAssistantSummary } from "../assistants/service.js";
import { seedWorkspaceAssistant } from "../test-helpers/assistant-fixture.js";
import { assistants, teamMembers, teams } from "../schema/index.js";
import type {
  AssistantSummary,
  ListAssistantsResponse
} from "../wire/types.js";
import { bootTestApi, type TestApi } from "./_setup.js";

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
  // This file is in the "integration" vitest project, which — unlike
  // "unit" — has no `vitest.setup.ts` scrub between tests (integration
  // suites need the real ambient ANTHROPIC_API_KEY). A `vi.stubEnv` in one
  // test would otherwise leak into the next.
  vi.unstubAllEnvs();
});

const MEMBER_HEADERS = { "x-valet-test-user-id": "test-member" };
const JSON_HEADERS = { "Content-Type": "application/json" };

/** Configure the workspace singleton through an internal test fixture. */
async function create(target: TestApi, body: { name?: string; owner?: { type: "user" | "team"; id: string } }, headers: Record<string, string> = {}): Promise<AssistantSummary> {
  return toAssistantSummary(await seedWorkspaceAssistant(target.providers.db, "local-org",
    body.owner ?? { type: "user", id: headers["x-valet-test-user-id"] ?? "local-user" }, body.name ?? null));
}

async function list(target: TestApi, query = "", headers: Record<string, string> = {}): Promise<AssistantSummary[]> {
  const res = await fetch(`${target.baseUrl}/api/assistants${query}`, { headers });
  expect(res.status).toBe(200);
  return ((await res.json()) as ListAssistantsResponse).assistants;
}

/** Creates `team_1` in the local org with `userId` on it in `role`. */
async function seedTeam(target: TestApi, userId: string, role: "admin" | "member"): Promise<void> {
  await target.providers.db
    .insert(teams)
    .values({ id: "team_1", orgId: "local-org", name: "Platform", createdAt: Date.now() });
  await target.providers.db.insert(teamMembers).values({ teamId: "team_1", userId, role });
}

describe("GET /api/assistants", () => {
  it("lists one singleton for the caller", async () => {
    api = await bootTestApi();
    const first = await create(api, { name: "Research" });
    const second = await create(api, { name: "Triage" });

    const rows = await list(api);
    expect(second.id).toBe(first.id);
    expect(rows.map((r) => r.id)).toEqual([first.id]);
  });

  it("without a filter it also lists the assistants of every team the caller is on", async () => {
    api = await bootTestApi();
    await seedTeam(api, "test-member", "member");
    const mine = await create(api, { name: "Mine" }, MEMBER_HEADERS);
    const teamOwned = await create(api, { name: "Platform bot", owner: { type: "team", id: "team_1" } });

    const rows = await list(api, "", MEMBER_HEADERS);
    expect(rows.map((r) => r.id).sort()).toEqual([mine.id, teamOwned.id].sort());
  });

  it("filters by owner", async () => {
    api = await bootTestApi();
    await seedTeam(api, "local-user", "admin");
    await create(api, { name: "Mine" });
    const teamOwned = await create(api, { name: "Platform bot", owner: { type: "team", id: "team_1" } });

    const rows = await list(api, "?ownerType=team&ownerId=team_1");
    expect(rows.map((r) => r.id)).toEqual([teamOwned.id]);
  });

  it("a non-member cannot list a team's assistants", async () => {
    api = await bootTestApi();
    await seedTeam(api, "local-user", "admin");

    const res = await fetch(`${api.baseUrl}/api/assistants?ownerType=team&ownerId=team_1`, {
      headers: MEMBER_HEADERS,
    });
    expect(res.status).toBe(404);
  });

  it("rejects half an owner filter and says how to fix it", async () => {
    api = await bootTestApi();

    const res = await fetch(`${api.baseUrl}/api/assistants?ownerType=team`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("ownerId");
  });

  it("omits archived assistants", async () => {
    api = await bootTestApi();
    const archived = await create(api, { name: "Drop" });

    await retireAssistant(api.providers.db, archived.id);

    const rows = await list(api);
    expect(rows.map((r) => r.id)).not.toContain(archived.id);
  });
});

describe("removed assistant profile endpoints", () => {
  it("offers no profile writes or assistant-addressed open route", async () => {
    api = await bootTestApi();
    const row = await resolveDefaultAssistant(api.providers.db, "local-org", { type: "user", id: "local-user" });
    for (const [method, path] of [["POST", "/api/assistants"], ["PATCH", `/api/assistants/${row.id}`], ["DELETE", `/api/assistants/${row.id}`], ["POST", `/api/assistants/${row.id}/session`]]) {
      const response = await fetch(`${api.baseUrl}${path}`, { method, headers: JSON_HEADERS, body: JSON.stringify({ name: "New profile" }) });
      expect(response.status).toBe(404);
    }
    expect(await api.providers.db.select().from(assistants)).toHaveLength(1);
  });
});

describe("workspace session initialization", () => {
  it("opens the singleton session idempotently and makes its session readable", async () => {
    api = await bootTestApi();
    const responses = await Promise.all(Array.from({ length: 3 }, () => fetch(`${api!.baseUrl}/api/orchestrator`, { method: "POST" })));
    const bodies: Array<{ sessionId: string }> = [];
    for (const response of responses) {
      expect(response.status).toBe(200);
      bodies.push(await response.json() as { sessionId: string });
    }
    expect(new Set(bodies.map(body => body.sessionId)).size).toBe(1);
    expect(await api.providers.db.select().from(assistants)).toHaveLength(1);
    expect((await fetch(`${api.baseUrl}/api/sessions/${encodeURIComponent(bodies[0]!.sessionId)}`)).status).toBe(200);
    expect((await fetch(`${api.baseUrl}/api/sessions/${encodeURIComponent(bodies[0]!.sessionId)}`, { headers: MEMBER_HEADERS })).status).toBe(404);
  });
});

describe("retired singleton sessions", () => {
  it("a retired assistant's session refuses to wake", async () => {
    api = await bootTestApi();
    const { db, engineHost } = api.providers;
    const created = await create(api, { name: "Research" });
    await retireAssistant(db, created.id);

    await expect(
      engineHost.assistantSessionFor(created.id, {
        actorUserId: "local-user",
        orgId: "local-org",
      }),
    ).rejects.toBeInstanceOf(ArchivedAssistantError);
  });

  // Migrated rows keep legacy `orchestrator:*` session ids that sessionFor's
  // prefix parse cannot recognize — the column-lookup fallback must route
  // them to the assistant build, where the archived refusal applies.
  it("a retired migrated assistant refuses to wake through the generic sessionFor path", async () => {
    api = await bootTestApi();
    const { db, engineHost } = api.providers;
    await db.insert(assistants).values({
      id: "asst_legacy_wake",
      orgId: "local-org",
      ownerType: "user",
      ownerId: "local-user",
      name: null,
      personality: null,
      behavior: null,
      sessionId: "orchestrator:user:local-user",
      createdAt: Date.now(),
      archivedAt: null,
    });
    await retireAssistant(db, "asst_legacy_wake");

    await expect(
      engineHost.sessionFor("orchestrator:user:local-user", {
        userId: "local-user",
        orgId: "local-org",
        workspace: "/tmp/legacy-wake",
      }),
    ).rejects.toBeInstanceOf(ArchivedAssistantError);
  });
});
