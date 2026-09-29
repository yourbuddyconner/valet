/**
 * EventDispatcher unit tests (event-system plan Task 6): real PGlite rows
 * for events/subscriptions/deliveries, recording fakes at the two seams
 * (`RunHost`, `deliverToOrchestrator`). `pollOnce()` is driven directly —
 * no timers, no sleeps.
 */
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import githubPlugin from "@valet/plugin-github/plugin";
import { eq } from "drizzle-orm";
import type { RunHost, WorkflowTriggerPayload } from "@valet/workflow";
import { freshTestPgDb, type TestPgDb } from "../test-helpers/pg-test-db.js";
import { PgWorkflowStore } from "../workflows/pg-store.js";
import { findFollowedThread } from "./followed-threads.js";
import {
  teams,
  teamMembers,
  orgMembers,
  userIdentityLinks,
  eventDeliveries,
  events,
  eventSubscriptions,
  workflowDefinitions,
  workflowRuns,
  workflowSignals,
} from "../schema/index.js";
import { EventDispatcher, type OrchestratorDeliverFn } from "./dispatcher.js";

const ORG = "org-1";

function fakeRunHost(overrides: Partial<RunHost> = {}): RunHost {
  return {
    start: vi.fn(async () => {}),
    wake: vi.fn(async () => {}),
    scheduleWake: vi.fn(async () => {}),
    terminate: vi.fn(async () => {}),
    startHost: vi.fn(),
    stopHost: vi.fn(async () => {}),
    ...overrides,
  };
}

interface SeedOpts {
  target: unknown;
  ownerType?: "user" | "team" | "org";
  attempts?: number;
  status?: "pending" | "failed";
  eventKey?: string;
  ownerId?: string;
  service?: string;
  eventKeys?: string[];
  refs?: Record<string, string>;
  summary?: string;
  payload?: unknown;
  actor?: unknown;
}

