/**
 * `PATCH /api/teams/:id` — team settings (TKAI-255): the team default
 * model. Gating matches the other team mutations (`canAdministerTeam`:
 * team admin of that team, or org admin), and validation matches
 * `PATCH /api/me`'s `defaultModel` (org-catalog id set, null clears).
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { orgMembers, teamMembers, teams, users } from "../schema/index.js";
import { setApprovedModels } from "../services/approved-models.js";
import { setOrgReasoningSettings } from "../services/reasoning.js";
import type { ListTeamsResponse, PatchTeamResponse } from "../wire/types.js";

let api: TestApi | undefined;

afterEach(async () => {
  vi.unstubAllEnvs();
  await api?.cleanup();
  api = undefined;
});

/** One team: `test-lead` is its team admin, `test-member` a plain member.
 * The stub identity `local-user` is an org admin who is NOT on the team. */
async function seedTeam(target: TestApi): Promise<void> {
  await target.providers.db
    .insert(teams)
    .values({ id: "team_1", orgId: "local-org", name: "Platform", createdAt: Date.now() });
  await target.providers.db.insert(teamMembers).values([
    { teamId: "team_1", userId: "test-lead", role: "admin" },
    { teamId: "team_1", userId: "test-member", role: "member" },
  ]);
}

async function patchTeam(
  target: TestApi,
  body: unknown,
  asUser?: string,
): Promise<Response> {
  return fetch(`${target.baseUrl}/api/teams/team_1`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      ...(asUser ? { "x-valet-test-user-id": asUser } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("PATCH /api/teams/:id", () => {
  it("home channel is admin-only, rejects DM IDs, and can be cleared", async () => {
    api = await bootTestApi();
    await seedTeam(api);
    expect((await patchTeam(api, { slackHomeChannelId: "C0123456789" }, "test-member")).status).toBe(404);
    expect((await patchTeam(api, { slackHomeChannelId: "D0123456789" }, "test-lead")).status).toBe(400);
    const saved = await patchTeam(api, { slackHomeChannelId: "C0123456789" }, "test-lead");
    expect(saved.status).toBe(200);
    expect(((await saved.json()) as PatchTeamResponse).team.slackHomeChannelId).toBe("C0123456789");
    const cleared = await patchTeam(api, { slackHomeChannelId: null }, "test-lead");
    expect(((await cleared.json()) as PatchTeamResponse).team.slackHomeChannelId).toBeNull();
  });

  it("team admin sets the default model; GET /api/teams reflects it", async () => {
    // The catalog reports an Anthropic entry as valid only when a key
    // exists (zero-config env fallback), same as me.test.ts.
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-env-stub");
    api = await bootTestApi();
    await seedTeam(api);

    const res = await patchTeam(api, { defaultModel: "anthropic/claude-sonnet-4-5" }, "test-lead");
    expect(res.status).toBe(200);
    const body = (await res.json()) as PatchTeamResponse;
    expect(body.team.defaultModel).toBe("anthropic/claude-sonnet-4-5");

    const listRes = await fetch(`${api.baseUrl}/api/teams`, {
      headers: { "x-valet-test-user-id": "test-lead" },
    });
    const list = (await listRes.json()) as ListTeamsResponse;
    expect(list.teams.find((t) => t.id === "team_1")?.defaultModel).toBe(
      "anthropic/claude-sonnet-4-5",
    );
  });

  it("null clears the override", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-env-stub");
    api = await bootTestApi();
    await seedTeam(api);
    await patchTeam(api, { defaultModel: "anthropic/claude-sonnet-4-5" }, "test-lead");

    const res = await patchTeam(api, { defaultModel: null }, "test-lead");
    expect(res.status).toBe(200);
    const body = (await res.json()) as PatchTeamResponse;
    expect(body.team.defaultModel).toBeNull();
  });

  it("org admin who is not on the team can set it (recovery path)", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-env-stub");
    api = await bootTestApi();
    await seedTeam(api);

    // The default stub identity `local-user` is the org admin.
    const res = await patchTeam(api, { defaultModel: "anthropic/claude-sonnet-4-5" });
    expect(res.status).toBe(200);
  });

  it("plain team member gets 404 (existence-hiding, same as other mutations)", async () => {
    api = await bootTestApi();
    await seedTeam(api);

    const res = await patchTeam(api, { defaultModel: "anthropic/claude-sonnet-4-5" }, "test-member");
    expect(res.status).toBe(404);
  });

  it("unknown model id 400s and names the fix", async () => {
    api = await bootTestApi();
    await seedTeam(api);

    const res = await patchTeam(api, { defaultModel: "not-a-real-model" }, "test-lead");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/GET \/api\/models/);
  });

  it("non-string non-null defaultModel 400s", async () => {
    api = await bootTestApi();
    await seedTeam(api);

    const res = await patchTeam(api, { defaultModel: 42 }, "test-lead");
    expect(res.status).toBe(400);
  });

  it("JSON-valid non-object bodies 400 instead of 500", async () => {
    api = await bootTestApi();
    await seedTeam(api);

    for (const body of [null, 42, true, "x", []]) {
      const res = await patchTeam(api, body, "test-lead");
      expect(res.status).toBe(400);
      const parsed = (await res.json()) as { error: string };
      expect(parsed.error).toMatch(/JSON object/);
    }
  });

  it("unknown field 400s rather than silently no-oping", async () => {
    api = await bootTestApi();
    await seedTeam(api);

    const res = await patchTeam(api, { name: "Renamed" }, "test-lead");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/unknown field/);
  });

  it("sets defaultReasoning within the org cap, normalizing case; GET reflects it", async () => {
    api = await bootTestApi();
    await seedTeam(api);
    await setOrgReasoningSettings(api.providers.db, "local-org", { max: "high" });

    const res = await patchTeam(api, { defaultReasoning: "Medium" }, "test-lead");
    expect(res.status).toBe(200);
    const body = (await res.json()) as PatchTeamResponse;
    expect(body.team.defaultReasoning).toBe("medium");

    const listRes = await fetch(`${api.baseUrl}/api/teams`, {
      headers: { "x-valet-test-user-id": "test-lead" },
    });
    const list = (await listRes.json()) as ListTeamsResponse;
    expect(list.teams.find((t) => t.id === "team_1")?.defaultReasoning).toBe("medium");
  });

  it("400s a defaultReasoning level exceeding the org cap", async () => {
    api = await bootTestApi();
    await seedTeam(api);
    await setOrgReasoningSettings(api.providers.db, "local-org", { max: "medium" });

    const res = await patchTeam(api, { defaultReasoning: "high" }, "test-lead");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/exceeds the org max/);
  });

  it("400s an unknown defaultReasoning level", async () => {
    api = await bootTestApi();
    await seedTeam(api);

    const res = await patchTeam(api, { defaultReasoning: "not-a-level" }, "test-lead");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/Unknown reasoning level/);
  });

  it("clears defaultReasoning when passed null, even above the org cap", async () => {
    api = await bootTestApi();
    await seedTeam(api);
    await setOrgReasoningSettings(api.providers.db, "local-org", { max: "minimal" });

    const res = await patchTeam(api, { defaultReasoning: null }, "test-lead");
    expect(res.status).toBe(200);
    const body = (await res.json()) as PatchTeamResponse;
    expect(body.team.defaultReasoning).toBeNull();
  });

  it("400s a catalog-valid but unapproved defaultModel for a non-org-admin team admin; org admin bypasses", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-env-stub");
    try {
      api = await bootTestApi();
      await seedTeam(api);
      // `test-lead` is a team admin but, unlike the other `seedTeam`
      // identities, must be a genuine org MEMBER here (not the stub-fallback
      // admin the `x-valet-test-user-id` header resolves to for an unseeded
      // id) so the approved-list gate has a non-admin caller to bind.
      await api.providers.db
        .insert(users)
        .values({ id: "test-lead", email: "lead@dev", name: "Test Lead", role: "member" });
      await api.providers.db
        .insert(orgMembers)
        .values({ orgId: "local-org", userId: "test-lead", role: "member", createdAt: Date.now() });
      await setApprovedModels(api.providers.db, "local-org", ["anthropic/claude-opus-4-7"]);

      const memberRes = await patchTeam(api, { defaultModel: "anthropic/claude-haiku-4-5" }, "test-lead");
      expect(memberRes.status).toBe(400);
      const body = (await memberRes.json()) as { error: string };
      expect(body.error).toMatch(/approved list/);

      // `local-user` (default identity, no header) is a real org admin.
      const adminRes = await patchTeam(api, { defaultModel: "anthropic/claude-haiku-4-5" });
      expect(adminRes.status).toBe(200);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
