/**
 * Event system end-to-end (event-system plan, Task 10): a signed webhook
 * travels the full pipeline over real HTTP — ingress verification → event
 * row → subscription match → delivery row → dispatcher → workflow run on
 * the real `LocalRunHost`. One case per ingress, because the two ingresses
 * differ: Linear arrives on the generic `/webhooks/events/:service` route,
 * GitHub on the App's own `/webhooks/github-app` route, which forwards
 * every non-installation event family into the same pipeline.
 *
 * The ingest path nudges the dispatcher in-process (fire-and-forget), so the
 * delivery may already be resolved by the time the webhook POST returns. The
 * test therefore awaits `providers.eventDispatcher.pollOnce()` for the
 * deterministic path and asserts final DB state via `expect.poll` — covering
 * both the "nudge already delivered" and "manual poll delivers" orderings
 * without sleeps.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { eq } from "drizzle-orm";
import githubPlugin from "@valet/plugin-github/plugin";
import linearPlugin from "@valet/plugin-linear/plugin";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { startGithubFixture, type GithubFixture } from "../test-helpers/github-fixture.js";
import { eventDeliveries, events, linearInstallations, workflowRuns } from "../schema/index.js";
import type {
  CreateEventSubscriptionResponse,
  CreateWorkflowResponse,
  PostGithubAppManifestResponse,
  RedeliverEventResponse,
} from "../wire/types.js";

let api: TestApi | undefined;
let githubFixture: GithubFixture | undefined;
const prevGithubApiUrl = process.env.GITHUB_API_URL;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
  await githubFixture?.close();
  githubFixture = undefined;
  if (prevGithubApiUrl === undefined) delete process.env.GITHUB_API_URL;
  else process.env.GITHUB_API_URL = prevGithubApiUrl;
});

const WEBHOOK_SECRET = "s1";
const HEADERS = { "Content-Type": "application/json" };

/** Minimal valid DAG — same literal as `routes/workflows.test.ts`. */
const VALID_DEFINITION = {
  version: "dag/v1",
  nodes: [
    { id: "trigger", type: "trigger" },
    { id: "stop", type: "stop" },
  ],
  edges: [{ from: "trigger", to: "stop" }],
};

/** Signs a Linear body the way plugin-linear verifies it (HMAC-SHA256 hex
 * over the raw body). */
function linearSig(body: string): string {
  return createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");
}

/** Org linear credential (webhook secret in metadata) + installation row
 * mapping the Linear workspace to `local-org` — same seeding as
 * `event-webhooks.test.ts`. */
async function seedLinearOrg(a: TestApi): Promise<void> {
  await a.providers.engineCredentials.save({ type: "org", id: "local-org" }, "linear", {
    type: "oauth2",
    accessToken: "linear-access-token",
    metadata: { webhookSecret: WEBHOOK_SECRET },
  });
  const now = Date.now();
  await a.providers.db.insert(linearInstallations).values({
    id: "li_e2e",
    orgId: "local-org",
    workspaceId: "lin-org-1",
    workspaceName: "Linear Test Workspace",
    webhookId: "linear-test-webhook",
    connectedBy: "local-user",
    createdAt: now,
    updatedAt: now,
  });
}

function issueCreateBody(teamKey: string, id: string): string {
  return JSON.stringify({
    action: "create",
    type: "Issue",
    organizationId: "lin-org-1",
    webhookTimestamp: Date.now(),
    data: { id, identifier: `${teamKey}-1`, title: "Bug", team: { key: teamKey } },
    webhookId: `wh-${id}`,
    createdAt: new Date().toISOString(),
  });
}

/** Every run of one workflow. Reads through the module-level `api`, like the
 * `expect.poll` closures below. */
async function runsOf(workflowId: string) {
  return api!.providers.db.select().from(workflowRuns).where(eq(workflowRuns.workflowId, workflowId));
}

async function postLinear(baseUrl: string, body: string, deliveryId: string): Promise<Response> {
  return fetch(`${baseUrl}/webhooks/events/linear`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Linear-Signature": linearSig(body),
      "Linear-Delivery": deliveryId,
    },
    body,
  });
}

/** The `params` jsonb shape is owned by the dispatcher's `startWorkflow`
 * (a `RunParams` whose `input` is a `WorkflowTriggerPayload`). */
