/**
 * `/api/workflows/{triggers,schedules,event-triggers,trigger-catalog,runs}`
 * route tests (spec 2026-08-15). Real Hono app via `bootTestApi` with the
 * github plugin; rows seeded directly through `providers.db`; cross-org cases
 * seed rows under a second org id (stub auth pins the caller to `local-org`).
 */
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import githubPlugin from "@valet/plugin-github/plugin";
import slackPlugin from "@valet/plugin-slack/plugin";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { eventSubscriptions, teamMembers, teams, userIdentityLinks, workflowDefinitions, workflowRuns, workflowSchedules } from "../schema/index.js";
import type {
  CreateWorkflowEventTriggerRequest,
  CreateWorkflowScheduleRequest,
  GetWorkflowTriggerCatalogResponse,
  ListAllWorkflowRunsResponse,
  ListWorkflowTriggersResponse,
  StartWorkflowRunResponse,
  WorkflowEventTriggerResponse,
  WorkflowScheduleResponse,
} from "../wire/types.js";

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

async function boot(): Promise<TestApi> {
  api = await bootTestApi({ plugins: [githubPlugin] });
  return api;
}

const VALID_CRON = "0 9 * * 1-5";

/** Creates a workflow definition row via the API and returns its id. */
async function createWorkflow(baseUrl: string, name = "test-wf"): Promise<string> {
  const res = await fetch(`${baseUrl}/api/workflows`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      definition: {
        version: "dag/v1",
        nodes: [
          { id: "trigger", type: "trigger" },
          { id: "stop", type: "stop" },
        ],
        edges: [{ from: "trigger", to: "stop" }],
      },
    }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { id: string };
  return body.id;
}

/** Seeds a schedule row directly (bypassing route validation). Defaults to
 * a row owned by user `someone` — a different org member than the stub
 * caller (`local-user`). */
async function seedScheduleRow(
  a: TestApi,
  id: string,
  orgId: string,
  opts: { workflowId?: string | null; owner?: { type: "user" | "team"; id: string } } = {},
): Promise<void> {
  const workflowId = opts.workflowId ?? null;
  const owner = opts.owner ?? { type: "user", id: "someone" };
  const now = Date.now();
  await a.providers.db.insert(workflowSchedules).values({
    id,
    orgId,
    ownerType: owner.type,
    ownerId: owner.id,
    targetKind: workflowId ? "workflow" : "orchestrator",
    workflowId,
    prompt: workflowId ? null : "hello",
    name: `seeded ${id}`,
    cron: VALID_CRON,
    timezone: "UTC",
    enabled: true,
    nextFireAt: now + 1000,
    lastFiredAt: null,
    createdBy: "someone",
    createdAt: now,
    updatedAt: now,
  });
}

/** Seeds an event subscription row with a workflow target. */
async function seedEventTriggerRow(
  a: TestApi,
  id: string,
  orgId: string,
  workflowId: string,
): Promise<void> {
  const now = Date.now();
  await a.providers.db.insert(eventSubscriptions).values({
    id,
    orgId,
    ownerType: "user",
    ownerId: "someone",
    name: `seeded trigger ${id}`,
    eventKeys: ["github.pull_request.opened"],
    filters: [],
    target: { kind: "workflow", workflowId },
    enabled: true,
    createdBy: "someone",
    createdAt: now,
    updatedAt: now,
  });
}

/** Seeds a workflow definition row owned by another principal, so the stub
 * caller cannot reach it through `ownedDefinitionRow`. */
async function seedWorkflowRow(
  a: TestApi,
  id: string,
  owner: { type: "user" | "team"; id: string },
): Promise<void> {
  const now = Date.now();
  await a.providers.db.insert(workflowDefinitions).values({
    id,
    orgId: "local-org",
    ownerType: owner.type,
    ownerId: owner.id,
    name: `seeded ${id}`,
    definition: {
      version: "dag/v1",
      nodes: [
        { id: "trigger", type: "trigger" },
        { id: "stop", type: "stop" },
      ],
      edges: [{ from: "trigger", to: "stop" }],
    },
    createdAt: now,
    updatedAt: now,
  });
}

