import type { CreateTeamResponse, CreateTeamApiKeyResponse } from "../wire/types.js";
import { eq } from "drizzle-orm";
import { agentSessions, teams, teamMembers } from "../schema/index.js";
import { afterEach, describe, expect, it } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";

let api: TestApi | undefined;
afterEach(async () => { await api?.cleanup(); api = undefined; });

describe("thread addressing compatibility", () => {
  it("creates in the workspace and reads the same history through either address", async () => {
    api = await bootTestApi();
    const created = await fetch(`${api.baseUrl}/api/threads`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "Thread API" }) });
    expect(created.status).toBe(201);
    const thread = await created.json();
    if (!thread || typeof thread !== "object" || !("id" in thread) || typeof thread.id !== "string" || !("sessionId" in thread) || typeof thread.sessionId !== "string") throw new Error("Invalid thread response");
    const detail = await fetch(`${api.baseUrl}/api/threads/${thread.id}`);
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({ id: thread.id, sessionId: thread.sessionId, title: "Thread API" });
    await api.providers.engineStore.appendEntries(thread.sessionId, thread.id, [{ id: "history-proof", sessionId: thread.sessionId, threadId: thread.id, parentId: null, type: "message", role: "user", content: "Preserve this history", createdAt: 1 }]);
    api.providers.engineHost.evictCache(thread.sessionId);
    const legacy = await fetch(`${api.baseUrl}/api/sessions/${encodeURIComponent(thread.sessionId)}/messages?threadId=${thread.id}`);
    const current = await fetch(`${api.baseUrl}/api/threads/${thread.id}/messages`);
    expect(current.status).toBe(200);
    expect(await current.json()).toEqual(await legacy.json());
    const conflict = await fetch(`${api.baseUrl}/api/threads/${thread.id}/messages?threadId=other`);
    expect(conflict.status).toBe(400);
    const bodyConflict = await fetch(`${api.baseUrl}/api/threads/${thread.id}/messages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "wrong thread", threadId: "other" }) });
    expect(bodyConflict.status).toBe(400);
    expect((await fetch(`${api.baseUrl}/api/threads/missing`)).status).toBe(404);
    expect((await fetch(`${api.baseUrl}/api/threads/${thread.id}/messages`, { headers: { "x-valet-test-user-id": "test-member" } })).status).toBe(404);
    await api.providers.db.update(agentSessions).set({ orgId: "different-org" }).where(eq(agentSessions.id, thread.sessionId));
    expect((await fetch(`${api.baseUrl}/api/threads/${thread.id}`)).status).toBe(404);
    await api.providers.db.update(agentSessions).set({ orgId: "local-org" }).where(eq(agentSessions.id, thread.sessionId));
    await api.providers.db.insert(teams).values({ id: "thread-team", orgId: "local-org", name: "Thread team", createdAt: Date.now() });
    await api.providers.db.insert(teamMembers).values({ teamId: "thread-team", userId: "test-member", role: "member" });
    await api.providers.db.update(agentSessions).set({ ownerType: "team", ownerId: "thread-team" }).where(eq(agentSessions.id, thread.sessionId));
    const memberHeaders = { "x-valet-test-user-id": "test-member" };
    expect((await fetch(`${api.baseUrl}/api/threads/${thread.id}`, { headers: memberHeaders })).status).toBe(200);
    await api.providers.db.delete(teamMembers).where(eq(teamMembers.teamId, "thread-team"));
    expect((await fetch(`${api.baseUrl}/api/threads/${thread.id}`, { headers: memberHeaders })).status).toBe(404);
    await api.providers.db.update(agentSessions).set({ ownerType: "user", ownerId: "local-user" }).where(eq(agentSessions.id, thread.sessionId));
    const archive = await fetch(`${api.baseUrl}/api/threads/${thread.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ archived: true }) });
    expect(archive.status).toBe(200);
    const archived = await fetch(`${api.baseUrl}/api/threads?archived=1`);
    expect(await archived.json()).toMatchObject({ threads: expect.arrayContaining([expect.objectContaining({ id: thread.id })]) });
  });
  it("keeps decisions inside their URL thread and denies team-key policy grants", async () => {
    api = await bootTestApi({ auth: true });
    const signup = await fetch(`${api.baseUrl}/api/auth/sign-up/email`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "thread-key@nowhere.test", name: "Admin", password: "correct-horse-battery" }) });
    const cookie = signup.headers.get("set-cookie")?.match(/better-auth\.session_token=[^;]+/)?.[0];
    if (!cookie) throw new Error("Missing session cookie");
    const team = await (await fetch(`${api.baseUrl}/api/teams`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "Thread team" }) })).json() as CreateTeamResponse;
    const key = await (await fetch(`${api.baseUrl}/api/teams/${team.team.id}/api-keys`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "CI" }) })).json() as CreateTeamApiKeyResponse;
    const headers = { "x-api-key": key.key, "content-type": "application/json" };
    expect(await (await fetch(`${api.baseUrl}/api/threads`, { headers })).json()).toEqual({ threads: [] });
    const created = await fetch(`${api.baseUrl}/api/threads`, { method: "POST", headers, body: "{}" });
    expect(created.status).toBe(201);
    const first = await created.json() as { id: string; sessionId: string };
    const second = await (await fetch(`${api.baseUrl}/api/threads`, { method: "POST", headers, body: "{}" })).json() as { id: string; sessionId: string };
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.id).not.toBe(first.id);
    const personal = await (await fetch(`${api.baseUrl}/api/threads`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: "{}" })).json() as { id: string };
    expect((await fetch(`${api.baseUrl}/api/threads/${personal.id}`, { headers })).status).toBe(404);
    expect((await fetch(`${api.baseUrl}/api/threads?workspace=user`, { headers })).status).toBe(404);
    const gate = {
      id: "thread-key-gate", sessionId: first.sessionId, threadId: first.id,
      queueItemId: "q-key", resumeKey: "key", ordinal: 0, type: "approval" as const,
      title: "Approve action?", actions: [{ id: "approve", label: "Approve" }, { id: "always_allow", label: "Always allow" }],
      status: "pending" as const, createdAt: Date.now(), updatedAt: Date.now(),
    };
    await api.providers.engineStore.saveDecisionGate(first.sessionId, first.id, gate);
    expect(await (await fetch(`${api.baseUrl}/api/threads/${second.id}/decisions`, { headers })).json()).toEqual({ gates: [] });
    const resolve = (id: string, actionId: string) => fetch(`${api!.baseUrl}/api/threads/${id}/decisions/${gate.id}/resolve`, { method: "POST", headers, body: JSON.stringify({ actionId }) });
    expect((await resolve(second.id, "approve")).status).toBe(404);
    expect((await resolve(first.id, "always_allow")).status).toBe(403);
    expect((await api.providers.engineStore.getDecisionGate(first.sessionId, gate.id))?.status).toBe("pending");
    const legacyDenial = await fetch(`${api.baseUrl}/api/sessions/${encodeURIComponent(first.sessionId)}/decisions/${gate.id}/resolve`, { method: "POST", headers, body: JSON.stringify({ actionId: "always_allow" }) });
    expect(legacyDenial.status).toBe(403);
    expect((await resolve(first.id, "approve")).status).toBe(200);
    expect((await api.providers.engineStore.getDecisionGate(first.sessionId, gate.id))?.status).toBe("resolved");
  });

});