interface RunParamsShape {
  workflowId: string;
  input: { type: string; data: { key: string } };
}

describe("event system e2e: signed webhook → subscription match → workflow run", () => {
  it("delivers a matching Linear event into a workflow run; filtered events create no delivery", async () => {
    api = await bootTestApi({ plugins: [githubPlugin, linearPlugin] });
    await seedLinearOrg(api);

    // ── Workflow definition via the API ─────────────────────────────────
    const wfRes = await fetch(`${api.baseUrl}/api/workflows`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ name: "on-issue", definition: VALID_DEFINITION }),
    });
    expect(wfRes.status).toBe(201);
    const workflow = (await wfRes.json()) as CreateWorkflowResponse;

    // ── Subscription targeting it, filtered to team TKAI ────────────────
    const subRes = await fetch(`${api.baseUrl}/api/event-subscriptions`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({
        name: "tkai issues",
        eventKeys: ["linear.issue.create"],
        filters: [{ field: "team", op: "eq", value: "TKAI" }],
        target: { kind: "workflow", workflowId: workflow.id },
      }),
    });
    expect(subRes.status).toBe(201);
    const sub = (await subRes.json()) as CreateEventSubscriptionResponse;

    // ── Signed webhook, team TKAI → 204 ─────────────────────────────────
    const res = await postLinear(api.baseUrl, issueCreateBody("TKAI", "iss-1"), "del-1");
    expect(res.status).toBe(204);

    // Deterministic drive: if the ingest nudge's poll is still in flight,
    // this is a no-op (draining guard) and expect.poll below covers it; if
    // the nudge already finished, this poll is what delivers.
    await api.providers.eventDispatcher.pollOnce();

    const eventRows = await api.providers.db.select().from(events).where(eq(events.orgId, "local-org"));
    expect(eventRows).toHaveLength(1);
    expect(eventRows[0].eventKey).toBe("linear.issue.create");

    await expect
      .poll(
        async () => {
          const rows = await api!.providers.db
            .select()
            .from(eventDeliveries)
            .where(eq(eventDeliveries.eventId, eventRows[0].id));
          return rows.map((r) => ({ status: r.status, subscriptionId: r.subscriptionId }));
        },
        { timeout: 5_000 },
      )
      .toEqual([{ status: "delivered", subscriptionId: sub.id }]);

    const runRows = await api.providers.db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.workflowId, workflow.id));
    expect(runRows).toHaveLength(1);
    const params = runRows[0].params as RunParamsShape;
    expect(params.workflowId).toBe(workflow.id);
    expect(params.input.type).toBe("event");
    expect(params.input.data.key).toBe("linear.issue.create");

    // ── Negative: team OTHER fails the filter — event is dropped, not stored ──
    // Ingest is match-gated: an event that matches no subscription (here the
    // filter excludes it) is never persisted. This is the privacy rule — the
    // events table keeps only what a subscription asked for.
    const negRes = await postLinear(api.baseUrl, issueCreateBody("OTHER", "iss-2"), "del-2");
    expect(negRes.status).toBe(204);

    const allEvents = await api.providers.db.select().from(events).where(eq(events.orgId, "local-org"));
    expect(allEvents).toHaveLength(1);
    expect(allEvents[0].id).toBe(eventRows[0].id);

    // The run count is unchanged — the filtered event started nothing.
    const runsAfter = await api.providers.db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.workflowId, workflow.id));
    expect(runsAfter).toHaveLength(1);
  }, 30_000);
});

