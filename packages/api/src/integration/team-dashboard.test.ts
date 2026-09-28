import { createAssistant, toAssistantSummary } from "../assistants/service.js";
/**
 * The three reads behind the team dashboard
 * (`docs/specs/2026-08-27-team-dashboard-design.md`):
 *
 *   - GET /api/teams/:id/children       — assistant runs across every team
 *     assistant, newest first, attributed to the spawning assistant.
 *   - GET /api/usage/breakdown?scope=team:<id> — team-owned spend,
 *     member-gated.
 *   - GET /api/artifacts?ownerType=team&ownerId=<id> — team artifacts,
 *     member-gated.
 *
 * `local-user` is the member; `test-member` (the `x-valet-test-user-id`
 * stub header) stays OFF the team so every gate has a non-member to refuse.
 */
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { agentSessions, artifacts, childWatches, teamMembers, teams } from "../schema/index.js";
import type {
  CreateAssistantResponse,
  GetTeamChildrenResponse,
  ListArtifactsResponse,
  UsageBreakdownResponse,
} from "../wire/types.js";
import { bootTestApi, type TestApi } from "./_setup.js";

let api: TestApi | undefined;
afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

const JSON_HEADERS = { "Content-Type": "application/json" };
const NON_MEMBER_HEADERS = { "x-valet-test-user-id": "test-member" };

async function seedTeam(target: TestApi): Promise<void> {
  await target.providers.db
    .insert(teams)
    .values({ id: "team_1", orgId: "local-org", name: "Security", createdAt: Date.now() });
  await target.providers.db
    .insert(teamMembers)
    .values({ teamId: "team_1", userId: "local-user", role: "admin" });
}

async function createTeamAssistant(target: TestApi, name: string): Promise<CreateAssistantResponse> {
  // Historical multiple profiles remain readable after the public creation path is retired.
  return toAssistantSummary(await createAssistant(target.providers.db, "local-org", { type: "team", id: "team_1" }, name));
}

async function seedChild(
  target: TestApi,
  opts: { childId: string; parentSessionId: string; title: string; settled: boolean; createdAt: number },
): Promise<void> {
  const { db } = target.providers;
  await db.insert(agentSessions).values({
    id: opts.childId,
    userId: "local-user",
    orgId: "local-org",
    workspace: `/tmp/${opts.childId}`,
    title: opts.title,
    status: "active",
    ownerType: "team",
    ownerId: "team_1",
    createdAt: opts.createdAt,
    updatedAt: opts.createdAt,
  });
  await db.insert(childWatches).values({
    childSessionId: opts.childId,
    queueItemId: `qi-${opts.childId}`,
    parentSessionId: opts.parentSessionId,
    parentThreadId: "th-1",
    actorUserId: "local-user",
    orgId: "local-org",
    settled: opts.settled,
    createdAt: opts.createdAt,
  });
}

