/**
 * `POST /api/teams/:id/orchestrator` — get-or-create the team's DEFAULT
 * assistant session (`services/session-access.ts`'s companion route: this
 * creates the `agent_sessions` row that route widens read access to).
 * Mirrors `POST /api/orchestrator`'s own contract for the user case.
 */
import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { agentSessions, teamMembers, teams } from "../schema/index.js";
import { setApprovedModels } from "../services/approved-models.js";
import { setOrgReasoningSettings } from "../services/reasoning.js";
import type { EnsureOrchestratorResponse, PatchSessionResponse } from "../wire/types.js";

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

describe("POST /api/teams/:id/orchestrator", () => {
  it("creates the team's default assistant session for a member and returns its id", async () => {
    api = await bootTestApi();
    const now = Date.now();
    await api.providers.db.insert(teams).values({ id: "team_1", orgId: "local-org", name: "Platform", createdAt: now });
    await api.providers.db.insert(teamMembers).values({ teamId: "team_1", userId: "local-user", role: "member" });

    const res = await fetch(`${api.baseUrl}/api/teams/team_1/orchestrator`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as EnsureOrchestratorResponse;
    // The address is the assistant's own id, so the test asserts the
    // scheme and the owner columns rather than a derivable literal.
    expect(body.sessionId).toMatch(/^assistant:asst_/);

    const rows = await api.providers.db.select().from(agentSessions).where(eq(agentSessions.id, body.sessionId));
    expect(rows[0]?.ownerType).toBe("team");
    expect(rows[0]?.ownerId).toBe("team_1");
  });

  it("is idempotent — a second call returns the same session id, doesn't duplicate the row", async () => {
    api = await bootTestApi();
    const now = Date.now();
    await api.providers.db.insert(teams).values({ id: "team_1", orgId: "local-org", name: "Platform", createdAt: now });
    await api.providers.db.insert(teamMembers).values({ teamId: "team_1", userId: "local-user", role: "member" });

    const first = (await (await fetch(`${api.baseUrl}/api/teams/team_1/orchestrator`, { method: "POST" })).json()) as EnsureOrchestratorResponse;
    const second = (await (await fetch(`${api.baseUrl}/api/teams/team_1/orchestrator`, { method: "POST" })).json()) as EnsureOrchestratorResponse;
    expect(second.sessionId).toBe(first.sessionId);

    const rows = await api.providers.db.select().from(agentSessions).where(eq(agentSessions.id, first.sessionId));
    expect(rows).toHaveLength(1);
  });

  it("lets an org admin reach a team's assistant without being a direct member — same rule GET /:id/members already uses", async () => {
    api = await bootTestApi();
    const now = Date.now();
    await api.providers.db.insert(teams).values({ id: "team_2", orgId: "local-org", name: "Other Team", createdAt: now });
    // No team_members row for local-user — it's an org admin (seeded by
    // bootTestApi), which `canViewTeam` already treats as a recovery path
    // for every team in the org, not just ones the caller is on.

    const res = await fetch(`${api.baseUrl}/api/teams/team_2/orchestrator`, { method: "POST" });
    expect(res.status).toBe(200);
  });

  it("404s for a team in a different org", async () => {
    api = await bootTestApi();
    const now = Date.now();
    await api.providers.db.insert(teams).values({ id: "team_3", orgId: "other-org", name: "Elsewhere", createdAt: now });

    const res = await fetch(`${api.baseUrl}/api/teams/team_3/orchestrator`, { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("404s for an unknown team id", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/teams/no-such-team/orchestrator`, { method: "POST" });
    expect(res.status).toBe(404);
  });
});

describe("GET /api/sessions/:id — team view access", () => {
  it("lets a team member view a team-owned session created via the orchestrator route", async () => {
    api = await bootTestApi();
    const now = Date.now();
    await api.providers.db.insert(teams).values({ id: "team_1", orgId: "local-org", name: "Platform", createdAt: now });
    await api.providers.db.insert(teamMembers).values({ teamId: "team_1", userId: "local-user", role: "member" });

    const created = (await (await fetch(`${api.baseUrl}/api/teams/team_1/orchestrator`, { method: "POST" })).json()) as EnsureOrchestratorResponse;

    const res = await fetch(`${api.baseUrl}/api/sessions/${created.sessionId}`);
    expect(res.status).toBe(200);
  });

  it("still 404s a session directly owned by someone else", async () => {
    api = await bootTestApi();
    const now = Date.now();
    await api.providers.db.insert(agentSessions).values({
      id: "sess_someone_else",
      userId: "test-member",
      orgId: "local-org",
      workspace: "/tmp",
      status: "active",
      ownerType: "user",
      ownerId: "test-member",
      createdAt: now,
      updatedAt: now,
    });

    const res = await fetch(`${api.baseUrl}/api/sessions/sess_someone_else`);
    expect(res.status).toBe(404);
  });
});

/**
 * The lifecycle routes on a team-owned session: `PATCH /api/sessions/:id`
 * (model), `POST /api/sessions/:id/pause`, `DELETE /api/sessions/:id`. They
 * follow team authority (`canAdministerSession`), not the `user_id` that
 * `ensureDefaultAssistantSession` stamped from the first member to open the
 * team's assistant.
 *
 * Two identities do the work, both seeded by `bootTestApi`: the default
 * `local-user` is an org admin, and `test-member` is a plain org member
 * selected with the `x-valet-test-user-id` impersonation header.
 *
 * `pause` gets no further than the hibernation-capability check here — the
 * harness runs a `VirtualSandboxProvider`, whose `capabilities().hibernation`
 * is false. A 409 from it therefore means the caller passed authorization,
 * which is what these tests measure. `PATCH` with an empty body reads the
 * same way: 400 `model is required` is the guard directly after the
 * authorization check.
 */
describe("team-owned session lifecycle routes", () => {
  const MEMBER_HEADERS = { "x-valet-test-user-id": "test-member" };

  /** Creates `team_1` in the local org and puts `test-member` on it. */
  async function seedTeam(target: TestApi, memberRole: "admin" | "member"): Promise<void> {
    await target.providers.db
      .insert(teams)
      .values({ id: "team_1", orgId: "local-org", name: "Platform", createdAt: Date.now() });
    await target.providers.db.insert(teamMembers).values({ teamId: "team_1", userId: "test-member", role: memberRole });
  }

  /** Opens the team's assistant as `headers`' identity. That call stamps
   * `agent_sessions.userId` with the caller — the first-opener effect. */
  async function openTeamAssistant(target: TestApi, headers: Record<string, string>): Promise<string> {
    const res = await fetch(`${target.baseUrl}/api/teams/team_1/orchestrator`, { method: "POST", headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as EnsureOrchestratorResponse;
    return body.sessionId;
  }

  async function statusOf(target: TestApi, sessionId: string): Promise<string | undefined> {
    const rows = await target.providers.db.select().from(agentSessions).where(eq(agentSessions.id, sessionId));
    return rows[0]?.status;
  }

  it("refuses a plain member the pause, even the member whose own first visit stamped the row", async () => {
    api = await bootTestApi();
    await seedTeam(api, "member");
    const sessionId = await openTeamAssistant(api, MEMBER_HEADERS);
    const rows = await api.providers.db.select().from(agentSessions).where(eq(agentSessions.id, sessionId));
    expect(rows[0]?.userId).toBe("test-member");

    const res = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/pause`, {
      method: "POST",
      headers: MEMBER_HEADERS,
    });
    expect(res.status).toBe(404);
    expect(await statusOf(api, sessionId)).toBe("active");
  });

  it("refuses a plain member the delete of an agent the whole team shares", async () => {
    api = await bootTestApi();
    await seedTeam(api, "member");
    const sessionId = await openTeamAssistant(api, MEMBER_HEADERS);

    const res = await fetch(`${api.baseUrl}/api/sessions/${sessionId}`, { method: "DELETE", headers: MEMBER_HEADERS });
    expect(res.status).toBe(404);
    expect(await statusOf(api, sessionId)).toBe("active");
  });

  it("refuses a plain member the model change", async () => {
    api = await bootTestApi();
    await seedTeam(api, "member");
    const sessionId = await openTeamAssistant(api, MEMBER_HEADERS);

    const res = await fetch(`${api.baseUrl}/api/sessions/${sessionId}`, {
      method: "PATCH",
      headers: { ...MEMBER_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "anthropic/claude-haiku-4-5" }),
    });
    expect(res.status).toBe(404);
  });

  it("lets a team admin reach the pause of a session another member's visit stamped", async () => {
    api = await bootTestApi();
    await seedTeam(api, "admin");
    // The org admin opens it first, so the row carries `local-user`.
    const sessionId = await openTeamAssistant(api, {});

    const res = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/pause`, {
      method: "POST",
      headers: MEMBER_HEADERS,
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body).toEqual({ error: "provider does not support hibernation" });
  });

  it("400s a catalog-valid but unapproved model for a non-org-admin team admin; org admin bypasses", async () => {
    api = await bootTestApi();
    // Team admin (passes `canAdministerSession`) but a plain org member, so
    // the approved-list gate has a real non-admin caller to bind against.
    await seedTeam(api, "admin");
    const sessionId = await openTeamAssistant(api, MEMBER_HEADERS);
    await setApprovedModels(api.providers.db, "local-org", ["anthropic/claude-opus-4-7"]);

    const memberRes = await fetch(`${api.baseUrl}/api/sessions/${sessionId}`, {
      method: "PATCH",
      headers: { ...MEMBER_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "anthropic/claude-haiku-4-5" }),
    });
    expect(memberRes.status).toBe(400);
    const body = (await memberRes.json()) as { error: string };
    expect(body.error).toMatch(/approved list/);

    // The default identity (`local-user`, no header) is an org admin and
    // bypasses the gate, same as `canAdministerSession` already lets it
    // through the ownership check above.
    const adminRes = await fetch(`${api.baseUrl}/api/sessions/${sessionId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "anthropic/claude-haiku-4-5" }),
    });
    expect(adminRes.status).toBe(200);
  });

  it("400s a session reasoning level exceeding the org cap; null always clears", async () => {
    api = await bootTestApi();
    await seedTeam(api, "admin");
    const sessionId = await openTeamAssistant(api, MEMBER_HEADERS);
    await setOrgReasoningSettings(api.providers.db, "local-org", { max: "medium" });

    const overCap = await fetch(`${api.baseUrl}/api/sessions/${sessionId}`, {
      method: "PATCH",
      headers: { ...MEMBER_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ reasoning: "high" }),
    });
    expect(overCap.status).toBe(400);
    const body = (await overCap.json()) as { error: string };
    expect(body.error).toMatch(/exceeds the org max/);

    const withinCap = await fetch(`${api.baseUrl}/api/sessions/${sessionId}`, {
      method: "PATCH",
      headers: { ...MEMBER_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ reasoning: "Medium" }),
    });
    expect(withinCap.status).toBe(200);
    // Applied (Task 11), not just validated: the response echoes the
    // normalized session-default reasoning that was actually set.
    expect(((await withinCap.json()) as PatchSessionResponse).reasoning).toBe("medium");

    const cleared = await fetch(`${api.baseUrl}/api/sessions/${sessionId}`, {
      method: "PATCH",
      headers: { ...MEMBER_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ reasoning: null }),
    });
    expect(cleared.status).toBe(200);
    expect(((await cleared.json()) as PatchSessionResponse).reasoning).toBeNull();
  });

  it("lets an org admin reach the model picker of a session stamped with another member's id", async () => {
    api = await bootTestApi();
    await seedTeam(api, "member");
    const sessionId = await openTeamAssistant(api, MEMBER_HEADERS);

    const res = await fetch(`${api.baseUrl}/api/sessions/${sessionId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body).toEqual({ error: "model is required" });
  });

  it("refuses an org admin deletion of the team singleton opened by another member", async () => {
    api = await bootTestApi();
    await seedTeam(api, "member");
    const sessionId = await openTeamAssistant(api, MEMBER_HEADERS);
    const response = await fetch(`${api.baseUrl}/api/sessions/${sessionId}`, { method: "DELETE" });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("Archive individual threads") });
    expect(await statusOf(api, sessionId)).toBe("active");
  });

  it("lets an org admin delete a standalone team session opened by another member", async () => {
    api = await bootTestApi();
    await seedTeam(api, "member");
    const now = Date.now();
    await api.providers.db.insert(agentSessions).values({
      id: "standalone-team-session", userId: "test-member", orgId: "local-org",
      workspace: "/tmp", status: "active", ownerType: "team", ownerId: "team_1",
      createdAt: now, updatedAt: now,
    });
    const response = await fetch(`${api.baseUrl}/api/sessions/standalone-team-session`, { method: "DELETE" });
    expect(response.status).toBe(200);
    expect(await statusOf(api, "standalone-team-session")).toBe("deleted");
  });

  it("leaves user-owned sessions direct-owner-only", async () => {
    api = await bootTestApi();
    const now = Date.now();
    await api.providers.db.insert(agentSessions).values({
      id: "sess_mine",
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp",
      status: "active",
      ownerType: "user",
      ownerId: "local-user",
      createdAt: now,
      updatedAt: now,
    });
    // `test-member` is on no team here; org membership alone never reaches
    // another user's own session.
    const denied = await fetch(`${api.baseUrl}/api/sessions/sess_mine`, { method: "DELETE", headers: MEMBER_HEADERS });
    expect(denied.status).toBe(404);
    expect(await statusOf(api, "sess_mine")).toBe("active");

    const allowed = await fetch(`${api.baseUrl}/api/sessions/sess_mine`, { method: "DELETE" });
    expect(allowed.status).toBe(200);
    expect(await statusOf(api, "sess_mine")).toBe("deleted");
  });
});