/** Seeds a team in `local-org` with the stub caller as a member. */
async function seedTeamWithCaller(a: TestApi, teamId: string): Promise<void> {
  const now = Date.now();
  await a.providers.db.insert(teams).values({ id: teamId, orgId: "local-org", name: teamId, createdAt: now });
  await a.providers.db.insert(teamMembers).values({ teamId, userId: "local-user", role: "member" });
}

// ── 1. POST /api/workflows/schedules — orchestrator target ────────────────

describe("POST /api/workflows/schedules", () => {
  it.each(["invalid", 42, true, null])("400s a malformed schedule target %j without storing a row", async target => {
    const a = await boot();
    const response = await fetch(`${a.baseUrl}/api/workflows/schedules`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Malformed", cron: VALID_CRON, target }),
    });
    expect(response.status).toBe(400);
    expect(await a.providers.db.select().from(workflowSchedules)).toEqual([]);
  });

  it("201s an orchestrator-target schedule with nextFireAt > now", async () => {
    const a = await boot();
    const before = Date.now();
    const res = await fetch(`${a.baseUrl}/api/workflows/schedules`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "daily standup",
        cron: VALID_CRON,
        target: { kind: "orchestrator", prompt: "Run the daily report" },
      } satisfies CreateWorkflowScheduleRequest),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as WorkflowScheduleResponse;
    expect(body.schedule.targetKind).toBe("orchestrator");
    expect(body.schedule.nextFireAt).toBeGreaterThan(before);
    expect(body.schedule.scheduleId).toBeTruthy();
  });

  // ── 2. Bad cron → 400 with "5-field" + example ────────────────────────

  it("400s a bad cron expression and names the 5-field requirement and an example", async () => {
    const a = await boot();
    const res = await fetch(`${a.baseUrl}/api/workflows/schedules`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "bad",
        cron: "bad",
        target: { kind: "orchestrator", prompt: "hello" },
      } satisfies CreateWorkflowScheduleRequest),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("5-field");
    expect(body.error).toContain("0 9");
  });

  // ── 3. Exactly-one-of workflowId+prompt ───────────────────────────────

  it("400s with object-required message when body is JSON null", async () => {
    const a = await boot();
    const res = await fetch(`${a.baseUrl}/api/workflows/schedules`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "null",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Request body must be a JSON object.");
  });

  it("400s when neither workflowId nor prompt is provided (service message passes through)", async () => {
    const a = await boot();
    // Send a raw object that bypasses the union constraint at the type level
    const res = await fetch(`${a.baseUrl}/api/workflows/schedules`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "both",
        cron: VALID_CRON,
        target: { kind: "workflow", workflowId: "" },
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    // The service's exactly-one-of validation: workflow_id "" is treated as
    // absent (falsy), and no prompt was given — so service returns the
    // exactly-one-of error.
    expect(body.error).toContain("exactly one of");
  });
});

// ── 3b. Orchestrator-prompt schedule follows the workspace ────────────────

