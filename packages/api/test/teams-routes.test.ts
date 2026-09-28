/**
 * Teams routes — GET/POST /api/teams, DELETE /api/teams/:id,
 * POST/PATCH/DELETE /api/teams/:id/members[/:userId].
 *
 * Drives a real `createApp` (via bootTestApi) over HTTP, exercising the
 * route layer's org-membership gating and error-code mapping on top of the
 * already-unit-tested service.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { bootTestApi, type TestApi } from "../src/integration/_setup.js";
import {
  agentSessions,
  assistants,
  orgMembers,
  teamJoinEligibilities,
  teamMembers,
  teams,
  users,
  workflowDefinitions,
  workflowRuns,
} from "../src/schema/index.js";
import { AUTH_SESSION_LIFETIME_SECONDS } from "../src/auth/config.js";
import type {
  CreateTeamResponse,
  ListSuggestedTeamsResponse,
  ListTeamMembersResponse,
  ListTeamsResponse,
} from "../src/wire/types.js";

const HEADERS = { "Content-Type": "application/json" };
const MEMBER_HEADERS = { "Content-Type": "application/json", "x-valet-test-user-id": "test-member" };
const ADMIN_HEADERS = { "Content-Type": "application/json", "x-valet-test-user-id": "test-admin" };

let api: TestApi;

afterEach(async () => {
  await api?.cleanup();
});

async function createTeam(baseUrl: string, name: string, headers = HEADERS) {
  const res = await fetch(`${baseUrl}/api/teams`, { method: "POST", headers, body: JSON.stringify({ name }) });
  return res;
}

describe("teams routes", () => {
  it("creates a team with the caller auto-admitted, then lists it", async () => {
    api = await bootTestApi();
    const { baseUrl } = api;

    const createRes = await createTeam(baseUrl, "Platform");
    expect(createRes.status).toBe(201);
    const { team, defaultAssistant } = (await createRes.json()) as CreateTeamResponse;
    expect(team.name).toBe("Platform");
    expect(defaultAssistant.sessionId).toBeTruthy();
    expect(defaultAssistant.owner).toEqual({ type: "team", id: team.id });
    // The response carries the row the create transaction seeded, not a
    // second one minted by a re-read.
    const seeded = await api.providers.db
      .select()
      .from(assistants)
      .where(and(eq(assistants.ownerType, "team"), eq(assistants.ownerId, team.id)));
    expect(seeded.map((r) => r.id)).toEqual([defaultAssistant.id]);

    const listRes = await fetch(`${baseUrl}/api/teams`, { headers: HEADERS });
    expect(listRes.status).toBe(200);
    const { teams } = (await listRes.json()) as ListTeamsResponse;
    expect(teams.map((t) => t.id)).toContain(team.id);
  });

  it("rejects a duplicate team name in the same org with 409", async () => {
    api = await bootTestApi();
    const { baseUrl } = api;

    expect((await createTeam(baseUrl, "Platform")).status).toBe(201);
    const dupe = await createTeam(baseUrl, "Platform");
    expect(dupe.status).toBe(409);
    const body = (await dupe.json()) as { code?: string };
    expect(body.code).toBe("team_name_conflict");
  });

  it("adds a member and lets that member see the team", async () => {
    api = await bootTestApi();
    const { baseUrl } = api;

    const createRes = await createTeam(baseUrl, "Platform");
    const { team } = (await createRes.json()) as CreateTeamResponse;

    const addRes = await fetch(`${baseUrl}/api/teams/${team.id}/members`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ userId: "test-member", role: "member" }),
    });
    expect(addRes.status).toBe(201);

    const listRes = await fetch(`${baseUrl}/api/teams`, { headers: MEMBER_HEADERS });
    const { teams } = (await listRes.json()) as ListTeamsResponse;
    expect(teams.map((t) => t.id)).toContain(team.id);
  });

  it("rejects demoting/removing the last admin with 409", async () => {
    api = await bootTestApi();
    const { baseUrl } = api;

    const createRes = await createTeam(baseUrl, "Platform");
    const { team } = (await createRes.json()) as CreateTeamResponse;

    const demote = await fetch(`${baseUrl}/api/teams/${team.id}/members/local-user`, {
      method: "PATCH",
      headers: HEADERS,
      body: JSON.stringify({ role: "member" }),
    });
    expect(demote.status).toBe(409);
    const demoteBody = (await demote.json()) as { code?: string };
    expect(demoteBody.code).toBe("last_admin");

    const remove = await fetch(`${baseUrl}/api/teams/${team.id}/members/local-user`, {
      method: "DELETE",
      headers: HEADERS,
    });
    expect(remove.status).toBe(409);
  });

  it("deletes a team", async () => {
    api = await bootTestApi();
    const { baseUrl } = api;

    const createRes = await createTeam(baseUrl, "Platform");
    const { team } = (await createRes.json()) as CreateTeamResponse;

    const delRes = await fetch(`${baseUrl}/api/teams/${team.id}`, { method: "DELETE", headers: HEADERS });
    expect(delRes.status).toBe(200);

    const listRes = await fetch(`${baseUrl}/api/teams`, { headers: HEADERS });
    const { teams } = (await listRes.json()) as ListTeamsResponse;
    expect(teams.map((t) => t.id)).not.toContain(team.id);
  });

  // TKAI-296: with the membership rows gone, nobody can view or administer
  // the team's assistant, so a surviving row and session are unreachable
  // orphans. Team delete retires the assistant and soft-deletes its session.
  //
  // Team creation owns the singleton that team deletion must retire.
  it("deleting a team retires its assistant and deletes the assistant's session", async () => {
    api = await bootTestApi();
    const { baseUrl, providers } = api;
    const { db } = providers;

    const createRes = await createTeam(baseUrl, "Platform");
    const { team } = (await createRes.json()) as CreateTeamResponse;

    const [singleton] = await db.select().from(assistants).where(and(eq(assistants.ownerType, "team"), eq(assistants.ownerId, team.id)));
    if (!singleton) throw new Error("Team singleton missing");
    await db.insert(agentSessions).values({
      id: singleton.sessionId,
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp/team-del",
      status: "active",
      ownerType: "team",
      ownerId: team.id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const delRes = await fetch(`${baseUrl}/api/teams/${team.id}`, {
      method: "DELETE",
      headers: HEADERS,
    });
    expect(delRes.status).toBe(200);

    const row = (
      await db.select().from(assistants).where(eq(assistants.id, singleton.id))
    )[0];
    expect(row?.archivedAt).not.toBeNull();
    const sess = (
      await db
        .select()
        .from(agentSessions)
        .where(eq(agentSessions.id, singleton.sessionId))
    )[0];
    expect(sess?.status).toBe("deleted");
    // The one team-owned row is retired.
    const teamOwned = await db
      .select()
      .from(assistants)
      .where(and(eq(assistants.ownerType, "team"), eq(assistants.ownerId, team.id)));
    expect(teamOwned.every((r) => r.archivedAt !== null)).toBe(true);
  });

  // The engine teardown runs AFTER the delete commits. A destroy before the
  // commit would tear down a conversation on a request that can still
  // refuse and change nothing.
  it("destroys the assistant's engine session only after the team rows are gone", async () => {
    api = await bootTestApi();
    const { baseUrl, providers } = api;
    const { db, engineHost } = providers;

    const createRes = await createTeam(baseUrl, "Platform");
    const { team } = (await createRes.json()) as CreateTeamResponse;

    const [singleton] = await db.select().from(assistants).where(and(eq(assistants.ownerType, "team"), eq(assistants.ownerId, team.id)));
    if (!singleton) throw new Error("Team singleton missing");
    await db.insert(agentSessions).values({
      id: singleton.sessionId,
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp/team-order",
      status: "active",
      ownerType: "team",
      ownerId: team.id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const teamRowsAtDestroy: number[] = [];
    const destroy = vi.spyOn(engineHost, "destroy").mockImplementation(async () => {
      const rows = await db.select().from(teams).where(eq(teams.id, team.id));
      teamRowsAtDestroy.push(rows.length);
    });

    const delRes = await fetch(`${baseUrl}/api/teams/${team.id}`, {
      method: "DELETE",
      headers: HEADERS,
    });
    expect(delRes.status).toBe(200);

    expect(destroy).toHaveBeenCalledWith(singleton.sessionId);
    // Teardown runs after the team row is gone.
    expect(teamRowsAtDestroy).toHaveLength(destroy.mock.calls.length);
    expect(teamRowsAtDestroy.every((n) => n === 0)).toBe(true);
    destroy.mockRestore();
  });

  // The run refusal lands inside the delete transaction, BEFORE the
  // assistant teardown: a refused delete that had already destroyed the
  // assistants' engine sessions would erase their history on a request
  // that reports 409 and changes nothing. An idle team workflow is reaped
  // with the team; only an unsettled run refuses.
  it("refuses a team with an unsettled run before touching its assistants", async () => {
    api = await bootTestApi();
    const { baseUrl, providers } = api;
    const { db } = providers;

    const createRes = await createTeam(baseUrl, "Platform");
    const { team } = (await createRes.json()) as CreateTeamResponse;

    await db.insert(workflowDefinitions).values({
      id: "wf_team_del",
      orgId: "local-org",
      ownerType: "team",
      ownerId: team.id,
      name: "Nightly",
      definition: { nodes: [], edges: [] },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await db.insert(workflowRuns).values({
      id: "run_team_del",
      workflowId: "wf_team_del",
      definitionVersionId: "v1",
      definition: { nodes: [], edges: [] },
      params: {},
      status: "running",
      ownerType: "team",
      ownerId: team.id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    // The refusal must leave the singleton untouched.
    const [singleton] = await db.select().from(assistants).where(and(eq(assistants.ownerType, "team"), eq(assistants.ownerId, team.id)));
    if (!singleton) throw new Error("Team singleton missing");

    const delRes = await fetch(`${baseUrl}/api/teams/${team.id}`, {
      method: "DELETE",
      headers: HEADERS,
    });
    expect(delRes.status).toBe(409);

    const row = (
      await db.select().from(assistants).where(eq(assistants.id, singleton.id))
    )[0];
    expect(row?.archivedAt).toBeNull();
    // The team-owned singleton survives untouched.
    const teamOwned = await db
      .select()
      .from(assistants)
      .where(and(eq(assistants.ownerType, "team"), eq(assistants.ownerId, team.id)));
    expect(teamOwned.every((r) => r.archivedAt === null)).toBe(true);
    expect(teamOwned).toHaveLength(1);
  });

  it("404s on a team id that doesn't exist (or belongs to another org)", async () => {
    api = await bootTestApi();
    const { baseUrl } = api;

    const res = await fetch(`${baseUrl}/api/teams/does-not-exist`, { method: "DELETE", headers: HEADERS });
    expect(res.status).toBe(404);
  });

  describe("explicit identity-provider team join", () => {
    async function seedSuggestion(
      teamId = "team_idp_platform",
      orgId = "local-org",
      userId = "test-member",
      observedAt = Date.now(),
    ) {
      const { db } = api.providers;
      await db.insert(teams).values({
        id: teamId,
        orgId,
        name: teamId.replace("team_idp_", ""),
        origin: "idp",
        externalId: `/${teamId}`,
        createdAt: Date.now(),
      });
      await db.insert(teamJoinEligibilities).values({ teamId, userId, observedAt });
      return teamId;
    }

    it("lists only an eligible unjoined team without its group path", async () => {
      api = await bootTestApi();
      const teamId = await seedSuggestion();
      await api.providers.db.insert(teams).values({
        id: "team_idp_unrelated",
        orgId: "local-org",
        name: "unrelated",
        origin: "idp",
        externalId: "/secret-group",
        createdAt: Date.now(),
      });

      const res = await fetch(`${api.baseUrl}/api/teams/suggestions`, { headers: MEMBER_HEADERS });
      expect(res.status).toBe(200);
      const body = (await res.json()) as ListSuggestedTeamsResponse;
      expect(body.teams).toEqual([{ id: teamId, name: "platform", memberCount: 0 }]);
      expect(JSON.stringify(body)).not.toContain("secret-group");
      expect(JSON.stringify(body)).not.toContain("externalId");
    });

    it("joins explicitly as a member and then hides the suggestion", async () => {
      api = await bootTestApi();
      const teamId = await seedSuggestion();

      const join = await fetch(`${api.baseUrl}/api/teams/${teamId}/join`, {
        method: "POST",
        headers: MEMBER_HEADERS,
      });
      expect(join.status).toBe(200);
      expect(await join.json()).toEqual({ joined: true });
      const membership = await api.providers.db
        .select({ role: teamMembers.role })
        .from(teamMembers)
        .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, "test-member")));
      expect(membership).toEqual([{ role: "member" }]);

      const suggestions = await fetch(`${api.baseUrl}/api/teams/suggestions`, { headers: MEMBER_HEADERS });
      expect(await suggestions.json()).toEqual({ teams: [] });
    });

    it("refuses stale, non-eligible, and foreign-org ids with the same 404", async () => {
      api = await bootTestApi();
      const staleId = await seedSuggestion();
      await api.providers.db
        .delete(teamJoinEligibilities)
        .where(eq(teamJoinEligibilities.userId, "test-member"));
      await seedSuggestion("team_idp_foreign", "another-org");

      for (const teamId of [staleId, "not-eligible", "team_idp_foreign"]) {
        const res = await fetch(`${api.baseUrl}/api/teams/${teamId}/join`, {
          method: "POST",
          headers: MEMBER_HEADERS,
        });
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: "team not found" });
      }
    });

    it("refuses eligibility older than the configured auth session lifetime", async () => {
      api = await bootTestApi();
      const observedAt = Date.now() - AUTH_SESSION_LIFETIME_SECONDS * 1000 - 1;
      const teamId = await seedSuggestion(
        "team_idp_expired",
        "local-org",
        "test-member",
        observedAt,
      );

      const suggestions = await fetch(`${api.baseUrl}/api/teams/suggestions`, {
        headers: MEMBER_HEADERS,
      });
      expect(await suggestions.json()).toEqual({ teams: [] });

      const join = await fetch(`${api.baseUrl}/api/teams/${teamId}/join`, {
        method: "POST",
        headers: MEMBER_HEADERS,
      });
      expect(join.status).toBe(404);
      expect(await join.json()).toEqual({ error: "team not found" });
    });

    it("refuses join after the caller loses organization membership", async () => {
      api = await bootTestApi();
      const teamId = await seedSuggestion();
      await api.providers.db
        .delete(orgMembers)
        .where(and(eq(orgMembers.orgId, "local-org"), eq(orgMembers.userId, "test-member")));

      const suggestions = await fetch(`${api.baseUrl}/api/teams/suggestions`, {
        headers: MEMBER_HEADERS,
      });
      expect(await suggestions.json()).toEqual({ teams: [] });

      const join = await fetch(`${api.baseUrl}/api/teams/${teamId}/join`, {
        method: "POST",
        headers: MEMBER_HEADERS,
      });
      expect(join.status).toBe(404);
      expect(await join.json()).toEqual({ error: "team not found" });
      expect(
        await api.providers.db
          .select()
          .from(teamMembers)
          .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, "test-member"))),
      ).toEqual([]);
    });

    it("is idempotent for an existing membership and preserves its role", async () => {
      api = await bootTestApi();
      const teamId = await seedSuggestion();
      await api.providers.db
        .insert(teamMembers)
        .values({ teamId, userId: "test-member", role: "admin" });

      const res = await fetch(`${api.baseUrl}/api/teams/${teamId}/join`, {
        method: "POST",
        headers: MEMBER_HEADERS,
      });
      expect(res.status).toBe(200);
      const membership = await api.providers.db
        .select({ role: teamMembers.role })
        .from(teamMembers)
        .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, "test-member")));
      expect(membership).toEqual([{ role: "admin" }]);
    });
  });

  describe("mutation authorization", () => {
    it("a member cannot mutate membership and receives a deletion-request refusal", async () => {
      api = await bootTestApi();
      const { baseUrl } = api;

      // local-user creates the team (auto-admitted admin) and adds
      // test-member as a plain member.
      const createRes = await createTeam(baseUrl, "Platform");
      const { team } = (await createRes.json()) as CreateTeamResponse;
      await fetch(`${baseUrl}/api/teams/${team.id}/members`, {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify({ userId: "test-member", role: "member" }),
      });

      // test-member (non-admin on this team) tries every mutation route.
      const addRes = await fetch(`${baseUrl}/api/teams/${team.id}/members`, {
        method: "POST",
        headers: MEMBER_HEADERS,
        body: JSON.stringify({ userId: "test-admin", role: "member" }),
      });
      expect(addRes.status).toBe(404);

      // A crafted request cannot self-promote. The authorization check uses
      // the caller's current role, not the role requested in the body.
      const setRoleRes = await fetch(`${baseUrl}/api/teams/${team.id}/members/test-member`, {
        method: "PATCH",
        headers: MEMBER_HEADERS,
        body: JSON.stringify({ role: "admin" }),
      });
      expect(setRoleRes.status).toBe(404);

      // Nor can the same plain member mutate somebody else's role.
      const changeOtherRes = await fetch(`${baseUrl}/api/teams/${team.id}/members/local-user`, {
        method: "PATCH",
        headers: MEMBER_HEADERS,
        body: JSON.stringify({ role: "member" }),
      });
      expect(changeOtherRes.status).toBe(404);

      const rows = await api.providers.db
        .select()
        .from(teamMembers)
        .where(eq(teamMembers.teamId, team.id));
      expect(rows.find((row) => row.userId === "test-member")?.role).toBe("member");
      expect(rows.find((row) => row.userId === "local-user")?.role).toBe("admin");

      const removeRes = await fetch(`${baseUrl}/api/teams/${team.id}/members/local-user`, {
        method: "DELETE",
        headers: MEMBER_HEADERS,
      });
      expect(removeRes.status).toBe(404);

      const deleteRes = await fetch(`${baseUrl}/api/teams/${team.id}`, {
        method: "DELETE",
        headers: MEMBER_HEADERS,
      });
      // TKAI-430 gives a known member an actionable refusal. Membership
      // mutations above still hide unavailable admin operations with 404.
      expect(deleteRes.status).toBe(403);
      expect(await deleteRes.json()).toMatchObject({ code: "team_admin_required", teamId: team.id });
      const surviving = await api.providers.db.select().from(teams).where(eq(teams.id, team.id));
      expect(surviving).toHaveLength(1);
    });

    it("a team admin can change a member's role", async () => {
      api = await bootTestApi();
      const { baseUrl } = api;

      const { team } = (await (await createTeam(baseUrl, "Platform")).json()) as CreateTeamResponse;
      await fetch(`${baseUrl}/api/teams/${team.id}/members`, {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify({ userId: "test-member", role: "member" }),
      });

      const promote = await fetch(`${baseUrl}/api/teams/${team.id}/members/test-member`, {
        method: "PATCH",
        headers: HEADERS,
        body: JSON.stringify({ role: "admin" }),
      });
      expect(promote.status).toBe(200);
      const rows = await api.providers.db
        .select()
        .from(teamMembers)
        .where(eq(teamMembers.teamId, team.id));
      expect(rows.find((row) => row.userId === "test-member")?.role).toBe("admin");
    });

    it("a team admin can add members and delete the team", async () => {
      api = await bootTestApi();
      const { baseUrl } = api;

      // local-user is the creator, hence a team admin.
      const createRes = await createTeam(baseUrl, "Platform");
      const { team } = (await createRes.json()) as CreateTeamResponse;

      const addRes = await fetch(`${baseUrl}/api/teams/${team.id}/members`, {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify({ userId: "test-member", role: "member" }),
      });
      expect(addRes.status).toBe(201);

      const deleteRes = await fetch(`${baseUrl}/api/teams/${team.id}`, { method: "DELETE", headers: HEADERS });
      expect(deleteRes.status).toBe(200);
    });

    it("an org admin can mutate a team they aren't a member of", async () => {
      api = await bootTestApi();
      const { baseUrl } = api;

      // local-user creates the team; test-admin is an org admin but not on
      // the team at all — the deliberate recovery path.
      const createRes = await createTeam(baseUrl, "Platform");
      const { team } = (await createRes.json()) as CreateTeamResponse;

      const addRes = await fetch(`${baseUrl}/api/teams/${team.id}/members`, {
        method: "POST",
        headers: ADMIN_HEADERS,
        body: JSON.stringify({ userId: "test-member", role: "member" }),
      });
      expect(addRes.status).toBe(201);

      const promote = await fetch(`${baseUrl}/api/teams/${team.id}/members/test-member`, {
        method: "PATCH",
        headers: ADMIN_HEADERS,
        body: JSON.stringify({ role: "admin" }),
      });
      expect(promote.status).toBe(200);
      const rows = await api.providers.db
        .select()
        .from(teamMembers)
        .where(eq(teamMembers.teamId, team.id));
      expect(rows.find((row) => row.userId === "test-member")?.role).toBe("admin");

      const deleteRes = await fetch(`${baseUrl}/api/teams/${team.id}`, { method: "DELETE", headers: ADMIN_HEADERS });
      expect(deleteRes.status).toBe(200);
    });

    it("a global Valet operator without org-admin or team-admin role cannot change roles", async () => {
      api = await bootTestApi();
      const { baseUrl, providers } = api;
      const { team } = (await (await createTeam(baseUrl, "Platform")).json()) as CreateTeamResponse;
      await fetch(`${baseUrl}/api/teams/${team.id}/members`, {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify({ userId: "test-member", role: "member" }),
      });
      // `users.role` gates operator APIs only. Team recovery authority comes
      // from `org_members.role`, which deliberately remains member here.
      await providers.db.update(users).set({ role: "admin" }).where(eq(users.id, "test-member"));

      const res = await fetch(`${baseUrl}/api/teams/${team.id}/members/test-member`, {
        method: "PATCH",
        headers: MEMBER_HEADERS,
        body: JSON.stringify({ role: "admin" }),
      });
      expect(res.status).toBe(404);
      const rows = await providers.db
        .select()
        .from(teamMembers)
        .where(and(eq(teamMembers.teamId, team.id), eq(teamMembers.userId, "test-member")));
      expect(rows[0]?.role).toBe("member");
    });

    it("a non-member org user gets 404, not 403, on a team mutation", async () => {
      api = await bootTestApi();
      const { baseUrl } = api;

      const createRes = await createTeam(baseUrl, "Platform");
      const { team } = (await createRes.json()) as CreateTeamResponse;

      // test-member is a plain org member, not on this team at all.
      const res = await fetch(`${baseUrl}/api/teams/${team.id}`, { method: "DELETE", headers: MEMBER_HEADERS });
      expect(res.status).toBe(404);
    });
  });

  describe("GET /:id/members authorization", () => {
    // Note: this harness always runs with VALET_LOCAL_AUTH=1, so every
    // request resolves to a concrete `AuthUser` (local-user by default, or
    // whoever `x-valet-test-user-id` impersonates) — there is no route path
    // that produces a real 401 here. Unauthenticated access is covered by
    // `authMiddleware`'s own gate on `VALET_LOCAL_AUTH`, not by this suite.

    it("a team member can view the roster", async () => {
      api = await bootTestApi();
      const { baseUrl } = api;

      const createRes = await createTeam(baseUrl, "Platform");
      const { team } = (await createRes.json()) as CreateTeamResponse;
      await fetch(`${baseUrl}/api/teams/${team.id}/members`, {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify({ userId: "test-member", role: "member" }),
      });

      const res = await fetch(`${baseUrl}/api/teams/${team.id}/members`, { headers: MEMBER_HEADERS });
      expect(res.status).toBe(200);
      const { members } = (await res.json()) as ListTeamMembersResponse;
      expect(members.map((m) => m.userId).sort()).toEqual(["local-user", "test-member"]);
    });

    it("an org admin who isn't on the team can still view the roster", async () => {
      api = await bootTestApi();
      const { baseUrl } = api;

      const createRes = await createTeam(baseUrl, "Platform");
      const { team } = (await createRes.json()) as CreateTeamResponse;

      const res = await fetch(`${baseUrl}/api/teams/${team.id}/members`, { headers: ADMIN_HEADERS });
      expect(res.status).toBe(200);
      const { members } = (await res.json()) as ListTeamMembersResponse;
      expect(members.map((m) => m.userId)).toEqual(["local-user"]);
    });

    it("a plain org member who isn't on the team gets 404, not the roster", async () => {
      api = await bootTestApi();
      const { baseUrl } = api;

      // local-user creates the team; test-member is a plain org member
      // (not an org admin) and is never added to this team.
      const createRes = await createTeam(baseUrl, "Platform");
      const { team } = (await createRes.json()) as CreateTeamResponse;

      const res = await fetch(`${baseUrl}/api/teams/${team.id}/members`, { headers: MEMBER_HEADERS });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { members?: unknown };
      expect(body.members).toBeUndefined();
    });

    it("404s on a nonexistent team id", async () => {
      api = await bootTestApi();
      const { baseUrl } = api;

      const res = await fetch(`${baseUrl}/api/teams/does-not-exist/members`, { headers: HEADERS });
      expect(res.status).toBe(404);
    });
  });

  describe("GET /teams admin-vs-member scoping", () => {
    it("an org admin sees every team in the org, including ones they aren't a member of", async () => {
      api = await bootTestApi();
      const { baseUrl } = api;

      // local-user creates two teams; test-admin (org admin) is never added
      // to either.
      const platform = (await (await createTeam(baseUrl, "Platform")).json()) as CreateTeamResponse;
      const growth = (await (await createTeam(baseUrl, "Growth")).json()) as CreateTeamResponse;

      const res = await fetch(`${baseUrl}/api/teams`, { headers: ADMIN_HEADERS });
      expect(res.status).toBe(200);
      const { teams } = (await res.json()) as ListTeamsResponse;
      const ids = teams.map((t) => t.id);
      expect(ids).toContain(platform.team.id);
      expect(ids).toContain(growth.team.id);
    });

    it("a plain member sees only the teams they belong to", async () => {
      api = await bootTestApi();
      const { baseUrl } = api;

      // test-member is added to Platform only; Growth stays out of reach.
      const platform = (await (await createTeam(baseUrl, "Platform")).json()) as CreateTeamResponse;
      const growth = (await (await createTeam(baseUrl, "Growth")).json()) as CreateTeamResponse;
      await fetch(`${baseUrl}/api/teams/${platform.team.id}/members`, {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify({ userId: "test-member", role: "member" }),
      });

      const res = await fetch(`${baseUrl}/api/teams`, { headers: MEMBER_HEADERS });
      expect(res.status).toBe(200);
      const { teams } = (await res.json()) as ListTeamsResponse;
      const ids = teams.map((t) => t.id);
      expect(ids).toContain(platform.team.id);
      expect(ids).not.toContain(growth.team.id);
    });

    it("memberCount reflects the actual roster size on the JSON boundary", async () => {
      api = await bootTestApi();
      const { baseUrl } = api;

      const createRes = await createTeam(baseUrl, "Platform");
      const { team } = (await createRes.json()) as CreateTeamResponse;

      let listRes = await fetch(`${baseUrl}/api/teams`, { headers: HEADERS });
      let { teams } = (await listRes.json()) as ListTeamsResponse;
      expect(teams.find((t) => t.id === team.id)?.memberCount).toBe(1);

      await fetch(`${baseUrl}/api/teams/${team.id}/members`, {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify({ userId: "test-member", role: "member" }),
      });

      listRes = await fetch(`${baseUrl}/api/teams`, { headers: HEADERS });
      ({ teams } = (await listRes.json()) as ListTeamsResponse);
      expect(teams.find((t) => t.id === team.id)?.memberCount).toBe(2);
    });
  });

  describe("identity-provider-backed teams", () => {
    async function seedIdpTeam(name: string, externalId: string): Promise<string> {
      const id = `team_idp_${name}`;
      await api.providers.db.insert(teams).values({
        id,
        orgId: "local-org",
        name,
        origin: "idp",
        externalId,
        createdAt: Date.now(),
      });
      await api.providers.db
        .insert(teamMembers)
        .values({ teamId: id, userId: "local-user", role: "admin" });
      return id;
    }

    it("keeps manual membership management available", async () => {
      api = await bootTestApi();
      const teamId = await seedIdpTeam("platform", "/platform");

      const add = await fetch(`${api.baseUrl}/api/teams/${teamId}/members`, {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify({ userId: "test-member", role: "member" }),
      });
      expect(add.status).toBe(201);
      const promote = await fetch(`${api.baseUrl}/api/teams/${teamId}/members/test-member`, {
        method: "PATCH",
        headers: HEADERS,
        body: JSON.stringify({ role: "admin" }),
      });
      expect(promote.status).toBe(200);
    });

    it("keeps provenance on the existing team wire response", async () => {
      api = await bootTestApi();
      const teamId = await seedIdpTeam("platform", "/platform");

      const listRes = await fetch(`${api.baseUrl}/api/teams`, { headers: HEADERS });
      const { teams: rows } = (await listRes.json()) as ListTeamsResponse;
      expect(rows.find((team) => team.id === teamId)).toMatchObject({
        origin: "idp",
        externalId: "/platform",
      });
    });

    it("still refuses a rename while allowing Valet-local defaults", async () => {
      vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-env-stub");
      try {
        api = await bootTestApi();
        const teamId = await seedIdpTeam("platform", "/platform");
        const rename = await fetch(`${api.baseUrl}/api/teams/${teamId}`, {
          method: "PATCH",
          headers: HEADERS,
          body: JSON.stringify({ name: "renamed" }),
        });
        expect(rename.status).toBe(400);

        const defaults = await fetch(`${api.baseUrl}/api/teams/${teamId}`, {
          method: "PATCH",
          headers: HEADERS,
          body: JSON.stringify({ defaultModel: "claude-haiku-4-5" }),
        });
        expect(defaults.status).toBe(200);
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });

  describe("addMember target validation", () => {
    it("rejects an unknown userId with 404", async () => {
      api = await bootTestApi();
      const { baseUrl } = api;

      const createRes = await createTeam(baseUrl, "Platform");
      const { team } = (await createRes.json()) as CreateTeamResponse;

      const res = await fetch(`${baseUrl}/api/teams/${team.id}/members`, {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify({ userId: "no-such-user", role: "member" }),
      });
      expect(res.status).toBe(404);
    });
  });
});

describe("GET /api/teams callerRole", () => {
  it("reports the caller's own role, and null for an org admin who is not a member", async () => {
    api = await bootTestApi();
    const res = await createTeam(api.baseUrl, "Roles");
    expect(res.status).toBe(201);
    const { team } = (await res.json()) as CreateTeamResponse;
    expect(team.callerRole).toBe("admin");

    const add = await fetch(`${api.baseUrl}/api/teams/${team.id}/members`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ userId: "test-member", role: "member" }),
    });
    expect(add.status).toBe(201);

    const asMember = await fetch(`${api.baseUrl}/api/teams`, { headers: MEMBER_HEADERS });
    const memberList = (await asMember.json()) as ListTeamsResponse;
    expect(memberList.teams.find((t) => t.id === team.id)?.callerRole).toBe("member");

    const asAdmin = await fetch(`${api.baseUrl}/api/teams`, { headers: ADMIN_HEADERS });
    const adminList = (await asAdmin.json()) as ListTeamsResponse;
    expect(adminList.teams.find((t) => t.id === team.id)?.callerRole).toBe(null);
  });
});

