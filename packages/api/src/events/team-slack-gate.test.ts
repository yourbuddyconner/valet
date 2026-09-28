import type { NormalizedEvent } from "@valet/engine";
import slackPlugin from "@valet/plugin-slack/plugin";
import type { RunHost } from "@valet/workflow";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eventDeliveries, eventDropLog, eventReceipts, events, eventSubscriptions, orgMembers, teamMembers, teams, userIdentityLinks } from "../schema/index.js";
import { freshTestPgDb, type TestPgDb } from "../test-helpers/pg-test-db.js";
import { PgWorkflowStore } from "../workflows/pg-store.js";
import { EventDispatcher, type OrchestratorDeliverFn } from "./dispatcher.js";
import { findFollowedThread } from "./followed-threads.js";
import { __resetIngestDropThrottle, catalogForService, ingestEvent } from "./ingest.js";
import { validateSubscriptionWrite } from "./subscription-write.js";
import { authorizedSubscriptionMatchesEvent } from "./team-slack-gate.js";

const ORG = "org-team-events";
const channelFilter = { field: "channel", op: "eq", value: "C1" } as const;
const creatorFilter = { field: "user", op: "eq", value: "U_A" } as const;
const plugins = [slackPlugin];
function mention(user = "U_B", channel = "C1", threadTs?: string): NormalizedEvent {
  return {
    key: "slack.app_mention", dedupeKey: randomUUID(), occurredAt: new Date().toISOString(),
    actor: { externalId: user }, refs: { channel }, summary: "Mention",
    payload: { user, channel, ts: "100.2", thread_ts: threadTs, text: "Help us" },
  };
}

