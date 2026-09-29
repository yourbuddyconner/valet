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
});
