/**
 * PATCH /api/sessions/:id — the `teamId` half (team-workspace-ui design,
 * decision 5): moving a session between workspaces.
 *
 * Pins the write, the membership gate, the personal-move semantics (`null`
 * makes it the CALLER's), the no-op path, and the guarantee that a move —
 * like a rename — never starts a sandbox.
 */
import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { agentSessions, assistants, childWatches, teamMembers, teams } from "../schema/index.js";
import type { PatchSessionResponse } from "../wire/types.js";

async function seedSession(
  api: TestApi,
  opts: { id: string; owner: { type: "user" | "team"; id: string }; userId?: string },
): Promise<void> {
  const now = Date.now();
  await api.providers.db.insert(agentSessions).values({
    id: opts.id,
    userId: opts.userId ?? "local-user",
    orgId: "local-org",
    workspace: `/tmp/move-test-${opts.id}`,
    status: "active",
    ownerType: opts.owner.type,
    ownerId: opts.owner.id,
    createdAt: now,
    updatedAt: now,
  });
}

async function seedTeam(api: TestApi, id: string, members: string[]): Promise<void> {
  const { db } = api.providers;
  await db.insert(teams).values({
    id,
    orgId: "local-org",
    name: `Team ${id}`,
    origin: "local",
    externalId: null,
    createdAt: Date.now(),
  });
  for (const userId of members) {
    await db.insert(teamMembers).values({ teamId: id, userId, role: "admin" });
  }
}

async function storedOwner(
  api: TestApi,
  sessionId: string,
): Promise<{ type: string; id: string } | undefined> {
  const rows = await api.providers.db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId))
    .limit(1);
  const row = rows[0];
  return row ? { type: row.ownerType, id: row.ownerId } : undefined;
}

