import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { resolveDefaultAssistant } from "../assistants/service.js";
import { agentSessions, assistants, childWatches, teams, teamMembers } from "../schema/index.js";
import type { ChildWorkResponse, CreateTeamResponse, CreateTeamApiKeyResponse } from "../wire/types.js";
let api: TestApi | undefined;
afterEach(async () => { await api?.cleanup(); api = undefined; });
const local = { type: "user", id: "local-user" } as const;
async function seedChildren(target: TestApi, parent: string, owner: { type: "user" | "team"; id: string } = local, total = 1, running = 0) {
  await target.providers.db.insert(agentSessions).values(Array.from({ length: total }, (_, i) => ({ id: `${parent}-child-${String(i).padStart(3, "0")}`, userId: "local-user", orgId: "local-org", workspace: "/tmp/test", ownerType: owner.type, ownerId: owner.id, title: `Work ${i}`, createdAt: 10, updatedAt: 10 })));
  await target.providers.db.insert(childWatches).values(Array.from({ length: total }, (_, i) => ({ childSessionId: `${parent}-child-${String(i).padStart(3, "0")}`, parentSessionId: parent, parentThreadId: "thread", queueItemId: `q-${parent}-${i}`, actorUserId: "local-user", orgId: "local-org", settled: i >= running, createdAt: 10 })));
}
async function list(target: TestApi, parent: string, suffix = "", headers?: Record<string, string>) {
  return fetch(`${target.baseUrl}/api/sessions/${encodeURIComponent(parent)}/children${suffix}`, { headers });
}
async function dismiss(target: TestApi, parent: string, child: string) {
  return fetch(`${target.baseUrl}/api/sessions/${encodeURIComponent(parent)}/children/${encodeURIComponent(child)}/dismiss`, { method: "POST" });
}
describe("parent-scoped child work", () => {
  it("authorizes a runtime before materialization and paginates running first with stable ties", async () => {
    api = await bootTestApi();
    const parent = await resolveDefaultAssistant(api.providers.db, "local-org", local);
    await api.providers.db.update(assistants).set({ sessionId: "runtime-without-assistant-prefix" }).where(eq(assistants.id, parent.id));
    parent.sessionId = "runtime-without-assistant-prefix";
    await seedChildren(api, parent.sessionId, local, 34, 29);
    const first = await (await list(api, parent.sessionId)).json() as ChildWorkResponse;
    expect(first.children).toHaveLength(25);
    expect(first.runningCount).toBe(29);
    expect(first.children.every(child => child.status === "running")).toBe(true);
    const second = await (await list(api, parent.sessionId, `?cursor=${first.nextCursor}`)).json() as ChildWorkResponse;
    expect(second.children).toHaveLength(9);
    expect(second.nextCursor).toBeNull();
    expect(second.runningCount).toBe(29);
    const ids = [...first.children, ...second.children].map(child => child.sessionId);
    expect(new Set(ids).size).toBe(34);
    expect(ids[0]).toBe(`${parent.sessionId}-child-028`);
    expect(second.children.slice(0, 4).every(child => child.status === "running")).toBe(true);
    const other = await resolveDefaultAssistant(api.providers.db, "local-org", { type: "team", id: "other" });
    await api.providers.db.insert(teams).values({ id: "other", orgId: "local-org", name: "Other", createdAt: 1 });
    await api.providers.db.insert(teamMembers).values({ teamId: "other", userId: "local-user", role: "member" });
    expect((await list(api, other.sessionId, `?cursor=${first.nextCursor}`)).status).toBe(400);
    expect((await list(api, parent.sessionId, "?cursor=invalid")).status).toBe(400);
    expect((await list(api, parent.sessionId, "?limit=0")).status).toBe(400);
  });
  it("caps pages at100 and keeps the full running count", async () => {
    api = await bootTestApi();
    const parent = await resolveDefaultAssistant(api.providers.db, "local-org", local);
    await seedChildren(api, parent.sessionId, local, 105, 105);
    const page = (await (await list(api, parent.sessionId, "?limit=1000")).json()) as ChildWorkResponse;
    expect(page.children).toHaveLength(100);
    expect(page.runningCount).toBe(105);
    expect(page.nextCursor).toBeTruthy();
  });
  it("fences cross-org parents and hides inaccessible team and personal work", async () => {
    api = await bootTestApi();
    const mine = await resolveDefaultAssistant(api.providers.db, "local-org", local);
    const team = await resolveDefaultAssistant(api.providers.db, "local-org", { type: "team", id: "team" });
    const foreign = await resolveDefaultAssistant(api.providers.db, "other-org", local);
    expect((await list(api, mine.sessionId, "", { "x-valet-test-user-id": "test-member" })).status).toBe(404);
    expect((await list(api, team.sessionId)).status).toBe(404);
    expect((await list(api, foreign.sessionId)).status).toBe(404);
    expect((await list(api, "missing")).status).toBe(404);
    for (const path of ["/api/orchestrator/children", "/api/teams/team/children"]) expect((await fetch(`${api.baseUrl}${path}`)).status).toBe(404);
  });
  it("scopes dismiss to parent, refuses running children, preserves history and first dismissal timestamp", async () => {
    api = await bootTestApi();
    const parent = await resolveDefaultAssistant(api.providers.db, "local-org", local);
    await seedChildren(api, parent.sessionId, local, 2, 1);
    const running = `${parent.sessionId}-child-000`, settled = `${parent.sessionId}-child-001`;
    expect((await dismiss(api, parent.sessionId, running)).status).toBe(409);
    await api.providers.db.insert(agentSessions).values({ id: "wrong-parent", orgId: "local-org", userId: "local-user", ownerType: "user", ownerId: "local-user", workspace: "/tmp/other", createdAt: 1, updatedAt: 1 });
    expect((await dismiss(api, "wrong-parent", settled)).status).toBe(404);
    expect((await dismiss(api, parent.sessionId, settled)).status).toBe(200);
    const [first] = await api.providers.db.select().from(childWatches).where(eq(childWatches.childSessionId, settled));
    expect((await dismiss(api, parent.sessionId, settled)).status).toBe(200);
    const [second] = await api.providers.db.select().from(childWatches).where(eq(childWatches.childSessionId, settled));
    expect(second?.dismissedAt).toBe(first?.dismissedAt);
    expect(await api.providers.db.select().from(agentSessions).where(eq(agentSessions.id, settled))).toHaveLength(1);
    expect(((await (await list(api, parent.sessionId)).json()) as ChildWorkResponse).children).toHaveLength(1);
  });
  it("hides and refuses dismissal of work moved to another workspace", async () => {
    api = await bootTestApi();
    await api.providers.db.insert(agentSessions).values({ id: "ordinary", userId: "local-user", orgId: "local-org", workspace: "/tmp/test", ownerType: "user", ownerId: "local-user", createdAt: 1, updatedAt: 1 });
    await seedChildren(api, "ordinary", local, 1, 1);
    expect(((await (await list(api, "ordinary")).json()) as ChildWorkResponse).children).toHaveLength(1);
    await api.providers.db.update(agentSessions).set({ ownerType: "team", ownerId: "elsewhere" }).where(eq(agentSessions.id, "ordinary-child-000"));
    const afterMove = (await (await list(api, "ordinary")).json()) as ChildWorkResponse;
    expect(afterMove.children).toHaveLength(0);
    expect(afterMove.runningCount).toBe(0);
    expect((await dismiss(api, "ordinary", "ordinary-child-000")).status).toBe(404);
  });
  it("admits team keys only to their own parent", async () => {
    api = await bootTestApi({ auth: true });
    const signup = await fetch(`${api.baseUrl}/api/auth/sign-up/email`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "child@nowhere.test", name: "Admin", password: "correct-horse-battery" }) });
    const cookie = signup.headers.get("set-cookie")?.match(/better-auth\.session_token=[^;]+/)?.[0];
    if (!cookie) throw new Error("Missing session cookie");
    const team = await (await fetch(`${api.baseUrl}/api/teams`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "Child team" }) })).json() as CreateTeamResponse;
    const key = await (await fetch(`${api.baseUrl}/api/teams/${team.team.id}/api-keys`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "CI" }) })).json() as CreateTeamApiKeyResponse;
    const runtime = await (await fetch(`${api.baseUrl}/api/workspaces/${team.team.id}/runtime`, { method: "POST", headers: { "x-api-key": key.key } })).json() as { sessionId: string };
    expect((await list(api, runtime.sessionId, "", { "x-api-key": key.key })).status).toBe(200);
    const personal = await (await fetch(`${api.baseUrl}/api/workspaces/user/runtime`, { method: "POST", headers: { cookie } })).json() as { sessionId: string };
    expect((await list(api, personal.sessionId, "", { "x-api-key": key.key })).status).toBe(404);
  });
});