describe("team assistant mentions through the org bot event pipeline", () => {
  let tdb: TestPgDb;
  beforeEach(async () => {
    __resetIngestDropThrottle();
    tdb = await freshTestPgDb();
    await tdb.appDb.insert(teams).values({ id: "team-1", orgId: ORG, name: "Team", createdAt: Date.now() });
    await tdb.appDb.insert(orgMembers).values([
      { orgId: ORG, userId: "member-a", role: "admin" },
      { orgId: ORG, userId: "member-b", role: "member" },
      // In the organization, on no team — the sender the audience choice is about.
      { orgId: ORG, userId: "member-c", role: "member" },
    ]);
    await tdb.appDb.insert(teamMembers).values([
      { teamId: "team-1", userId: "member-a", role: "admin" },
      { teamId: "team-1", userId: "member-b", role: "member" },
    ]);
    await tdb.appDb.insert(userIdentityLinks).values([
      { id: "link-a", provider: "slack", externalId: "U_A", userId: "member-a", createdAt: Date.now() },
      { id: "link-b", provider: "slack", externalId: "U_B", userId: "member-b", createdAt: Date.now() },
      { id: "link-c", provider: "slack", externalId: "U_C", userId: "member-c", createdAt: Date.now() },
      { id: "link-outsider", provider: "slack", externalId: "U_X", userId: "outsider", createdAt: Date.now() },
    ]);
  });
  async function seed(
    ownerType: "user" | "team" = "team",
    legacy = false,
    workflow = false,
    audience: "team" | "organization" | null = null,
  ) {
    const [sub] = await tdb.appDb.insert(eventSubscriptions).values({
      id: randomUUID(), orgId: ORG, ownerType, ownerId: ownerType === "team" ? "team-1" : "member-a",
      createdBy: "member-a", name: "Team replies", eventKeys: ["slack.app_mention"],
      filters: legacy || ownerType === "user" || workflow ? [channelFilter, creatorFilter] : [channelFilter],
      target: workflow ? { kind: "workflow", workflowId: "wf-1" } : { kind: "orchestrator", follow: true },
      audience,
      enabled: true, createdAt: Date.now(), updatedAt: Date.now(),
    }).returning();
    return sub;
  }
  function ingest(event = mention()) {
    return ingestEvent({ db: tdb.appDb, plugins }, { orgId: ORG, service: "slack", event });
  }
  function dispatcher() {
    const deliver = vi.fn<OrchestratorDeliverFn>(async () => {});
    const workflowRunHost: RunHost = {
      start: vi.fn(async () => {}), wake: vi.fn(async () => {}), scheduleWake: vi.fn(async () => {}),
      terminate: vi.fn(async () => {}), startHost: vi.fn(), stopHost: vi.fn(async () => {}),
    };
    const host = new EventDispatcher({
      db: tdb.appDb, workflowStore: new PgWorkflowStore(tdb.pgdb), workflowRunHost,
      deliverToOrchestrator: deliver,
      resolveChannelOrigin: (_service, _key, payload) => {
        if (typeof payload !== "object" || payload === null || !("channel" in payload) || !("ts" in payload)) return null;
        const threadTs = "thread_ts" in payload && payload.thread_ts ? payload.thread_ts : payload.ts;
        return { channelType: "slack", threadKey: `slack:${payload.channel}:${threadTs}`, messageTs: String(payload.ts) };
      },
    });
    return { host, deliver };
  }

  it.each([false, true])("a different linked member matches and owns the follow actor (legacy=%s)", async (legacy) => {
    await seed("team", legacy);
    expect((await ingest()).deliveries).toBe(1);
    const { host, deliver } = dispatcher();
    await host.pollOnce();
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({
      orgId: ORG, ownerType: "team", ownerId: "team-1", actorUserId: "member-b",
      signal: expect.objectContaining({ body: "Help us", origin: { channelType: "slack", threadKey: "slack:C1:100.2", messageTs: "100.2" } }),
    }));
    const key = { orgId: ORG, channelType: "slack", channelId: "C1", threadTs: "100.2" };
    expect(await findFollowedThread(tdb.appDb, key)).toMatchObject({ ownerType: "team", ownerId: "team-1", createdBy: "member-b" });
    await ingest(mention("U_A", "C1", "100.2"));
    await host.pollOnce();
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliver.mock.calls[0][0]).not.toHaveProperty("assistantId");
    expect(await findFollowedThread(tdb.appDb, key)).toMatchObject({ createdBy: "member-b", ownerId: "team-1" });
  });

  it.each([["U_X", "not_team_member"], ["U_UNLINKED", "unlinked_sender"]])("denies %s before event persistence", async (sender, reason) => {
    await seed();
    expect(await ingest(mention(sender))).toMatchObject({ deliveries: 0, skipped: true });
    expect(await tdb.appDb.select().from(events)).toHaveLength(0);
    expect(await tdb.appDb.select().from(eventDeliveries)).toHaveLength(0);
    expect(await tdb.appDb.select().from(eventDropLog)).toEqual(expect.arrayContaining([expect.objectContaining({ reason })]));
  });

  it("does not retain a denied mention as a filter-excluded payload diagnostic", async () => {
    await seed();
    expect(await ingest(mention("U_X"))).toMatchObject({ deliveries: 0, skipped: true });

    const rows = await tdb.appDb.select().from(eventDropLog);
    expect(rows).toEqual(expect.arrayContaining([expect.objectContaining({ reason: "not_team_member", eventMetadata: null })]));
    expect(rows).not.toEqual(expect.arrayContaining([expect.objectContaining({ reason: "filter_excluded" })]));
    expect(JSON.stringify(rows)).not.toContain("Help us");
    expect(JSON.stringify(rows)).not.toContain("C1");
    const [receipt] = await tdb.appDb.select().from(eventReceipts);
    expect(receipt.stages).toEqual(expect.arrayContaining([expect.objectContaining({ stage: "subscription_match", outcome: "authorization_denied" })]));
    expect(receipt.subscriptions).toEqual(expect.arrayContaining([expect.objectContaining({ outcome: "authorization_denied" })]));
    expect(JSON.stringify(receipt)).not.toContain("Help us");
    expect(JSON.stringify(receipt)).not.toContain("U_X");
  });

  it("redacts an unauthorized sender from a team-only filter miss", async () => {
    await seed();
    expect(await ingest(mention("U_X", "C2"))).toMatchObject({ deliveries: 0, skipped: true });

    const rows = await tdb.appDb.select().from(eventDropLog);
    expect(rows).toEqual([expect.objectContaining({ reason: "filter_excluded", eventMetadata: {} })]);
    expect(JSON.stringify(rows)).not.toContain("Help us");
    expect(JSON.stringify(rows)).not.toContain("C2");
  });

  it("keeps an ordinary filter diagnostic for mixed team and non-team subscriptions", async () => {
    await seed();
    await seed("user");
    expect(await ingest(mention("U_X", "C2"))).toMatchObject({ deliveries: 0, skipped: true });

    const rows = await tdb.appDb.select().from(eventDropLog);
    expect(rows).toEqual([expect.objectContaining({
      reason: "filter_excluded",
      eventMetadata: expect.objectContaining({ channel: "C2" }),
    })]);
    expect(rows).not.toEqual(expect.arrayContaining([expect.objectContaining({ reason: "not_team_member" })]));
  });

  it("drops an organization member who is on no team when the audience is the team", async () => {
    await seed("team", false, false, "team");
    expect(await ingest(mention("U_C"))).toMatchObject({ deliveries: 0, skipped: true });
    expect(await tdb.appDb.select().from(eventDropLog)).toEqual(
      expect.arrayContaining([expect.objectContaining({ reason: "not_team_member" })]),
    );
  });

  it("admits an organization member who is on no team when the audience is the organization", async () => {
    const sub = await seed("team", false, false, "organization");
    expect((await ingest(mention("U_C"))).deliveries).toBe(1);
    const { host, deliver } = dispatcher();
    await host.pollOnce();
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({
      ownerType: "team", ownerId: "team-1", actorUserId: "member-c",
    }));
    // The follow names the rule it came from, or the router would re-check
    // team membership and drop every later message in the thread.
    expect(await findFollowedThread(tdb.appDb, { orgId: ORG, channelType: "slack", channelId: "C1", threadTs: "100.2" }))
      .toMatchObject({ ownerId: "team-1", createdBy: "member-c", subscriptionId: sub.id });
  });

  it.each([["U_X", "not_org_member"], ["U_UNLINKED", "unlinked_sender"]])(
    "denies %s under the organization audience",
    async (sender, reason) => {
      await seed("team", false, false, "organization");
      expect(await ingest(mention(sender))).toMatchObject({ deliveries: 0, skipped: true });
      expect(await tdb.appDb.select().from(events)).toHaveLength(0);
      expect(await tdb.appDb.select().from(eventDropLog)).toEqual(
        expect.arrayContaining([expect.objectContaining({ reason })]),
      );
    },
  );

  it("denies the organization audience after the sender leaves the organization", async () => {
    const sub = await seed("team", false, false, "organization");
    const event = mention("U_C");
    expect((await ingest(event)).deliveries).toBe(1);
    await tdb.appDb.delete(orgMembers).where(and(eq(orgMembers.orgId, ORG), eq(orgMembers.userId, "member-c")));
    expect((await ingest(mention("U_C"))).deliveries).toBe(0);
    expect(await authorizedSubscriptionMatchesEvent(tdb.appDb, sub, event.key, event.payload, catalogForService(plugins, "slack"))).toBe(false);
    const { host, deliver } = dispatcher();
    await host.pollOnce();
    expect(deliver).not.toHaveBeenCalled();
    // The dead-letter names the membership the audience actually requires.
    expect(await tdb.appDb.select().from(eventDeliveries)).toEqual([
      expect.objectContaining({ status: "dead", lastError: expect.stringContaining("organization membership") }),
    ]);
  });

  it("rechecks removal on the next match and on queued dispatch", async () => {
    const sub = await seed();
    const event = mention();
    await ingest(event);
    await tdb.appDb.delete(teamMembers).where(and(eq(teamMembers.teamId, "team-1"), eq(teamMembers.userId, "member-b")));
    expect((await ingest()).deliveries).toBe(0);
    expect(await authorizedSubscriptionMatchesEvent(tdb.appDb, sub, event.key, event.payload, catalogForService(plugins, "slack"))).toBe(false);
    const { host, deliver } = dispatcher();
    await host.pollOnce();
    expect(deliver).not.toHaveBeenCalled();
    expect(await tdb.appDb.select().from(eventDeliveries)).toEqual([expect.objectContaining({ status: "dead" })]);
  });

  it("denies new mentions, replay matches and queued delivery after org removal with a stale team row", async () => {
    const sub = await seed();
    const event = mention();
    expect((await ingest(event)).deliveries).toBe(1);
    await tdb.appDb.delete(orgMembers).where(and(eq(orgMembers.orgId, ORG), eq(orgMembers.userId, "member-b")));
    await tdb.appDb.insert(orgMembers).values({ orgId: "other-org", userId: "member-b", role: "admin" });
    expect(await tdb.appDb.select().from(teamMembers).where(eq(teamMembers.userId, "member-b"))).toHaveLength(1);
    expect((await ingest()).deliveries).toBe(0);
    expect(await authorizedSubscriptionMatchesEvent(tdb.appDb, sub, event.key, event.payload, catalogForService(plugins, "slack"))).toBe(false);
    const { host, deliver } = dispatcher();
    await host.pollOnce();
    expect(deliver).not.toHaveBeenCalled();
    expect(await tdb.appDb.select().from(eventDeliveries)).toEqual([expect.objectContaining({ status: "dead" })]);
  });

  it("an authorized mention re-binds a thread whose binding rule is revoked", async () => {
    const openRule = await seed("team", false, false, "organization");
    const key = { orgId: ORG, channelType: "slack", channelId: "C1", threadTs: "100.2" };
    expect((await ingest(mention("U_C"))).deliveries).toBe(1);
    const { host } = dispatcher();
    await host.pollOnce();
    expect(await findFollowedThread(tdb.appDb, key)).toMatchObject({
      createdBy: "member-c", subscriptionId: openRule.id,
    });

    // The rule is revoked. The thread now authorizes nobody: its actor is on
    // no team, and the rule that admitted them is gone.
    await tdb.appDb.delete(eventSubscriptions).where(eq(eventSubscriptions.id, openRule.id));

    // A team member's explicit mention takes the thread over.
    const teamRule = await seed("team", false, false, "team");
    expect((await ingest(mention("U_B", "C1", "100.2"))).deliveries).toBe(1);
    await host.pollOnce();
    expect(await findFollowedThread(tdb.appDb, key)).toMatchObject({
      createdBy: "member-b", subscriptionId: teamRule.id,
    });
  });

  it("keeps the binding when a re-mention arrives on a thread that still authorizes its actor", async () => {
    const rule = await seed("team", false, false, "organization");
    const key = { orgId: ORG, channelType: "slack", channelId: "C1", threadTs: "100.2" };
    expect((await ingest(mention("U_C"))).deliveries).toBe(1);
    const { host } = dispatcher();
    await host.pollOnce();
    expect((await ingest(mention("U_B", "C1", "100.2"))).deliveries).toBe(1);
    await host.pollOnce();
    expect(await findFollowedThread(tdb.appDb, key)).toMatchObject({
      createdBy: "member-c", subscriptionId: rule.id,
    });
  });

  it("names team membership in the dead-letter of a team-audience denial", async () => {
    await seed("team", false, false, "team");
    expect((await ingest()).deliveries).toBe(1);
    await tdb.appDb.delete(teamMembers).where(and(eq(teamMembers.teamId, "team-1"), eq(teamMembers.userId, "member-b")));
    const { host } = dispatcher();
    await host.pollOnce();
    expect(await tdb.appDb.select().from(eventDeliveries)).toEqual([
      expect.objectContaining({ status: "dead", lastError: expect.stringContaining("team membership") }),
    ]);
  });

  it("keeps the channel restriction and rejects a team in another org", async () => {
    await seed();
    expect((await ingest(mention("U_B", "C2"))).deliveries).toBe(0);
    await tdb.appDb.update(teams).set({ orgId: "foreign-org" }).where(eq(teams.id, "team-1"));
    expect((await ingest()).deliveries).toBe(0);
  });

  it.each([false, true])("preserves creator-only semantics for personal/workflow rules (workflow=%s)", async (workflow) => {
    await seed(workflow ? "team" : "user", false, workflow);
    expect((await ingest()).deliveries).toBe(0);
    expect((await ingest(mention("U_A"))).deliveries).toBe(1);
  });

  it("team writes need channel scope but no creator link or user filter", async () => {
    await tdb.appDb.delete(userIdentityLinks).where(eq(userIdentityLinks.userId, "member-a"));
    const body = { name: "Team", eventKeys: ["slack.app_mention"], filters: [channelFilter, creatorFilter], target: { kind: "orchestrator", orchestrator: "team", teamId: "team-1" } };
    const scope = { creatorUserId: "member-a", anyChannel: false, matchChanged: true };
    expect(await validateSubscriptionWrite(tdb.appDb, plugins, body, scope)).toEqual({ ok: true, filters: [channelFilter] });
    expect(await validateSubscriptionWrite(tdb.appDb, plugins, { ...body, filters: [] }, scope)).toMatchObject({ ok: false });
    expect(await validateSubscriptionWrite(tdb.appDb, plugins, { ...body, filters: [] }, { ...scope, anyChannel: true })).toEqual({ ok: true, filters: [] });
  });
});