describe("POST /api/workflows/schedules — orchestrator-prompt workspace scope", () => {
  async function createPromptSchedule(a: TestApi, body: Record<string, unknown>) {
    return fetch(`${a.baseUrl}/api/workflows/schedules`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("a team member's scheduled prompt is owned by the TEAM, so it fires the team assistant", async () => {
    const a = await boot();
    await seedTeamWithCaller(a, "team_a");

    const res = await createPromptSchedule(a, {
      name: "team standup",
      cron: VALID_CRON,
      target: { kind: "orchestrator", prompt: "post the standup" },
      teamId: "team_a",
    });
    expect(res.status).toBe(201);
    const scheduleId = ((await res.json()) as WorkflowScheduleResponse).schedule.scheduleId;

    const rows = await a.providers.db
      .select({ ownerType: workflowSchedules.ownerType, ownerId: workflowSchedules.ownerId })
      .from(workflowSchedules)
      .where(eq(workflowSchedules.id, scheduleId));
    expect(rows[0]).toEqual({ ownerType: "team", ownerId: "team_a" });
  });

  it("a non-member's team id 404s, existence-hidden, and writes nothing", async () => {
    const a = await boot();
    await a.providers.db
      .insert(teams)
      .values({ id: "team_x", orgId: "local-org", name: "team_x", createdAt: Date.now() });

    const res = await createPromptSchedule(a, {
      name: "sneaky",
      cron: VALID_CRON,
      target: { kind: "orchestrator", prompt: "hi" },
      teamId: "team_x",
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("team not found");

    const rows = await a.providers.db.select().from(workflowSchedules);
    expect(rows).toHaveLength(0);
  });

  it("no teamId keeps the schedule the caller's own (personal, unchanged)", async () => {
    const a = await boot();
    const res = await createPromptSchedule(a, {
      name: "my standup",
      cron: VALID_CRON,
      target: { kind: "orchestrator", prompt: "remind me" },
    });
    expect(res.status).toBe(201);
    const scheduleId = ((await res.json()) as WorkflowScheduleResponse).schedule.scheduleId;

    const rows = await a.providers.db
      .select({ ownerType: workflowSchedules.ownerType, ownerId: workflowSchedules.ownerId })
      .from(workflowSchedules)
      .where(eq(workflowSchedules.id, scheduleId));
    expect(rows[0]).toEqual({ ownerType: "user", ownerId: "local-user" });
  });
});

// ── 4. GET /api/workflows/triggers — both kinds present ──────────────────

describe("GET /api/workflows/triggers", () => {
  it("returns both schedule and event-trigger items with correct kind discriminants", async () => {
    const a = await boot();
    const wfId = await createWorkflow(a.baseUrl, "wf_1");
    await seedScheduleRow(a, "sched_1", "local-org", { owner: { type: "user", id: "local-user" } });
    await seedEventTriggerRow(a, "trig_1", "local-org", wfId);

    const res = await fetch(`${a.baseUrl}/api/workflows/triggers`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListWorkflowTriggersResponse;

    const schedule = body.triggers.find((t) => t.kind === "schedule");
    const event = body.triggers.find((t) => t.kind === "event");
    expect(schedule).toBeDefined();
    expect(event).toBeDefined();
    expect(schedule!.detail).toHaveProperty("cron", VALID_CRON);
    expect(event!.workflowId).toBe(wfId);
  });

  // ── 5. ?workflowId filter ─────────────────────────────────────────────

  it("filters by workflowId — orchestrator-target schedule (no workflowId) is excluded", async () => {
    const a = await boot();
    const wfId = await createWorkflow(a.baseUrl, "wf_filtered");
    // orchestrator, no workflowId
    await seedScheduleRow(a, "sched_orch", "local-org", { owner: { type: "user", id: "local-user" } });
    await seedEventTriggerRow(a, "trig_wf", "local-org", wfId);

    const res = await fetch(`${a.baseUrl}/api/workflows/triggers?workflowId=${wfId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListWorkflowTriggersResponse;

    const ids = body.triggers.map((t) => t.id);
    expect(ids).toContain("trig_wf");
    expect(ids).not.toContain("sched_orch");
  });
});

// ── 6. PATCH /api/workflows/schedules/:id ────────────────────────────────

describe("PATCH /api/workflows/schedules/:id", () => {
  it("200s with enabled: false; 404s on unknown id", async () => {
    const a = await boot();
    await seedScheduleRow(a, "sched_patch", "local-org", { owner: { type: "user", id: "local-user" } });

    const res = await fetch(`${a.baseUrl}/api/workflows/schedules/sched_patch`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as WorkflowScheduleResponse;
    expect(body.schedule.enabled).toBe(false);

    const notFound = await fetch(`${a.baseUrl}/api/workflows/schedules/sched_no_exist`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(notFound.status).toBe(404);
  });

  it("404 error body contains corrective suffix", async () => {
    const a = await boot();
    const res = await fetch(`${a.baseUrl}/api/workflows/schedules/sched_missing`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Confirm the id");
  });
});

// ── 7. DELETE /api/workflows/schedules/:id ───────────────────────────────

describe("DELETE /api/workflows/schedules/:id", () => {
  it("200s first delete then 404s second delete", async () => {
    const a = await boot();
    await seedScheduleRow(a, "sched_del", "local-org", { owner: { type: "user", id: "local-user" } });

    const first = await fetch(`${a.baseUrl}/api/workflows/schedules/sched_del`, { method: "DELETE" });
    expect(first.status).toBe(200);
    const body = (await first.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    const second = await fetch(`${a.baseUrl}/api/workflows/schedules/sched_del`, { method: "DELETE" });
    expect(second.status).toBe(404);
  });
});

// ── 8. POST /api/workflows/schedules/:id/run ─────────────────────────────

describe("POST /api/workflows/schedules/:id/run", () => {
  it("200s and creates a workflow_runs row whose id starts with wfrun_sch_", async () => {
    const a = await boot();
    const wfId = await createWorkflow(a.baseUrl, "wf_for_fire");
    await seedScheduleRow(a, "sched_fire", "local-org", { workflowId: wfId });

    const res = await fetch(`${a.baseUrl}/api/workflows/schedules/sched_fire/run`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    const runRows = await a.providers.db
      .select({ id: workflowRuns.id })
      .from(workflowRuns)
      .where(eq(workflowRuns.workflowId, wfId));
    expect(runRows.length).toBeGreaterThan(0);
    expect(runRows[0]!.id).toMatch(/^wfrun_sch_/);
  });
});

// ── 9. POST/PATCH/DELETE /api/workflows/event-triggers round trip + 400 ──

describe("event-trigger CRUD", () => {
  it("PATCH 404 error body contains corrective suffix", async () => {
    const a = await boot();
    const res = await fetch(`${a.baseUrl}/api/workflows/event-triggers/trig_missing`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Confirm the id");
  });

  it("round-trips create/patch/delete and 400s a bogus event key on create", async () => {
    const a = await boot();
    const wfId = await createWorkflow(a.baseUrl, "wf_evt");

    // Create
    const createRes = await fetch(`${a.baseUrl}/api/workflows/event-triggers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workflowId: wfId,
        name: "on PR open",
        eventKeys: ["github.pull_request.opened"],
        filters: [],
      } satisfies CreateWorkflowEventTriggerRequest),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as WorkflowEventTriggerResponse;
    expect(created.trigger.triggerId).toBeTruthy();
    expect(created.trigger.workflowId).toBe(wfId);

    // Patch
    const patchRes = await fetch(`${a.baseUrl}/api/workflows/event-triggers/${created.trigger.triggerId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(patchRes.status).toBe(200);
    const patched = (await patchRes.json()) as WorkflowEventTriggerResponse;
    expect(patched.trigger.enabled).toBe(false);

    // Delete
    const deleteRes = await fetch(`${a.baseUrl}/api/workflows/event-triggers/${created.trigger.triggerId}`, {
      method: "DELETE",
    });
    expect(deleteRes.status).toBe(200);

    // 400 on bogus event key
    const badRes = await fetch(`${a.baseUrl}/api/workflows/event-triggers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workflowId: wfId,
        name: "bogus",
        eventKeys: ["github.does.not.exist"],
        filters: [],
      } satisfies CreateWorkflowEventTriggerRequest),
    });
    expect(badRes.status).toBe(400);
    const badBody = (await badRes.json()) as { error: string };
    expect(badBody.error).toContain("github.does.not.exist");
  });

  // Mention scoping (TKAI-299): the trigger path shares the subscriptions
  // CRUD gate (`events/mention-scope.ts`). One create + one patch case here
  // pin the wiring; the rule matrix lives in `events.test.ts`.
  it("scopes a slack.app_mention trigger to the creator and named channels", async () => {
    api = await bootTestApi({ plugins: [slackPlugin] });
    const a = api;
    const wfId = await createWorkflow(a.baseUrl, "wf_mention");

    // No channel filter and no anyChannel → refused.
    const bare = await fetch(`${a.baseUrl}/api/workflows/event-triggers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workflowId: wfId,
        name: "on mention",
        eventKeys: ["slack.app_mention"],
        filters: [],
      } satisfies CreateWorkflowEventTriggerRequest),
    });
    expect(bare.status).toBe(400);
    expect(((await bare.json()) as { error: string }).error).toContain("at least one channel");

    // Channel named + creator linked → created with the injected user filter.
    await a.providers.db.insert(userIdentityLinks).values({
      id: "uil-local",
      provider: "slack",
      externalId: "U_LOCAL",
      userId: "local-user",
      createdAt: Date.now(),
      notifyAttention: true,
    });
    const createRes = await fetch(`${a.baseUrl}/api/workflows/event-triggers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workflowId: wfId,
        name: "on mention",
        eventKeys: ["slack.app_mention"],
        filters: [{ field: "channel", op: "eq", value: "C123" }],
      } satisfies CreateWorkflowEventTriggerRequest),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as WorkflowEventTriggerResponse;
    expect(created.trigger.filters).toEqual([
      { field: "channel", op: "eq", value: "C123" },
      { field: "user", op: "eq", value: "U_LOCAL" },
    ]);

    // A filters patch that drops the channel scope is refused without
    // anyChannel, and accepted with it.
    const stripRes = await fetch(`${a.baseUrl}/api/workflows/event-triggers/${created.trigger.triggerId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filters: [] }),
    });
    expect(stripRes.status).toBe(400);
    const anyRes = await fetch(`${a.baseUrl}/api/workflows/event-triggers/${created.trigger.triggerId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filters: [], anyChannel: true }),
    });
    expect(anyRes.status).toBe(200);
    const patched = (await anyRes.json()) as WorkflowEventTriggerResponse;
    expect(patched.trigger.filters).toEqual([{ field: "user", op: "eq", value: "U_LOCAL" }]);
  });
});