describe("event system e2e: redelivery starts a SECOND workflow run", () => {
  it("replays a delivered event through a new delivery row and a new run", async () => {
    api = await bootTestApi({ plugins: [githubPlugin, linearPlugin] });
    await seedLinearOrg(api);

    const wfRes = await fetch(`${api.baseUrl}/api/workflows`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ name: "on-issue", definition: VALID_DEFINITION }),
    });
    const workflow = (await wfRes.json()) as CreateWorkflowResponse;

    const subRes = await fetch(`${api.baseUrl}/api/event-subscriptions`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({
        name: "tkai issues",
        eventKeys: ["linear.issue.create"],
        filters: [],
        target: { kind: "workflow", workflowId: workflow.id },
      }),
    });
    expect(subRes.status).toBe(201);

    // ── First pass: the event arrives and runs once ─────────────────────
    expect((await postLinear(api.baseUrl, issueCreateBody("TKAI", "iss-1"), "del-1")).status).toBe(204);
    await api.providers.eventDispatcher.pollOnce();

    const eventRows = await api.providers.db.select().from(events).where(eq(events.orgId, "local-org"));
    expect(eventRows).toHaveLength(1);
    const eventId = eventRows[0].id;

    await expect
      .poll(async () => (await runsOf(workflow.id)).map((r) => r.status), { timeout: 10_000 })
      .toEqual(["settled"]);
    const firstRunId = (await runsOf(workflow.id))[0].id;

    // ── Redelivery: the user repaired the workflow and wants this event ──
    const redeliverRes = await fetch(`${api.baseUrl}/api/events/${eventId}/redeliver`, { method: "POST" });
    expect(redeliverRes.status).toBe(200);
    expect((await redeliverRes.json()) as RedeliverEventResponse).toEqual({ created: 1 });

    await api.providers.eventDispatcher.pollOnce();

    // Two delivery rows with DIFFERENT ids. This is the whole point: the
    // dispatcher derives the run id from the delivery id and returns early
    // when that run exists, so a redelivery that reused the first delivery
    // id would report success and start nothing.
    const deliveryRows = await api.providers.db
      .select()
      .from(eventDeliveries)
      .where(eq(eventDeliveries.eventId, eventId));
    expect(deliveryRows).toHaveLength(2);
    expect(new Set(deliveryRows.map((d) => d.id)).size).toBe(2);

    // Two runs, both really executed by the real host, one per delivery.
    await expect
      .poll(async () => (await runsOf(workflow.id)).map((r) => ({ status: r.status, outcome: r.outcome })), {
        timeout: 10_000,
      })
      .toEqual([
        { status: "settled", outcome: "completed" },
        { status: "settled", outcome: "completed" },
      ]);
    const runIds = (await runsOf(workflow.id)).map((r) => r.id).sort();
    expect(runIds).toEqual(deliveryRows.map((d) => `wfrun_evt_${d.id}`).sort());
    expect(runIds).toContain(firstRunId);
  }, 30_000);
});

// ── GitHub ingress ────────────────────────────────────────────────────────
//
// GitHub deliveries do NOT arrive on `/webhooks/events/:service` — that
// route only resolves an org for `linear`. They arrive on the GitHub App's
// own `/webhooks/github-app` route, which verifies the App signature and
// then forwards the event into the same ingest pipeline. The helpers below
// are local to this file for the same reason the Linear ones are: the
// route-level suites own their own seeding.

const { privateKey: GITHUB_APP_PEM } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const GITHUB_WEBHOOK_SECRET = "gh-webhook-secret";

/** Drives the real manifest → setup exchange against the fake GitHub API so
 * the deployment has a `github_app` credential to verify signatures with.
 * A REAL PEM, because any discovery along the way mints an App JWT. */
async function configureGithubApp(baseUrl: string): Promise<void> {
  githubFixture = startGithubFixture({
    listInstallations: () => ({ body: [] }),
    convertManifest: () => ({
      body: {
        id: 42,
        slug: "valet-acme",
        name: "Valet Acme",
        client_id: "Iv1.client",
        client_secret: "oauth-client-secret",
        webhook_secret: GITHUB_WEBHOOK_SECRET,
        pem: GITHUB_APP_PEM,
        html_url: "https://github.com/apps/valet-acme",
      },
    }),
  });
  process.env.GITHUB_API_URL = githubFixture.url;

  const manifestRes = await fetch(`${baseUrl}/api/org/github-app/manifest`, {
    method: "POST",
    headers: HEADERS,
    body: "{}",
  });
  expect(manifestRes.status).toBe(200);
  const { state } = (await manifestRes.json()) as PostGithubAppManifestResponse;

  const setupRes = await fetch(
    `${baseUrl}/api/org/github-app/setup?code=some-code&state=${encodeURIComponent(state)}`,
    { redirect: "manual" },
  );
  expect(setupRes.status).toBe(302);
}

function prOpenedBody(repoFullName: string, prNumber: number): string {
  return JSON.stringify({
    action: "opened",
    number: prNumber,
    pull_request: {
      number: prNumber,
      title: "Add the thing",
      html_url: `https://github.com/${repoFullName}/pull/${prNumber}`,
      updated_at: new Date().toISOString(),
    },
    repository: { full_name: repoFullName },
    sender: { id: 4321, login: "octocat" },
  });
}