describe("GET /api/teams/:id/children", () => {
  it("lists runs across every team assistant, newest first, attributed to the spawning assistant", async () => {
    api = await bootTestApi();
    await seedTeam(api);
    const sentinel = await createTeamAssistant(api, "Sentinel");
    const triage = await createTeamAssistant(api, "Triage");

    const now = Date.now();
    await seedChild(api, { childId: "child-a", parentSessionId: sentinel.sessionId, title: "Audit PR", settled: true, createdAt: now });
    await seedChild(api, { childId: "child-b", parentSessionId: triage.sessionId, title: "Rotate creds", settled: false, createdAt: now + 1 });

    const res = await fetch(`${api.baseUrl}/api/teams/team_1/children`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as GetTeamChildrenResponse;

    expect(body.children).toHaveLength(2);
    expect(body.children[0]).toMatchObject({
      sessionId: "child-b",
      title: "Rotate creds",
      status: "running",
      assistantId: triage.id,
      assistantName: "Triage",
    });
    expect(body.children[1]).toMatchObject({
      sessionId: "child-a",
      status: "settled",
      assistantId: sentinel.id,
      assistantName: "Sentinel",
    });
  });

  it("keeps a running child visible past the 20-newest window", async () => {
    api = await bootTestApi();
    await seedTeam(api);
    const sentinel = await createTeamAssistant(api, "Sentinel");

    const base = Date.now() - 60_000;
    // The long-running child starts FIRST...
    await seedChild(api, { childId: "child-old-running", parentSessionId: sentinel.sessionId, title: "Nightly audit", settled: false, createdAt: base });
    // ...then 20 quick settled runs push it out of the newest-20 window.
    for (let i = 0; i < 20; i++) {
      await seedChild(api, { childId: `child-q${i}`, parentSessionId: sentinel.sessionId, title: `Quick ${i}`, settled: true, createdAt: base + 1000 + i });
    }

    const res = await fetch(`${api.baseUrl}/api/teams/team_1/children`);
    const body = (await res.json()) as GetTeamChildrenResponse;
    const running = body.children.filter((c) => c.status === "running");
    expect(running.map((c) => c.sessionId)).toContain("child-old-running");
  });

  it("404s a non-member, and answers an assistant-less team with an empty list", async () => {
    api = await bootTestApi();
    await seedTeam(api);

    const nonMember = await fetch(`${api.baseUrl}/api/teams/team_1/children`, {
      headers: NON_MEMBER_HEADERS,
    });
    expect(nonMember.status).toBe(404);

    const empty = await fetch(`${api.baseUrl}/api/teams/team_1/children`);
    expect(empty.status).toBe(200);
    const body = (await empty.json()) as GetTeamChildrenResponse;
    expect(body.children).toEqual([]);
  });
});

describe("GET /api/usage/breakdown?scope=team&teamId=", () => {
  const USAGE = JSON.stringify({ input: 100, output: 20, cacheRead: 0, cacheWrite: 0, total: 120 });
  const COST = JSON.stringify({ input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 });

  async function seedEntry(target: TestApi, id: string, sessionId: string, now: number): Promise<void> {
    await target.providers.db.execute(sql`
      INSERT INTO engine_entries (id, session_id, thread_id, entry_type, role, model, usage, cost, created_at)
      VALUES (${id}, ${sessionId}, 'th', 'message', 'assistant', 'claude', ${USAGE}::text, ${COST}::text, ${now})
    `);
  }

  it("covers team-owned spend only; admins get byUser, members do not", async () => {
    api = await bootTestApi();
    await seedTeam(api);
    const now = Date.now();
    const { db } = api.providers;

    await db.insert(agentSessions).values([
      { id: "team-sess", userId: "local-user", orgId: "local-org", workspace: "/w", status: "active", ownerType: "team", ownerId: "team_1", createdAt: now, updatedAt: now, title: "Team work" },
      { id: "personal-sess", userId: "local-user", orgId: "local-org", workspace: "/w", status: "active", ownerType: "user", ownerId: "local-user", createdAt: now, updatedAt: now, title: "Mine" },
    ]);
    await seedEntry(api, "e-team", "team-sess", now);
    await seedEntry(api, "e-mine", "personal-sess", now);

    const res = await fetch(`${api.baseUrl}/api/usage/breakdown?window=24h&scope=team&teamId=team_1`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as UsageBreakdownResponse;
    expect(body.scope).toBe("team");
    // Only the team session's one entry — the personal entry stays out.
    expect(body.totalTurns).toBe(1);
    expect(body.totalTokens).toBe(120);
    // local-user administers team_1, so the per-member rows are present
    // and attribute the team spend to its one spender.
    expect(body.byUser).toBeDefined();
    expect(body.byUser?.some((m) => m.userId === "local-user" && m.totalTokens === 120)).toBe(true);

    // A PLAIN member reads the aggregate, never colleagues' individual spend.
    await db.insert(teamMembers).values({ teamId: "team_1", userId: "test-member", role: "member" });
    const asMember = await fetch(`${api.baseUrl}/api/usage/breakdown?window=24h&scope=team&teamId=team_1`, {
      headers: NON_MEMBER_HEADERS,
    });
    expect(asMember.status).toBe(200);
    const memberBody = (await asMember.json()) as UsageBreakdownResponse;
    expect(memberBody.totalTokens).toBe(120);
    expect(memberBody.byUser).toBeUndefined();
  });

  it("answers a caller with no membership 404 (existence-hiding)", async () => {
    api = await bootTestApi();
    await api.providers.db
      .insert(teams)
      .values({ id: "team_1", orgId: "local-org", name: "Security", createdAt: Date.now() });
    const res = await fetch(`${api.baseUrl}/api/usage/breakdown?window=24h&scope=team&teamId=team_1`, {
      headers: NON_MEMBER_HEADERS,
    });
    expect(res.status).toBe(404);
  });

  it("the CSV export blanks per-member attribution for a plain member, keeps it for an admin", async () => {
    api = await bootTestApi();
    await seedTeam(api);
    const now = Date.now();
    const { db } = api.providers;
    await db.insert(agentSessions).values({ id: "team-sess", userId: "local-user", orgId: "local-org", workspace: "/w", status: "active", ownerType: "team", ownerId: "team_1", createdAt: now, updatedAt: now, title: "Team work" });
    await seedEntry(api, "e-team", "team-sess", now);
    await db.insert(teamMembers).values({ teamId: "team_1", userId: "test-member", role: "member" });

    // Admin (local-user): the user_id column carries attribution.
    const adminCsv = await (await fetch(`${api.baseUrl}/api/usage/export.csv?window=24h&scope=team&teamId=team_1&granularity=turn`)).text();
    expect(adminCsv).toContain("local-user");

    // Plain member: same rows, attribution blank — the breakdown hides
    // byUser from members and the export must not hand it back.
    const memberCsv = await (
      await fetch(`${api.baseUrl}/api/usage/export.csv?window=24h&scope=team&teamId=team_1&granularity=turn`, { headers: NON_MEMBER_HEADERS })
    ).text();
    expect(memberCsv).toContain("team-sess");
    expect(memberCsv).not.toContain("local-user");
  });
});

describe("GET /api/artifacts?ownerType=team&ownerId=<id>", () => {
  async function seedArtifact(
    target: TestApi,
    opts: { id: string; ownerType: string; ownerId: string; title: string },
  ): Promise<void> {
    const now = Date.now();
    await target.providers.db.insert(artifacts).values({
      id: opts.id,
      token: `tok-${opts.id}`,
      ownerType: opts.ownerType,
      ownerId: opts.ownerId,
      orgId: "local-org",
      actorUserId: "local-user",
      sourceMemoryPath: `notes/${opts.id}.md`,
      title: opts.title,
      content: "# hi",
      createdAt: now,
      updatedAt: now,
    });
  }

  it("lists the team's artifacts for a member; 404s a non-member; 400s a malformed filter", async () => {
    api = await bootTestApi();
    await seedTeam(api);
    await seedArtifact(api, { id: "art-team", ownerType: "team", ownerId: "team_1", title: "Postmortem" });
    await seedArtifact(api, { id: "art-mine", ownerType: "user", ownerId: "local-user", title: "Scratch" });

    const res = await fetch(`${api.baseUrl}/api/artifacts?ownerType=team&ownerId=team_1`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListArtifactsResponse;
    expect(body.artifacts.map((a) => a.id)).toEqual(["art-team"]);

    const nonMember = await fetch(`${api.baseUrl}/api/artifacts?ownerType=team&ownerId=team_1`, {
      headers: NON_MEMBER_HEADERS,
    });
    expect(nonMember.status).toBe(404);

    const malformed = await fetch(`${api.baseUrl}/api/artifacts?ownerType=user`);
    expect(malformed.status).toBe(400);
  });
});
