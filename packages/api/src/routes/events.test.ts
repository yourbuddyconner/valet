/**
 * `/api/events*` + `/api/event-subscriptions` route tests (event-system plan,
 * Task 7). Real Hono app via `bootTestApi` with the real github plugin's
 * trigger catalog; rows seeded straight through `providers.db`; cross-org
 * cases seed rows under a second org id (stub auth pins the caller to
 * `local-org`, so "another org" is expressed in data, not identity).
 */
import type { ValetPlugin } from "@valet/engine";
import githubPlugin from "@valet/plugin-github/plugin";
import linearPlugin from "@valet/plugin-linear/plugin";
import slackPlugin from "@valet/plugin-slack/plugin";
import type { RunHost } from "@valet/workflow";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as assistantsService from "../assistants/service.js";
import { createAssistant, retireAssistant } from "../assistants/service.js";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import {
  eventDeliveries,
  eventDropLog,
  events,
  eventSubscriptions,
  orgMembers,
  teamMembers,
  teams,
  userIdentityLinks,
  workflowDefinitions,
} from "../schema/index.js";
import * as teamsService from "../services/teams.js";
import { deleteTeam } from "../services/teams.js";
import type {
  CreateEventSubscriptionRequest,
  CreateEventSubscriptionResponse,
  EventSubscriptionCollisionErrorWire,
  EventSubscriptionFilterWire,
  EventSubscriptionTargetWire,
  EventSubscriptionWire,
  GetEventCatalogResponse,
  GetEventResponse,
  ListEventDropsResponse,
  ListEventsResponse,
  ListEventSubscriptionsResponse,
  PatchEventSubscriptionResponse,
  RedeliverEventResponse,
} from "../wire/types.js";
import * as workflowService from "../workflows/service.js";

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

async function boot(): Promise<TestApi> {
  api = await bootTestApi({ plugins: [githubPlugin] });
  return api;
}

/** The message both owner-filtered listings answer with when one half of
 * the pair is missing. The same string the workflows and skills suites
 * assert, because one client builds one query for all of them. */
const HALF_FILTER_ERROR = "Filter by owner with both ownerType and ownerId, or send neither.";

const VALID_BODY: CreateEventSubscriptionRequest = {
  name: "pr opens",
  eventKeys: ["github.pull_request.opened"],
  filters: [{ field: "repo", op: "eq", value: "acme/widgets" }],
  target: { kind: "orchestrator" },
};