async function postGithubDelivery(baseUrl: string, body: string, deliveryId: string): Promise<Response> {
  const signature = `sha256=${createHmac("sha256", GITHUB_WEBHOOK_SECRET).update(body).digest("hex")}`;
  return fetch(`${baseUrl}/webhooks/github-app`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-github-event": "pull_request",
      "x-github-delivery": deliveryId,
      "x-hub-signature-256": signature,
    },
    body,
  });
}

describe("event system e2e: signed GitHub webhook → subscription match → workflow run", () => {
  it("starts a workflow run from a pull_request delivery; a filtered-out repo starts nothing", async () => {
    api = await bootTestApi({ plugins: [githubPlugin] });
    await configureGithubApp(api.baseUrl);

    // ── Workflow definition via the API ─────────────────────────────────
    const wfRes = await fetch(`${api.baseUrl}/api/workflows`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ name: "review-on-pr", definition: VALID_DEFINITION }),
    });
    expect(wfRes.status).toBe(201);
    const workflow = (await wfRes.json()) as CreateWorkflowResponse;

    // ── Subscription targeting it, filtered to one repo ─────────────────
    const subRes = await fetch(`${api.baseUrl}/api/event-subscriptions`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({
        name: "acme/widgets PRs",
        eventKeys: ["github.pull_request.opened"],
        filters: [{ field: "repo", op: "eq", value: "acme/widgets" }],
        target: { kind: "workflow", workflowId: workflow.id },
      }),
    });
    expect(subRes.status).toBe(201);
    const sub = (await subRes.json()) as CreateEventSubscriptionResponse;

    // ── Signed delivery for the matching repo → 204 ─────────────────────
    const res = await postGithubDelivery(api.baseUrl, prOpenedBody("acme/widgets", 7), "gh-del-1");
    expect(res.status).toBe(204);

    await api.providers.eventDispatcher.pollOnce();

    const eventRows = await api.providers.db.select().from(events).where(eq(events.orgId, "local-org"));
    expect(eventRows).toHaveLength(1);
    expect(eventRows[0].service).toBe("github");
    expect(eventRows[0].eventKey).toBe("github.pull_request.opened");
    expect(eventRows[0].dedupeKey).toBe("gh-del-1");

    await expect
      .poll(
        async () => {
          const rows = await api!.providers.db
            .select()
            .from(eventDeliveries)
            .where(eq(eventDeliveries.eventId, eventRows[0].id));
          return rows.map((r) => ({ status: r.status, subscriptionId: r.subscriptionId }));
        },
        { timeout: 5_000 },
      )
      .toEqual([{ status: "delivered", subscriptionId: sub.id }]);

    // The run must actually RUN, not just exist as a `pending` row — the
    // real `LocalRunHost` drives this trigger → stop definition to settled.
    await expect
      .poll(
        async () => {
          const rows = await api!.providers.db
            .select()
            .from(workflowRuns)
            .where(eq(workflowRuns.workflowId, workflow.id));
          return rows.map((r) => ({ status: r.status, outcome: r.outcome }));
        },
        { timeout: 10_000 },
      )
      .toEqual([{ status: "settled", outcome: "completed" }]);

    const runRows = await api.providers.db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.workflowId, workflow.id));
    const params = runRows[0].params as RunParamsShape;
    expect(params.workflowId).toBe(workflow.id);
    expect(params.input.type).toBe("event");
    expect(params.input.data.key).toBe("github.pull_request.opened");

    // ── Negative: another repo fails the filter — event is dropped, not stored ─
    // Ingest is match-gated: an event no subscription matches (the repo filter
    // excludes it) is never persisted. The events table keeps only what a
    // subscription asked for.
    const negRes = await postGithubDelivery(api.baseUrl, prOpenedBody("acme/other", 8), "gh-del-2");
    expect(negRes.status).toBe(204);

    const allEvents = await api.providers.db.select().from(events).where(eq(events.orgId, "local-org"));
    expect(allEvents).toHaveLength(1);
    expect(allEvents[0].id).toBe(eventRows[0].id);

    await api.providers.eventDispatcher.pollOnce();

    const runsAfter = await api.providers.db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.workflowId, workflow.id));
    expect(runsAfter).toHaveLength(1);
  }, 30_000);
});
