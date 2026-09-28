import { afterEach, describe, expect, it } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { createTeam, addMember } from "../services/teams.js";
import type { CreateWorkflowResponse, EnsureWorkflowConversationResponse } from "../wire/types.js";

let api: TestApi | undefined;
afterEach(async () => { await api?.cleanup(); api = undefined; });
const definition = { version: "dag/v1", nodes: [{ id: "trigger", type: "trigger" }, { id: "stop", type: "stop" }], edges: [{ from: "trigger", to: "stop" }] };
async function workflow(baseUrl: string, teamId?: string) {
  const response = await fetch(`${baseUrl}/api/workflows`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Editor", definition, teamId }) });
  expect(response.status).toBe(201);
  return await response.json() as CreateWorkflowResponse;
}
async function open(baseUrl: string, id: string, userId = "local-user") {
  const response = await fetch(`${baseUrl}/api/workflows/${id}/conversation`, { method: "POST", headers: { "x-valet-test-user-id": userId } });
  expect(response.status).toBe(200);
  return await response.json() as EnsureWorkflowConversationResponse;
}
describe("workflow editor conversation", () => {
  it("converges concurrent opens and preserves the thread on reopen without submitting prompts", async () => {
    api = await bootTestApi();
    const wf = await workflow(api.baseUrl);
    const opened = await Promise.all(Array.from({ length: 6 }, () => open(api!.baseUrl, wf.id)));
    expect(new Set(opened.map(row => row.threadId)).size).toBe(1);
    expect(await open(api.baseUrl, wf.id)).toEqual(opened[0]);
    const threads = await api.providers.engineStore.listThreads(opened[0]!.sessionId);
    expect(threads.filter(thread => thread.key === `workflow:${wf.id}`)).toHaveLength(1);
    expect(await api.providers.engineStore.getEntries(opened[0]!.sessionId, opened[0]!.threadId)).toEqual([]);
    const other = await workflow(api.baseUrl);
    expect((await open(api.baseUrl, other.id)).threadId).not.toBe(opened[0]!.threadId);
  });
  it("shares a team thread with members and rejects unrelated users and workflows", async () => {
    api = await bootTestApi();
    const team = await createTeam(api.providers.db, { orgId: "local-org", name: "Editors", creatorUserId: "local-user" });
    await addMember(api.providers.db, { teamId: team.id, userId: "test-member", role: "member" });
    const wf = await workflow(api.baseUrl, team.id);
    expect(await open(api.baseUrl, wf.id, "test-member")).toEqual(await open(api.baseUrl, wf.id));
    const personal = await workflow(api.baseUrl);
    for (const id of [personal.id, "missing"]) {
      const response = await fetch(`${api.baseUrl}/api/workflows/${id}/conversation`, { method: "POST", headers: { "x-valet-test-user-id": "test-member" } });
      expect(response.status).toBe(404);
    }
  });
});