async function postSubscription(
  baseUrl: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${baseUrl}/api/event-subscriptions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function patchSubscription(
  baseUrl: string,
  id: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${baseUrl}/api/event-subscriptions/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

interface SeedSubscriptionOpts {
  name?: string;
  eventKeys?: string[];
  filters?: EventSubscriptionFilterWire[];
  target?: EventSubscriptionTargetWire;
  enabled?: boolean;
  /** Defaults to the colleague pair `user`/`someone` — neither the stub
   * caller (`local-user`) nor the alternate identity (`test-member`). */
  ownerType?: "user" | "team" | "org";
  ownerId?: string;
}

/** Seeds a subscription row directly (bypassing route validation) — used for
 * cross-org 404 cases where the route would refuse to create the row, and for
 * redelivery cases that need a disabled row or a workflow target without a
 * CRUD round trip. */
async function seedSubscriptionRow(
  a: TestApi,
  id: string,
  orgId: string,
  opts: SeedSubscriptionOpts = {},
): Promise<void> {
  const now = Date.now();
  await a.providers.db.insert(eventSubscriptions).values({
    id,
    orgId,
    ownerType: opts.ownerType ?? "user",
    ownerId: opts.ownerId ?? "someone",
    name: opts.name ?? `seeded ${id}`,
    eventKeys: opts.eventKeys ?? ["github.push"],
    filters: opts.filters ?? [],
    target: opts.target ?? { kind: "orchestrator" },
    enabled: opts.enabled ?? true,
    createdBy: "someone",
    createdAt: now,
    updatedAt: now,
  });
}

async function seedEventRow(
  a: TestApi,
  args: { id: string; orgId?: string; service?: string; eventKey?: string; receivedAt: number },
): Promise<void> {
  await a.providers.db.insert(events).values({
    id: args.id,
    orgId: args.orgId ?? "local-org",
    service: args.service ?? "github",
    eventKey: args.eventKey ?? "github.pull_request.opened",
    dedupeKey: `dedupe-${args.id}`,
    actor: { externalId: "42", login: "octocat" },
    refs: { repo: "acme/widgets" },
    summary: `event ${args.id}`,
    payload: { repository: { full_name: "acme/widgets" } },
    occurredAt: args.receivedAt,
    receivedAt: args.receivedAt,
  });
}

describe("GET /api/events/drops", () => {
  it("returns org-scoped drops newest-first with the last-event timestamp", async () => {
    const a = await boot();
    const now = Date.now();
    await a.providers.db.insert(eventDropLog).values([
      { id: "d_old", orgId: "local-org", reason: "filter_excluded", detail: "old", createdAt: now - 3000 },
      { id: "d_new", orgId: "local-org", reason: "bad_signature", detail: "new", createdAt: now - 1000 },
      { id: "d_foreign", orgId: "other-org", reason: "unknown_org", detail: "x", createdAt: now },
    ]);
    // A matched event is more recent than any drop, so it sets lastEventAt.
    await seedEventRow(a, { id: "ev_1", receivedAt: now - 500 });

    const res = await fetch(`${a.baseUrl}/api/events/drops`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListEventDropsResponse;

    expect(body.drops.map((d) => d.id)).toEqual(["d_new", "d_old"]);
    expect(body.drops[0].reason).toBe("bad_signature");
    expect(body.lastEventAt).toBe(now - 500);
  });

  it("searches and pages drops without showing members Slack diagnostics", async () => {
    const a = await boot();
    await a.providers.db.insert(eventDropLog).values([
      { id: "d3", orgId: "local-org", reason: "bad_signature", detail: "Webhook signature failed", createdAt: 3_000 },
      { id: "d2", orgId: "local-org", reason: "no_subscription_match", detail: "No rule for deploy", createdAt: 2_000 },
      { id: "d1", orgId: "local-org", reason: "bad_signature", detail: "Older signature failure", createdAt: 1_000 },
      { id: "hidden", orgId: "local-org", reason: "slack_interaction_unmatched", detail: "Slack deploy action", createdAt: 4_000 },
    ]);
    const member = { "x-valet-test-user-id": "test-member" };
    const first = await fetch(a.baseUrl + "/api/events/drops?q=signature&limit=1", { headers: member });
    const firstBody = (await first.json()) as ListEventDropsResponse;
    expect(firstBody.drops.map((drop) => drop.id)).toEqual(["d3"]);
    expect(firstBody.nextCursor).toBeTruthy();
    const second = await fetch(a.baseUrl + "/api/events/drops?q=signature&cursor=" + encodeURIComponent(firstBody.nextCursor!), { headers: member });
    expect(((await second.json()) as ListEventDropsResponse).drops.map((drop) => drop.id)).toEqual(["d1"]);
    const hidden = await fetch(a.baseUrl + "/api/events/drops?q=deploy", { headers: member });
    expect(((await hidden.json()) as ListEventDropsResponse).drops.map((drop) => drop.id)).toEqual(["d2"]);
  });

  it("keeps last-event time global across search and pages", async () => {
    const a = await boot();
    await a.providers.db.insert(eventDropLog).values([
      { id: "new", orgId: "local-org", reason: "bad_signature", detail: "unmatched", createdAt: 4_000 },
      { id: "old1", orgId: "local-org", reason: "bad_signature", detail: "needle", createdAt: 2_000 },
      { id: "old2", orgId: "local-org", reason: "bad_signature", detail: "needle", createdAt: 1_000 },
    ]);
    const first = (await (await fetch(a.baseUrl + "/api/events/drops?q=needle&limit=1")).json()) as ListEventDropsResponse;
    const second = (await (await fetch(a.baseUrl + "/api/events/drops?q=needle&cursor=" + encodeURIComponent(first.nextCursor!))).json()) as ListEventDropsResponse;
    expect(first.lastEventAt).toBe(4_000);
    expect(second.lastEventAt).toBe(4_000);
  });

  it.each(["x%y", "x_y", "x\\y"])("treats %s as a literal search character", async (query) => {
    const a = await boot();
    await a.providers.db.insert(eventDropLog).values([
      { id: "literal", orgId: "local-org", reason: "bad_signature", detail: "literal " + query, createdAt: 2_000 },
      { id: "other", orgId: "local-org", reason: "bad_signature", detail: "ordinary text", createdAt: 1_000 },
    ]);
    const body = (await (await fetch(a.baseUrl + "/api/events/drops?q=" + encodeURIComponent(query))).json()) as ListEventDropsResponse;
    expect(body.drops.map((drop) => drop.id)).toEqual(["literal"]);
  });

  it("walks tied timestamps forward and backward for members", async () => {
    const a = await boot();
    await a.providers.db.insert(eventDropLog).values([
      { id: "e", orgId: "local-org", reason: "bad_signature", detail: "e", createdAt: 3_000 },
      { id: "d", orgId: "local-org", reason: "slack_interaction_unmatched", detail: "hidden", createdAt: 3_000 },
      { id: "c", orgId: "local-org", reason: "bad_signature", detail: "c", createdAt: 2_000 },
      { id: "b", orgId: "local-org", reason: "bad_signature", detail: "b", createdAt: 2_000 },
      { id: "a", orgId: "local-org", reason: "bad_signature", detail: "a", createdAt: 1_000 },
    ]);
    const headers = { "x-valet-test-user-id": "test-member" };
    const first = await (await fetch(a.baseUrl + "/api/events/drops?limit=2", { headers })).json() as ListEventDropsResponse;
    const second = await (await fetch(a.baseUrl + "/api/events/drops?limit=2&cursor=" + encodeURIComponent(first.nextCursor!), { headers })).json() as ListEventDropsResponse;
    expect([...first.drops, ...second.drops].map((row) => row.id)).toEqual(["e", "c", "b", "a"]);
    expect(second.previousCursor).toBeTruthy();
    const back = await (await fetch(a.baseUrl + "/api/events/drops?limit=2&direction=previous&cursor=" + encodeURIComponent(second.previousCursor!), { headers })).json() as ListEventDropsResponse;
    expect(back.drops.map((row) => row.id)).toEqual(["e", "c"]);
    expect(back.previousCursor).toBeNull();
    expect(new Set([...first.drops, ...second.drops].map((row) => row.id)).size).toBe(4);
  });

  it("rejects an invalid drop direction", async () => {
    const a = await boot();
    expect((await fetch(a.baseUrl + "/api/events/drops?direction=sideways")).status).toBe(400);
  });

  it.each(["?limit=0", "?limit=1.5", "?q=" + "x".repeat(201), "?cursor=broken"])('rejects invalid drop query %s', async (query) => {
    const a = await boot();
    expect((await fetch(a.baseUrl + "/api/events/drops" + query)).status).toBe(400);
  });

  it("shows Slack interaction diagnostics only to organization admins", async () => {
    const a = await boot();
    const now = Date.now();
    await a.providers.db.insert(eventDropLog).values([
      { id: "d_interaction", orgId: "local-org", reason: "slack_interaction_unmatched", detail: "Slack block_actions", createdAt: now },
      { id: "d_public", orgId: "local-org", reason: "bad_signature", detail: "signature failed", createdAt: now - 1 },
    ]);

    const member = (await (await fetch(`${a.baseUrl}/api/events/drops`, { headers: { "x-valet-test-user-id": "test-member" } })).json()) as ListEventDropsResponse;
    expect(member.drops.map((drop) => drop.id)).toEqual(["d_public"]);
    expect(member.drops[0].detail).not.toContain("token");

    const admin = (await (await fetch(`${a.baseUrl}/api/events/drops`)).json()) as ListEventDropsResponse;
    expect(admin.drops.map((drop) => drop.id)).toEqual(["d_interaction", "d_public"]);
  });

  it("resolves /events/drops as the literal path, not an event id", async () => {
    const a = await boot();
    const res = await fetch(`${a.baseUrl}/api/events/drops`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListEventDropsResponse;
    expect(body.drops).toEqual([]);
    expect(body.lastEventAt).toBeNull();
  });
});

describe("GET /api/events/catalog", () => {
  it("returns the merged plugin catalog grouped by service", async () => {
    const a = await boot();
    const res = await fetch(`${a.baseUrl}/api/events/catalog`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as GetEventCatalogResponse;

    const github = body.services.find((s) => s.service === "github");
    expect(github).toBeDefined();
    const prOpened = github!.entries.find((e) => e.key === "github.pull_request.opened");
    expect(prOpened).toBeDefined();
    expect(prOpened!.filters.map((f) => f.field)).toContain("repo");
    // Non-actioned family appears as a bare key.
    expect(github!.entries.some((e) => e.key === "github.push")).toBe(true);
  });
});

describe("POST /api/event-subscriptions", () => {
  it("201s a valid orchestrator subscription and writes a user-owned row", async () => {
    const a = await boot();
    const res = await postSubscription(a.baseUrl, VALID_BODY);
    expect(res.status).toBe(201);
    const body = (await res.json()) as CreateEventSubscriptionResponse;
    expect(body.id).toBeTruthy();
    expect(body.name).toBe("pr opens");
    expect(body.enabled).toBe(true);
    expect(body.ownerType).toBe("user");
    expect(body.ownerId).toBe("local-user");

    const rows = await a.providers.db.select().from(eventSubscriptions).where(eq(eventSubscriptions.id, body.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].orgId).toBe("local-org");
    expect(rows[0].createdBy).toBe("local-user");
    expect(rows[0].eventKeys).toEqual(["github.pull_request.opened"]);
  });

  it("round-trips a filter's display label; matching ignores it", async () => {
    const a = await boot();
    const res = await postSubscription(a.baseUrl, {
      ...VALID_BODY,
      filters: [{ field: "repo", op: "eq", value: "acme/widgets", label: "Widgets repo" }],
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as CreateEventSubscriptionResponse;
    expect(body.filters).toEqual([{ field: "repo", op: "eq", value: "acme/widgets", label: "Widgets repo" }]);
    // The label is persisted verbatim in the jsonb, not stripped by the writer.
    const rows = await a.providers.db.select().from(eventSubscriptions).where(eq(eventSubscriptions.id, body.id));
    expect(rows[0].filters).toEqual([{ field: "repo", op: "eq", value: "acme/widgets", label: "Widgets repo" }]);
  });

  it("orchestrator target with orchestrator=org writes an org-owned row", async () => {
    const a = await boot();
    const res = await postSubscription(a.baseUrl, {
      ...VALID_BODY,
      target: { kind: "orchestrator", orchestrator: "org" },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as CreateEventSubscriptionResponse;
    expect(body.ownerType).toBe("org");
    expect(body.ownerId).toBe("local-org");
  });

  it("accepts a trailing-wildcard pattern that matches catalog entries", async () => {
    const a = await boot();
    const res = await postSubscription(a.baseUrl, { ...VALID_BODY, eventKeys: ["github.pull_request.*"] });
    expect(res.status).toBe(201);
  });

  it("201s a workflow target owned by the caller's org", async () => {
    const a = await boot();
    const wfRes = await fetch(`${a.baseUrl}/api/workflows`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "wf",
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
    expect(wfRes.status).toBe(201);
    const wf = (await wfRes.json()) as { id: string };

    const res = await postSubscription(a.baseUrl, {
      ...VALID_BODY,
      target: { kind: "workflow", workflowId: wf.id },
    });
    expect(res.status).toBe(201);
  });

  it("rejects a workflow target owned by a DIFFERENT user in the same org — this route must not bypass createWorkflowTrigger's ownership check", async () => {
    const a = await boot();
    const wfRes = await fetch(`${a.baseUrl}/api/workflows`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "someone-elses-workflow",
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
    expect(wfRes.status).toBe(201);
    const wf = (await wfRes.json()) as { id: string; ownerId: string };
    // The workflow is created with no auth header, so it's owned by the
    // default stub identity ("local-user"), not "test-member" — pin that
    // here so the 400 below is provably a cross-user rejection, not a
    // vacuous pass from the two identities accidentally coinciding.
    expect(wf.ownerId).toBe("local-user");

    const res = await postSubscription(
      a.baseUrl,
      { ...VALID_BODY, target: { kind: "workflow", workflowId: wf.id } },
      { "x-valet-test-user-id": "test-member" },
    );
    expect(res.status).toBe(400);
  });

  it("400s an empty eventKeys array", async () => {
    const a = await boot();
    const res = await postSubscription(a.baseUrl, { ...VALID_BODY, eventKeys: [] });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("eventKeys");
  });

  it("400s an unknown event key, naming it", async () => {
    const a = await boot();
    const res = await postSubscription(a.baseUrl, { ...VALID_BODY, eventKeys: ["github.nope.opened"] });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("github.nope.opened");
  });

  it("400s a wildcard pattern that matches nothing, naming it", async () => {
    const a = await boot();
    const res = await postSubscription(a.baseUrl, { ...VALID_BODY, eventKeys: ["linear.*"] });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("linear.*");
  });

  it("400s a filter field no catalog entry declares, naming it", async () => {
    const a = await boot();
    const res = await postSubscription(a.baseUrl, {
      ...VALID_BODY,
      filters: [{ field: "nonsense", op: "eq", value: "x" }],
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("nonsense");
  });

  it("400s a filter field declared only by a service the eventKeys don't select", async () => {
    // `repo` is a GitHub catalog field; a linear-only subscription using it
    // would validate against the cross-service union and then never match
    // anything at ingest (filtersMatch only consults the arriving event's
    // own entry). Must be rejected, not silently inert.
    api = await bootTestApi({ plugins: [githubPlugin, linearPlugin] });
    const res = await postSubscription(api.baseUrl, {
      ...VALID_BODY,
      eventKeys: ["linear.issue.*"],
      filters: [{ field: "repo", op: "eq", value: "acme/widgets" }],
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("repo");

    // Sanity: the same filter is fine when the eventKeys DO select github.
    const ok = await postSubscription(api.baseUrl, VALID_BODY);
    expect(ok.status).toBe(201);
  });

  it("400s a signal target (no workflow node parks on event signals yet)", async () => {
    const a = await boot();
    const res = await postSubscription(a.baseUrl, { ...VALID_BODY, target: { kind: "signal" } });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("signal");
  });

  it("400s a bad filter op, naming it", async () => {
    const a = await boot();
    const res = await postSubscription(a.baseUrl, {
      ...VALID_BODY,
      filters: [{ field: "repo", op: "matches", value: "x" }],
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("matches");
  });

  it("400s a catastrophic-backtracking regex pattern, with a fix hint", async () => {
    const a = await boot();
    const res = await postSubscription(a.baseUrl, {
      ...VALID_BODY,
      filters: [{ field: "repo", op: "regex", value: "(a+)+" }],
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("nests");
  });

  it("400s a filter with missing/empty value for op eq, naming the field", async () => {
    const a = await boot();
    const res = await postSubscription(a.baseUrl, {
      ...VALID_BODY,
      filters: [{ field: "repo", op: "eq", value: "" }],
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("repo");
  });

  it("400s a filter with a string value for op in (must be array), naming the field", async () => {
    const a = await boot();
    const res = await postSubscription(a.baseUrl, {
      ...VALID_BODY,
      filters: [{ field: "repo", op: "in", value: "acme/widgets" }],
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("repo");
  });

  it("400s an unknown target kind", async () => {
    const a = await boot();
    const res = await postSubscription(a.baseUrl, { ...VALID_BODY, target: { kind: "webhook" } });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("target");
  });

  it("400s a workflow target with no workflowId", async () => {
    const a = await boot();
    const res = await postSubscription(a.baseUrl, { ...VALID_BODY, target: { kind: "workflow" } });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("workflowId");
  });

  it("400s a workflow target owned by another org", async () => {
    const a = await boot();
    const now = Date.now();
    await a.providers.db.insert(workflowDefinitions).values({
      id: "wf_foreign",
      orgId: "other-org",
      ownerType: "user",
      ownerId: "someone",
      name: "foreign",
      definition: { version: "dag/v1", nodes: [], edges: [] },
      createdAt: now,
      updatedAt: now,
    });

    const res = await postSubscription(a.baseUrl, {
      ...VALID_BODY,
      target: { kind: "workflow", workflowId: "wf_foreign" },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("workflow");
  });

  it("files a team workflow's subscription with the team, not the creator", async () => {
    const a = await boot();
    const now = Date.now();
    await a.providers.db.insert(teams).values({ id: "t_eng", orgId: "local-org", name: "Eng", createdAt: now });
    await a.providers.db.insert(teamMembers).values({ teamId: "t_eng", userId: "local-user", role: "member" });
    await a.providers.db.insert(workflowDefinitions).values({
      id: "wf_team",
      orgId: "local-org",
      ownerType: "team",
      ownerId: "t_eng",
      name: "team workflow",
      definition: { version: "dag/v1", nodes: [], edges: [] },
      createdAt: now,
      updatedAt: now,
    });

    const res = await postSubscription(a.baseUrl, {
      ...VALID_BODY,
      target: { kind: "workflow", workflowId: "wf_team" },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as CreateEventSubscriptionResponse;
    // The owner names the WORKSPACE the automation belongs to. Stamping the
    // creator filed a team workflow's trigger in a personal workspace, where
    // the team that owns the workflow could not see it.
    expect(body.ownerType).toBe("team");
    expect(body.ownerId).toBe("t_eng");

    // Who armed it is still recorded, on its own column.
    const rows = await a.providers.db.select().from(eventSubscriptions).where(eq(eventSubscriptions.id, body.id));
    expect(rows[0].createdBy).toBe("local-user");
  });

  it("400s a missing name", async () => {
    const a = await boot();
    const res = await postSubscription(a.baseUrl, { ...VALID_BODY, name: "" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("name");
  });
});

// Visibility reversed on 2026-08-24 (small-fixes design, decision 1): the
// list used to be org-wide for every caller, and the page now names the
// workspace switcher's owner. An owner narrows to that owner's rows PLUS
// the org's own, which belong to every workspace. An unscoped call keeps
// the old answer, so both behaviors are pinned here.
describe("GET /api/event-subscriptions", () => {
  it("with no owner, lists every subscription in the caller's org", async () => {
    const a = await boot();
    const created = await postSubscription(a.baseUrl, VALID_BODY);
    expect(created.status).toBe(201);
    await seedSubscriptionRow(a, "sub_colleague", "local-org", { name: "a colleague's" });
    await seedSubscriptionRow(a, "sub_foreign", "other-org");

    const res = await fetch(`${a.baseUrl}/api/event-subscriptions`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListEventSubscriptionsResponse;
    expect(body.subscriptions.map((s) => s.name).sort()).toEqual(["a colleague's", "pr opens"]);
  });

  it("with the caller's own owner, lists only the caller's subscriptions", async () => {
    const a = await boot();
    const created = await postSubscription(a.baseUrl, VALID_BODY);
    expect(created.status).toBe(201);
    // Same org, another member — the row the old org-wide list showed and
    // the scoped list must not.
    await seedSubscriptionRow(a, "sub_colleague", "local-org", { name: "a colleague's" });

    const res = await fetch(`${a.baseUrl}/api/event-subscriptions?ownerType=user&ownerId=local-user`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListEventSubscriptionsResponse;
    expect(body.subscriptions).toHaveLength(1);
    expect(body.subscriptions[0].name).toBe("pr opens");
  });

  it("with a team owner, lists that team's subscriptions only", async () => {
    const a = await boot();
    const created = await postSubscription(a.baseUrl, VALID_BODY);
    expect(created.status).toBe(201);
    await seedSubscriptionRow(a, "sub_team", "local-org", {
      name: "team automation",
      ownerType: "team",
      ownerId: "t_eng",
    });

    const res = await fetch(`${a.baseUrl}/api/event-subscriptions?ownerType=team&ownerId=t_eng`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListEventSubscriptionsResponse;
    expect(body.subscriptions).toHaveLength(1);
    expect(body.subscriptions[0].name).toBe("team automation");
  });

  // An org-owned subscription has no workspace of its own. If the owner
  // filter excluded it, the create dialog's "Notify the org assistant"
  // option would write a row that appears in no list and can never be
  // disabled from the UI, while it keeps firing on every matching webhook.
  it("lists org-owned subscriptions in the personal workspace too", async () => {
    const a = await boot();
    const created = await postSubscription(a.baseUrl, {
      ...VALID_BODY,
      name: "org watch",
      target: { kind: "orchestrator", orchestrator: "org" },
    });
    expect(created.status).toBe(201);
    await seedSubscriptionRow(a, "sub_mine", "local-org", { name: "mine", ownerId: "local-user" });
    await seedSubscriptionRow(a, "sub_colleague", "local-org", { name: "a colleague's" });

    const res = await fetch(`${a.baseUrl}/api/event-subscriptions?ownerType=user&ownerId=local-user`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListEventSubscriptionsResponse;
    expect(body.subscriptions.map((s) => s.name).sort()).toEqual(["mine", "org watch"]);
  });

  it("lists org-owned subscriptions in a team workspace too", async () => {
    const a = await boot();
    const created = await postSubscription(a.baseUrl, {
      ...VALID_BODY,
      name: "org watch",
      target: { kind: "orchestrator", orchestrator: "org" },
    });
    expect(created.status).toBe(201);
    await seedSubscriptionRow(a, "sub_team", "local-org", {
      name: "team automation",
      ownerType: "team",
      ownerId: "t_eng",
    });
    await seedSubscriptionRow(a, "sub_colleague", "local-org", { name: "a colleague's" });

    const res = await fetch(`${a.baseUrl}/api/event-subscriptions?ownerType=team&ownerId=t_eng`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListEventSubscriptionsResponse;
    expect(body.subscriptions.map((s) => s.name).sort()).toEqual(["org watch", "team automation"]);
  });

  it("keeps another org's org-owned rows out of the union", async () => {
    const a = await boot();
    await seedSubscriptionRow(a, "sub_foreign_org", "other-org", {
      name: "another org's",
      ownerType: "org",
      ownerId: "other-org",
    });

    const res = await fetch(`${a.baseUrl}/api/event-subscriptions?ownerType=user&ownerId=local-user`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListEventSubscriptionsResponse;
    expect(body.subscriptions).toHaveLength(0);
  });

  it("400s a half-specified owner pair, naming both parameters", async () => {
    const a = await boot();

    const res = await fetch(`${a.baseUrl}/api/event-subscriptions?ownerType=user`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe(HALF_FILTER_ERROR);
  });
});

describe("PATCH /api/event-subscriptions/:id", () => {
  it("updates name/enabled/filters and re-validates what's provided", async () => {
    const a = await boot();
    const created = (await (await postSubscription(a.baseUrl, VALID_BODY)).json()) as CreateEventSubscriptionResponse;

    const res = await fetch(`${a.baseUrl}/api/event-subscriptions/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "renamed", enabled: false, filters: [] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PatchEventSubscriptionResponse;
    expect(body.name).toBe("renamed");
    expect(body.enabled).toBe(false);
    expect(body.filters).toEqual([]);

    const rows = await a.providers.db.select().from(eventSubscriptions).where(eq(eventSubscriptions.id, created.id));
    expect(rows[0].enabled).toBe(false);
    expect(rows[0].name).toBe("renamed");
  });

  it("400s patched eventKeys with an unknown key", async () => {
    const a = await boot();
    const created = (await (await postSubscription(a.baseUrl, VALID_BODY)).json()) as CreateEventSubscriptionResponse;

    const res = await fetch(`${a.baseUrl}/api/event-subscriptions/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ eventKeys: ["github.bogus"] }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("github.bogus");
  });

  it("404s a subscription in another org", async () => {
    const a = await boot();
    await seedSubscriptionRow(a, "sub_foreign", "other-org");

    const res = await fetch(`${a.baseUrl}/api/event-subscriptions/sub_foreign`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(404);
  });

  it("404s a colleague's personal subscription in the SAME org, row unchanged", async () => {
    const a = await boot();
    // seedSubscriptionRow's row is ownerType "user"/ownerId "someone" —
    // neither the default caller ("local-user") nor "test-member" below.
    await seedSubscriptionRow(a, "sub_colleague", "local-org");

    const res = await fetch(`${a.baseUrl}/api/event-subscriptions/sub_colleague`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "x-valet-test-user-id": "test-member" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(404);

    const rows = await a.providers.db
      .select()
      .from(eventSubscriptions)
      .where(eq(eventSubscriptions.id, "sub_colleague"));
    expect(rows[0].enabled).toBe(true);
  });

  it("an org-owned subscription is mutable by any org member", async () => {
    const a = await boot();
    const created = (await (
      await postSubscription(a.baseUrl, { ...VALID_BODY, target: { kind: "orchestrator", orchestrator: "org" } })
    ).json()) as CreateEventSubscriptionResponse;
    expect(created.ownerType).toBe("org");

    const res = await fetch(`${a.baseUrl}/api/event-subscriptions/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "x-valet-test-user-id": "test-member" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(200);
  });
});

describe("DELETE /api/event-subscriptions/:id", () => {
  it("204s and removes the row", async () => {
    const a = await boot();
    const created = (await (await postSubscription(a.baseUrl, VALID_BODY)).json()) as CreateEventSubscriptionResponse;

    const res = await fetch(`${a.baseUrl}/api/event-subscriptions/${created.id}`, { method: "DELETE" });
    expect(res.status).toBe(204);

    const rows = await a.providers.db.select().from(eventSubscriptions).where(eq(eventSubscriptions.id, created.id));
    expect(rows).toHaveLength(0);
  });

  it("404s a subscription in another org (row survives)", async () => {
    const a = await boot();
    await seedSubscriptionRow(a, "sub_foreign", "other-org");

    const res = await fetch(`${a.baseUrl}/api/event-subscriptions/sub_foreign`, { method: "DELETE" });
    expect(res.status).toBe(404);

    const rows = await a.providers.db.select().from(eventSubscriptions).where(eq(eventSubscriptions.id, "sub_foreign"));
    expect(rows).toHaveLength(1);
  });

  it("404s a colleague's personal subscription in the SAME org, row survives", async () => {
    const a = await boot();
    await seedSubscriptionRow(a, "sub_colleague", "local-org");

    const res = await fetch(`${a.baseUrl}/api/event-subscriptions/sub_colleague`, {
      method: "DELETE",
      headers: { "x-valet-test-user-id": "test-member" },
    });
    expect(res.status).toBe(404);

    const rows = await a.providers.db
      .select()
      .from(eventSubscriptions)
      .where(eq(eventSubscriptions.id, "sub_colleague"));
    expect(rows).toHaveLength(1);
  });
});

describe("GET /api/events", () => {
  it("returns the org's events newest-first, excluding other orgs", async () => {
    const a = await boot();
    await seedEventRow(a, { id: "ev_old", receivedAt: 1_000 });
    await seedEventRow(a, { id: "ev_new", receivedAt: 3_000 });
    await seedEventRow(a, { id: "ev_mid", receivedAt: 2_000 });
    await seedEventRow(a, { id: "ev_foreign", orgId: "other-org", receivedAt: 4_000 });

    const res = await fetch(`${a.baseUrl}/api/events`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListEventsResponse;
    expect(body.events.map((e) => e.id)).toEqual(["ev_new", "ev_mid", "ev_old"]);
    expect(body.events[0].summary).toBe("event ev_new");
    expect(body.events[0].refs).toEqual({ repo: "acme/widgets" });
  });

  it("filters by service and key, and honors limit", async () => {
    const a = await boot();
    await seedEventRow(a, { id: "ev_a", eventKey: "github.pull_request.opened", receivedAt: 1_000 });
    await seedEventRow(a, { id: "ev_b", eventKey: "github.push", receivedAt: 2_000 });
    await seedEventRow(a, { id: "ev_c", service: "linear", eventKey: "linear.issue.create", receivedAt: 3_000 });

    const byKey = (await (await fetch(`${a.baseUrl}/api/events?key=github.push`)).json()) as ListEventsResponse;
    expect(byKey.events.map((e) => e.id)).toEqual(["ev_b"]);

    const byService = (await (await fetch(`${a.baseUrl}/api/events?service=github`)).json()) as ListEventsResponse;
    expect(byService.events.map((e) => e.id)).toEqual(["ev_b", "ev_a"]);

    const limited = (await (await fetch(`${a.baseUrl}/api/events?limit=1`)).json()) as ListEventsResponse;
    expect(limited.events.map((e) => e.id)).toEqual(["ev_c"]);
  });

  it("keeps matched Slack events available to the member who owns their subscription", async () => {
    const a = await boot();
    const now = Date.now();
    await seedEventRow(a, { id: "ev_slack", service: "slack", eventKey: "slack.message", receivedAt: now - 1_000 });
    await seedSubscriptionRow(a, "sub_member_slack", "local-org", { ownerId: "test-member" });
    await a.providers.db.insert(eventDeliveries).values({
      id: "del_member_slack", eventId: "ev_slack", subscriptionId: "sub_member_slack", status: "delivered", attempts: 1,
      nextAttemptAt: 0, createdAt: now - 1_000,
    });
    const memberHeaders = { "x-valet-test-user-id": "test-member" };

    const list = (await (await fetch(`${a.baseUrl}/api/events?service=slack&ownerType=user&ownerId=test-member`, { headers: memberHeaders })).json()) as ListEventsResponse;
    expect(list.events.map((event) => event.id)).toEqual(["ev_slack"]);
    expect((await fetch(`${a.baseUrl}/api/events/ev_slack`, { headers: memberHeaders })).status).toBe(200);
    expect((await fetch(`${a.baseUrl}/api/events/ev_slack/redeliver`, { method: "POST", headers: memberHeaders })).status).toBe(200);
  });

  // The owner filter is what the page's "This workspace" state sends. It reads
  // ownership through the deliveries, because the events table has no owner
  // column (small-fixes design, decision 2). It also carries a 30-day lower
  // bound on `received_at`, so these rows are seeded relative to now.
  it("with an owner, returns only events delivered to that owner's subscriptions", async () => {
    const a = await boot();
    await seedSubscriptionRow(a, "sub_mine", "local-org", { ownerId: "local-user" });
    await seedSubscriptionRow(a, "sub_colleague", "local-org", { ownerId: "someone" });

    const now = Date.now();
    await seedEventRow(a, { id: "ev_mine", receivedAt: now - 3_000 });
    await seedEventRow(a, { id: "ev_theirs", receivedAt: now - 4_000 });
    await seedEventRow(a, { id: "ev_undelivered", receivedAt: now - 5_000 });

    await a.providers.db.insert(eventDeliveries).values([
      {
        id: "del_mine",
        eventId: "ev_mine",
        subscriptionId: "sub_mine",
        status: "delivered" as const,
        attempts: 1,
        nextAttemptAt: 0,
        createdAt: 1_000,
      },
      {
        id: "del_theirs",
        eventId: "ev_theirs",
        subscriptionId: "sub_colleague",
        status: "delivered" as const,
        attempts: 1,
        nextAttemptAt: 0,
        createdAt: 1_000,
      },
    ]);

    const scoped = (await (
      await fetch(`${a.baseUrl}/api/events?ownerType=user&ownerId=local-user`)
    ).json()) as ListEventsResponse;
    expect(scoped.events.map((e) => e.id)).toEqual(["ev_mine"]);

    // The same three events, unscoped: the filter narrows the feed, it does
    // not change what the feed holds.
    const all = (await (await fetch(`${a.baseUrl}/api/events`)).json()) as ListEventsResponse;
    expect(all.events.map((e) => e.id)).toEqual(["ev_mine", "ev_theirs", "ev_undelivered"]);
  });

  // The subscriptions list returns org-owned rows in every workspace, so the
  // feed beside it has to show what those rows received. A workspace that
  // lists a subscription and hides its events contradicts the tab next to it.
  it("with an owner, also returns events delivered to an ORG-owned subscription", async () => {
    const a = await boot();
    await seedSubscriptionRow(a, "sub_org", "local-org", {
      ownerType: "org",
      ownerId: "local-org",
    });
    await seedSubscriptionRow(a, "sub_colleague", "local-org", { ownerId: "someone" });

    const now = Date.now();
    await seedEventRow(a, { id: "ev_org", receivedAt: now - 3_000 });
    await seedEventRow(a, { id: "ev_theirs", receivedAt: now - 4_000 });
    await a.providers.db.insert(eventDeliveries).values([
      {
        id: "del_org",
        eventId: "ev_org",
        subscriptionId: "sub_org",
        status: "delivered" as const,
        attempts: 1,
        nextAttemptAt: 0,
        createdAt: 1_000,
      },
      {
        id: "del_theirs",
        eventId: "ev_theirs",
        subscriptionId: "sub_colleague",
        status: "delivered" as const,
        attempts: 1,
        nextAttemptAt: 0,
        createdAt: 1_000,
      },
    ]);

    // The caller owns no subscription at all here: the org-owned row is the
    // only reason this event joins their workspace.
    const scoped = (await (
      await fetch(`${a.baseUrl}/api/events?ownerType=user&ownerId=local-user`)
    ).json()) as ListEventsResponse;
    expect(scoped.events.map((e) => e.id)).toEqual(["ev_org"]);
  });

  it("combines the owner filter with the service and key filters", async () => {
    const a = await boot();
    await seedSubscriptionRow(a, "sub_mine", "local-org", { ownerId: "local-user" });
    const now = Date.now();
    await seedEventRow(a, { id: "ev_pr", eventKey: "github.pull_request.opened", receivedAt: now - 2_000 });
    await seedEventRow(a, { id: "ev_push", eventKey: "github.push", receivedAt: now - 3_000 });
    await a.providers.db.insert(eventDeliveries).values([
      {
        id: "del_pr",
        eventId: "ev_pr",
        subscriptionId: "sub_mine",
        status: "delivered" as const,
        attempts: 1,
        nextAttemptAt: 0,
        createdAt: 1_000,
      },
      {
        id: "del_push",
        eventId: "ev_push",
        subscriptionId: "sub_mine",
        status: "delivered" as const,
        attempts: 1,
        nextAttemptAt: 0,
        createdAt: 1_000,
      },
    ]);

    const res = await fetch(
      `${a.baseUrl}/api/events?ownerType=user&ownerId=local-user&key=github.push`,
    );
    const body = (await res.json()) as ListEventsResponse;
    expect(body.events.map((e) => e.id)).toEqual(["ev_push"]);
  });

  // Without a lower bound the `EXISTS` walks the org's whole event history
  // to fill a page it can never fill, because no index can pre-select the
  // rows it rejects. The window is the bound; "All" keeps the full history.
  it("with an owner, looks back 30 days only, while All keeps the history", async () => {
    const a = await boot();
    await seedSubscriptionRow(a, "sub_mine", "local-org", { ownerId: "local-user" });

    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    await seedEventRow(a, { id: "ev_recent", receivedAt: now - day });
    await seedEventRow(a, { id: "ev_old", receivedAt: now - 31 * day });
    await a.providers.db.insert(eventDeliveries).values(
      ["ev_recent", "ev_old"].map((eventId) => ({
        id: `del_${eventId}`,
        eventId,
        subscriptionId: "sub_mine",
        status: "delivered" as const,
        attempts: 1,
        nextAttemptAt: 0,
        createdAt: now,
      })),
    );

    const scoped = (await (
      await fetch(`${a.baseUrl}/api/events?ownerType=user&ownerId=local-user`)
    ).json()) as ListEventsResponse;
    expect(scoped.events.map((e) => e.id)).toEqual(["ev_recent"]);

    const all = (await (await fetch(`${a.baseUrl}/api/events`)).json()) as ListEventsResponse;
    expect(all.events.map((e) => e.id)).toEqual(["ev_recent", "ev_old"]);
  });

  it("400s a half-specified owner pair, naming both parameters", async () => {
    const a = await boot();

    const res = await fetch(`${a.baseUrl}/api/events?ownerId=local-user`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe(HALF_FILTER_ERROR);
  });
});

describe("GET /api/events/:id", () => {
  it("returns the event with its deliveries", async () => {
    const a = await boot();
    await seedEventRow(a, { id: "ev_1", receivedAt: 1_000 });
    await seedSubscriptionRow(a, "sub_1", "local-org");
    await a.providers.db.insert(eventDeliveries).values({
      id: "del_1",
      eventId: "ev_1",
      subscriptionId: "sub_1",
      status: "failed",
      attempts: 2,
      lastError: "boom",
      nextAttemptAt: 5_000,
      createdAt: 1_000,
    });

    const res = await fetch(`${a.baseUrl}/api/events/ev_1`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as GetEventResponse;
    expect(body.event.id).toBe("ev_1");
    expect(body.event.payload).toEqual({ repository: { full_name: "acme/widgets" } });
    expect(body.deliveries).toHaveLength(1);
    expect(body.deliveries[0]).toMatchObject({
      subscriptionId: "sub_1",
      status: "failed",
      attempts: 2,
      lastError: "boom",
    });
    // A failing delivery must say WHEN it retries and WHAT it is trying to
    // reach; without both, it reads the same as a dead one.
    expect(body.deliveries[0].nextAttemptAt).toBe(5_000);
    expect(body.deliveries[0].subscriptionName).toBe("seeded sub_1");
  });

  it("reports no next attempt for a delivery that gave up", async () => {
    const a = await boot();
    await seedEventRow(a, { id: "ev_dead", receivedAt: 1_000 });
    await seedSubscriptionRow(a, "sub_dead", "local-org", { name: "PR reviewer" });
    // A dead row keeps the `next_attempt_at` of the attempt that gave up, so
    // shipping the column raw would promise a retry that never comes.
    await a.providers.db.insert(eventDeliveries).values({
      id: "del_dead",
      eventId: "ev_dead",
      subscriptionId: "sub_dead",
      status: "dead",
      attempts: 4,
      lastError: "Error: connect ECONNREFUSED 127.0.0.1:8788",
      nextAttemptAt: 9_000,
      createdAt: 1_000,
    });

    const res = await fetch(`${a.baseUrl}/api/events/ev_dead`);
    const body = (await res.json()) as GetEventResponse;
    expect(body.deliveries[0].status).toBe("dead");
    expect(body.deliveries[0].nextAttemptAt).toBeNull();
    expect(body.deliveries[0].subscriptionName).toBe("PR reviewer");
    // The error is the one field a reader needs whole.
    expect(body.deliveries[0].lastError).toBe("Error: connect ECONNREFUSED 127.0.0.1:8788");
  });

  it("404s an event belonging to another org", async () => {
    const a = await boot();
    await seedEventRow(a, { id: "ev_foreign", orgId: "other-org", receivedAt: 1_000 });

    const res = await fetch(`${a.baseUrl}/api/events/ev_foreign`);
    expect(res.status).toBe(404);
  });
});

// ── Redelivery ──────────────────────────────────────────────────────────────

/** Records the run ids the dispatcher starts, and never runs anything. The
 * recorded ids are the point: the dispatcher derives a run id from the
 * delivery id (`wfrun_evt_${deliveryId}`) and returns early when that run
 * exists, so a redelivery that reused a delivery id would report success and
 * start nothing. */
function recordingRunHost(): { host: RunHost; started: string[] } {
  const started: string[] = [];
  return {
    started,
    host: {
      start: async (runId: string) => {
        started.push(runId);
      },
      wake: async () => {},
      scheduleWake: async () => {},
      terminate: async () => {},
      startHost: () => {},
      stopHost: async () => {},
    },
  };
}

async function seedWorkflowRow(a: TestApi, id: string): Promise<void> {
  const now = Date.now();
  await a.providers.db.insert(workflowDefinitions).values({
    id,
    orgId: "local-org",
    ownerType: "user",
    ownerId: "local-user",
    name: `workflow ${id}`,
    definition: { version: "dag/v1", nodes: [], edges: [] },
    createdAt: now,
    updatedAt: now,
  });
}

async function deliveriesFor(a: TestApi, eventId: string) {
  return a.providers.db.select().from(eventDeliveries).where(eq(eventDeliveries.eventId, eventId));
}

async function redeliver(baseUrl: string, eventId: string): Promise<Response> {
  return fetch(`${baseUrl}/api/events/${eventId}/redeliver`, { method: "POST" });
}

describe("POST /api/events/:id/redeliver", () => {
  /** Workflow targets on a recording run host: a redelivery dispatches for
   * real, without a live workflow engine in a route test. */
  async function bootWithRunHost(): Promise<{ a: TestApi; started: string[] }> {
    const { host, started } = recordingRunHost();
    api = await bootTestApi({ plugins: [githubPlugin], workflowRunHost: host });
    return { a: api, started };
  }

  it("creates NEW delivery rows and dispatches them, leaving the dead row intact", async () => {
    const { a, started } = await bootWithRunHost();
    await seedWorkflowRow(a, "wf_redeliver");
    await seedEventRow(a, { id: "ev_1", receivedAt: 1_000 });
    await seedSubscriptionRow(a, "sub_1", "local-org", {
      eventKeys: ["github.pull_request.opened"],
      target: { kind: "workflow", workflowId: "wf_redeliver" },
    });
    // The 9am attempt that gave up.
    await a.providers.db.insert(eventDeliveries).values({
      id: "del_dead",
      eventId: "ev_1",
      subscriptionId: "sub_1",
      status: "dead",
      attempts: 4,
      lastError: "workflow wf_redeliver not found in org local-org",
      nextAttemptAt: 2_000,
      createdAt: 1_000,
    });

    const res = await redeliver(a.baseUrl, "ev_1");
    expect(res.status).toBe(200);
    expect((await res.json()) as RedeliverEventResponse).toEqual({ created: 1 });

    const rows = await deliveriesFor(a, "ev_1");
    expect(rows).toHaveLength(2);
    const fresh = rows.find((r) => r.id !== "del_dead");
    expect(fresh).toBeDefined();

    // The dispatcher must start a run under the NEW delivery id. A reused id
    // would resolve to `wfrun_evt_del_dead` and be swallowed by the
    // already-exists early return. (The route nudges the dispatcher, so the
    // delivery may already be done here; this poll covers both orderings.)
    await a.providers.eventDispatcher.pollOnce();
    await expect.poll(() => started, { timeout: 5_000 }).toEqual([`wfrun_evt_${fresh!.id}`]);

    // The dead row is the record of what happened; it is never revived.
    const settled = await deliveriesFor(a, "ev_1");
    expect(settled.find((r) => r.id === "del_dead")).toMatchObject({ status: "dead", attempts: 4 });
    expect(settled.find((r) => r.id === fresh!.id)?.status).toBe("delivered");
  });

  it("targets the subscriptions matching NOW: skips disabled, includes one created after the event", async () => {
    const { a } = await bootWithRunHost();
    await seedWorkflowRow(a, "wf_redeliver");
    await seedEventRow(a, { id: "ev_1", receivedAt: 1_000 });
    // Deliberately switched off — the owner does not want this event.
    await seedSubscriptionRow(a, "sub_off", "local-org", {
      eventKeys: ["github.pull_request.opened"],
      target: { kind: "workflow", workflowId: "wf_redeliver" },
      enabled: false,
    });
    // Created after the event, and repaired — the owner does want it.
    await seedSubscriptionRow(a, "sub_fixed", "local-org", {
      eventKeys: ["github.pull_request.*"],
      target: { kind: "workflow", workflowId: "wf_redeliver" },
    });

    const res = await redeliver(a.baseUrl, "ev_1");
    expect((await res.json()) as RedeliverEventResponse).toEqual({ created: 1 });
    const rows = await deliveriesFor(a, "ev_1");
    expect(rows.map((r) => r.subscriptionId)).toEqual(["sub_fixed"]);
  });

  it("applies the subscription filters, not just the event key", async () => {
    const { a } = await bootWithRunHost();
    await seedWorkflowRow(a, "wf_redeliver");
    // seedEventRow's payload is repository acme/widgets.
    await seedEventRow(a, { id: "ev_1", receivedAt: 1_000 });
    await seedSubscriptionRow(a, "sub_other_repo", "local-org", {
      eventKeys: ["github.pull_request.opened"],
      filters: [{ field: "repo", op: "eq", value: "acme/other" }],
      target: { kind: "workflow", workflowId: "wf_redeliver" },
    });

    const res = await redeliver(a.baseUrl, "ev_1");
    expect((await res.json()) as RedeliverEventResponse).toEqual({ created: 0 });
    expect(await deliveriesFor(a, "ev_1")).toHaveLength(0);
  });

  it("200s with created 0 when nothing matches, so the UI can say so", async () => {
    const a = await boot();
    await seedEventRow(a, { id: "ev_1", receivedAt: 1_000 });

    const res = await redeliver(a.baseUrl, "ev_1");
    expect(res.status).toBe(200);
    expect((await res.json()) as RedeliverEventResponse).toEqual({ created: 0 });
  });

  it("404s an event in another org and writes nothing", async () => {
    const a = await boot();
    await seedEventRow(a, { id: "ev_foreign", orgId: "other-org", receivedAt: 1_000 });
    await seedSubscriptionRow(a, "sub_foreign", "other-org", {
      eventKeys: ["github.pull_request.opened"],
    });

    const res = await redeliver(a.baseUrl, "ev_foreign");
    expect(res.status).toBe(404);
    expect(await deliveriesFor(a, "ev_foreign")).toHaveLength(0);
  });
});

/**
 * A team owns event subscriptions the same way it owns workflows, skills and
 * sessions: the subscription names the TEAM as owner, and the dispatcher
 * delivers into that team's default assistant rather than the assistant of
 * whichever member happened to create it.
 *
 * Membership is the bar to create one, matching team workflows and team
 * sessions — a member who can start a team workflow by hand can equally
 * arrange for an event to start it. A caller who is not on the team gets 404,
 * never 403, so a subscription never confirms a team's existence.
 */
describe("event subscriptions — team ownership", () => {
  async function bootWithTeam(): Promise<TestApi> {
    const a = await boot();
    const now = Date.now();
    await a.providers.db.insert(teams).values({ id: "team_1", orgId: "local-org", name: "Platform", createdAt: now });
    await a.providers.db.insert(teamMembers).values({ teamId: "team_1", userId: "test-member", role: "member" });
    // A second team the caller is NOT on, to prove the refusal below is about
    // membership and not about the id being unknown.
    await a.providers.db.insert(teams).values({ id: "team_2", orgId: "local-org", name: "Other", createdAt: now });
    return a;
  }

  const teamBody: CreateEventSubscriptionRequest = {
    ...VALID_BODY,
    target: { kind: "orchestrator", orchestrator: "team", teamId: "team_1" },
  };

  it("stamps a team target with the TEAM as owner, not the creating member", async () => {
    const a = await bootWithTeam();
    const res = await postSubscription(a.baseUrl, teamBody, { "x-valet-test-user-id": "test-member" });
    expect(res.status).toBe(201);
    const created = (await res.json()) as CreateEventSubscriptionResponse;
    expect(created.ownerType).toBe("team");
    expect(created.ownerId).toBe("team_1");
    expect(created.ownerId).not.toBe("test-member");
    // The row agrees with the response — the owner is persisted, not just
    // reported, because the dispatcher reads the row and never the response.
    const rows = await a.providers.db
      .select()
      .from(eventSubscriptions)
      .where(eq(eventSubscriptions.id, created.id));
    expect(rows[0]?.ownerType).toBe("team");
    expect(rows[0]?.ownerId).toBe("team_1");
    // `createdBy` still records the human, which is what the dispatcher hands
    // the engine as the actor — a team id is not a user.
    expect(rows[0]?.createdBy).toBe("test-member");
  });

  it("404s a team the caller is not a member of, without naming it", async () => {
    const a = await bootWithTeam();
    const res = await postSubscription(
      a.baseUrl,
      { ...VALID_BODY, target: { kind: "orchestrator", orchestrator: "team", teamId: "team_2" } },
      { "x-valet-test-user-id": "test-member" },
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("team not found");
    expect(body.error).not.toContain("Other");
  });

  // `deleteTeam` deletes a team's own event_subscriptions rows under
  // `lockTeamForOwnership` (services/teams.ts). An insert that already
  // passed its membership/ownership checks before the delete's transaction
  // commits, but writes after, lands as an orphan pointing at a team (or
  // workflow) that no longer exists — the same race #709 closed for
  // schedules. These two tests force that race deterministically by
  // deleting the target from inside the pre-insert check's mock
  // implementation, which still calls through to the real check first.
  it("does not leave an orphaned subscription when the team is deleted between the membership check and the insert", async () => {
    const a = await bootWithTeam();
    const original = teamsService.isTeamMember;
    const spy = vi.spyOn(teamsService, "isTeamMember").mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      await deleteTeam(a.providers.db, { teamId: "team_1" });
      return result;
    });
    try {
      const res = await postSubscription(a.baseUrl, teamBody, { "x-valet-test-user-id": "test-member" });
      expect(res.status).toBe(400);
      expect(await a.providers.db.select().from(eventSubscriptions)).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("does not leave an orphaned subscription when its target workflow is deleted before the insert", async () => {
    const a = await bootWithTeam();
    const now = Date.now();
    await a.providers.db.insert(workflowDefinitions).values({
      id: "wf_team_race",
      orgId: "local-org",
      ownerType: "team",
      ownerId: "team_1",
      name: "target",
      definition: { version: "dag/v1", nodes: [], edges: [] },
      createdAt: now,
      updatedAt: now,
    });
    const original = workflowService.armableDefinitionRow;
    const spy = vi.spyOn(workflowService, "armableDefinitionRow").mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      await a.providers.db.delete(workflowDefinitions).where(eq(workflowDefinitions.id, "wf_team_race"));
      return result;
    });
    try {
      const res = await postSubscription(
        a.baseUrl,
        { ...VALID_BODY, target: { kind: "workflow", workflowId: "wf_team_race" } },
        { "x-valet-test-user-id": "test-member" },
      );
      expect(res.status).toBe(400);
      expect(await a.providers.db.select().from(eventSubscriptions)).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("does not leave an orphaned subscription when its target assistant is archived before the insert", async () => {
    const a = await bootWithTeam();
    const assistant = await createAssistant(
      a.providers.db,
      "local-org",
      { type: "team", id: "team_1" },
      "Team assistant",
    );
    const original = assistantsService.checkAssistantForOwner;
    const spy = vi
      .spyOn(assistantsService, "checkAssistantForOwner")
      .mockImplementationOnce(async (...args) => {
        const result = await original(...args);
        // `deleteTeam` retires a team's assistants under the same ownership
        // lock (services/teams.ts). This forces that race deterministically:
        // the check above still passes on stale data, then the assistant is
        // archived before the (fixed) in-lock recheck runs.
        await retireAssistant(a.providers.db, assistant.id);
        return result;
      });
    try {
      const res = await postSubscription(
        a.baseUrl,
        {
          ...VALID_BODY,
          target: { kind: "orchestrator", orchestrator: "team", teamId: "team_1", assistantId: assistant.id },
        },
        { "x-valet-test-user-id": "test-member" },
      );
      expect(res.status).toBe(400);
      expect(await a.providers.db.select().from(eventSubscriptions)).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("404s a team id that does not exist at all — same answer as one you're not on", async () => {
    const a = await bootWithTeam();
    const res = await postSubscription(
      a.baseUrl,
      { ...VALID_BODY, target: { kind: "orchestrator", orchestrator: "team", teamId: "team_nope" } },
      { "x-valet-test-user-id": "test-member" },
    );
    expect(res.status).toBe(404);
  });

  it("400s a team target with no teamId — it names no team", async () => {
    const a = await bootWithTeam();
    const res = await postSubscription(
      a.baseUrl,
      { ...VALID_BODY, target: { kind: "orchestrator", orchestrator: "team" } },
      { "x-valet-test-user-id": "test-member" },
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("team orchestrator target requires teamId");
  });

  it("400s a teamId on a user target — it would read as delivering to the team, and does not", async () => {
    const a = await bootWithTeam();
    const res = await postSubscription(
      a.baseUrl,
      { ...VALID_BODY, target: { kind: "orchestrator", orchestrator: "user", teamId: "team_1" } },
      { "x-valet-test-user-id": "test-member" },
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("teamId is only valid when orchestrator is team");
  });

  it("lets another member of the same team change and delete it", async () => {
    const a = await bootWithTeam();
    await a.providers.db.insert(teamMembers).values({ teamId: "team_1", userId: "test-admin", role: "member" });
    const created = (await (
      await postSubscription(a.baseUrl, teamBody, { "x-valet-test-user-id": "test-member" })
    ).json()) as CreateEventSubscriptionResponse;

    const patched = await fetch(`${a.baseUrl}/api/event-subscriptions/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "x-valet-test-user-id": "test-admin" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as PatchEventSubscriptionResponse).enabled).toBe(false);

    const deleted = await fetch(`${a.baseUrl}/api/event-subscriptions/${created.id}`, {
      method: "DELETE",
      headers: { "x-valet-test-user-id": "test-admin" },
    });
    expect(deleted.status).toBe(204);
  });

  it("404s a non-member trying to change or delete a team subscription", async () => {
    const a = await bootWithTeam();
    const created = (await (
      await postSubscription(a.baseUrl, teamBody, { "x-valet-test-user-id": "test-member" })
    ).json()) as CreateEventSubscriptionResponse;

    const patched = await fetch(`${a.baseUrl}/api/event-subscriptions/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "x-valet-test-user-id": "outsider" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(patched.status).toBe(404);

    const deleted = await fetch(`${a.baseUrl}/api/event-subscriptions/${created.id}`, {
      method: "DELETE",
      headers: { "x-valet-test-user-id": "outsider" },
    });
    expect(deleted.status).toBe(404);

    // Still there, and still enabled — the refusal changed nothing.
    const rows = await a.providers.db
      .select()
      .from(eventSubscriptions)
      .where(eq(eventSubscriptions.id, created.id));
    expect(rows[0]?.enabled).toBe(true);
  });
});

// ── Assistant routing on an orchestrator target ────────────────────────────
//
// A rule may name WHICH of its owner's assistants answers. Absent means the
// owner's default, the behavior every rule had before the field.
describe("event-subscription assistant target", () => {
  async function seedAssistants(a: TestApi): Promise<{ mine: string; foreign: string }> {
    const db = a.providers.db;
    // The first create for a principal takes the default slot.
    await createAssistant(db, "local-org", { type: "user", id: "local-user" }, "Primary");
    const mine = await createAssistant(db, "local-org", { type: "user", id: "local-user" }, "Ops");
    const foreign = await createAssistant(db, "local-org", { type: "user", id: "someone-else" }, "Theirs");
    return { mine: mine.id, foreign: foreign.id };
  }

  it("rejects selecting a named assistant", async () => {
    const a = await bootTestApi({ plugins: [githubPlugin] });
    const { mine } = await seedAssistants(a);

    const res = await fetch(`${a.baseUrl}/api/event-subscriptions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "to ops",
        eventKeys: ["github.pull_request.opened"],
        target: { kind: "orchestrator", orchestrator: "user", assistantId: mine },
      }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("Choose the personal or team workspace") });
  });

  it("refuses an assistant owned by someone else, without saying it exists", async () => {
    const a = await bootTestApi({ plugins: [githubPlugin] });
    const { foreign } = await seedAssistants(a);

    const res = await fetch(`${a.baseUrl}/api/event-subscriptions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "nope",
        eventKeys: ["github.pull_request.opened"],
        target: { kind: "orchestrator", orchestrator: "user", assistantId: foreign },
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    // Same message an id that does not exist gets: existence stays hidden.
    expect(body.error).toContain("Assistant selection is not supported");
  });

  it("rejects assistant routing patches", async () => {
    const a = await bootTestApi({ plugins: [githubPlugin] });
    const { mine } = await seedAssistants(a);

    const created = (await (
      await fetch(`${a.baseUrl}/api/event-subscriptions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "repoint me",
          eventKeys: ["github.pull_request.opened"],
          target: { kind: "orchestrator", orchestrator: "user" },
        }),
      })
    ).json()) as { id: string; target: { assistantId?: string } };
    expect(created.target.assistantId).toBeUndefined();

    for (const assistantId of [mine, null]) {
      const res = await fetch(`${a.baseUrl}/api/event-subscriptions/${created.id}`, {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ assistantId }),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: expect.stringContaining("Assistant selection is not supported") });
    }
  });

  it("refuses assistantId on a workflow target", async () => {
    const a = await bootTestApi({ plugins: [githubPlugin] });
    const { mine } = await seedAssistants(a);
    const res = await fetch(`${a.baseUrl}/api/event-subscriptions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "wrong kind",
        eventKeys: ["github.pull_request.opened"],
        target: { kind: "workflow", workflowId: "w1", assistantId: mine },
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("only valid on an orchestrator target");
  });
});

/**
 * Prompt templates on an orchestrator target (TKAI-491). The write gate is
 * what makes the delivery-time renderer total, so every refusal it owes is
 * asserted here; the rendering itself is `events/prompt-template.test.ts`.
 */
describe("event-subscription prompt templates", () => {
  const PROMPT_BODY = {
    name: "triage",
    eventKeys: ["github.pull_request.opened"],
    target: {
      kind: "orchestrator",
      systemPrompt: "Triage this pull request. Answer in one sentence.",
      userPromptTemplate: "{{payload.sender}} opened {{payload.repo}}: {{event.summary}}",
    },
  };

  it("stores both templates on the target and reads them back", async () => {
    const a = await boot();
    const res = await postSubscription(a.baseUrl, PROMPT_BODY);
    expect(res.status).toBe(201);
    const body = (await res.json()) as CreateEventSubscriptionResponse;
    expect(body.target).toMatchObject({
      kind: "orchestrator",
      systemPrompt: PROMPT_BODY.target.systemPrompt,
      userPromptTemplate: PROMPT_BODY.target.userPromptTemplate,
    });
  });

  it("400s a template variable outside the documented set, naming the fix", async () => {
    const a = await boot();
    const res = await postSubscription(a.baseUrl, {
      ...PROMPT_BODY,
      target: { kind: "orchestrator", userPromptTemplate: "{{session.history}}" },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("unknown variable");
    expect(body.error).toContain("event.summary");
  });

  it("400s a payload field the selected events do not declare", async () => {
    const a = await boot();
    const res = await postSubscription(a.baseUrl, {
      ...PROMPT_BODY,
      target: { kind: "orchestrator", userPromptTemplate: "{{payload.comment_body}}" },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("payload.comment_body");
  });

  it("400s a malformed template", async () => {
    const a = await boot();
    const res = await postSubscription(a.baseUrl, {
      ...PROMPT_BODY,
      target: { kind: "orchestrator", systemPrompt: "Watch {{refs.repo" },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("unclosed");
  });

  it("400s event text in the instruction field, so a sender cannot write the instruction", async () => {
    const a = await boot();
    const res = await postSubscription(a.baseUrl, {
      ...PROMPT_BODY,
      target: { kind: "orchestrator", systemPrompt: "Follow this: {{payload.sender}}" },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("{{payload.sender}}");
    expect(body.error).toContain("userPromptTemplate");
  });

  it("stores a template that shows the assistant a JSON shape", async () => {
    const a = await boot();
    const res = await postSubscription(a.baseUrl, {
      ...PROMPT_BODY,
      target: {
        kind: "orchestrator",
        systemPrompt: 'Reply with JSON like {"summary": {"text": "x"}}',
      },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as CreateEventSubscriptionResponse;
    expect(body.target).toMatchObject({
      systemPrompt: 'Reply with JSON like {"summary": {"text": "x"}}',
    });
  });

  it("400s a prompt template on a workflow target, so workflow prompts stay the workflow's own", async () => {
    const a = await boot();
    const res = await postSubscription(a.baseUrl, {
      ...PROMPT_BODY,
      target: { kind: "workflow", workflowId: "wf-1", systemPrompt: "Do it" },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "systemPrompt is only valid on an orchestrator target",
    );
  });

  it("patches a template, and null clears it back to the default delivery", async () => {
    const a = await boot();
    const created = (await (await postSubscription(a.baseUrl, PROMPT_BODY)).json()) as EventSubscriptionWire;

    const patched = (await (
      await patchSubscription(a.baseUrl, created.id, { systemPrompt: "Summarize it instead." })
    ).json()) as PatchEventSubscriptionResponse;
    expect(patched.target).toMatchObject({
      systemPrompt: "Summarize it instead.",
      userPromptTemplate: PROMPT_BODY.target.userPromptTemplate,
    });

    const cleared = (await (
      await patchSubscription(a.baseUrl, created.id, { systemPrompt: null, userPromptTemplate: null })
    ).json()) as PatchEventSubscriptionResponse;
    expect(cleared.target).toEqual({ kind: "orchestrator" });
  });

  it("400s a patched template that names a variable the rule's events do not declare", async () => {
    const a = await boot();
    const created = (await (await postSubscription(a.baseUrl, PROMPT_BODY)).json()) as EventSubscriptionWire;
    const res = await patchSubscription(a.baseUrl, created.id, {
      userPromptTemplate: "{{payload.comment_body}}",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("payload.comment_body");
  });

  it("re-validates a stored template against narrowed eventKeys", async () => {
    const a = await boot();
    const created = (await (
      await postSubscription(a.baseUrl, {
        name: "pr numbers",
        eventKeys: ["github.pull_request.opened"],
        target: { kind: "orchestrator", userPromptTemplate: "PR {{payload.pr_number}}" },
      })
    ).json()) as EventSubscriptionWire;

    // `pr_number` is a pull_request field; an issues-only rule cannot render it.
    const res = await patchSubscription(a.baseUrl, created.id, { eventKeys: ["github.issues.opened"] });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("payload.pr_number");
  });
});

describe("GET /api/events/filter-options", () => {
  // A plugin with two option sources: a plain one and one that dependsOn the
  // first, so the endpoint's dispatch, query passthrough, and dependsOn gating
  // are exercised without hitting a real provider.
  const fixturePlugin: ValetPlugin = {
    name: "fixture",
    version: "0",
    triggers: [
      {
        id: "fixture.thing",
        service: "fixture",
        description: "",
        verify: () => null,
        toEvent: (e) => ({
          key: "fixture.thing",
          dedupeKey: "d",
          occurredAt: new Date(0).toISOString(),
          refs: {},
          summary: "",
          payload: e.payload,
        }),
        catalog: [
          {
            key: "fixture.thing",
            description: "",
            filters: [
              { field: "repo", path: "repo", description: "", options: { source: "fixture.repos" } },
              { field: "branch", path: "branch", description: "", options: { source: "fixture.branches", dependsOn: ["repo"] } },
            ],
          },
        ],
      },
    ],
    filterOptionResolvers: {
      "fixture.repos": async (ctx) =>
        [
          { id: "acme/app", label: "acme/app" },
          { id: "acme/web", label: "acme/web" },
        ].filter((o) => !ctx.q || o.label.includes(ctx.q)),
      "fixture.branches": async (ctx) => (ctx.deps.repo ? [{ id: "main", label: "main" }] : []),
    },
  };

  async function bootFixture(): Promise<TestApi> {
    api = await bootTestApi({ plugins: [fixturePlugin] });
    return api;
  }

  it("lists a source's options and filters by q", async () => {
    const a = await bootFixture();
    const all = (await (await fetch(`${a.baseUrl}/api/events/filter-options?source=fixture.repos`)).json()) as {
      options: { id: string; label: string }[];
    };
    expect(all.options).toEqual([
      { id: "acme/app", label: "acme/app" },
      { id: "acme/web", label: "acme/web" },
    ]);
    const filtered = (await (await fetch(`${a.baseUrl}/api/events/filter-options?source=fixture.repos&q=web`)).json()) as {
      options: { id: string }[];
    };
    expect(filtered.options).toEqual([{ id: "acme/web", label: "acme/web" }]);
  });

  it("passes a dependsOn value through; empty without it", async () => {
    const a = await bootFixture();
    const without = (await (await fetch(`${a.baseUrl}/api/events/filter-options?source=fixture.branches`)).json()) as {
      options: unknown[];
    };
    expect(without.options).toEqual([]);
    const withRepo = (await (
      await fetch(`${a.baseUrl}/api/events/filter-options?source=fixture.branches&repo=acme/app`)
    ).json()) as { options: { id: string }[] };
    expect(withRepo.options).toEqual([{ id: "main", label: "main" }]);
  });

  it("unknown source returns an empty list and a reason, not an error", async () => {
    const a = await bootFixture();
    const res = await fetch(`${a.baseUrl}/api/events/filter-options?source=nope`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { options: unknown[]; reason?: string };
    expect(body.options).toEqual([]);
    expect(body.reason).toContain("unknown option source");
  });

  it("400s when source is missing", async () => {
    const a = await bootFixture();
    const res = await fetch(`${a.baseUrl}/api/events/filter-options`);
    expect(res.status).toBe(400);
  });

  // A rate-limited provider used to poison the 60s memo: the empty list from
  // the failed call was cached, so every retry inside the next minute answered
  // "no options" from cache and the user could not recover by retrying.
  it("does not cache a failed lookup, so the next call retries the provider", async () => {
    let calls = 0;
    // Its own source name: `filterOptionsCache` is module state keyed by
    // (org, source, deps, q), and it outlives each test's api instance.
    const flakyPlugin: ValetPlugin = {
      ...fixturePlugin,
      filterOptionResolvers: {
        "fixture.flaky": async () => {
          calls += 1;
          if (calls === 1) throw new Error("ratelimited");
          return [{ id: "acme/app", label: "acme/app" }];
        },
      },
    };
    api = await bootTestApi({ plugins: [flakyPlugin] });

    const first = (await (await fetch(`${api.baseUrl}/api/events/filter-options?source=fixture.flaky`)).json()) as {
      options: unknown[];
      reason?: string;
    };
    expect(first.options).toEqual([]);
    expect(first.reason).toContain("could not list options");

    const second = (await (await fetch(`${api.baseUrl}/api/events/filter-options?source=fixture.flaky`)).json()) as {
      options: { id: string }[];
      reason?: string;
    };
    expect(second.options).toEqual([{ id: "acme/app", label: "acme/app" }]);
    expect(second.reason).toBeUndefined();
    expect(calls).toBe(2);
  });
});

// ── Mention scoping (TKAI-299) ─────────────────────────────────────────────
//
// A subscription selecting `slack.app_mention` must name channels (or set the
// explicit `anyChannel` flag) and is force-filtered to its creator's linked
// Slack user. See `events/mention-scope.ts`.

describe("mention scoping (slack.app_mention)", () => {
  async function bootSlack(): Promise<TestApi> {
    api = await bootTestApi({ plugins: [slackPlugin] });
    return api;
  }

  /** Links a Valet user to a Slack user id, as the connect flow would. */
  async function linkSlack(a: TestApi, userId: string, externalId: string): Promise<void> {
    await a.providers.db.insert(userIdentityLinks).values({
      id: `uil-${userId}`,
      provider: "slack",
      externalId,
      userId,
      createdAt: Date.now(),
      notifyAttention: true,
    });
  }

  const MENTION_BODY: CreateEventSubscriptionRequest = {
    name: "my mentions",
    eventKeys: ["slack.app_mention"],
    filters: [{ field: "channel", op: "eq", value: "C123", label: "#eng" }],
    target: { kind: "orchestrator" },
  };

  it("a team-owned mention subscription uses membership instead of a creator filter", async () => {
    const a = await bootSlack();
    const now = Date.now();
    await a.providers.db.insert(teams).values({ id: "team_1", orgId: "local-org", name: "Platform", createdAt: now });
    await a.providers.db.insert(teamMembers).values({ teamId: "team_1", userId: "local-user", role: "admin" });
    const res = await postSubscription(a.baseUrl, {
      ...MENTION_BODY,
      target: { kind: "orchestrator", orchestrator: "team", teamId: "team_1" },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as CreateEventSubscriptionResponse;
    expect(body.ownerType).toBe("team");
    expect(body.ownerId).toBe("team_1");
    expect(body.filters).toEqual([
      { field: "channel", op: "eq", value: "C123", label: "#eng" },
    ]);
    const rows = await a.providers.db.select().from(eventSubscriptions).where(eq(eventSubscriptions.id, body.id));
    expect(rows[0].filters).toEqual(body.filters);
  });

  it("a team mention rule takes an organization audience, and an absent one reads back as team", async () => {
    const a = await bootSlack();
    const now = Date.now();
    await a.providers.db.insert(teams).values({ id: "team_1", orgId: "local-org", name: "Platform", createdAt: now });
    await a.providers.db.insert(teamMembers).values({ teamId: "team_1", userId: "local-user", role: "admin" });
    const teamTarget: EventSubscriptionTargetWire = { kind: "orchestrator", orchestrator: "team", teamId: "team_1" };

    const open = await postSubscription(a.baseUrl, { ...MENTION_BODY, target: teamTarget, audience: "organization" });
    expect(open.status).toBe(201);
    const opened = (await open.json()) as CreateEventSubscriptionResponse;
    expect(opened.audience).toBe("organization");
    const openRows = await a.providers.db.select().from(eventSubscriptions).where(eq(eventSubscriptions.id, opened.id));
    expect(openRows[0].audience).toBe("organization");

    const quiet = await postSubscription(a.baseUrl, {
      ...MENTION_BODY,
      name: "team only",
      filters: [{ field: "channel", op: "eq", value: "C999" }],
      target: teamTarget,
    });
    expect(quiet.status).toBe(201);
    const quieted = (await quiet.json()) as CreateEventSubscriptionResponse;
    expect(quieted.audience).toBe("team");
    const quietRows = await a.providers.db.select().from(eventSubscriptions).where(eq(eventSubscriptions.id, quieted.id));
    expect(quietRows[0].audience).toBeNull();
  });

  it("patches the audience of a team mention rule in both directions", async () => {
    const a = await bootSlack();
    const now = Date.now();
    await a.providers.db.insert(teams).values({ id: "team_1", orgId: "local-org", name: "Platform", createdAt: now });
    await a.providers.db.insert(teamMembers).values({ teamId: "team_1", userId: "local-user", role: "admin" });
    const res = await postSubscription(a.baseUrl, {
      ...MENTION_BODY,
      target: { kind: "orchestrator", orchestrator: "team", teamId: "team_1" },
    });
    const created = (await res.json()) as CreateEventSubscriptionResponse;

    const opened = await patchSubscription(a.baseUrl, created.id, { audience: "organization" });
    expect(opened.status).toBe(200);
    expect(((await opened.json()) as PatchEventSubscriptionResponse).audience).toBe("organization");

    const closed = await patchSubscription(a.baseUrl, created.id, { audience: "team" });
    expect(closed.status).toBe(200);
    expect(((await closed.json()) as PatchEventSubscriptionResponse).audience).toBe("team");
    const rows = await a.providers.db.select().from(eventSubscriptions).where(eq(eventSubscriptions.id, created.id));
    expect(rows[0].audience).toBe("team");
  });

  // A client that GETs a rule and PATCHes the object back must not be refused
  // for echoing a field the read itself filled in.
  it("accepts a read-modify-write patch of a rule that has no audience", async () => {
    const a = await bootSlack();
    await linkSlack(a, "local-user", "U_LOCAL");
    const created = (await (await postSubscription(a.baseUrl, {
      name: "my mentions", eventKeys: ["slack.app_mention"],
      filters: [{ field: "channel", op: "eq", value: "C1" }],
      target: { kind: "orchestrator", orchestrator: "user" },
    })).json()) as CreateEventSubscriptionResponse;

    const list = (await (await fetch(`${a.baseUrl}/api/event-subscriptions`)).json()) as ListEventSubscriptionsResponse;
    const echoed = list.subscriptions.find((sub) => sub.id === created.id);
    expect(echoed).toBeDefined();
    // A personal target carries no audience on the wire at all.
    expect(echoed?.audience).toBeUndefined();

    const res = await patchSubscription(a.baseUrl, created.id, { ...echoed, name: "renamed" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as PatchEventSubscriptionResponse).name).toBe("renamed");
  });

  // The runtime gate treats team ownership plus an orchestrator target as a
  // team mention rule, with no `orchestrator: "team"` on the target. The write
  // gate must read the same rows the same way.
  it("patches the audience of a team-owned rule whose target names no orchestrator", async () => {
    const a = await bootSlack();
    const now = Date.now();
    await a.providers.db.insert(teams).values({ id: "team_1", orgId: "local-org", name: "Platform", createdAt: now });
    await a.providers.db.insert(teamMembers).values({ teamId: "team_1", userId: "local-user", role: "admin" });
    await seedSubscriptionRow(a, "sub_runtime", "local-org", {
      ownerType: "team", ownerId: "team_1", eventKeys: ["slack.app_mention"],
      filters: [{ field: "channel", op: "eq", value: "C1" }],
      target: { kind: "orchestrator" },
    });

    const res = await patchSubscription(a.baseUrl, "sub_runtime", { audience: "organization" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as PatchEventSubscriptionResponse).audience).toBe("organization");
  });

  it("names the two accepted values when the audience is malformed", async () => {
    const a = await bootSlack();
    const now = Date.now();
    await a.providers.db.insert(teams).values({ id: "team_1", orgId: "local-org", name: "Platform", createdAt: now });
    await a.providers.db.insert(teamMembers).values({ teamId: "team_1", userId: "local-user", role: "admin" });
    const res = await postSubscription(a.baseUrl, {
      ...MENTION_BODY,
      target: { kind: "orchestrator", orchestrator: "team", teamId: "team_1" },
      audience: "everyone",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      'audience must be "team" or "organization". Choose one of those two values, or remove the audience.',
    );
  });

  it.each<EventSubscriptionTargetWire>([
    { kind: "workflow", workflowId: "wf_1" },
    { kind: "orchestrator", orchestrator: "user" },
  ])("refuses an audience on a target that is not a team assistant (%o)", async (target) => {
    const a = await bootSlack();
    await linkSlack(a, "local-user", "U_LOCAL");
    const res = await postSubscription(a.baseUrl, { ...MENTION_BODY, target, audience: "organization" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "Only a team assistant mention rule has an invocation audience. Point the rule at a team assistant, or remove the audience.",
    );
  });

  it.each(["team", "organization"])("redelivery rechecks the mentioner's current %s membership", async (removed) => {
    const a = await bootSlack();
    await a.providers.eventDispatcher.stop();
    await a.providers.db.insert(teams).values({ id: "team-replay", orgId: "local-org", name: "Replay", createdAt: Date.now() });
    await a.providers.db.insert(teamMembers).values({ teamId: "team-replay", userId: "member-b", role: "member" });
    await a.providers.db.insert(orgMembers).values({ orgId: "local-org", userId: "member-b", role: "member" });
    await linkSlack(a, "member-b", "U_B");
    await seedSubscriptionRow(a, "sub-replay", "local-org", {
      ownerType: "team", ownerId: "team-replay", eventKeys: ["slack.app_mention"],
      filters: [{ field: "channel", op: "eq", value: "C1" }], target: { kind: "orchestrator" },
    });
    await a.providers.db.insert(events).values({
      id: "event-replay", orgId: "local-org", service: "slack", eventKey: "slack.app_mention",
      dedupeKey: "replay", actor: { externalId: "U_B" }, refs: {}, summary: "Mention",
      payload: { user: "U_B", channel: "C1", ts: "1.2" }, occurredAt: Date.now(), receivedAt: Date.now(),
    });
    const first = await redeliver(a.baseUrl, "event-replay");
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ created: 1 });
    if (removed === "team") {
      await a.providers.db.delete(teamMembers).where(eq(teamMembers.teamId, "team-replay"));
    } else {
      await a.providers.db.delete(orgMembers).where(and(eq(orgMembers.orgId, "local-org"), eq(orgMembers.userId, "member-b")));
      // A stale team row and membership elsewhere must not authorize replay.
      await a.providers.db.insert(orgMembers).values({ orgId: "other-org", userId: "member-b", role: "member" });
      expect(await a.providers.db.select().from(teamMembers).where(eq(teamMembers.teamId, "team-replay"))).toHaveLength(1);
    }
    const second = await redeliver(a.baseUrl, "event-replay");
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ created: 0 });
  });

  it("injects the creator's linked Slack user filter on create", async () => {
    const a = await bootSlack();
    await linkSlack(a, "local-user", "U_LOCAL");
    const res = await postSubscription(a.baseUrl, MENTION_BODY);
    expect(res.status).toBe(201);
    const body = (await res.json()) as CreateEventSubscriptionResponse;
    expect(body.filters).toEqual([
      { field: "channel", op: "eq", value: "C123", label: "#eng" },
      { field: "user", op: "eq", value: "U_LOCAL" },
    ]);
    const rows = await a.providers.db.select().from(eventSubscriptions).where(eq(eventSubscriptions.id, body.id));
    expect(rows[0].filters).toEqual(body.filters);
  });

  it("keeps a user filter that already names the creator, without duplicating it", async () => {
    const a = await bootSlack();
    await linkSlack(a, "local-user", "U_LOCAL");
    const res = await postSubscription(a.baseUrl, {
      ...MENTION_BODY,
      filters: [...MENTION_BODY.filters!, { field: "user", op: "eq", value: "U_LOCAL" }],
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as CreateEventSubscriptionResponse;
    expect(body.filters!.filter((f) => f.field === "user")).toHaveLength(1);
  });

  it("refuses a user filter naming someone else", async () => {
    const a = await bootSlack();
    await linkSlack(a, "local-user", "U_LOCAL");
    const res = await postSubscription(a.baseUrl, {
      ...MENTION_BODY,
      filters: [...MENTION_BODY.filters!, { field: "user", op: "eq", value: "U_OTHER" }],
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("own @-mentions");
  });

  it("refuses creation when the creator has no linked Slack account", async () => {
    const a = await bootSlack();
    const res = await postSubscription(a.baseUrl, MENTION_BODY);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Connected accounts");
  });

  it("refuses creation without a channel filter unless anyChannel is set", async () => {
    const a = await bootSlack();
    await linkSlack(a, "local-user", "U_LOCAL");
    const res = await postSubscription(a.baseUrl, { ...MENTION_BODY, filters: [] });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("at least one channel");
  });

  it("a prefix channel filter does not satisfy the channel requirement", async () => {
    const a = await bootSlack();
    await linkSlack(a, "local-user", "U_LOCAL");
    const res = await postSubscription(a.baseUrl, {
      ...MENTION_BODY,
      filters: [{ field: "channel", op: "prefix", value: "C" }],
    });
    expect(res.status).toBe(400);
  });

  it("accepts multiple channels via an in filter", async () => {
    const a = await bootSlack();
    await linkSlack(a, "local-user", "U_LOCAL");
    const res = await postSubscription(a.baseUrl, {
      ...MENTION_BODY,
      filters: [{ field: "channel", op: "in", value: ["C123", "C456"] }],
    });
    expect(res.status).toBe(201);
  });

  it("anyChannel: true permits a channel-less mention subscription", async () => {
    const a = await bootSlack();
    await linkSlack(a, "local-user", "U_LOCAL");
    const res = await postSubscription(a.baseUrl, { ...MENTION_BODY, filters: [], anyChannel: true });
    expect(res.status).toBe(201);
    const body = (await res.json()) as CreateEventSubscriptionResponse;
    expect(body.filters).toEqual([{ field: "user", op: "eq", value: "U_LOCAL" }]);
  });

  it("refuses anyChannel combined with channel filters", async () => {
    const a = await bootSlack();
    await linkSlack(a, "local-user", "U_LOCAL");
    const res = await postSubscription(a.baseUrl, { ...MENTION_BODY, anyChannel: true });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Any channel");
  });

  it("refuses mixing app_mention with any other key", async () => {
    const a = await bootSlack();
    await linkSlack(a, "local-user", "U_LOCAL");
    const noUserField = await postSubscription(a.baseUrl, {
      ...MENTION_BODY,
      eventKeys: ["slack.app_mention", "slack.channel_archive"],
    });
    expect(noUserField.status).toBe(400);
    expect(((await noUserField.json()) as { error: string }).error).toContain("slack.channel_archive");

    // A key WITH a user field is refused too: the injected creator filter
    // would silently narrow it to the creator's own events.
    const withUserField = await postSubscription(a.baseUrl, {
      ...MENTION_BODY,
      eventKeys: ["slack.app_mention", "slack.message"],
    });
    expect(withUserField.status).toBe(400);
    expect(((await withUserField.json()) as { error: string }).error).toContain("slack.message");
  });

  it("refuses an empty channel in list instead of storing a dead filter", async () => {
    const a = await bootSlack();
    await linkSlack(a, "local-user", "U_LOCAL");
    const res = await postSubscription(a.baseUrl, {
      ...MENTION_BODY,
      filters: [{ field: "channel", op: "in", value: [] }],
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("empty list");
  });

  it("a slack.* wildcard cannot widen around the gate", async () => {
    const a = await bootSlack();
    await linkSlack(a, "local-user", "U_LOCAL");
    const res = await postSubscription(a.baseUrl, { ...MENTION_BODY, eventKeys: ["slack.*"] });
    // The wildcard selects app_mention, so scoping applies — and the wildcard
    // also selects user-less keys, which the mix rule refuses.
    expect(res.status).toBe(400);
  });

  it("leaves non-mention slack subscriptions unscoped", async () => {
    const a = await bootSlack();
    const res = await postSubscription(a.baseUrl, {
      name: "all channel messages",
      eventKeys: ["slack.message"],
      filters: [],
      target: { kind: "orchestrator" },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as CreateEventSubscriptionResponse;
    expect(body.filters).toEqual([]);
  });

  it("PATCH re-applies scoping keyed to the creator when filters change", async () => {
    const a = await bootSlack();
    // Row created by `someone` (linked), owned by the caller so it is mutable.
    await linkSlack(a, "someone", "U_SOMEONE");
    await seedSubscriptionRow(a, "sub_m1", "local-org", {
      eventKeys: ["slack.app_mention"],
      filters: [
        { field: "channel", op: "eq", value: "C123" },
        { field: "user", op: "eq", value: "U_SOMEONE" },
      ],
      ownerType: "user",
      ownerId: "local-user",
    });
    const res = await fetch(`${a.baseUrl}/api/event-subscriptions/sub_m1`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filters: [], anyChannel: true }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PatchEventSubscriptionResponse;
    // The injected filter names the CREATOR's Slack user, not the caller's.
    expect(body.filters).toEqual([{ field: "user", op: "eq", value: "U_SOMEONE" }]);
  });

  it("PATCH of a stored any-channel row keeps working without re-sending the flag", async () => {
    const a = await bootSlack();
    await linkSlack(a, "someone", "U_SOMEONE");
    // Stored any-channel state: mention key, no channel filter.
    await seedSubscriptionRow(a, "sub_m4", "local-org", {
      eventKeys: ["slack.app_mention"],
      filters: [{ field: "user", op: "eq", value: "U_SOMEONE" }],
      ownerType: "user",
      ownerId: "local-user",
    });
    // The patch tunes a text filter and never touches channel scope. The
    // server derives the row's any-channel state, so no flag is needed.
    const res = await fetch(`${a.baseUrl}/api/event-subscriptions/sub_m4`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filters: [
          { field: "user", op: "eq", value: "U_SOMEONE" },
          { field: "text", op: "contains", value: "deploy" },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PatchEventSubscriptionResponse;
    expect(body.filters.some((f) => f.field === "text")).toBe(true);
  });

  it("PATCH can narrow a stored any-channel row to named channels", async () => {
    const a = await bootSlack();
    await linkSlack(a, "someone", "U_SOMEONE");
    await seedSubscriptionRow(a, "sub_m5", "local-org", {
      eventKeys: ["slack.app_mention"],
      filters: [{ field: "user", op: "eq", value: "U_SOMEONE" }],
      ownerType: "user",
      ownerId: "local-user",
    });
    const res = await fetch(`${a.baseUrl}/api/event-subscriptions/sub_m5`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filters: [
          { field: "user", op: "eq", value: "U_SOMEONE" },
          { field: "channel", op: "eq", value: "C999" },
        ],
      }),
    });
    expect(res.status).toBe(200);
  });

  it("PATCH cannot strip the channel scope without anyChannel", async () => {
    const a = await bootSlack();
    await linkSlack(a, "someone", "U_SOMEONE");
    await seedSubscriptionRow(a, "sub_m2", "local-org", {
      eventKeys: ["slack.app_mention"],
      filters: [
        { field: "channel", op: "eq", value: "C123" },
        { field: "user", op: "eq", value: "U_SOMEONE" },
      ],
      ownerType: "user",
      ownerId: "local-user",
    });
    const res = await fetch(`${a.baseUrl}/api/event-subscriptions/sub_m2`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filters: [{ field: "user", op: "eq", value: "U_SOMEONE" }] }),
    });
    expect(res.status).toBe(400);
  });

  it("an enabled-only PATCH skips scoping, even when the creator is unlinked", async () => {
    const a = await bootSlack();
    // No link for `someone`: a toggle must still work on an old row.
    await seedSubscriptionRow(a, "sub_m3", "local-org", {
      eventKeys: ["slack.app_mention"],
      filters: [{ field: "channel", op: "eq", value: "C123" }],
      ownerType: "user",
      ownerId: "local-user",
    });
    const res = await fetch(`${a.baseUrl}/api/event-subscriptions/sub_m3`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(200);
  });
});

describe("subscription collision gate (TKAI-294)", () => {
  /** The existing narrow rule the candidates below step on: same event key
   * as VALID_BODY, scoped to one repo. */
  async function seedNarrowRule(a: TestApi, over: SeedSubscriptionOpts = {}): Promise<void> {
    await seedSubscriptionRow(a, "sub_narrow", "local-org", {
      name: "narrow repo rule",
      eventKeys: ["github.pull_request.opened"],
      filters: [{ field: "repo", op: "eq", value: "acme/widgets" }],
      ...over,
    });
  }

  it("409s a create that covers an existing rule, naming it in the payload", async () => {
    const a = await boot();
    await seedNarrowRule(a);

    const res = await postSubscription(a.baseUrl, { ...VALID_BODY, filters: [] });
    expect(res.status).toBe(409);
    const body = (await res.json()) as EventSubscriptionCollisionErrorWire;
    expect(body.error).toContain("narrow repo rule");
    expect(body.collisions.blocking).toHaveLength(1);
    expect(body.collisions.blocking[0].subscription.id).toBe("sub_narrow");
    expect(body.collisions.blocking[0].relation).toBe("superset");
    expect(body.collisions.blocking[0].sharedKeys).toEqual(["github.pull_request.opened"]);

    // The blocked write left no row behind.
    const rows = await a.providers.db.select().from(eventSubscriptions);
    expect(rows).toHaveLength(1);
  });

  it("allowCollision commits the blocked write and reports what it stepped on", async () => {
    const a = await boot();
    await seedNarrowRule(a);

    const res = await postSubscription(a.baseUrl, {
      ...VALID_BODY,
      filters: [],
      allowCollision: true,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as CreateEventSubscriptionResponse;
    expect(body.collisions?.blocking.map((b) => b.subscription.id)).toEqual(["sub_narrow"]);
  });

  it("201s an overlapping (non-containing) create with a warning payload", async () => {
    const a = await boot();
    await seedNarrowRule(a, {
      filters: [{ field: "repo", op: "in", value: ["acme/widgets", "acme/gadgets"] }],
    });

    // VALID_BODY's repo eq is a strict subset of the seeded `in` list.
    const res = await postSubscription(a.baseUrl, VALID_BODY);
    expect(res.status).toBe(201);
    const body = (await res.json()) as CreateEventSubscriptionResponse;
    expect(body.collisions?.blocking).toEqual([]);
    expect(body.collisions?.overlapping.map((o) => o.subscription.id)).toEqual(["sub_narrow"]);
    expect(body.collisions?.overlapping[0].relation).toBe("subset");
  });

  it("ignores disabled rules — an unarmed rule cannot collide", async () => {
    const a = await boot();
    await seedNarrowRule(a, { enabled: false });

    const res = await postSubscription(a.baseUrl, { ...VALID_BODY, filters: [] });
    expect(res.status).toBe(201);
    const body = (await res.json()) as CreateEventSubscriptionResponse;
    expect(body.collisions).toBeUndefined();
  });

  it("ignores disjoint rules — a different repo is no collision", async () => {
    const a = await boot();
    await seedNarrowRule(a, {
      filters: [{ field: "repo", op: "eq", value: "beta/things" }],
    });

    // VALID_BODY is scoped to acme/widgets; the seeded rule to beta/things.
    const res = await postSubscription(a.baseUrl, VALID_BODY);
    expect(res.status).toBe(201);
    const body = (await res.json()) as CreateEventSubscriptionResponse;
    expect(body.collisions).toBeUndefined();
  });

  it("never compares against another org's rules (no cross-org leak)", async () => {
    const a = await boot();
    await seedNarrowRule(a, {});
    // Same coverage, other org — must not appear in any payload.
    await seedSubscriptionRow(a, "sub_foreign", "other-org", {
      eventKeys: ["github.pull_request.opened"],
      filters: [{ field: "repo", op: "eq", value: "acme/widgets" }],
    });

    const res = await postSubscription(a.baseUrl, { ...VALID_BODY, filters: [] });
    expect(res.status).toBe(409);
    const body = (await res.json()) as EventSubscriptionCollisionErrorWire;
    const ids = [
      ...body.collisions.blocking.map((b) => b.subscription.id),
      ...body.collisions.overlapping.map((o) => o.subscription.id),
    ];
    expect(ids).toEqual(["sub_narrow"]);
  });

  it("409s a PATCH that widens a rule over an existing one; allowCollision overrides", async () => {
    const a = await boot();
    const created = (await (
      await postSubscription(a.baseUrl, VALID_BODY)
    ).json()) as CreateEventSubscriptionResponse;
    await seedNarrowRule(a, {
      filters: [{ field: "repo", op: "eq", value: "acme/gadgets" }],
    });

    const patch = (extra: Record<string, unknown>) =>
      fetch(`${a.baseUrl}/api/event-subscriptions/${created.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filters: [], ...extra }),
      });

    const blocked = await patch({});
    expect(blocked.status).toBe(409);
    const blockedBody = (await blocked.json()) as EventSubscriptionCollisionErrorWire;
    expect(blockedBody.collisions.blocking[0].subscription.id).toBe("sub_narrow");
    // The refused patch changed nothing.
    const rows = await a.providers.db
      .select()
      .from(eventSubscriptions)
      .where(eq(eventSubscriptions.id, created.id));
    expect(rows[0].filters).toEqual(VALID_BODY.filters);

    const overridden = await patch({ allowCollision: true });
    expect(overridden.status).toBe(200);
    const body = (await overridden.json()) as PatchEventSubscriptionResponse;
    expect(body.collisions?.blocking.map((b) => b.subscription.id)).toEqual(["sub_narrow"]);
  });

  it("a disabled create skips the gate; enabling it later runs it", async () => {
    const a = await boot();
    await seedNarrowRule(a);

    const created = (await (
      await postSubscription(a.baseUrl, { ...VALID_BODY, filters: [], enabled: false })
    ).json()) as CreateEventSubscriptionResponse;
    expect(created.collisions).toBeUndefined();

    const arm = await fetch(`${a.baseUrl}/api/event-subscriptions/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(arm.status).toBe(409);

    // A patch that leaves the rule disabled stays uncheckable — nothing fires.
    const rename = await fetch(`${a.baseUrl}/api/event-subscriptions/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "still parked" }),
    });
    expect(rename.status).toBe(200);
  });
});
