import { afterEach, describe, expect, it } from "vitest";
import { bootTestApi, type TestApi } from "./_setup.js";
import { assistants, teams, teamMembers } from "../schema/index.js";

let api: TestApi | undefined;
afterEach(async () => { await api?.cleanup(); api = undefined; });
const headers = { "Content-Type": "application/json" };

function idOf(value: unknown): string {
  if (value && typeof value === "object" && "id" in value && typeof value.id === "string") return value.id;
  throw new Error("Expected an assistant response");
}

describe("workspace assistant contract", () => {
  it("concurrent initialization returns one personal assistant", async () => {
    api = await bootTestApi();
    const base = api.baseUrl;
    const responses = await Promise.all(Array.from({ length: 4 }, () => fetch(`${base}/api/assistants`, {
      method: "POST", headers, body: "{}",
    })));
    expect(responses.map(r => r.status)).toEqual([200, 200, 200, 200]);
    const rows = await api.providers.db.select().from(assistants);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.isDefault).toBe(true);
  });

  it("rejects creating customized profiles and editing the workspace assistant", async () => {
    api = await bootTestApi();
    const custom = await fetch(`${api.baseUrl}/api/assistants`, {
      method: "POST", headers, body: JSON.stringify({ name: "Custom agent", personality: "custom" }),
    });
    expect(custom.status).toBe(409);
    await fetch(`${api.baseUrl}/api/assistants`, { method: "POST", headers, body: "{}" });
    const [row] = await api.providers.db.select().from(assistants);
    expect(row).toBeDefined();
    const edited = await fetch(`${api.baseUrl}/api/assistants/${row!.id}`, {
      method: "PATCH", headers, body: JSON.stringify({ name: "Another agent" }),
    });
    expect(edited.status).toBe(409);
    expect((await api.providers.db.select().from(assistants))[0]?.name).toBeNull();
  });
  it("keeps the team singleton separate from personal work and rejects nonmembers", async () => {
    api = await bootTestApi();
    await api.providers.db.insert(teams).values({ id: "team-one", orgId: "local-org", name: "Team", createdAt: Date.now() });
    await api.providers.db.insert(teamMembers).values({ teamId: "team-one", userId: "local-user", role: "admin" });
    const personal = await fetch(`${api.baseUrl}/api/assistants`, { method: "POST", headers, body: "{}" }).then(r => r.json()).then(idOf);
    const initialize = () => fetch(`${api!.baseUrl}/api/assistants`, { method: "POST", headers,
      body: JSON.stringify({ owner: { type: "team", id: "team-one" } }) }).then(r => r.json()).then(idOf);
    const [first, second] = await Promise.all([initialize(), initialize()]);
    expect(first).toBe(second); expect(first).not.toBe(personal);
    const denied = await fetch(`${api.baseUrl}/api/teams/team-one/orchestrator`, {
      method: "POST", headers: { "x-valet-test-user-id": "test-member" },
    });
    expect(denied.status).toBe(404);
    expect(await api.providers.db.select().from(assistants)).toHaveLength(2);
  });

  it("disables the alternate profile editing endpoint without changing the assistant", async () => {
    api = await bootTestApi();
    const response = await fetch(`${api.baseUrl}/api/orchestrator/info`, {
      method: "PATCH", headers, body: JSON.stringify({ name: "Custom", personality: "custom" }),
    });
    expect(response.status).toBe(409);
    expect(await api.providers.db.select().from(assistants)).toHaveLength(0);
  });

  it("rejects assistant routing embedded in workflow definitions", async () => {
    api = await bootTestApi();
    const definition = {
      version: "dag/v1",
      nodes: [{ id: "start", type: "trigger" }, { id: "done", type: "stop", outcome: "success" }],
      edges: [{ from: "start", to: "done" }],
    };
    const rejected = await fetch(`${api.baseUrl}/api/workflows`, {
      method: "POST", headers,
      body: JSON.stringify({ name: "Unsupported routing", definition: { ...definition, assistantId: "other-assistant" } }),
    });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ errors: [expect.stringContaining("Remove assistantId")] });
    const accepted = await fetch(`${api.baseUrl}/api/workflows`, {
      method: "POST", headers, body: JSON.stringify({ name: "Workspace workflow", definition }),
    });
    expect(accepted.status).toBe(201);
    expect(await accepted.json()).toMatchObject({ ownerType: "user", ownerId: "local-user", definition });
  });

});