describe("EventDispatcher", () => {
  let tdb: TestPgDb;

  beforeEach(async () => {
    tdb = await freshTestPgDb();
  });

  /** Seeds one event + subscription + due delivery; returns their ids. */
  async function seedDelivery(opts: SeedOpts) {
    const db = tdb.appDb;
    const now = Date.now();
    const eventId = randomUUID();
    const subscriptionId = randomUUID();
    const deliveryId = randomUUID();
    await db.insert(events).values({
      id: eventId,
      orgId: ORG,
      service: opts.service ?? "github",
      eventKey: opts.eventKey ?? "github.issues.opened",
      dedupeKey: randomUUID(),
      actor: opts.actor ?? null,
      refs: opts.refs ?? { repo: "acme/site", installation_id: "42" },
      summary: opts.summary ?? "Issue #7 opened: broken build",
      payload: opts.payload ?? { action: "opened", issue: { number: 7 } },
      occurredAt: now - 5_000,
      receivedAt: now,
    });
    await db.insert(eventSubscriptions).values({
      id: subscriptionId,
      orgId: ORG,
      ownerType: opts.ownerType ?? "user",
      ownerId: opts.ownerId ?? "user-1",
      name: "test sub",
      eventKeys: opts.eventKeys ?? ["github.issues.*"],
      filters: [],
      target: opts.target,
      enabled: true,
      createdBy: "user-1",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(eventDeliveries).values({
      id: deliveryId,
      eventId,
      subscriptionId,
      status: opts.status ?? "pending",
      attempts: opts.attempts ?? 0,
      nextAttemptAt: now - 1_000,
      createdAt: now,
    });
    return { eventId, subscriptionId, deliveryId };
  }

  async function getDelivery(id: string) {
    const rows = await tdb.appDb.select().from(eventDeliveries).where(eq(eventDeliveries.id, id)).limit(1);
    const row = rows[0];
    if (!row) throw new Error(`delivery ${id} vanished`);
    return row;
  }

  it.each([
    { policy: "always", member: true, enabled: true, sameOrg: true, expected: "delivered" },
    { policy: "ignoreIfMyTeamSubscribed", member: true, enabled: true, sameOrg: true, expected: "skipped" },
    { policy: "ignoreIfMyTeamSubscribed", member: false, enabled: true, sameOrg: true, expected: "delivered" },
    { policy: "ignoreIfAnyTeamSubscribed", member: false, enabled: true, sameOrg: true, expected: "skipped" },
    { policy: "ignoreIfAnyTeamSubscribed", member: true, enabled: false, sameOrg: true, expected: "delivered" },
    { policy: "ignoreIfAnyTeamSubscribed", member: true, enabled: true, sameOrg: false, expected: "delivered" },
  ])("evaluates current team coverage: $policy member=$member enabled=$enabled sameOrg=$sameOrg", async ({ policy, member, enabled, sameOrg, expected }) => {
    const db = tdb.appDb;
    const { deliveryId, subscriptionId } = await seedDelivery({ target: { kind: "orchestrator", deliveryPolicy: policy, pauseOnOverlap: true } });
    const teamOrg = sameOrg ? ORG : "other-org";
    await db.insert(teams).values({ id: "coverage-team", orgId: teamOrg, name: "Coverage", createdAt: Date.now() });
    if (member) await db.insert(teamMembers).values({ teamId: "coverage-team", userId: "user-1", role: "member" });
    await db.insert(eventSubscriptions).values({
      id: "coverage-rule", orgId: teamOrg, ownerType: "team", ownerId: "coverage-team", name: "Team coverage",
      eventKeys: ["github.issues.*"], filters: [], target: { kind: "orchestrator", orchestrator: "team", teamId: "coverage-team" },
      enabled, createdBy: "user-1", createdAt: Date.now(), updatedAt: Date.now(),
    });
    const deliver = vi.fn<OrchestratorDeliverFn>(async () => {});
    const dispatcher = new EventDispatcher({ db, workflowRunHost: fakeRunHost(), workflowStore: new PgWorkflowStore(tdb.pgdb), deliverToOrchestrator: deliver, plugins: [githubPlugin] });
    await dispatcher.pollOnce();
    expect((await getDelivery(deliveryId)).status).toBe(expected);
    expect(deliver).toHaveBeenCalledTimes(expected === "delivered" ? 1 : 0);
    const [personal] = await db.select().from(eventSubscriptions).where(eq(eventSubscriptions.id, subscriptionId));
    expect(personal!.enabled).toBe(expected !== "skipped");
    await dispatcher.pollOnce();
    expect(deliver).toHaveBeenCalledTimes(expected === "delivered" ? 1 : 0);
  });

  it("skips only matching events without pausing and respects a later disabled team rule on retry", async () => {
    const db = tdb.appDb;
    const { deliveryId, subscriptionId } = await seedDelivery({ target: { kind: "orchestrator", deliveryPolicy: "ignoreIfAnyTeamSubscribed" }, status: "failed", attempts: 1 });
    await db.insert(teams).values({ id: "retry-team", orgId: ORG, name: "Retry", createdAt: Date.now() });
    await db.insert(eventSubscriptions).values({ id: "retry-rule", orgId: ORG, ownerType: "team", ownerId: "retry-team", name: "Coverage", eventKeys: ["github.issues.*"], filters: [], target: { kind: "orchestrator", orchestrator: "team", teamId: "retry-team" }, enabled: true, createdBy: "user-1", createdAt: Date.now(), updatedAt: Date.now() });
    const deliver = vi.fn<OrchestratorDeliverFn>(async () => {});
    const dispatcher = new EventDispatcher({ db, workflowRunHost: fakeRunHost(), workflowStore: new PgWorkflowStore(tdb.pgdb), deliverToOrchestrator: deliver, plugins: [githubPlugin] });
    await dispatcher.pollOnce();
    expect((await getDelivery(deliveryId)).status).toBe("skipped");
    const [personal] = await db.select().from(eventSubscriptions).where(eq(eventSubscriptions.id, subscriptionId));
    expect(personal!.enabled).toBe(true);
    await db.update(eventSubscriptions).set({ enabled: false }).where(eq(eventSubscriptions.id, "retry-rule"));
    // A deliberately redelivered event re-evaluates current coverage.
    await db.update(eventDeliveries).set({ status: "pending", nextAttemptAt: 0 }).where(eq(eventDeliveries.id, deliveryId));
    await dispatcher.pollOnce();
    expect((await getDelivery(deliveryId)).status).toBe("delivered");
  });

  it("delivers a workflow-target delivery: RunHost.start gets the event trigger payload; row -> delivered", async () => {
    const db = tdb.appDb;
    const now = Date.now();
    const definition = { nodes: [], edges: [] };
    await db.insert(workflowDefinitions).values({
      id: "wf-1",
      orgId: ORG,
      ownerType: "user",
      ownerId: "user-1",
      name: "on issue",
      definition,
      createdAt: now,
      updatedAt: now,
    });
    const { eventId, subscriptionId, deliveryId } = await seedDelivery({
      target: { kind: "workflow", workflowId: "wf-1" },
    });

    const runHost = fakeRunHost();
    const deliver = vi.fn<OrchestratorDeliverFn>(async () => {});
    const dispatcher = new EventDispatcher({
      db,
      workflowRunHost: runHost,
      workflowStore: new PgWorkflowStore(tdb.pgdb),
      deliverToOrchestrator: deliver,
    });
    await dispatcher.pollOnce();

    expect(runHost.start).toHaveBeenCalledTimes(1);
    const [runId, params, def, owner] = vi.mocked(runHost.start).mock.calls[0];
    // Derived, not minted: retried claims must resolve to the same run.
    expect(runId).toBe(`wfrun_evt_${deliveryId}`);
    expect(def).toEqual(definition);
    expect(owner).toEqual({ ownerType: "user", ownerId: "user-1" });
    expect(params.workflowId).toBe("wf-1");
    expect(params.triggerId).toBe(subscriptionId);
    const trigger = params.input as WorkflowTriggerPayload;
    expect(trigger.type).toBe("event");
    expect(trigger.triggerId).toBe(subscriptionId);
    expect(trigger.data).toEqual({
      key: "github.issues.opened",
      summary: "Issue #7 opened: broken build",
      refs: { repo: "acme/site", installation_id: "42" },
      payload: { action: "opened", issue: { number: 7 } },
    });
    expect(trigger.metadata).toEqual({ eventId, service: "github" });

    const row = await getDelivery(deliveryId);
    expect(row.status).toBe("delivered");
    expect(row.attempts).toBe(1);
    expect(row.deliveredAt).not.toBeNull();
    expect(deliver).not.toHaveBeenCalled();
  });

  it("retried workflow delivery is idempotent: an already-started run is not started twice", async () => {
    // Simulates the partial-failure retry: a prior attempt started the run
    // but crashed before the delivered-status UPDATE, the claim lease lapsed,
    // and the poll re-claimed the row. The derived runId already exists, so
    // the retry must mark the delivery delivered WITHOUT a second start.
    const db = tdb.appDb;
    const now = Date.now();
    const definition = { nodes: [], edges: [] };
    await db.insert(workflowDefinitions).values({
      id: "wf-1",
      orgId: ORG,
      ownerType: "user",
      ownerId: "user-1",
      name: "on issue",
      definition,
      createdAt: now,
      updatedAt: now,
    });
    const { deliveryId } = await seedDelivery({ target: { kind: "workflow", workflowId: "wf-1" } });
    await db.insert(workflowRuns).values({
      id: `wfrun_evt_${deliveryId}`,
      workflowId: "wf-1",
      definitionVersionId: "v-whatever",
      definition,
      params: {},
      status: "running",
      ownerType: "user",
      ownerId: "user-1",
      createdAt: now,
      updatedAt: now,
    });

    const runHost = fakeRunHost();
    const dispatcher = new EventDispatcher({
      db,
      workflowRunHost: runHost,
      workflowStore: new PgWorkflowStore(tdb.pgdb),
      deliverToOrchestrator: vi.fn<OrchestratorDeliverFn>(async () => {}),
    });
    await dispatcher.pollOnce();

    expect(runHost.start).not.toHaveBeenCalled();
    const row = await getDelivery(deliveryId);
    expect(row.status).toBe("delivered");
  });

  it("delivers an orchestrator-target delivery: seam gets SignalContent with signalType = event key; row -> delivered", async () => {
    const { eventId, deliveryId } = await seedDelivery({ target: { kind: "orchestrator" }, ownerType: "org" });

    const deliver = vi.fn<OrchestratorDeliverFn>(async () => {});
    const dispatcher = new EventDispatcher({
      db: tdb.appDb,
      workflowRunHost: fakeRunHost(),
      workflowStore: new PgWorkflowStore(tdb.pgdb),
      deliverToOrchestrator: deliver,
    });
    await dispatcher.pollOnce();

    expect(deliver).toHaveBeenCalledTimes(1);
    const args = deliver.mock.calls[0][0];
    expect(args.orgId).toBe(ORG);
    expect(args.ownerType).toBe("org");
    expect(args.ownerId).toBe("user-1");
    expect(args.dispatchId).toBe(`event:${deliveryId}`);
    expect(args.signal.kind).toBe("signal");
    expect(args.signal.signalType).toBe("github.issues.opened");
    // jsonb round-trips reorder object keys, so parse the excerpt instead
    // of comparing the serialized string byte-for-byte.
    const [summary, excerpt] = args.signal.body.split("\n\n");
    expect(summary).toBe("Issue #7 opened: broken build");
    expect(JSON.parse(excerpt)).toEqual({ action: "opened", issue: { number: 7 } });
    expect(args.signal.attributes).toEqual({
      repo: "acme/site",
      installation_id: "42",
      eventId,
      service: "github",
    });

    const row = await getDelivery(deliveryId);
    expect(row.status).toBe("delivered");
    expect(row.attempts).toBe(1);
  });

  async function seedMentionMember(teamId: string) {
    await tdb.appDb.insert(teams).values({ id: teamId, orgId: ORG, name: "Team", createdAt: Date.now() });
    await tdb.appDb.insert(teamMembers).values({ teamId, userId: "member-9", role: "member" });
    await tdb.appDb.insert(orgMembers).values({ orgId: ORG, userId: "member-9", role: "member" });
    await tdb.appDb.insert(userIdentityLinks).values({ id: "link-9", provider: "slack", externalId: "U9", userId: "member-9", createdAt: Date.now() });
  }

  it("channel-origin orchestrator delivery: readable body + origin + sender, no raw JSON", async () => {
    await seedMentionMember("team-x");
    const { deliveryId } = await seedDelivery({
      target: { kind: "orchestrator" },
      ownerType: "team",
      ownerId: "team-x",
      service: "slack",
      eventKey: "slack.app_mention",
      eventKeys: ["slack.app_mention"],
      refs: { channel: "C1", user: "U9" },
      summary: "Mention in #deploys",
      payload: { type: "app_mention", channel: "C1", user: "U9", text: "who are you", ts: "1.2" },
      actor: { externalId: "U9" },
    });

    const deliver = vi.fn<OrchestratorDeliverFn>(async () => {});
    const dispatcher = new EventDispatcher({
      db: tdb.appDb,
      workflowRunHost: fakeRunHost(),
      workflowStore: new PgWorkflowStore(tdb.pgdb),
      deliverToOrchestrator: deliver,
      resolveChannelOrigin: (service) =>
        service === "slack" ? { channelType: "slack", threadKey: "slack:C1:1.2" } : null,
    });
    await dispatcher.pollOnce();

    expect(deliver).toHaveBeenCalledTimes(1);
    const args = deliver.mock.calls[0][0];
    expect(args.signal.origin).toEqual({ channelType: "slack", threadKey: "slack:C1:1.2" });
    expect(args.signal.body).toContain("who are you");
    expect(args.signal.body).not.toContain("{"); // no raw JSON dump
    expect(args.signal.attributes?.sender).toBe("U9");

    const row = await getDelivery(deliveryId);
    expect(row.status).toBe("delivered");
  });

  /**
   * Prompt templates on an orchestrator target (TKAI-491). The rendering is
   * the pure part (`prompt-template.test.ts`); these cover the wiring: which
   * event fields reach the renderer, and that a rule with no template
   * delivers the same body it always did.
   */
  describe("orchestrator prompt templates", () => {
    const PAYLOAD = {
      action: "opened",
      issue: { number: 7 },
      repository: { full_name: "acme/site" },
      sender: { login: "octocat" },
    };

    function dispatcherWith(deliver: OrchestratorDeliverFn): EventDispatcher {
      return new EventDispatcher({
        db: tdb.appDb,
        workflowRunHost: fakeRunHost(),
        workflowStore: new PgWorkflowStore(tdb.pgdb),
        deliverToOrchestrator: deliver,
        plugins: [githubPlugin],
      });
    }

    it("renders the user prompt template in place of the default body", async () => {
      await seedDelivery({
        target: {
          kind: "orchestrator",
          userPromptTemplate: "{{payload.sender}} opened {{payload.repo}} ({{refs.installation_id}}): {{event.key}}",
        },
        payload: PAYLOAD,
      });
      const deliver = vi.fn<OrchestratorDeliverFn>(async () => {});
      await dispatcherWith(deliver).pollOnce();

      expect(deliver.mock.calls[0][0].signal.body).toBe(
        "octocat opened acme/site (42): github.issues.opened",
      );
    });

    it("renders the system prompt above the body the rule would have delivered", async () => {
      await seedDelivery({
        target: { kind: "orchestrator", systemPrompt: "Triage {{event.key}}. Answer in one sentence." },
        payload: PAYLOAD,
      });
      const deliver = vi.fn<OrchestratorDeliverFn>(async () => {});
      await dispatcherWith(deliver).pollOnce();

      const body = deliver.mock.calls[0][0].signal.body;
      expect(body).toContain("Triage github.issues.opened. Answer in one sentence.");
      // The default body still follows the instructions, excerpt and all.
      expect(body).toContain("Issue #7 opened: broken build");
      expect(body).toContain('"full_name":"acme/site"');
    });

    it("keeps a channel message readable through {{event.body}}", async () => {
      await seedMentionMember("team-y");
      await seedDelivery({
        target: { kind: "orchestrator", userPromptTemplate: "In #deploys: {{event.body}}" },
        ownerType: "team",
        ownerId: "team-y",
        service: "slack",
        eventKey: "slack.app_mention",
        eventKeys: ["slack.app_mention"],
        refs: { channel: "C1", user: "U9" },
        summary: "Mention in #deploys",
        payload: { type: "app_mention", channel: "C1", user: "U9", text: "who are you", ts: "1.2" },
        actor: { externalId: "U9" },
      });
      const deliver = vi.fn<OrchestratorDeliverFn>(async () => {});
      const dispatcher = new EventDispatcher({
        db: tdb.appDb,
        workflowRunHost: fakeRunHost(),
        workflowStore: new PgWorkflowStore(tdb.pgdb),
        deliverToOrchestrator: deliver,
        resolveChannelOrigin: (service) =>
          service === "slack" ? { channelType: "slack", threadKey: "slack:C1:1.2" } : null,
        plugins: [githubPlugin],
      });
      await dispatcher.pollOnce();

      expect(deliver.mock.calls[0][0].signal.body).toBe("In #deploys: who are you");
    });

    it("delivers the default body untouched when the rule configures no template", async () => {
      await seedDelivery({ target: { kind: "orchestrator" }, payload: PAYLOAD });
      const deliver = vi.fn<OrchestratorDeliverFn>(async () => {});
      await dispatcherWith(deliver).pollOnce();

      const [summary, excerpt] = deliver.mock.calls[0][0].signal.body.split("\n\n");
      expect(summary).toBe("Issue #7 opened: broken build");
      expect(JSON.parse(excerpt)).toEqual(PAYLOAD);
    });
  });

  it("records a followed thread for a follow-enabled channel mention; none when follow is off", async () => {
    await seedMentionMember("team-x");
    async function dispatchMention(follow: boolean) {
      await seedDelivery({
        target: { kind: "orchestrator", follow },
        ownerType: "team",
        ownerId: "team-x",
        service: "slack",
        eventKey: "slack.app_mention",
        eventKeys: ["slack.app_mention"],
        refs: { channel: "C1" },
        summary: "Mention",
        payload: { type: "app_mention", channel: "C1", user: "U9", text: "hi", ts: "1.2" },
      });
      const dispatcher = new EventDispatcher({
        db: tdb.appDb,
        workflowRunHost: fakeRunHost(),
        workflowStore: new PgWorkflowStore(tdb.pgdb),
        deliverToOrchestrator: vi.fn<OrchestratorDeliverFn>(async () => {}),
        resolveChannelOrigin: (service) =>
          service === "slack" ? { channelType: "slack", threadKey: "slack:C1:1.2" } : null,
      });
      await dispatcher.pollOnce();
    }

    await dispatchMention(false);
    const key = { orgId: ORG, channelType: "slack", channelId: "C1", threadTs: "1.2" };
    expect(await findFollowedThread(tdb.appDb, key)).toBeNull();

    await dispatchMention(true);
    const row = await findFollowedThread(tdb.appDb, key);
    expect(row?.ownerType).toBe("team");
    expect(row?.ownerId).toBe("team-x");
    expect(row?.createdBy).toBe("member-9");
  });

  it("signal target: inserts workflow_signals for org runs parked on event:<key> and wakes them", async () => {
    const db = tdb.appDb;
    const now = Date.now();
    const signalType = "event:github.issues.opened";
    // Definition rows carry the org scoping; run-2 belongs to another org
    // and must NOT be signalled despite an identical wait condition.
    for (const [defId, orgId] of [
      ["wf-a", ORG],
      ["wf-b", "other-org"],
    ] as const) {
      await db.insert(workflowDefinitions).values({
        id: defId,
        orgId,
        ownerType: "user",
        ownerId: "user-1",
        name: defId,
        definition: { nodes: [] },
        createdAt: now,
        updatedAt: now,
      });
    }
    for (const [runId, workflowId] of [
      ["run-1", "wf-a"],
      ["run-2", "wf-b"],
    ] as const) {
      await db.insert(workflowRuns).values({
        id: runId,
        workflowId,
        definitionVersionId: "v1",
        definition: { nodes: [] },
        params: { workflowId, definitionVersionId: "v1" },
        status: "parked",
        waitingOn: [{ kind: "signal", nodeId: "wait-1", signalType, timeoutAt: now + 3_600_000 }],
        createdAt: now,
        updatedAt: now,
      });
    }
    const { eventId, deliveryId } = await seedDelivery({ target: { kind: "signal" } });

    const runHost = fakeRunHost();
    const dispatcher = new EventDispatcher({
      db,
      workflowRunHost: runHost,
      workflowStore: new PgWorkflowStore(tdb.pgdb),
      deliverToOrchestrator: vi.fn<OrchestratorDeliverFn>(async () => {}),
    });
    await dispatcher.pollOnce();

    const signals = await db.select().from(workflowSignals);
    expect(signals).toHaveLength(1);
    expect(signals[0].runId).toBe("run-1");
    expect(signals[0].signalId).toBe(`event:${eventId}:run-1`);
    expect(signals[0].signalType).toBe(signalType);
    expect(signals[0].payload).toEqual({
      key: "github.issues.opened",
      summary: "Issue #7 opened: broken build",
      refs: { repo: "acme/site", installation_id: "42" },
      payload: { action: "opened", issue: { number: 7 } },
    });
    expect(runHost.wake).toHaveBeenCalledTimes(1);
    expect(runHost.wake).toHaveBeenCalledWith("run-1");

    const row = await getDelivery(deliveryId);
    expect(row.status).toBe("delivered");
  });

  it("failure increments attempts, sets next_attempt_at per backoff, records last_error", async () => {
    const { deliveryId } = await seedDelivery({ target: { kind: "orchestrator" } });
    const deliver = vi.fn<OrchestratorDeliverFn>(async () => {
      throw new Error("orchestrator boom");
    });
    const dispatcher = new EventDispatcher({
      db: tdb.appDb,
      workflowRunHost: fakeRunHost(),
      workflowStore: new PgWorkflowStore(tdb.pgdb),
      deliverToOrchestrator: deliver,
    });

    // Attempt 1 → 30s backoff.
    let before = Date.now();
    await dispatcher.pollOnce();
    let row = await getDelivery(deliveryId);
    expect(row.status).toBe("failed");
    expect(row.attempts).toBe(1);
    expect(row.lastError).toContain("orchestrator boom");
    expect(row.nextAttemptAt).toBeGreaterThanOrEqual(before + 30_000);
    expect(row.nextAttemptAt).toBeLessThanOrEqual(Date.now() + 30_000);

    // Make it due again; attempt 2 → 2m backoff.
    await tdb.appDb
      .update(eventDeliveries)
      .set({ nextAttemptAt: Date.now() - 1 })
      .where(eq(eventDeliveries.id, deliveryId));
    before = Date.now();
    await dispatcher.pollOnce();
    row = await getDelivery(deliveryId);
    expect(row.status).toBe("failed");
    expect(row.attempts).toBe(2);
    expect(row.nextAttemptAt).toBeGreaterThanOrEqual(before + 120_000);
    expect(row.nextAttemptAt).toBeLessThanOrEqual(Date.now() + 120_000);
  });

  it("marks the delivery dead on the 5th failure", async () => {
    const { deliveryId } = await seedDelivery({
      target: { kind: "orchestrator" },
      status: "failed",
      attempts: 4,
    });
    const dispatcher = new EventDispatcher({
      db: tdb.appDb,
      workflowRunHost: fakeRunHost(),
      workflowStore: new PgWorkflowStore(tdb.pgdb),
      deliverToOrchestrator: vi.fn<OrchestratorDeliverFn>(async () => {
        throw new Error("still broken");
      }),
    });
    await dispatcher.pollOnce();

    const row = await getDelivery(deliveryId);
    expect(row.status).toBe("dead");
    expect(row.attempts).toBe(5);
    expect(row.lastError).toContain("still broken");

    // A dead row is never claimed again.
    await dispatcher.pollOnce();
    expect((await getDelivery(deliveryId)).attempts).toBe(5);
  });

  it("claimed rows are skipped by a concurrent pollOnce", async () => {
    const { deliveryId } = await seedDelivery({ target: { kind: "orchestrator" } });
    // PGlite is single-connection, so the claim UPDATEs serialize and a
    // true cross-connection EvalPlanQual interleave can't be reproduced
    // here. This test only covers the sequential shape (d2 polls after
    // d1's claim committed). In-process, the `draining` guard fires before
    // d2's claim ever reaches the DB; the real cross-process fence is the
    // due conditions repeated on the outer UPDATE qual (EPQ recheck fails
    // once the winner bumps next_attempt_at) — see the dispatcher's file
    // doc comment.
    // The slow seam holds the first dispatcher's delivery open while the
    // second polls; the atomic claim must keep the row invisible to it.
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const deliver = vi.fn<OrchestratorDeliverFn>(async () => {
      await gate;
    });
    const mkDispatcher = () =>
      new EventDispatcher({
        db: tdb.appDb,
        workflowRunHost: fakeRunHost(),
        workflowStore: new PgWorkflowStore(tdb.pgdb),
        deliverToOrchestrator: deliver,
      });
    const d1 = mkDispatcher();
    const d2 = mkDispatcher();

    const p1 = d1.pollOnce();
    // Give d1's claim a macrotask to land before d2 polls.
    await new Promise((r) => setImmediate(r));
    const p2 = d2.pollOnce();
    await p2; // d2 must complete without touching the claimed row
    expect(deliver).toHaveBeenCalledTimes(1);
    release();
    await p1;

    expect(deliver).toHaveBeenCalledTimes(1);
    const row = await getDelivery(deliveryId);
    expect(row.status).toBe("delivered");
    expect(row.attempts).toBe(1);
  });
});

/**
 * A team-owned subscription must reach the TEAM's default assistant. The
 * dispatcher is owner-agnostic — it forwards the subscription's principal
 * straight through — so these pin the two values that are easy to get wrong.
 *
 * `actorUserId` is the one that was wrong: it used to be `ownerId`, which is
 * a real user id only on a personal subscription. On a team or org one it
 * handed a team/org id to `ensureDefaultAssistantSession`, which writes it to
 * `agent_sessions.user_id` — a user column. Nobody is at a keyboard when an
 * event fires, so the subscription's author is the only real user available.
 */
describe("EventDispatcher — team-owned subscriptions", () => {
  let tdb: TestPgDb;

  beforeEach(async () => {
    tdb = await freshTestPgDb();
  });

  async function deliverWith(ownerType: "user" | "team" | "org", ownerId: string) {
    const db = tdb.appDb;
    const now = Date.now();
    const subscriptionId = randomUUID();
    const eventId = randomUUID();
    const deliveryId = randomUUID();
    await db.insert(events).values({
      id: eventId,
      orgId: ORG,
      service: "github",
      eventKey: "github.issues.opened",
      dedupeKey: randomUUID(),
      refs: { repo: "acme/site" },
      summary: "Issue #7 opened",
      payload: { action: "opened" },
      occurredAt: now - 5_000,
      receivedAt: now,
    });
    await db.insert(eventSubscriptions).values({
      id: subscriptionId,
      orgId: ORG,
      ownerType,
      ownerId,
      name: "test sub",
      eventKeys: ["github.issues.*"],
      filters: [],
      target: { kind: "orchestrator" },
      enabled: true,
      createdBy: "author-user",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(eventDeliveries).values({
      id: deliveryId,
      eventId,
      subscriptionId,
      status: "pending",
      attempts: 0,
      nextAttemptAt: now - 1_000,
      createdAt: now,
    });

    const deliver = vi.fn<OrchestratorDeliverFn>(async () => {});
    await new EventDispatcher({
      db,
      workflowRunHost: fakeRunHost(),
      workflowStore: new PgWorkflowStore(tdb.pgdb),
      deliverToOrchestrator: deliver,
    }).pollOnce();
    return deliver;
  }

  it("forwards the team principal unchanged", async () => {
    const deliver = await deliverWith("team", "team_1");
    expect(deliver).toHaveBeenCalledTimes(1);
    const args = deliver.mock.calls[0][0];
    expect(args.ownerType).toBe("team");
    expect(args.ownerId).toBe("team_1");
  });

  it("acts as the subscription's author, never as the team id", async () => {
    const deliver = await deliverWith("team", "team_1");
    const args = deliver.mock.calls[0][0];
    expect(args.actorUserId).toBe("author-user");
    expect(args.actorUserId).not.toBe("team_1");
  });

  it("acts as the author on an org subscription too — the same bug, one owner type over", async () => {
    const deliver = await deliverWith("org", ORG);
    const args = deliver.mock.calls[0][0];
    expect(args.actorUserId).toBe("author-user");
    expect(args.actorUserId).not.toBe(ORG);
  });

  it("still acts as the owner on a personal subscription, where owner and author are the same person", async () => {
    const deliver = await deliverWith("user", "author-user");
    const args = deliver.mock.calls[0][0];
    expect(args.ownerId).toBe("author-user");
    expect(args.actorUserId).toBe("author-user");
  });
});
