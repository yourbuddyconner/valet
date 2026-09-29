/**
 * `POST /api/sessions/:id/decisions/:gateId/resolve` — the route-level
 * `always_allow` admin gate (action-policies plan, Task 4). Defense-in-depth
 * front half: `policies/service.ts`'s `writeAlwaysAllowPolicy` already fails
 * a non-admin resolution closed (`AlwaysAllowNotAdminError`, T3), but only
 * AFTER the engine has consumed the gate. This route rejects a non-admin's
 * `always_allow` submission before it ever reaches the engine/gate lookup —
 * placed ahead of the "gate is pending" check below, so it 403s even for a
 * bogus/nonexistent gateId, which is what these tests exercise (no real
 * decision gate needs to exist for the 403 case).
 */
import { eq } from "drizzle-orm";
import { agentSessions, teams, teamMembers, workflowDefinitions } from "../schema/index.js";
import { ensureWorkflowSession } from "../workflows/engine-deps.js";
import { describe, it, expect, afterEach } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import type { CreateSessionResponse } from "../wire/types.js";

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

async function createSession(baseUrl: string, headers?: Record<string, string>): Promise<string> {
  const res = await fetch(`${baseUrl}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ workspace: "/tmp" }),
  });
  expect(res.status).toBe(201);
  const { id } = (await res.json()) as CreateSessionResponse;
  return id;
}

describe("POST /decisions/:gateId/resolve — always_allow admin gate", () => {
  it("403s for a non-admin resolver, before the gate-pending lookup (bogus gateId still 403s)", async () => {
    api = await bootTestApi();
    // test-member is seeded as a non-admin org member — see _setup.ts.
    const memberHeaders = { "x-valet-test-user-id": "test-member" };
    const sessionId = await createSession(api.baseUrl, memberHeaders);

    const res = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/decisions/nonexistent-gate/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...memberHeaders },
      body: JSON.stringify({ actionId: "always_allow" }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "org admin required for always_allow" });
  });

  it("does not 403 an admin resolver on always_allow (falls through to the gate-pending 404)", async () => {
    api = await bootTestApi();
    // local-user is the seeded org admin — see _setup.ts.
    const sessionId = await createSession(api.baseUrl);

    const res = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/decisions/nonexistent-gate/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actionId: "always_allow" }),
    });
    // Admin clears the always_allow gate — falls through to the ordinary
    // "gate not pending" 404 (no real gate exists in this test), proving
    // the 403 is specifically the non-admin path, not a blanket block.
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "gate not pending" });
  });

  it("does not gate a plain actionId (only always_allow triggers the admin check)", async () => {
    api = await bootTestApi();
    const memberHeaders = { "x-valet-test-user-id": "test-member" };
    const sessionId = await createSession(api.baseUrl, memberHeaders);

    const res = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/decisions/nonexistent-gate/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...memberHeaders },
      body: JSON.stringify({ actionId: "approve" }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "gate not pending" });
  });
});

it("lets current team members reach an existing workflow agent gate without an app session row", async () => {
  api = await bootTestApi();
  const p = api.providers;
  const now = Date.now();
  await p.db.insert(teams).values({ id: "approval-team", orgId: "local-org", name: "Approval team", createdAt: now });
  await p.db.insert(teamMembers).values({ teamId: "approval-team", userId: "local-user", role: "member" });
  await p.db.insert(workflowDefinitions).values({ id: "approval-workflow", orgId: "local-org", ownerType: "team", ownerId: "approval-team", name: "Approval workflow", definition: {}, createdAt: now, updatedAt: now });
  await p.workflowStore.createRun("approval-run", { workflowId: "approval-workflow", definitionVersionId: "v1" },
    { version: "dag/v1", nodes: [], edges: [] }, "v1", { ownerType: "team", ownerId: "approval-team" });
  const sessionId = "wf:approval-run:triage";
  const session = await ensureWorkflowSession({ db: p.db, store: p.workflowStore, engineStore: p.engineStore,
    host: p.engineHost, actionPluginByService: p.actionPluginByService, credentials: p.engineCredentials }, sessionId);
  const threadId = session.thread().id;
  await p.engineStore.saveDecisionGate(sessionId, threadId, {
    id: "join-channel", sessionId, threadId, queueItemId: "q", resumeKey: "join", ordinal: 0,
    type: "approval", title: "Approve Join Channel?", actions: [{ id: "approve", label: "Approve" }],
    status: "pending", createdAt: now, updatedAt: now,
  });
  expect(await p.db.select().from(agentSessions).where(eq(agentSessions.id, sessionId))).toEqual([]);
  const base = `${api.baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/decisions`;
  const get = await fetch(base);
  expect(get.status).toBe(200);
  expect(await get.json()).toMatchObject({ gates: [{ id: "join-channel", title: "Approve Join Channel?" }] });
  const outsider = { "x-valet-test-user-id": "test-member", "Content-Type": "application/json" };
  expect((await fetch(base, { headers: outsider })).status).toBe(404);
  expect((await fetch(`${base}/join-channel/resolve`, { method: "POST", headers: outsider, body: JSON.stringify({ actionId: "approve" }) })).status).toBe(404);
  const threadBase = `${api.baseUrl}/api/threads/${threadId}/decisions`;
  expect((await fetch(threadBase)).status).toBe(200);
  expect((await fetch(threadBase, { headers: outsider })).status).toBe(404);
  expect((await fetch(`${api.baseUrl}/api/threads/${threadId}/messages`)).status).toBe(404);
  const approved = await fetch(`${threadBase}/join-channel/resolve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ actionId: "approve" }) });
  expect(approved.status).toBe(200);
  expect(await p.engineStore.getDecisionGate(sessionId, "join-channel")).toMatchObject({ status: "resolved", resolution: { actionId: "approve", resolvedBy: "local-user" } });
  const guessed = "wf:approval-run:never-created";
  expect((await fetch(`${api.baseUrl}/api/sessions/${encodeURIComponent(guessed)}/decisions`)).status).toBe(404);
  expect(await p.engineStore.getSession(guessed)).toBeNull();
  await p.workflowStore.createRun("org-approval-run", { workflowId: "approval-workflow", definitionVersionId: "v1" },
    { version: "dag/v1", nodes: [], edges: [] }, "v1", { ownerType: "org", ownerId: "local-org" });
  await ensureWorkflowSession({ db: p.db, store: p.workflowStore, engineStore: p.engineStore,
    host: p.engineHost, actionPluginByService: p.actionPluginByService, credentials: p.engineCredentials }, "wf:org-approval-run:triage");
  const orgBase = `${api.baseUrl}/api/sessions/wf%3Aorg-approval-run%3Atriage/decisions`;
  expect((await fetch(orgBase)).status).toBe(200);
  expect((await fetch(orgBase, { headers: outsider })).status).toBe(404);
  const orgResolve = await fetch(`${orgBase}/missing/resolve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ actionId: "approve" }) });
  expect(await orgResolve.json()).toEqual({ error: "gate not pending" });
  await p.db.delete(teamMembers).where(eq(teamMembers.teamId, "approval-team"));
  expect((await fetch(base)).status).toBe(404);
});
