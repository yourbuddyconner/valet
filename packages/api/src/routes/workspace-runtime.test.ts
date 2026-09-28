import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { assistants, teams, teamMembers } from "../schema/index.js";
let api: TestApi | undefined;
afterEach(async () => { await api?.cleanup(); api = undefined; });
describe("workspace runtime authorization", () => {
  it("probes without creating, ensures personal runtime idempotently, and removes old entry points", async () => {
    api = await bootTestApi();
    const root = `${api.baseUrl}/api/workspaces/user/runtime`;
    expect(await (await fetch(root)).json()).toEqual({ sessionId: null, exists: false });
    expect(await api.providers.db.select().from(assistants)).toHaveLength(0);
    const first = await (await fetch(root, { method: "POST" })).json();
    expect(await (await fetch(root, { method: "POST" })).json()).toEqual(first);
    for (const path of ["/api/orchestrator", "/api/orchestrator/info", "/api/teams/unknown/orchestrator"]) {
      expect((await fetch(`${api.baseUrl}${path}`, { method: "POST" })).status).toBe(404);
    }
  });
  it("authorizes every operation by the requested team's organization and membership", async () => {
    api = await bootTestApi();
    await api.providers.db.insert(teams).values([
      { id: "same", orgId: "local-org", name: "Same", createdAt: 1 },
      { id: "foreign", orgId: "foreign-org", name: "Foreign", createdAt: 1 },
    ]);
    await api.providers.db.insert(teamMembers).values([
      { teamId: "same", userId: "test-member", role: "member" },
      { teamId: "foreign", userId: "test-member", role: "member" },
    ]);
    for (const workspace of ["same", "foreign", "missing"]) {
      for (const [suffix, method] of [["", "GET"], ["", "POST"], ["/info", "GET"]]) {
        const response = await fetch(`${api.baseUrl}/api/workspaces/${workspace}/runtime${suffix}`, { method, headers: { "x-valet-test-user-id": "test-member" } });
        expect(response.status).toBe(workspace === "same" ? 200 : 404);
      }
    }
    await api.providers.db.delete(teamMembers).where(eq(teamMembers.userId, "test-member"));
    for (const [suffix, method] of [["", "GET"], ["", "POST"], ["/info", "GET"]]) {
      expect((await fetch(`${api.baseUrl}/api/workspaces/same/runtime${suffix}`, { method, headers: { "x-valet-test-user-id": "test-member" } })).status).toBe(404);
    }
  });
});
