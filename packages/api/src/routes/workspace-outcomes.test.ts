import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import { workspaceActiveWorkRouter } from "./workspace-active-work.js";
import { workspaceOutcomesRouter } from "./workspace-outcomes.js";
import { sql, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { actionInvocations, agentSessions, teams, teamMembers, workflowDefinitions, workflowRuns, assistants, sessionThreads } from "../schema/index.js";
import { encodePageCursor } from "../lib/page-cursor.js";
import { safeOutcomeUrl } from "../services/workspace-outcomes.js";
import type { WorkspaceOutcomesResponse, WorkspaceActiveWorkResponse } from "../wire/types.js";

let api: TestApi | undefined;
afterEach(async () => { await api?.cleanup(); api = undefined; });
async function setup() {
  const target = await bootTestApi(); api = target;
  const db = target.providers.db;
  await db.insert(teams).values([
    { id: "team", orgId: "local-org", name: "Team", createdAt: 1 },
    { id: "foreign", orgId: "other-org", name: "Foreign", createdAt: 1 },
  ]);
  await db.insert(teamMembers).values({ teamId: "team", userId: "local-user", role: "member" });
  await db.insert(agentSessions).values([
    { id: "own", ownerType: "user", ownerId: "local-user", orgId: "local-org", userId: "local-user", workspace: "w", createdAt: 1, updatedAt: 1 },
    { id: "other", ownerType: "user", ownerId: "test-member", orgId: "local-org", userId: "test-member", workspace: "w", createdAt: 1, updatedAt: 1 },
    { id: "team-work", ownerType: "team", ownerId: "team", orgId: "local-org", userId: "local-user", workspace: "w", createdAt: 1, updatedAt: 1 },
    { id: "foreign-work", ownerType: "user", ownerId: "local-user", orgId: "other-org", userId: "local-user", workspace: "w", createdAt: 1, updatedAt: 1 },
  ]);
  return target;
}
async function list(target: TestApi, workspace = "user", query = "") {
  const response = await fetch(`${target.baseUrl}/api/workspaces/${workspace}/outcomes${query}`);
  expect(response.status).toBe(200);
  return await response.json() as WorkspaceOutcomesResponse;
}

describe("workspace confirmed outcomes", () => {
  it("returns only confirmed writes and safe source fields, with stable pagination", async () => {
    const target = await setup(); const db = target.providers.db;
    const base = { createdAt: 100, orgId: "local-org", sessionId: "own", service: "github", status: "completed" as const, durationMs: 5 };
    await db.insert(actionInvocations).values([
      { ...base, invocationId: "pr", actionId: "github.create_pull_request", params: { body: "secret request" }, result: { success: true, data: { title: "Ship fix", html_url: "https://example.com/pull/1", body: "secret result" } } },
      { ...base, invocationId: "review", actionId: "github.create_review", result: { success: true, data: { state: "APPROVED", html_url: "https://example.com/pull/1#review" } } },
      { ...base, invocationId: "slack", actionId: "slack.send_message", result: { success: true, data: { channel: "C1", permalink: "javascript:alert(1)", text: "private message" } } },
      { ...base, invocationId: "pending-review", actionId: "github.create_review", result: { success: true, data: { state: "PENDING" } } },
      { ...base, invocationId: "failed", actionId: "github.create_pull_request", result: { success: false } },
      { ...base, invocationId: "attempt", actionId: "github.create_pull_request", durationMs: null, result: { success: true } },
      { ...base, invocationId: "denied", actionId: "github.create_pull_request", status: "denied", result: { success: true } },
    ]);
    const terminal = JSON.stringify([{ type: "tool_call", toolName: "bash", status: "completed", result: { details: { outcome: { kind: "pull_request_created", url: "https://example.com/pull/2" } } } }]);
    await db.execute(sql`INSERT INTO engine_entries (id,session_id,thread_id,entry_type,role,parts,created_at)
      VALUES ('entry','own','thread','message','assistant',${terminal},101)`);
    const first = await list(target, "user", "?limit=2");
    expect(first.items.map(i => i.id)).toEqual(["terminal:entry:1", "action:slack"]);
    expect(first.items[0]).toMatchObject({ kind: "pull_request", threadId: "thread", sessionId: "own", url: "https://example.com/pull/2" });
    expect(first.items[1].url).toBeUndefined();
    const second = await list(target, "user", `?limit=2&cursor=${first.nextCursor}`);
    expect(second.items.map(i => i.id)).toEqual(["action:review", "action:pr"]);
    expect(second.items[1]).toMatchObject({ title: "Ship fix", url: "https://example.com/pull/1" });
    expect(second.nextCursor).toBeNull();
    expect(JSON.stringify([first, second])).not.toMatch(/secret|private message|params|body/);
    for (const bad of ["?cursor=bad", "?limit=0", "?limit=1.5", `?cursor=${encodePageCursor({ feed: "outcomes", orgId: "other", ownerType: "user", ownerId: "local-user", at: 100, id: "a" })}`]) {
      expect((await fetch(`${target.baseUrl}/api/workspaces/user/outcomes${bad}`)).status).toBe(400);
    }
    expect((await fetch(`${target.baseUrl}/api/workspaces/team/outcomes?cursor=${first.nextCursor}`)).status).toBe(400);
  });
  it("fences owners, current membership and organizations before paging", async () => {
    const target = await setup(); const db = target.providers.db;
    await db.insert(actionInvocations).values(["own", "other", "team-work", "foreign-work"].map(sessionId => ({
      invocationId: sessionId, sessionId, orgId: "local-org", createdAt: 100, durationMs: 1,
      actionId: "slack.send_message", status: "completed" as const, result: { success: true },
    })));
    expect((await list(target)).items.map(i => i.id)).toEqual(["action:own"]);
    expect((await list(target, "team")).items.map(i => i.id)).toEqual(["action:team-work"]);
    for (const scope of ["missing", "foreign"]) expect((await fetch(`${target.baseUrl}/api/workspaces/${scope}/outcomes`)).status).toBe(404);
    await db.delete(teamMembers).where(eq(teamMembers.userId, "local-user"));
    expect((await fetch(`${target.baseUrl}/api/workspaces/team/outcomes`)).status).toBe(404);
    expect((await list(target)).items.map(i => i.id)).toEqual(["action:own"]);
  });
  it("resolves workflow-only sources and limits team principals to their own workspace", async () => {
    const target = await setup(); const db = target.providers.db;
    await db.insert(workflowDefinitions).values({ id: "wf", orgId: "local-org", ownerType: "team", ownerId: "team", name: "Workflow", definition: {}, createdAt: 1, updatedAt: 1 });
    await db.insert(workflowRuns).values({ id: "run", workflowId: "wf", definitionVersionId: "version", definition: {}, params: {}, ownerType: "team", ownerId: "team", createdAt: 1, updatedAt: 1 });
    await db.insert(actionInvocations).values({ invocationId: "workflow-action", workflowExecutionId: "run", orgId: "local-org", createdAt: 100, durationMs: 1, actionId: "slack.send_message", status: "completed", result: { success: true } });
    const parts = JSON.stringify([{ type: "tool_call", toolName: "bash", status: "completed", result: { details: { outcome: { kind: "review_submitted" } } } }]);
    await db.execute(sql`INSERT INTO engine_entries (id,session_id,thread_id,entry_type,role,parts,created_at)
      VALUES ('workflow-entry','wf:run:step','workflow-thread','message','assistant',${parts},101)`);
    expect((await list(target)).items).toEqual([]);
    const workflowOutcomes = (await list(target, "team")).items;
    expect(workflowOutcomes).toHaveLength(2);
    expect(workflowOutcomes.every(item => item.workflowRunId === "run" && !item.sessionId)).toBe(true);
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("providers", target.providers);
      c.set("user", { id: "local-user", email: "local@dev", role: "admin", orgId: "local-org" });
      c.set("principal", { type: "team", id: "team" });
      await next();
    });
    app.route("/api/workspaces", workspaceOutcomesRouter);
    await db.delete(teamMembers).where(eq(teamMembers.userId, "local-user"));
    expect((await app.request("/api/workspaces/team/outcomes")).status).toBe(200);
    for (const workspace of ["user", "foreign", "missing"]) {
      expect((await app.request(`/api/workspaces/${workspace}/outcomes`)).status).toBe(404);
    }
  });
  it("rejects non-web sources and embedded credentials", () => {
    for (const value of [null, "file:///tmp/a", "javascript:alert(1)", "https://user:password@example.com", "invalid"]) expect(safeOutcomeUrl(value)).toBeUndefined();
    expect(safeOutcomeUrl("https://example.com/pull/1")).toBe("https://example.com/pull/1");
  });
});


