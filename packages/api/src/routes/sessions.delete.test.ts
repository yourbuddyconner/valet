import { describe, it, expect, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { agentSessions, assistants, teamMembers, teams } from "../schema/index.js";
import { resolveDefaultAssistant } from "../assistants/service.js";

async function seedSession(
  api: TestApi,
  opts: { id: string; owner: { type: "user" | "team"; id: string } },
): Promise<void> {
  const now = Date.now();
  await api.providers.db.insert(agentSessions).values({
    id: opts.id,
    userId: "local-user",
    orgId: "local-org",
    workspace: `/tmp/delete-test-${opts.id}`,
    status: "active",
    ownerType: opts.owner.type,
    ownerId: opts.owner.id,
    createdAt: now,
    updatedAt: now,
  });
}

async function seedAssistant(
  api: TestApi,
  opts: {
    id: string;
    owner: { type: "user" | "team"; id: string };
    /** Rows migrated from orchestrator_identities keep legacy
     * `orchestrator:*` session ids — pass one to model them. */
    sessionId?: string;
  },
): Promise<void> {
  await api.providers.db.insert(assistants).values({
    id: opts.id,
    orgId: "local-org",
    ownerType: opts.owner.type,
    ownerId: opts.owner.id,
    name: null,
    personality: null,
    behavior: null,
    sessionId: opts.sessionId ?? `assistant:${opts.id}`,
    createdAt: Date.now(),
    archivedAt: null,
  });
}

async function storedStatus(api: TestApi, sessionId: string): Promise<string | undefined> {
  const rows = await api.providers.db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId))
    .limit(1);
  return rows[0]?.status;
}

function del(api: TestApi, sessionId: string) {
  return fetch(`${api.baseUrl}/api/sessions/${sessionId}`, { method: "DELETE" });
}

describe("DELETE /api/sessions/:id — assistant guard", () => {
  let api: TestApi | undefined;

  afterEach(async () => {
    await api?.cleanup();
    api = undefined;
  });

  it("refuses to delete the caller's own assistant session, naming the corrective action", async () => {
    api = await bootTestApi();
    await seedAssistant(api, { id: "asst_mine", owner: { type: "user", id: "local-user" } });
    await seedSession(api, {
      id: "assistant:asst_mine",
      owner: { type: "user", id: "local-user" },
    });

    const res = await del(api, "assistant:asst_mine");
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/cannot be deleted/i);
    expect(body.error).toMatch(/archive individual threads/i);
    expect(await storedStatus(api, "assistant:asst_mine")).toBe("active");
  });

  it("refuses to delete the team singleton even for its admin", async () => {
    api = await bootTestApi();
    const { db, engineHost } = api.providers;
    await db.insert(teams).values({ id: "team_del", orgId: "local-org", name: "Team", createdAt: Date.now() });
    await db.insert(teamMembers).values({ teamId: "team_del", userId: "local-user", role: "admin" });
    await seedAssistant(api, { id: "asst_team", owner: { type: "team", id: "team_del" } });
    await seedSession(api, { id: "assistant:asst_team", owner: { type: "team", id: "team_del" } });
    const destroy = vi.spyOn(engineHost, "destroy");
    expect((await del(api, "assistant:asst_team")).status).toBe(409);
    expect(await storedStatus(api, "assistant:asst_team")).toBe("active");
    expect(destroy).not.toHaveBeenCalled();
    const same = await resolveDefaultAssistant(db, "local-org", { type: "team", id: "team_del" });
    expect(same.id).toBe("asst_team");
    expect(same.archivedAt).toBeNull();
  });

  it("still deletes a plain personal session", async () => {
    api = await bootTestApi();
    await seedSession(api, { id: "plain-sess", owner: { type: "user", id: "local-user" } });

    const res = await del(api, "plain-sess");
    expect(res.status).toBe(200);
    expect(await storedStatus(api, "plain-sess")).toBe("deleted");
  });

  it("keeps the session visible when teardown fails and permits deletion retry", async () => {
    api = await bootTestApi();
    await seedSession(api, { id: "audit-retry", owner: { type: "user", id: "local-user" } });
    const destroy = vi.spyOn(api.providers.engineHost, "destroy").mockRejectedValueOnce(new Error("Audit export failed. Restore audit storage before deleting the sandbox."));
    const failed = await del(api, "audit-retry");
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({ error: "Audit export failed. Restore audit storage before deleting the sandbox." });
    expect(await storedStatus(api, "audit-retry")).toBe("active");
    expect(destroy).toHaveBeenCalledTimes(1);
    expect((await del(api, "audit-retry")).status).toBe(200);
    expect(await storedStatus(api, "audit-retry")).toBe("deleted");
  });

  // Rows migrated from orchestrator_identities keep legacy `orchestrator:*`
  // session ids that `parseAssistantSessionId` cannot recognize; the guard
  // must use the assistants.session_id column to protect those sessions.
  it("refuses a migrated personal assistant with a legacy session id", async () => {
    api = await bootTestApi();
    await seedAssistant(api, {
      id: "asst_legacy_me",
      owner: { type: "user", id: "local-user" },
      sessionId: "orchestrator:user:local-user",
    });
    await seedSession(api, {
      id: "orchestrator:user:local-user",
      owner: { type: "user", id: "local-user" },
    });

    const res = await del(api, "orchestrator:user:local-user");
    expect(res.status).toBe(409);
    expect(await storedStatus(api, "orchestrator:user:local-user")).toBe("active");
  });

  it.each(["active", "deleted"] as const)("does not bypass the singleton guard with a legacy cleanup flag (%s)", async status => {
    api = await bootTestApi();
    const { db, engineHost } = api.providers;
    await db.insert(teams).values({ id: "team_legacy", orgId: "local-org", name: "Team", createdAt: Date.now() });
    await db.insert(teamMembers).values({ teamId: "team_legacy", userId: "local-user", role: "admin" });
    const id = "orchestrator:team:team_legacy";
    await seedAssistant(api, { id: "asst_legacy", owner: { type: "team", id: "team_legacy" }, sessionId: id });
    await seedSession(api, { id, owner: { type: "team", id: "team_legacy" } });
    await db.update(agentSessions).set({ status, credentialOwnerMode: "actor" }).where(eq(agentSessions.id, id));
    const destroy = vi.spyOn(engineHost, "destroy");
    expect((await del(api, `${id}?retireLegacyTeam=true`)).status).toBe(409);
    expect(destroy).not.toHaveBeenCalled();
    const [row] = await db.select().from(assistants).where(eq(assistants.id, "asst_legacy"));
    expect(row?.archivedAt).toBeNull();
    expect(await storedStatus(api, id)).toBe(status);
  });

  it("does not expose another user's assistant through delete", async () => {
    api = await bootTestApi();
    await seedAssistant(api, { id: "asst_other", owner: { type: "user", id: "local-user" } });
    await seedSession(api, { id: "assistant:asst_other", owner: { type: "user", id: "local-user" } });
    expect((await fetch(`${api.baseUrl}/api/sessions/assistant:asst_other`, { method: "DELETE", headers: { "x-valet-test-user-id": "test-member" } })).status).toBe(404);
    expect(await storedStatus(api, "assistant:asst_other")).toBe("active");
  });
});