function patch(api: TestApi, sessionId: string, body: unknown) {
  return fetch(`${api.baseUrl}/api/sessions/${sessionId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("PATCH /api/sessions/:id — teamId (move between workspaces)", () => {
  let api: TestApi | undefined;

  afterEach(async () => {
    await api?.cleanup();
    api = undefined;
  });

  it("moves a personal session to a team the caller belongs to", async () => {
    api = await bootTestApi();
    await seedTeam(api, "team_mv", ["local-user"]);
    await seedSession(api, { id: "mv-to-team", owner: { type: "user", id: "local-user" } });

    const res = await patch(api, "mv-to-team", { teamId: "team_mv" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PatchSessionResponse;
    expect(body.owner).toEqual({ type: "team", id: "team_mv" });
    expect(await storedOwner(api, "mv-to-team")).toEqual({ type: "team", id: "team_mv" });
  });

  it("teamId null moves a team session to the caller's own workspace", async () => {
    api = await bootTestApi();
    await seedTeam(api, "team_mv2", ["local-user"]);
    await seedSession(api, { id: "mv-to-me", owner: { type: "team", id: "team_mv2" } });

    const res = await patch(api, "mv-to-me", { teamId: null });
    expect(res.status).toBe(200);
    expect(await storedOwner(api, "mv-to-me")).toEqual({ type: "user", id: "local-user" });
  });

  it("404s for a team the caller is not a member of, and writes nothing", async () => {
    api = await bootTestApi();
    // Only test-member is on the team; local-user (the caller) is not —
    // org-admin status must not substitute for membership here, the same
    // rule the create route applies.
    await seedTeam(api, "team_notmine", ["test-member"]);
    await seedSession(api, { id: "mv-denied", owner: { type: "user", id: "local-user" } });

    const res = await patch(api, "mv-denied", { teamId: "team_notmine" });
    expect(res.status).toBe(404);
    expect(await storedOwner(api, "mv-denied")).toEqual({ type: "user", id: "local-user" });
  });

  it("404s for an unknown team id", async () => {
    api = await bootTestApi();
    await seedSession(api, { id: "mv-ghost", owner: { type: "user", id: "local-user" } });

    const res = await patch(api, "mv-ghost", { teamId: "team_ghost" });
    expect(res.status).toBe(404);
    expect(await storedOwner(api, "mv-ghost")).toEqual({ type: "user", id: "local-user" });
  });

  it("rejects a non-string, non-null teamId and names the fix", async () => {
    api = await bootTestApi();
    await seedSession(api, { id: "mv-type", owner: { type: "user", id: "local-user" } });

    const res = await patch(api, "mv-type", { teamId: 42 });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("teamId must be a team id");
  });

  it("an unchanged owner is a no-op 200", async () => {
    api = await bootTestApi();
    await seedTeam(api, "team_same", ["local-user"]);
    await seedSession(api, { id: "mv-same", owner: { type: "team", id: "team_same" } });

    const res = await patch(api, "mv-same", { teamId: "team_same" });
    expect(res.status).toBe(200);
    expect(await storedOwner(api, "mv-same")).toEqual({ type: "team", id: "team_same" });
  });

  it("moves without starting a sandbox", async () => {
    api = await bootTestApi();
    await seedTeam(api, "team_cold", ["local-user"]);
    await seedSession(api, { id: "mv-cold", owner: { type: "user", id: "local-user" } });
    expect(api.providers.engineHost.isLive("mv-cold")).toBe(false);

    const res = await patch(api, "mv-cold", { teamId: "team_cold" });
    expect(res.status).toBe(200);
    // A move evicts the cache; it must not materialize the engine session.
    expect(api.providers.engineHost.isLive("mv-cold")).toBe(false);
  });

  it("refuses to move an assistant's session — the owner is structural", async () => {
    api = await bootTestApi();
    await seedTeam(api, "team_asst", ["local-user"]);
    await seedSession(api, {
      id: "assistant:as_move",
      owner: { type: "user", id: "local-user" },
    });

    const res = await patch(api, "assistant:as_move", { teamId: "team_asst" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("assistant");
    expect(await storedOwner(api, "assistant:as_move")).toEqual({
      type: "user",
      id: "local-user",
    });
  });

  // Migrated assistants keep legacy `orchestrator:*` session ids the prefix
  // parse cannot recognize; the refusal keys off the assistants table's
  // session_id column for them (TKAI-296 review).
  it("refuses to move a migrated assistant's legacy-id session", async () => {
    api = await bootTestApi();
    await seedTeam(api, "team_legacy_mv", ["local-user"]);
    await api.providers.db.insert(assistants).values({
      id: "asst_legacy_mv",
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
    await seedSession(api, {
      id: "orchestrator:user:local-user",
      owner: { type: "user", id: "local-user" },
    });

    const res = await patch(api, "orchestrator:user:local-user", { teamId: "team_legacy_mv" });
    expect(res.status).toBe(400);
    expect(await storedOwner(api, "orchestrator:user:local-user")).toEqual({
      type: "user",
      id: "local-user",
    });
  });

  it("refuses to move a child session — it follows its parent", async () => {
    api = await bootTestApi();
    await seedTeam(api, "team_child", ["local-user"]);
    await seedSession(api, { id: "mv-parent", owner: { type: "user", id: "local-user" } });
    await seedSession(api, { id: "mv-child", owner: { type: "user", id: "local-user" } });
    await api.providers.db.insert(childWatches).values({
      childSessionId: "mv-child",
      queueItemId: "qi-mv-child",
      parentSessionId: "mv-parent",
      parentThreadId: "web:default",
      actorUserId: "local-user",
      orgId: "local-org",
      createdAt: Date.now(),
    });

    const res = await patch(api, "mv-child", { teamId: "team_child" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("child session");
    expect(await storedOwner(api, "mv-child")).toEqual({ type: "user", id: "local-user" });
  });

  it("404s for another user's personal session — org admin included", async () => {
    api = await bootTestApi();
    // local-user is org admin, but a PERSONAL session of another user is not
    // theirs to administer (`canAdministerSession` has no org-admin branch
    // for user-owned rows).
    await seedSession(api, {
      id: "mv-authz",
      owner: { type: "user", id: "test-member" },
      userId: "test-member",
    });
    await seedTeam(api, "team_authz", ["local-user"]);

    const res = await patch(api, "mv-authz", { teamId: "team_authz" });
    expect(res.status).toBe(404);
    expect(await storedOwner(api, "mv-authz")).toEqual({ type: "user", id: "test-member" });
  });

  it("a personal move re-stamps userId so the mover can administer it", async () => {
    api = await bootTestApi();
    // The row's creator is test-member; local-user (a team admin of the
    // owning team) takes it personal. Without the userId re-stamp, the
    // access checks would still answer to test-member and the mover could
    // not even rename what they now own.
    await seedTeam(api, "team_take", ["local-user", "test-member"]);
    await seedSession(api, {
      id: "mv-take",
      owner: { type: "team", id: "team_take" },
      userId: "test-member",
    });

    const res = await patch(api, "mv-take", { teamId: null });
    expect(res.status).toBe(200);
    expect(await storedOwner(api, "mv-take")).toEqual({ type: "user", id: "local-user" });

    const rename = await patch(api, "mv-take", { title: "Mine now" });
    expect(rename.status).toBe(200);
  });
});