describe("workspace active work", () => {
  it("finds old runtime and child work before paging and fences source titles", async () => {
    const target = await setup(); const db = target.providers.db;
    await db.insert(assistants).values({ id: "runtime", orgId: "local-org", ownerType: "user", ownerId: "local-user", sessionId: "own", createdAt: 1 });
    await db.insert(agentSessions).values([
      { id: "child", ownerType: "user", ownerId: "local-user", orgId: "local-org", userId: "local-user", title: "Child work", workspace: "w", createdAt: 1, updatedAt: 1 },
      ...Array.from({ length: 30 }, (_, i) => ({ id: `idle-${i}`, ownerType: "user" as const, ownerId: "local-user", orgId: "local-org", userId: "local-user", workspace: "w", createdAt: 1000, updatedAt: 1000 })),
    ]);
    await db.insert(sessionThreads).values([
      { id: "own-thread", sessionId: "own", title: "Runtime request", createdAt: 1 },
      { id: "foreign-title", sessionId: "other", title: "Private other title", createdAt: 1 },
    ]);
    for (const [id, session, thread, status, outcome] of [
      ["runtime-q", "own", "own-thread", "blocked_on_decision_gate", null],
      ["child-q", "child", "foreign-title", "running", null],
      ["failed-q", "child", "failed-thread", "terminalizing", "failed"],
      ["complete-q", "own", "own-thread", "terminalizing", "completed"],
      ["settled-q", "own", "own-thread", "settled", "failed"],
      ["other-q", "other", "other-thread", "running", null],
      ["foreign-q", "foreign-work", "foreign-thread", "running", null],
      ["team-q", "team-work", "team-thread", "running", null],
    ]) {
      await db.execute(sql`INSERT INTO engine_queue_items (id,session_id,thread_id,status,outcome,content,attempt_count,max_attempts,timeout_at,created_at,updated_at)
        VALUES (${id},${session},${thread},${status},${outcome},'secret prompt',1,1,10000,1,2)`);
    }
    const request = async (query = "") => {
      const response = await fetch(`${target.baseUrl}/api/workspaces/user/active-work${query}`);
      expect(response.status).toBe(200);
      return await response.json() as WorkspaceActiveWorkResponse;
    };
    const first = await request("?limit=2");
    expect(first.items.map(i => [i.id, i.state])).toEqual([["runtime-q", "needs_you"], ["failed-q", "failed"]]);
    expect(first.items[0].title).toBe("Runtime request");
    const second = await request(`?limit=2&cursor=${first.nextCursor}`);
    expect(second.items).toEqual([{ id: "child-q", sessionId: "child", threadId: "foreign-title", title: "Child work", state: "working", updatedAt: 2 }]);
    expect(second.nextCursor).toBeNull();
    expect(JSON.stringify([first, second])).not.toMatch(/secret prompt|Private other title/);
    for (const path of [
      `/api/workspaces/team/active-work?cursor=${first.nextCursor}`,
      `/api/workspaces/user/outcomes?cursor=${first.nextCursor}`,
      `/api/workspaces/user/active-work?cursor=${encodePageCursor({ feed: "outcomes", orgId: "local-org", ownerType: "user", ownerId: "local-user", at: 2, id: "runtime-q" })}`,
      "/api/workspaces/user/active-work?limit=0",
      "/api/workspaces/user/active-work?cursor=bad",
    ]) expect((await fetch(`${target.baseUrl}${path}`)).status).toBe(400);
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("providers", target.providers);
      c.set("user", { id: "local-user", email: "local@dev", role: "admin", orgId: "local-org" });
      c.set("principal", { type: "team", id: "team" });
      await next();
    });
    app.route("/api/workspaces", workspaceActiveWorkRouter);
    expect(await (await app.request("/api/workspaces/team/active-work")).json()).toMatchObject({ items: [{ id: "team-q" }] });
    expect((await app.request("/api/workspaces/user/active-work")).status).toBe(404);
    expect((await app.request("/api/workspaces/foreign/active-work")).status).toBe(404);
    await db.delete(teamMembers).where(eq(teamMembers.userId, "local-user"));
    expect((await fetch(`${target.baseUrl}/api/workspaces/team/active-work`)).status).toBe(404);
  });
});