// ── 10. GET /api/workflows/trigger-catalog ────────────────────────────────

describe("GET /api/workflows/trigger-catalog", () => {
  it("200s with a github service entry", async () => {
    const a = await boot();
    const res = await fetch(`${a.baseUrl}/api/workflows/trigger-catalog`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as GetWorkflowTriggerCatalogResponse;
    const github = body.catalog.find((s) => s.service === "github");
    expect(github).toBeDefined();
    expect(github!.entries.length).toBeGreaterThan(0);
  });
});

// ── 11. GET /api/workflows/runs — route precedence + workflowName ─────────

describe("GET /api/workflows/runs", () => {
  it("200s with empty runs on a fresh org (not swallowed by workflowsRouter GET /:id)", async () => {
    const a = await boot();
    const res = await fetch(`${a.baseUrl}/api/workflows/runs`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListAllWorkflowRunsResponse;
    expect(body.runs).toEqual([]);
  });

  it("returns runs with workflowName after a run is started", async () => {
    const a = await boot();
    const wfId = await createWorkflow(a.baseUrl, "named-workflow");

    const startRes = await fetch(`${a.baseUrl}/api/workflows/${wfId}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: {} }),
    });
    expect(startRes.status).toBe(201);
    const started = (await startRes.json()) as StartWorkflowRunResponse;
    expect(started.runId).toBeTruthy();

    const runsRes = await fetch(`${a.baseUrl}/api/workflows/runs`);
    expect(runsRes.status).toBe(200);
    const body = (await runsRes.json()) as ListAllWorkflowRunsResponse;
    expect(body.runs.length).toBeGreaterThan(0);
    expect(body.runs[0]!.workflowName).toBe("named-workflow");
  });
});

// ── 12. Cross-org invisibility ────────────────────────────────────────────

describe("cross-org invisibility", () => {
  it("schedule in other org is excluded from GET /triggers and 404s on PATCH/DELETE", async () => {
    const a = await boot();
    await seedScheduleRow(a, "sched_other", "org_other");

    // GET /triggers must not include the other org's schedule
    const getRes = await fetch(`${a.baseUrl}/api/workflows/triggers`);
    expect(getRes.status).toBe(200);
    const body = (await getRes.json()) as ListWorkflowTriggersResponse;
    expect(body.triggers.map((t) => t.id)).not.toContain("sched_other");

    // PATCH → 404
    const patchRes = await fetch(`${a.baseUrl}/api/workflows/schedules/sched_other`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(patchRes.status).toBe(404);

    // DELETE → 404
    const deleteRes = await fetch(`${a.baseUrl}/api/workflows/schedules/sched_other`, {
      method: "DELETE",
    });
    expect(deleteRes.status).toBe(404);
  });

  it("event-trigger in other org is excluded from GET /triggers and 404s on PATCH/DELETE", async () => {
    const a = await boot();
    const wfId = await createWorkflow(a.baseUrl, "wf_other_evt");
    await seedEventTriggerRow(a, "trig_other", "org_other", wfId);

    // GET /triggers must not include the other org's event-trigger
    const getRes = await fetch(`${a.baseUrl}/api/workflows/triggers`);
    expect(getRes.status).toBe(200);
    const body = (await getRes.json()) as ListWorkflowTriggersResponse;
    expect(body.triggers.map((t) => t.id)).not.toContain("trig_other");

    // PATCH → 404
    const patchRes = await fetch(`${a.baseUrl}/api/workflows/event-triggers/trig_other`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(patchRes.status).toBe(404);

    // DELETE → 404
    const deleteRes = await fetch(`${a.baseUrl}/api/workflows/event-triggers/trig_other`, {
      method: "DELETE",
    });
    expect(deleteRes.status).toBe(404);
  });
});

// ── 13. Same-org owner scoping ────────────────────────────────────────────
// The access rule: a caller may see and change a schedule or event trigger
// when they own the row, are a member of the owning team, or can reach the
// target workflow. Another org member's personal rows must answer exactly
// like missing rows.

describe("same-org owner scoping", () => {
  it("another user's personal schedule and unreachable-workflow trigger are excluded from GET /triggers", async () => {
    const a = await boot();
    // Foreign rows: an orchestrator schedule owned by user `someone`, and a
    // trigger whose target workflow is owned by `someone`.
    await seedScheduleRow(a, "sched_foreign", "local-org");
    await seedWorkflowRow(a, "wf_foreign", { type: "user", id: "someone" });
    await seedEventTriggerRow(a, "trig_foreign", "local-org", "wf_foreign");
    // Control: the caller's own orchestrator schedule, created via the API.
    const createRes = await fetch(`${a.baseUrl}/api/workflows/schedules`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "mine",
        cron: VALID_CRON,
        target: { kind: "orchestrator", prompt: "check my PRs" },
      } satisfies CreateWorkflowScheduleRequest),
    });
    expect(createRes.status).toBe(201);
    const mine = (await createRes.json()) as WorkflowScheduleResponse;

    const res = await fetch(`${a.baseUrl}/api/workflows/triggers`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListWorkflowTriggersResponse;
    const ids = body.triggers.map((t) => t.id);
    expect(ids).toContain(mine.schedule.scheduleId);
    expect(ids).not.toContain("sched_foreign");
    expect(ids).not.toContain("trig_foreign");
  });

  it("PATCH, DELETE, and fire on another user's schedule answer 404", async () => {
    const a = await boot();
    await seedScheduleRow(a, "sched_foreign", "local-org");

    const patchRes = await fetch(`${a.baseUrl}/api/workflows/schedules/sched_foreign`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(patchRes.status).toBe(404);

    const fireRes = await fetch(`${a.baseUrl}/api/workflows/schedules/sched_foreign/run`, { method: "POST" });
    expect(fireRes.status).toBe(404);

    const deleteRes = await fetch(`${a.baseUrl}/api/workflows/schedules/sched_foreign`, { method: "DELETE" });
    expect(deleteRes.status).toBe(404);
  });

  it("PATCH and DELETE on a trigger for an unreachable workflow answer 404", async () => {
    const a = await boot();
    await seedWorkflowRow(a, "wf_foreign", { type: "user", id: "someone" });
    await seedEventTriggerRow(a, "trig_foreign", "local-org", "wf_foreign");

    const patchRes = await fetch(`${a.baseUrl}/api/workflows/event-triggers/trig_foreign`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(patchRes.status).toBe(404);

    const deleteRes = await fetch(`${a.baseUrl}/api/workflows/event-triggers/trig_foreign`, { method: "DELETE" });
    expect(deleteRes.status).toBe(404);
  });

  it("files a team workflow's new trigger with the team, not the creator", async () => {
    const a = await boot();
    await seedTeamWithCaller(a, "team_b");
    await seedWorkflowRow(a, "wf_team_b", { type: "team", id: "team_b" });

    const res = await fetch(`${a.baseUrl}/api/workflows/event-triggers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workflowId: "wf_team_b",
        name: "on PR open",
        eventKeys: ["github.pull_request.opened"],
        filters: [],
      } satisfies CreateWorkflowEventTriggerRequest),
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as WorkflowEventTriggerResponse;

    // The subscription follows its workflow, the same rule a schedule on
    // that workflow follows. `created_by` still names who armed it.
    const rows = await a.providers.db
      .select()
      .from(eventSubscriptions)
      .where(eq(eventSubscriptions.id, created.trigger.triggerId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ownerType).toBe("team");
    expect(rows[0]!.ownerId).toBe("team_b");
    expect(rows[0]!.createdBy).toBe("local-user");
  });

  it("team-owned schedule and team workflow's trigger are visible and mutable for a team member", async () => {
    const a = await boot();
    await seedTeamWithCaller(a, "team_a");
    await seedWorkflowRow(a, "wf_team", { type: "team", id: "team_a" });
    await seedScheduleRow(a, "sched_team", "local-org", { workflowId: "wf_team", owner: { type: "team", id: "team_a" } });
    // Created by `someone`, but its target workflow belongs to the caller's
    // team — reachable-workflow access must admit the caller.
    await seedEventTriggerRow(a, "trig_team", "local-org", "wf_team");

    const res = await fetch(`${a.baseUrl}/api/workflows/triggers`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListWorkflowTriggersResponse;
    const ids = body.triggers.map((t) => t.id);
    expect(ids).toContain("sched_team");
    expect(ids).toContain("trig_team");

    const patchRes = await fetch(`${a.baseUrl}/api/workflows/schedules/sched_team`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(patchRes.status).toBe(200);
  });
});

// ── 14. Workspace scope filter (?ownerType=&ownerId=) ─────────────────────
// The hub's flat Triggers and Runs tabs pin ONE workspace via the switcher.
// The property under test: a caller's OWN personal row must NOT ride along
// into a team scope — the tab shows one workspace, not the caller's union.

describe("GET /api/workflows/{triggers,runs}?ownerType=&ownerId=", () => {
  const DEFINITION = {
    version: "dag/v1",
    nodes: [
      { id: "trigger", type: "trigger" },
      { id: "stop", type: "stop" },
    ],
    edges: [{ from: "trigger", to: "stop" }],
  };

  /** A team in `local-org` the caller is NOT a member of. */
  async function seedTeamWithoutCaller(a: TestApi, teamId: string): Promise<void> {
    await a.providers.db
      .insert(teams)
      .values({ id: teamId, orgId: "local-org", name: teamId, createdAt: Date.now() });
  }

  it("triggers: a team scope shows the team's rows, not the caller's personal ones", async () => {
    const a = await boot();
    await seedTeamWithCaller(a, "team_a");
    await seedWorkflowRow(a, "wf_team", { type: "team", id: "team_a" });
    // Team rows: a team-owned schedule, and a trigger created by `someone` on
    // the team workflow (kept by the workflow-reach arm).
    await seedScheduleRow(a, "sched_team", "local-org", {
      workflowId: "wf_team",
      owner: { type: "team", id: "team_a" },
    });
    await seedEventTriggerRow(a, "trig_team", "local-org", "wf_team");
    // The caller's OWN personal schedule — reachable, but not this workspace.
    await seedScheduleRow(a, "sched_mine", "local-org", { owner: { type: "user", id: "local-user" } });

    const res = await fetch(`${a.baseUrl}/api/workflows/triggers?ownerType=team&ownerId=team_a`);
    expect(res.status).toBe(200);
    const ids = ((await res.json()) as ListWorkflowTriggersResponse).triggers.map((t) => t.id);
    expect(ids).toContain("sched_team");
    expect(ids).toContain("trig_team");
    // The crux: the caller's personal schedule does not leak into the team tab.
    expect(ids).not.toContain("sched_mine");
  });

  it("triggers: a personal scope drops the teams, keeping only the caller's own rows", async () => {
    const a = await boot();
    await seedTeamWithCaller(a, "team_a");
    await seedWorkflowRow(a, "wf_team", { type: "team", id: "team_a" });
    await seedScheduleRow(a, "sched_team", "local-org", {
      workflowId: "wf_team",
      owner: { type: "team", id: "team_a" },
    });
    await seedScheduleRow(a, "sched_mine", "local-org", { owner: { type: "user", id: "local-user" } });

    const res = await fetch(`${a.baseUrl}/api/workflows/triggers?ownerType=user&ownerId=local-user`);
    expect(res.status).toBe(200);
    const ids = ((await res.json()) as ListWorkflowTriggersResponse).triggers.map((t) => t.id);
    expect(ids).toContain("sched_mine");
    expect(ids).not.toContain("sched_team");
  });

  it("triggers: a team the caller is not on 404s, existence-hidden", async () => {
    const a = await boot();
    await seedTeamWithoutCaller(a, "team_x");
    const forbidden = await fetch(`${a.baseUrl}/api/workflows/triggers?ownerType=team&ownerId=team_x`);
    const missing = await fetch(`${a.baseUrl}/api/workflows/triggers?ownerType=team&ownerId=team_nope`);
    expect(forbidden.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await forbidden.json()).toEqual(await missing.json());
  });

  it("triggers: a half-given filter 400s", async () => {
    const a = await boot();
    const res = await fetch(`${a.baseUrl}/api/workflows/triggers?ownerType=team`);
    expect(res.status).toBe(400);
  });

  it("runs: a team scope shows only the team workflow's runs", async () => {
    const a = await boot();
    await seedTeamWithCaller(a, "team_a");
    const mineWf = await createWorkflow(a.baseUrl, "mine-wf");
    await seedWorkflowRow(a, "wf_team", { type: "team", id: "team_a" });
    await a.providers.workflowStore.createRun(
      "run_mine",
      { workflowId: mineWf, definitionVersionId: "v1" },
      DEFINITION,
      "v1",
      { ownerType: "user", ownerId: "local-user" },
    );
    await a.providers.workflowStore.createRun(
      "run_team",
      { workflowId: "wf_team", definitionVersionId: "v1" },
      DEFINITION,
      "v1",
      { ownerType: "team", ownerId: "team_a" },
    );

    const res = await fetch(`${a.baseUrl}/api/workflows/runs?ownerType=team&ownerId=team_a`);
    expect(res.status).toBe(200);
    const runIds = ((await res.json()) as ListAllWorkflowRunsResponse).runs.map((r) => r.runId);
    expect(runIds).toContain("run_team");
    expect(runIds).not.toContain("run_mine");
  });

  it("runs: a team the caller is not on 404s", async () => {
    const a = await boot();
    await seedTeamWithoutCaller(a, "team_x");
    const res = await fetch(`${a.baseUrl}/api/workflows/runs?ownerType=team&ownerId=team_x`);
    expect(res.status).toBe(404);
  });
});
