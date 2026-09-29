/**
 * PUBLIC `/api/channels/slack/webhook` — verify once, ack fast, fan out to
 * the channel host and the event pipeline.
 *
 * Route-level against the real Slack plugin: real HMAC signatures, real
 * transport, assertions against actual DB rows. The fan-out runs after the
 * 200 is returned, so assertions on its effects poll.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { and, eq } from "drizzle-orm";
import slackPlugin from "@valet/plugin-slack/plugin";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { eventDeliveries, eventDropLog, eventReceipts, events, eventSubscriptions, teams, orgMembers, teamMembers, userIdentityLinks } from "../schema/index.js";
import { __resetSlackWebhookThrottle } from "./slack-webhook.js";
import { __resetIngestDropThrottle } from "../events/ingest.js";
import * as ingestModule from "../events/ingest.js";
import * as followRouter from "../channels/follow-router.js";
import * as signalDiagnostics from "../orchestrator/signals.js";

let api: TestApi | undefined;

beforeEach(() => {
  // The real transport must never send test messages to Slack.
  const fetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (new URL(url).hostname === "slack.com") {
      return Promise.resolve(Response.json({ ok: false, error: "invalid_auth" }));
    }
    return fetch(input, init);
  });
  __resetSlackWebhookThrottle();
  __resetIngestDropThrottle();
});

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
  vi.restoreAllMocks();
});

const SECRET = "slack-signing-secret";
const TEAM_ID = "T0001";
const DM_CHANNEL = "D300";

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function sign(body: string, secret = SECRET, ts = nowSeconds()): Record<string, string> {
  const digest = createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex");
  return {
    "Content-Type": "application/json",
    "X-Slack-Signature": `v0=${digest}`,
    "X-Slack-Request-Timestamp": String(ts),
  };
}

/** Saves the org credential the route resolves the signing secret from. */
async function seedCredential(a: TestApi): Promise<void> {
  await a.providers.engineCredentials.save({ type: "org", id: "local-org" }, "slack", {
    type: "bot_token",
    accessToken: "xoxb-test-token",
    metadata: { webhookSecret: SECRET, teamId: TEAM_ID, botUserId: "U0BOT", botId: "BVALET" },
  });
}

async function seedRunningTransport(a: TestApi): Promise<void> {
  await seedCredential(a);
  await a.providers.channelHost.start();
}

/** `teamId: null` omits `team_id` entirely. `undefined` would select the
 * default parameter instead, which is the opposite of the intent. */
function envelope(event: Record<string, unknown>, eventId: string, teamId: string | null = TEAM_ID): string {
  const body: Record<string, unknown> = {
    token: "ignored",
    api_app_id: "A001",
    type: "event_callback",
    event_id: eventId,
    event_time: nowSeconds(),
    event,
  };
  if (teamId !== null) body.team_id = teamId;
  return JSON.stringify(body);
}

function dmMessage(): Record<string, unknown> {
  return {
    type: "message",
    channel: DM_CHANNEL,
    channel_type: "im",
    user: "U100",
    text: "hello valet",
    ts: "1720000002.000100",
    event_ts: "1720000002.000100",
  };
}

function botFormMessage(): Record<string, unknown> {
  return {
    type: "message",
    subtype: "bot_message",
    bot_id: "B_FORM",
    app_id: "A_FORM",
    channel: "C_FORM",
    text: "Submitted intake",
    ts: "1720000002.000100",
    event_ts: "1720000002.000100",
  };
}

function humanChannelMessage(): Record<string, unknown> {
  return {
    type: "message",
    channel: "C_FORM",
    user: "U100",
    text: "Human intake",
    ts: "1720000001.000100",
    event_ts: "1720000001.000100",
  };
}

function reactionAdded(): Record<string, unknown> {
  return {
    type: "reaction_added",
    user: "U100",
    reaction: "tada",
    item_user: "U200",
    item: { type: "message", channel: "C500", ts: "1720000002.000100" },
    event_ts: "1720000005.000200",
  };
}

function appMention(): Record<string, unknown> {
  return {
    type: "app_mention",
    user: "U100",
    channel: "C500",
    text: "<@U0BOT> ship it",
    ts: "1720000002.000100",
    event_ts: "1720000002.000100",
  };
}

function homeOpened(): Record<string, unknown> {
  return {
    type: "app_home_opened",
    user: "U100",
    channel: DM_CHANNEL,
    tab: "messages",
    event_ts: "1720000003.000000",
  };
}

async function post(baseUrl: string, body: string, headers: Record<string, string>): Promise<Response> {
  return fetch(`${baseUrl}/api/channels/slack/webhook`, { method: "POST", headers, body });
}

async function dropReasons(a: TestApi): Promise<string[]> {
  const rows = await a.providers.db.select().from(eventDropLog).where(eq(eventDropLog.orgId, "local-org"));
  return rows.map((r) => r.reason);
}

/** Scope every event assertion to this event's dedupeKey. The fan-out is
 * fire-and-forget, so a total row count would be flaky under load. */
async function eventCount(a: TestApi, dedupeKey: string): Promise<number> {
  const rows = await a.providers.db
    .select()
    .from(events)
    .where(and(eq(events.orgId, "local-org"), eq(events.dedupeKey, dedupeKey)));
  return rows.length;
}

/** Count `event_deliveries` written for this event, joined on its dedupeKey.
 * A delivery row is the proof the event matched a subscription and was queued
 * for the dispatcher — the hop the ingest tests below assert reaches. */
async function deliveryCount(a: TestApi, dedupeKey: string): Promise<number> {
  const rows = await a.providers.db
    .select({ id: eventDeliveries.id })
    .from(eventDeliveries)
    .innerJoin(events, eq(eventDeliveries.eventId, events.id))
    .where(and(eq(events.orgId, "local-org"), eq(events.dedupeKey, dedupeKey)));
  return rows.length;
}

async function seedSubscription(
  a: TestApi,
  eventKeys: string[],
  filters: { field: string; op: string; value: string | string[] }[] = [],
): Promise<void> {
  const now = Date.now();
  await a.providers.db.insert(eventSubscriptions).values({
    id: `sub_${eventKeys[0].replace(/\W/g, "_")}`,
    orgId: "local-org",
    ownerType: "org",
    ownerId: "local-org",
    name: "test subscription",
    eventKeys,
    filters,
    target: { kind: "orchestrator" },
    enabled: true,
    createdBy: "local-user",
    createdAt: now,
    updatedAt: now,
  });
}

describe("POST /api/channels/slack/webhook", () => {
  it("echoes the url_verification challenge before any credential exists", async () => {
    api = await bootTestApi({ plugins: [slackPlugin] });

    const res = await post(api.baseUrl, JSON.stringify({ type: "url_verification", challenge: "ch-123" }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challenge: "ch-123" });
  });

  it("refuses to reflect an over-long challenge", async () => {
    api = await bootTestApi({ plugins: [slackPlugin] });

    const res = await post(api.baseUrl, JSON.stringify({ type: "url_verification", challenge: "x".repeat(600) }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(400);
  });

  it("processes a redelivery whose first attempt never landed, and records that the ack was slow", async () => {
    api = await bootTestApi({ plugins: [slackPlugin] });
    await seedRunningTransport(api);
    await seedSubscription(api, ["slack.message"]);

    // Slack redelivers because the previous attempt produced no 2xx, so this
    // may be the only copy of the message that ever arrives. Dropping it
    // would lose what the user typed.
    const body = envelope(dmMessage(), "Ev-retry");
    const res = await post(api.baseUrl, body, {
      ...sign(body),
      "x-slack-retry-num": "1",
      "x-slack-retry-reason": "http_timeout",
    });

    expect(res.status).toBe(200);
    await expect.poll(() => eventCount(api!, "Ev-retry"), { timeout: 5_000 }).toBe(1);
    await expect.poll(() => dropReasons(api!), { timeout: 5_000 }).toContain("slack_retry");
  });

  it("does not double-process a redelivery of an update it already handled", async () => {
    api = await bootTestApi({ plugins: [slackPlugin] });
    await seedRunningTransport(api);
    await seedSubscription(api, ["slack.message"]);

    const body = envelope(dmMessage(), "Ev-retry-dup");
    expect((await post(api.baseUrl, body, sign(body))).status).toBe(200);
    await expect.poll(() => eventCount(api!, "Ev-retry-dup"), { timeout: 5_000 }).toBe(1);

    // Same `event_id`, so ingest's `(service, dedupeKey)` conflict target
    // absorbs it and the events table keeps exactly one row.
    const retry = await post(api.baseUrl, body, {
      ...sign(body),
      "x-slack-retry-num": "2",
      "x-slack-retry-reason": "http_timeout",
    });
    expect(retry.status).toBe(200);
    await expect.poll(() => dropReasons(api!), { timeout: 5_000 }).toContain("slack_retry");
    expect(await eventCount(api, "Ev-retry-dup")).toBe(1);
  });

  it("acks and drop-logs when the org has no slack credential", async () => {
    api = await bootTestApi({ plugins: [slackPlugin] });

    const body = envelope(dmMessage(), "Ev-nocred");
    const res = await post(api.baseUrl, body, sign(body));

    // An ack, not a 401: a half-configured org must not put Slack into a
    // retry loop against an endpoint that keeps failing.
    expect(res.status).toBe(200);
    expect(await dropReasons(api)).toContain("unknown_org");
  });

  it("acks and drop-logs when the credential exists but the transport is not running", async () => {
    api = await bootTestApi({ plugins: [slackPlugin] });
    await seedCredential(api);

    const body = envelope(dmMessage(), "Ev-notransport");
    const res = await post(api.baseUrl, body, sign(body));

    expect(res.status).toBe(200);
    expect(await dropReasons(api)).toContain("transport_unavailable");
  });

  it("401s a body signed with the wrong secret", async () => {
    api = await bootTestApi({ plugins: [slackPlugin] });
    await seedRunningTransport(api);

    const body = envelope(dmMessage(), "Ev-badsig");
    const res = await post(api.baseUrl, body, sign(body, "wrong-secret"));

    expect(res.status).toBe(401);
    expect(await dropReasons(api)).toContain("bad_signature");
    expect(await eventCount(api, "Ev-badsig")).toBe(0);
  });

  it("401s a crafted multibyte signature header instead of 500ing", async () => {
    api = await bootTestApi({ plugins: [slackPlugin] });
    await seedRunningTransport(api);

    const body = envelope(dmMessage(), "Ev-crafted");
    const res = await post(api.baseUrl, body, {
      "Content-Type": "application/json",
      "X-Slack-Signature": `v0=${"0".repeat(63)}é`,
      "X-Slack-Request-Timestamp": String(nowSeconds()),
    });

    expect(res.status).toBe(401);
  });

  it("401s a replayed body whose timestamp is outside the window", async () => {
    api = await bootTestApi({ plugins: [slackPlugin] });
    await seedRunningTransport(api);

    const body = envelope(dmMessage(), "Ev-replay");
    const res = await post(api.baseUrl, body, sign(body, SECRET, nowSeconds() - 1_000));

    expect(res.status).toBe(401);
  });

  it("routes a DM to the channel host, where an unlinked sender is dropped", async () => {
    api = await bootTestApi({ plugins: [slackPlugin] });
    await seedRunningTransport(api);

    const body = envelope(dmMessage(), "Ev-dm");
    expect((await post(api.baseUrl, body, sign(body))).status).toBe(200);

    // No identity link exists, so reaching the host is observable as this
    // drop reason. It proves the update was verified, parsed, and routed.
    await expect.poll(() => dropReasons(api!), { timeout: 5_000 }).toContain("unlinked_sender");
  });

  it("acks app_home_opened but does not route it (no thread_ts under per-thread routing)", async () => {
    api = await bootTestApi({ plugins: [slackPlugin] });
    await seedRunningTransport(api);

    const body = envelope({ ...homeOpened(), text: "private classifier payload", token: "classifier-secret" }, "Ev-home");
    expect((await post(api.baseUrl, body, sign(body))).status).toBe(200);

    // Under per-thread routing, app_home_opened has no thread_ts to anchor a
    // conversation key, so parseUpdate returns null. The webhook acks (200)
    // but there is no subscription event. Record that classification outcome.
    await expect.poll(() => dropReasons(api!), { timeout: 5_000 }).toContain("slack_classifier_rejected");
    const rows = await api.providers.db.select().from(eventDropLog).where(eq(eventDropLog.reason, "slack_classifier_rejected"));
    expect(rows[0]?.detail).toContain("No enabled Slack trigger classifier");
    expect(rows[0]?.eventMetadata).toBeNull();
    expect(JSON.stringify(rows)).not.toContain("private classifier payload");
    expect(JSON.stringify(rows)).not.toContain("classifier-secret");
  });

  it("persists a subscribed slack.message and skips it when nothing subscribes", async () => {
    api = await bootTestApi({ plugins: [slackPlugin] });
    await seedRunningTransport(api);

    const unsubscribed = envelope(dmMessage(), "Ev-msg-1");
    expect((await post(api.baseUrl, unsubscribed, sign(unsubscribed))).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await eventCount(api, "Ev-msg-1")).toBe(0);

    await seedSubscription(api, ["slack.message"]);
    const subscribed = envelope(dmMessage(), "Ev-msg-2");
    expect((await post(api.baseUrl, subscribed, sign(subscribed))).status).toBe(200);
    await expect.poll(() => eventCount(api!, "Ev-msg-2"), { timeout: 5_000 }).toBe(1);
  });

  it("records a named slack.message near-miss for a normalized bot form message", async () => {
    api = await bootTestApi({ plugins: [slackPlugin] });
    await seedRunningTransport(api);
    await seedSubscription(api, ["slack.message"]);

    const body = envelope(botFormMessage(), "Ev-bot-form");
    expect((await post(api.baseUrl, body, sign(body))).status).toBe(200);

    await expect.poll(async () => {
      const rows = await api!.providers.db.select().from(eventDropLog)
        .where(and(eq(eventDropLog.orgId, "local-org"), eq(eventDropLog.eventKey, "slack.message")));
      return rows;
    }, { timeout: 5_000 }).toEqual([expect.objectContaining({
      reason: "filter_excluded",
      eventMetadata: {
        channel: "C_FORM",
        botId: "B_FORM",
        rawEventType: "message",
        rawSubtype: "bot_message",
      },
    })]);
    expect(await eventCount(api, "Ev-bot-form")).toBe(0);
  });

  it("does not let a slack.message filter miss suppress the bot-message near-miss", async () => {
    api = await bootTestApi({ plugins: [slackPlugin] });
    await seedRunningTransport(api);
    await seedSubscription(api, ["slack.message"], [{ field: "channel", op: "eq", value: "C_OTHER" }]);

    const human = envelope(humanChannelMessage(), "Ev-human-filtered");
    const bot = envelope(botFormMessage(), "Ev-bot-near-miss-after-filter");
    expect((await post(api.baseUrl, human, sign(human))).status).toBe(200);
    await expect.poll(async () => (await api!.providers.db.select().from(eventDropLog)
      .where(and(eq(eventDropLog.orgId, "local-org"), eq(eventDropLog.eventKey, "slack.message")))).length, { timeout: 5_000 }).toBe(1);
    expect((await post(api.baseUrl, bot, sign(bot))).status).toBe(200);
    await expect.poll(async () => (await api!.providers.db.select().from(eventDropLog)
      .where(and(eq(eventDropLog.orgId, "local-org"), eq(eventDropLog.eventKey, "slack.message")))).length, { timeout: 5_000 }).toBe(2);
    const rows = await api.providers.db.select().from(eventDropLog)
      .where(and(eq(eventDropLog.orgId, "local-org"), eq(eventDropLog.eventKey, "slack.message")));
    expect(rows.map((row) => row.detail)).toEqual(expect.arrayContaining([
      expect.stringContaining("every subscription"),
      expect.stringContaining("bot message"),
    ]));
  });

  it.each([
    { subtype: undefined, user: undefined, channel: "C_FORM" },
    { subtype: undefined, user: "U_UNLINKED", channel: "C_FORM" },
    { subtype: "bot_message", user: "U_UNAUTHORIZED", channel: "C_FORM" },
    { subtype: "bot_message", user: "U_UNLINKED", channel: "C_OTHER" },
  ])("records bot guidance for a team-owned human-message subscription: %j", async ({ subtype, user, channel }) => {
    api = await bootTestApi({ plugins: [slackPlugin] });
    await seedRunningTransport(api);
    const now = Date.now();
    await api.providers.db.insert(teams).values({ id: "team-near-miss", orgId: "local-org", name: "Restricted", createdAt: now });
    await api.providers.db.insert(userIdentityLinks).values({
      id: "link-near-miss", provider: "slack", externalId: "U_UNAUTHORIZED", userId: "test-member", createdAt: now,
    });
    await api.providers.db.insert(eventSubscriptions).values({
      id: "sub_team_near_miss", orgId: "local-org", ownerType: "team", ownerId: "team-near-miss",
      name: "restricted messages", eventKeys: ["slack.message"], filters: [{ field: "channel", op: "eq", value: channel }],
      target: { kind: "orchestrator", orchestrator: "team", teamId: "team-near-miss" },
      enabled: true, createdBy: "local-user", createdAt: now, updatedAt: now,
    });

    const body = envelope({ ...botFormMessage(), subtype, user }, "Ev-team-bot-near-miss");
    expect((await post(api.baseUrl, body, sign(body))).status).toBe(200);
    await expect.poll(async () => api!.providers.db.select().from(eventDropLog)
      .where(eq(eventDropLog.orgId, "local-org")), { timeout: 5_000 }).toEqual([
      expect.objectContaining({
        eventKey: "slack.message", reason: "filter_excluded",
        detail: expect.stringContaining("Subscribe to `slack.bot_message`"),
        eventMetadata: channel === "C_FORM" ? expect.objectContaining({ channel: "C_FORM", botId: "B_FORM" }) : {},
      }),
    ]);
    expect(await eventCount(api, "Ev-team-bot-near-miss")).toBe(0);
  });

  it("throttles guidance for repeated team bot messages without a sender", async () => {
    api = await bootTestApi({ plugins: [slackPlugin] });
    await seedRunningTransport(api);
    const now = Date.now();
    await api.providers.db.insert(teams).values({ id: "team-bot-flood", orgId: "local-org", name: "Restricted", createdAt: now });
    await api.providers.db.insert(eventSubscriptions).values({
      id: "sub_team_bot_flood", orgId: "local-org", ownerType: "team", ownerId: "team-bot-flood",
      name: "restricted messages", eventKeys: ["slack.message"], filters: [],
      target: { kind: "orchestrator", orchestrator: "team", teamId: "team-bot-flood" },
      enabled: true, createdBy: "local-user", createdAt: now, updatedAt: now,
    });

    for (const eventId of ["Ev-bot-flood-1", "Ev-bot-flood-2"]) {
      const body = envelope(botFormMessage(), eventId);
      expect((await post(api.baseUrl, body, sign(body))).status).toBe(200);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    const rows = await api.providers.db.select().from(eventDropLog).where(eq(eventDropLog.orgId, "local-org"));
    expect(rows).toEqual([expect.objectContaining({ eventKey: "slack.message", reason: "filter_excluded" })]);
  });

  it("uses a non-team subscription without writing a team authorization denial", async () => {
    api = await bootTestApi({ plugins: [slackPlugin] });
    await seedRunningTransport(api);
    await seedSubscription(api, ["slack.message"]);
    const now = Date.now();
    await api.providers.db.insert(teams).values({ id: "team-mixed-near-miss", orgId: "local-org", name: "Restricted", createdAt: now });
    await api.providers.db.insert(eventSubscriptions).values({
      id: "sub_team_mixed_near_miss", orgId: "local-org", ownerType: "team", ownerId: "team-mixed-near-miss",
      name: "restricted messages", eventKeys: ["slack.message"], filters: [],
      target: { kind: "orchestrator", orchestrator: "team", teamId: "team-mixed-near-miss" },
      enabled: true, createdBy: "local-user", createdAt: now, updatedAt: now,
    });

    const body = envelope({ ...botFormMessage(), user: "U_UNLINKED" }, "Ev-bot-mixed-near-miss");
    expect((await post(api.baseUrl, body, sign(body))).status).toBe(200);
    await expect.poll(async () => (await api!.providers.db.select().from(eventDropLog)
      .where(and(eq(eventDropLog.orgId, "local-org"), eq(eventDropLog.eventKey, "slack.message")))).length, { timeout: 5_000 }).toBe(1);
    expect(await dropReasons(api)).not.toContain("unlinked_sender");
  });

  it("does not create a slack.message near-miss when a slack.bot_message subscription delivers", async () => {
    api = await bootTestApi({ plugins: [slackPlugin] });
    await seedRunningTransport(api);
    await seedSubscription(api, ["slack.message"]);
    await seedSubscription(api, ["slack.bot_message"]);

    const body = envelope(botFormMessage(), "Ev-bot-delivered");
    expect((await post(api.baseUrl, body, sign(body))).status).toBe(200);
    await expect.poll(() => deliveryCount(api!, "Ev-bot-delivered"), { timeout: 5_000 }).toBe(1);

    const nearMisses = await api.providers.db.select().from(eventDropLog)
      .where(and(eq(eventDropLog.orgId, "local-org"), eq(eventDropLog.eventKey, "slack.message")));
    expect(nearMisses).toEqual([]);
  });

  it.each(["bot_message", undefined])("delivers an NDA bot callback with subtype %s exactly once", async (subtype) => {
    api = await bootTestApi({ plugins: [slackPlugin] });
    await seedRunningTransport(api);
    await seedSubscription(api, ["slack.bot_message"], [
      { field: "channel", op: "eq", value: "C0BND4A8ZUK" },
      { field: "bot_id", op: "eq", value: "B0C492869S4" },
      { field: "text", op: "contains", value: "New NDA Review Request" },
    ]);
    const body = envelope({ ...botFormMessage(), subtype, channel: "C0BND4A8ZUK", bot_id: "B0C492869S4", text: "New NDA Review Request: example" }, "Ev-nda");
    expect((await post(api.baseUrl, body, sign(body))).status).toBe(200);
    await expect.poll(() => deliveryCount(api!, "Ev-nda"), { timeout: 5_000 }).toBe(1);
    expect((await post(api.baseUrl, body, { ...sign(body), "X-Slack-Retry-Num": "1" })).status).toBe(200);
    await expect.poll(() => dropReasons(api!), { timeout: 5_000 }).toContain("slack_retry");
    expect(await eventCount(api, "Ev-nda")).toBe(1);
    expect(await deliveryCount(api, "Ev-nda")).toBe(1);
  });

  it.each([
    { subtype: "bot_message", tokenField: "accessToken" },
    { subtype: undefined, tokenField: "accessToken" },
    { subtype: "bot_message", tokenField: "apiKey" },
  ])("resolves legacy identity and delivers the existing NDA subscription: %j", async ({ subtype, tokenField }) => {
    api = await bootTestApi({ plugins: [slackPlugin] });
    await seedRunningTransport(api);
    await api.providers.engineCredentials.save({ type: "org", id: "local-org" }, "slack", {
      type: "bot_token", [tokenField]: "xoxb-test-token",
      metadata: { webhookSecret: SECRET, teamId: TEAM_ID },
    });
    const priorFetch = vi.mocked(globalThis.fetch).getMockImplementation();
    if (!priorFetch) throw new Error("Missing fetch fixture");
    const authCalls = vi.fn(() => Response.json({ ok: true, team_id: TEAM_ID, user_id: "U0BOT", bot_id: "BVALET" }));
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      if (String(input) === "https://slack.com/api/auth.test") return Promise.resolve(authCalls());
      return priorFetch(input, init);
    });
    await seedSubscription(api, ["slack.bot_message"], [
      { field: "channel", op: "eq", value: "C0BND4A8ZUK" },
      { field: "bot_id", op: "eq", value: "B0C492869S4" },
      { field: "text", op: "contains", value: "New NDA Review Request" },
    ]);
    const message = { ...botFormMessage(), subtype, channel: "C0BND4A8ZUK", bot_id: "B0C492869S4", text: "New NDA Review Request: example" };
    const body = envelope(message, "Ev-legacy-nda");
    expect((await post(api.baseUrl, body, sign(body))).status).toBe(200);
    await expect.poll(() => deliveryCount(api!, "Ev-legacy-nda"), { timeout: 5_000 }).toBe(1);
    expect((await post(api.baseUrl, body, sign(body))).status).toBe(200);
    // Match every bot so the self-message assertions exercise the ingress guard.
    await api.providers.db.update(eventSubscriptions).set({ filters: [] })
      .where(eq(eventSubscriptions.id, "sub_slack_bot_message"));
    for (const [suffix, self] of [
      ["bot", { bot_id: "BVALET" }], ["user", { user: "U0BOT" }],
    ] as const) {
      const selfBody = envelope({ ...message, ...self }, `Ev-legacy-self-${suffix}`);
      expect((await post(api.baseUrl, selfBody, sign(selfBody))).status).toBe(200);
    }
    const nextBody = envelope(message, "Ev-legacy-next");
    expect((await post(api.baseUrl, nextBody, sign(nextBody))).status).toBe(200);
    await expect.poll(() => deliveryCount(api!, "Ev-legacy-next"), { timeout: 5_000 }).toBe(1);
    expect(await eventCount(api, "Ev-legacy-self-bot")).toBe(0);
    expect(await eventCount(api, "Ev-legacy-self-user")).toBe(0);
    expect(await deliveryCount(api, "Ev-legacy-nda")).toBe(1);
    expect(await dropReasons(api)).not.toContain("slack_bot_identity_missing");
    expect(authCalls).toHaveBeenCalledTimes(1);
  });

  it("resolves identity only for verified local bot events, after acknowledging Slack", async () => {
    api = await bootTestApi({ plugins: [slackPlugin] });
    await seedRunningTransport(api);
    await api.providers.engineCredentials.save({ type: "org", id: "local-org" }, "slack", {
      type: "bot_token", accessToken: "xoxb-test-token",
      metadata: { webhookSecret: SECRET, teamId: TEAM_ID, botUserId: "U0BOT" },
    });
    await seedSubscription(api, ["slack.bot_message"]);
    const priorFetch = vi.mocked(globalThis.fetch).getMockImplementation();
    if (!priorFetch) throw new Error("Missing fetch fixture");
    let release = (_response: Response): void => {};
    const pending = new Promise<Response>((resolve) => { release = resolve; });
    const lookup = vi.fn(() => pending);
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      if (String(input) === "https://slack.com/api/auth.test") return lookup();
      return priorFetch(input, init);
    });
    const body = envelope(botFormMessage(), "Ev-delayed-identity");
    try {
      expect((await post(api.baseUrl, body, sign(body, "wrong-secret"))).status).toBe(401);
      const foreign = envelope(botFormMessage(), "Ev-foreign-identity", "T_OTHER");
      expect((await post(api.baseUrl, foreign, sign(foreign))).status).toBe(200);
      const human = envelope(humanChannelMessage(), "Ev-human-no-lookup");
      expect((await post(api.baseUrl, human, sign(human))).status).toBe(200);
      expect(lookup).not.toHaveBeenCalled();
      // This response must arrive while auth.test is still unresolved.
      expect((await post(api.baseUrl, body, sign(body))).status).toBe(200);
      await expect.poll(() => lookup.mock.calls.length).toBe(1);
      expect(await eventCount(api, "Ev-delayed-identity")).toBe(0);
    } finally {
      release(Response.json({ ok: true, team_id: TEAM_ID, user_id: "U0BOT", bot_id: "BVALET" }));
    }
    await expect.poll(() => deliveryCount(api!, "Ev-delayed-identity"), { timeout: 5_000 }).toBe(1);
  });

  it.each([
    { owner: "org", user: undefined, channel: "C_FORM" },
    { owner: "team", user: undefined, channel: "C_FORM" },
    { owner: "team", user: "U_UNLINKED", channel: "C_FORM" },
    { owner: "team", user: undefined, channel: "C_OTHER" },
  ])("reports a missing installation bot ID for a subscribed bot callback: %j", async ({ owner, user, channel }) => {
    api = await bootTestApi({ plugins: [slackPlugin] });
    await seedRunningTransport(api);
    await api.providers.engineCredentials.save({ type: "org", id: "local-org" }, "slack", {
      type: "bot_token", accessToken: "xoxb-test-token",
      metadata: { webhookSecret: SECRET, teamId: TEAM_ID, botUserId: "U0BOT" },
    });
    await seedSubscription(api, ["slack.bot_message"]);
    if (owner === "team") {
      await api.providers.db.insert(teams).values({ id: "team-bot-identity", orgId: "local-org", name: "Bot workflows", createdAt: Date.now() });
      await api.providers.db.update(eventSubscriptions).set({
        ownerType: "team", ownerId: "team-bot-identity",
        filters: [{ field: "channel", op: "eq", value: channel }],
        target: { kind: "orchestrator", orchestrator: "team", teamId: "team-bot-identity" },
      }).where(eq(eventSubscriptions.id, "sub_slack_bot_message"));
    }
    const body = envelope({ ...botFormMessage(), user }, "Ev-missing-identity");
    expect((await post(api.baseUrl, body, sign(body))).status).toBe(200);
    await expect.poll(async () => api!.providers.db.select().from(eventDropLog)
      .where(eq(eventDropLog.eventKey, "slack.bot_message")), { timeout: 5_000 }).toEqual([
      expect.objectContaining({ reason: "slack_bot_identity_missing", detail: expect.stringContaining("Reconnect Slack"), eventMetadata: channel === "C_FORM" ? expect.objectContaining({ channel: "C_FORM", botId: "B_FORM" }) : {} }),
    ]);
    expect(await eventCount(api, "Ev-missing-identity")).toBe(0);
    expect(await dropReasons(api)).not.toContain("unlinked_sender");
    expect((await post(api.baseUrl, body, sign(body))).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const rows = await api.providers.db.select().from(eventDropLog)
      .where(eq(eventDropLog.eventKey, "slack.bot_message"));
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain("ignored");
  });

  it.each([
    { key: "slack.message", ownerType: "org" },
    { key: "slack.message", ownerType: "user" },
    { key: "slack.bot_message", ownerType: "org" },
    { key: "slack.bot_message", ownerType: "user" },
  ])("omits excluded-channel metadata from bot diagnostics: %j", async ({ key, ownerType }) => {
    api = await bootTestApi({ plugins: [slackPlugin] });
    await seedRunningTransport(api);
    if (key === "slack.bot_message") {
      await api.providers.engineCredentials.save({ type: "org", id: "local-org" }, "slack", {
        type: "bot_token", accessToken: "xoxb-test-token",
        metadata: { webhookSecret: SECRET, teamId: TEAM_ID, botUserId: "U0BOT" },
      });
    }
    await seedSubscription(api, [key], [{ field: "channel", op: "eq", value: "C_HUMAN" }]);
    if (ownerType === "user") {
      await api.providers.db.update(eventSubscriptions).set({ ownerType: "user", ownerId: "local-user" })
        .where(eq(eventSubscriptions.id, `sub_${key.replace(/\W/g, "_")}`));
    }
    const body = envelope({ ...botFormMessage(), subtype: undefined, channel: "C_ENG_PRIVATE", text: "Private deployment details" }, "Ev-excluded-bot");
    expect((await post(api.baseUrl, body, sign(body))).status).toBe(200);
    await expect.poll(async () => api!.providers.db.select().from(eventDropLog)
      .where(eq(eventDropLog.orgId, "local-org")), { timeout: 5_000 }).toEqual([
      expect.objectContaining({
        eventKey: key, eventMetadata: {},
        reason: key === "slack.message" ? "filter_excluded" : "slack_bot_identity_missing",
      }),
    ]);
    expect(await eventCount(api, "Ev-excluded-bot")).toBe(0);
  });

  it("does not retain missing-identity diagnostics for unsubscribed bot traffic", async () => {
    api = await bootTestApi({ plugins: [slackPlugin] });
    await seedRunningTransport(api);
    await api.providers.engineCredentials.save({ type: "org", id: "local-org" }, "slack", {
      type: "bot_token", accessToken: "xoxb-test-token",
      metadata: { webhookSecret: SECRET, teamId: TEAM_ID, botUserId: "U0BOT" },
    });
    const body = envelope(botFormMessage(), "Ev-unsubscribed-missing-identity");
    expect((await post(api.baseUrl, body, sign(body))).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await dropReasons(api)).toEqual([]);
    expect(await eventCount(api, "Ev-unsubscribed-missing-identity")).toBe(0);
  });

  it("uses the bot-message filter diagnostic instead of duplicating a near-miss", async () => {
    api = await bootTestApi({ plugins: [slackPlugin] });
    await seedRunningTransport(api);
    await seedSubscription(api, ["slack.message"]);
    await seedSubscription(api, ["slack.bot_message"], [{ field: "channel", op: "eq", value: "C_OTHER" }]);

    const body = envelope(botFormMessage(), "Ev-bot-filtered");
    expect((await post(api.baseUrl, body, sign(body))).status).toBe(200);
    await expect.poll(async () => {
      const rows = await api!.providers.db.select().from(eventDropLog).where(eq(eventDropLog.orgId, "local-org"));
      return rows.map((row) => row.eventKey);
    }, { timeout: 5_000 }).toEqual(["slack.bot_message"]);
  });

  it("does not log unrelated normalized bot messages", async () => {
    api = await bootTestApi({ plugins: [slackPlugin] });
    await seedRunningTransport(api);

    const body = envelope(botFormMessage(), "Ev-bot-unrelated");
    expect((await post(api.baseUrl, body, sign(body))).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await dropReasons(api)).not.toContain("filter_excluded");
  });

  it("records only bounded metadata for an unmatched Slack form submission", async () => {
    api = await bootTestApi({ plugins: [slackPlugin] });
    await seedRunningTransport(api);
    const payload = encodeURIComponent(JSON.stringify({ type: "block_actions", token: "legacy-secret", team: { id: TEAM_ID }, user: { id: "U100" } }));
    const body = `payload=${payload}`;
    expect((await post(api.baseUrl, body, sign(body))).status).toBe(200);
    await expect.poll(() => dropReasons(api!), { timeout: 5_000 }).toContain("slack_interaction_unmatched");
    const drops = await api.providers.db.select().from(eventDropLog).where(eq(eventDropLog.reason, "slack_interaction_unmatched"));
    expect(drops).toHaveLength(1);
    expect(JSON.stringify(drops[0])).not.toContain("legacy-secret");
    const list = await fetch(`${api.baseUrl}/api/events/drops`);
    expect(JSON.stringify(await list.json())).not.toContain("legacy-secret");
    expect(await api.providers.db.select().from(events)).toHaveLength(0);
    expect(await api.providers.db.select().from(eventDeliveries)).toHaveLength(0);

    expect((await post(api.baseUrl, body, { ...sign(body), "x-slack-retry-num": "1" })).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await api.providers.db.select().from(eventDropLog).where(eq(eventDropLog.reason, "slack_interaction_unmatched"))).toHaveLength(1);
  });

  it("ingests a signed reaction_added and queues a delivery for a matching subscription", async () => {
    api = await bootTestApi({ plugins: [slackPlugin] });
    await seedRunningTransport(api);
    await seedSubscription(api, ["slack.reaction_added"]);

    const body = envelope(reactionAdded(), "Ev-react");
    expect((await post(api.baseUrl, body, sign(body))).status).toBe(200);

    // The event lands (reaction is not ephemeral) and a delivery is queued
    // against the subscription — the full ingest → match → dispatch handoff.
    await expect.poll(() => eventCount(api!, "Ev-react"), { timeout: 5_000 }).toBe(1);
    await expect.poll(() => deliveryCount(api!, "Ev-react"), { timeout: 5_000 }).toBe(1);
  });

  it("de-duplicates a replayed reaction_added on event_id", async () => {
    api = await bootTestApi({ plugins: [slackPlugin] });
    await seedRunningTransport(api);
    await seedSubscription(api, ["slack.reaction_added"]);

    const body = envelope(reactionAdded(), "Ev-react-dup");
    expect((await post(api.baseUrl, body, sign(body))).status).toBe(200);
    await expect.poll(() => eventCount(api!, "Ev-react-dup"), { timeout: 5_000 }).toBe(1);

    // Same event_id, so ingest's (service, dedupeKey) conflict absorbs it.
    const replay = await post(api.baseUrl, body, {
      ...sign(body),
      "x-slack-retry-num": "1",
      "x-slack-retry-reason": "http_timeout",
    });
    expect(replay.status).toBe(200);
    // Poll for the retry drop-log as the signal that the replay's
    // fire-and-forget fan-out finished. A fixed sleep could assert before a
    // duplicate delivery landed and pass vacuously.
    await expect.poll(() => dropReasons(api!), { timeout: 5_000 }).toContain("slack_retry");
    expect(await eventCount(api, "Ev-react-dup")).toBe(1);
    expect(await deliveryCount(api, "Ev-react-dup")).toBe(1);
  });

  it("does not drop-log an event no subscription names (ambient traffic stays silent)", async () => {
    api = await bootTestApi({ plugins: [slackPlugin] });
    await seedRunningTransport(api);
    // No subscription seeded, so nothing names slack.reaction_added.
    const body = envelope(reactionAdded(), "Ev-react-nosub");
    expect((await post(api.baseUrl, body, sign(body))).status).toBe(200);

    // Let the fire-and-forget fan-out run, then confirm nothing was stored and
    // no filter-excluded drop was written for it.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await eventCount(api, "Ev-react-nosub")).toBe(0);
    expect(await dropReasons(api)).not.toContain("filter_excluded");
  });

  it("drop-logs filter_excluded when a subscription names the key but its filter excludes the event", async () => {
    api = await bootTestApi({ plugins: [slackPlugin] });
    await seedRunningTransport(api);
    const now = Date.now();
    await api.providers.db.insert(eventSubscriptions).values({
      id: "sub_react_filtered",
      orgId: "local-org",
      ownerType: "org",
      ownerId: "local-org",
      name: "reactions in C999 only",
      eventKeys: ["slack.reaction_added"],
      // reactionAdded() is in C500, which this filter excludes.
      filters: [{ field: "channel", op: "eq", value: "C999" }],
      target: { kind: "orchestrator" },
      enabled: true,
      createdBy: "local-user",
      createdAt: now,
      updatedAt: now,
    });

    const body = envelope(reactionAdded(), "Ev-react-filtered");
    expect((await post(api.baseUrl, body, sign(body))).status).toBe(200);

    await expect.poll(() => dropReasons(api!), { timeout: 5_000 }).toContain("filter_excluded");
    expect(await eventCount(api, "Ev-react-filtered")).toBe(0);
  });

  it("ingests a signed app_mention and queues a delivery for a matching subscription", async () => {
    api = await bootTestApi({ plugins: [slackPlugin] });
    await seedRunningTransport(api);
    // The mention-scope rule (TKAI-299) requires the user filter at match
    // time; the fixture's mentioner is U100.
    await seedSubscription(api, ["slack.app_mention"], [{ field: "user", op: "eq", value: "U100" }]);

    const body = envelope(appMention(), "Ev-mention");
    expect((await post(api.baseUrl, body, sign(body))).status).toBe(200);

    await expect.poll(() => eventCount(api!, "Ev-mention"), { timeout: 5_000 }).toBe(1);
    await expect.poll(() => deliveryCount(api!, "Ev-mention"), { timeout: 5_000 }).toBe(1);
  });

  it("routes another team member through the org bot without a team credential", async () => {
    const a = await bootTestApi({ plugins: [slackPlugin] });
    api = a;
    await a.providers.eventDispatcher.stop();
    await seedRunningTransport(a);
    const now = Date.now();
    await a.providers.db.insert(teams).values({ id: "team-mention", orgId: "local-org", name: "Mentions", createdAt: now });
    await a.providers.db.insert(orgMembers).values({ orgId: "local-org", userId: "member-b", role: "member" });
    await a.providers.db.insert(teamMembers).values({ teamId: "team-mention", userId: "member-b", role: "member" });
    await a.providers.db.insert(userIdentityLinks).values({ id: "member-link", provider: "slack", externalId: "U100", userId: "member-b", createdAt: now });
    await a.providers.db.insert(eventSubscriptions).values({
      id: "team-sub", orgId: "local-org", ownerType: "team", ownerId: "team-mention",
      name: "Team mentions", eventKeys: ["slack.app_mention"],
      filters: [{ field: "channel", op: "eq", value: "C500" }, { field: "user", op: "eq", value: "U_CREATOR" }],
      target: { kind: "orchestrator", follow: true }, createdBy: "member-a", enabled: true, createdAt: now, updatedAt: now,
    });
    const body = envelope(appMention(), "Ev-team-member");
    expect((await post(a.baseUrl, body, sign(body))).status).toBe(200);
    await expect.poll(() => deliveryCount(a, "Ev-team-member"), { timeout: 5_000 }).toBe(1);
    expect(await a.providers.engineCredentials.get({ type: "team", id: "team-mention" }, "slack")).toBeNull();
  });

  it("fails closed on a legacy app_mention subscription with no user filter", async () => {
    api = await bootTestApi({ plugins: [slackPlugin] });
    await seedRunningTransport(api);
    // A row from before the mention-scope gate (TKAI-299): no user filter.
    // It must NOT fire for anyone's mention, and the miss must be visible in
    // the drop log rather than silent.
    await seedSubscription(api, ["slack.app_mention"]);

    const body = envelope(appMention(), "Ev-mention-legacy");
    expect((await post(api.baseUrl, body, sign(body))).status).toBe(200);

    await expect.poll(() => dropReasons(api!), { timeout: 5_000 }).toContain("filter_excluded");
    expect(await eventCount(api, "Ev-mention-legacy")).toBe(0);
  });

  it("drops an update from another workspace even though its signature is valid", async () => {
    api = await bootTestApi({ plugins: [slackPlugin] });
    await seedRunningTransport(api);
    await seedSubscription(api, ["slack.message"]);

    // A Slack app's signing secret is valid for every workspace that
    // installs the app, so a valid signature alone proves nothing.
    const body = envelope(dmMessage(), "Ev-foreign", "T9999");
    expect((await post(api.baseUrl, body, sign(body))).status).toBe(200);

    await expect.poll(() => dropReasons(api!), { timeout: 5_000 }).toContain("foreign_workspace");
    expect(await eventCount(api, "Ev-foreign")).toBe(0);
    expect(await dropReasons(api)).not.toContain("unlinked_sender");
  });

  it("drops an update that names no workspace at all", async () => {
    api = await bootTestApi({ plugins: [slackPlugin] });
    await seedRunningTransport(api);
    await seedSubscription(api, ["slack.message"]);

    const body = envelope(dmMessage(), "Ev-noteam", null);
    expect((await post(api.baseUrl, body, sign(body))).status).toBe(200);

    await expect.poll(() => dropReasons(api!), { timeout: 5_000 }).toContain("foreign_workspace");
    expect(await eventCount(api, "Ev-noteam")).toBe(0);
  });

  it("413s a body over the size cap", async () => {
    api = await bootTestApi({ plugins: [slackPlugin] });
    await seedRunningTransport(api);

    const res = await post(api.baseUrl, JSON.stringify({ pad: "x".repeat(1_100_000) }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(413);
  });

  it("acks inside Slack's 3-second window without waiting on the fan-out", async () => {
    api = await bootTestApi({ plugins: [slackPlugin] });
    await seedRunningTransport(api);

    const body = envelope(dmMessage(), "Ev-timing");
    const started = Date.now();
    const res = await post(api.baseUrl, body, sign(body));
    const elapsed = Date.now() - started;

    expect(res.status).toBe(200);
    expect(elapsed).toBeLessThan(3_000);
  });
});


describe("Slack receipt diagnostics", () => {
  const secretBody = "secret-form-answer-do-not-retain-in-receipt";
  async function receipts(eventId: string) {
    return api!.providers.db.select().from(eventReceipts).where(eq(eventReceipts.externalId, eventId));
  }
  async function completedReceipt(eventId: string, stage: string) {
    await expect.poll(async () => (await receipts(eventId)).some(row => Array.isArray(row.stages) && row.stages.some((item: unknown) => typeof item === "object" && item !== null && "stage" in item && item.stage === stage && "outcome" in item && item.outcome !== "started")), { timeout: 5_000 }).toBe(true);
    const [receipt] = await receipts(eventId);
    expect(JSON.stringify(receipt)).not.toContain(secretBody);
    expect(JSON.stringify(receipt)).not.toContain(SECRET);
    expect(JSON.stringify(receipt)).not.toContain("xoxb-test-token");
    return receipt;
  }

  it("links verified redeliveries to one persisted event and preserves retry metadata", async () => {
    api = await bootTestApi({ plugins: [slackPlugin] });
    await seedRunningTransport(api);
    await seedSubscription(api, ["slack.message"]);
    const eventId = "Ev-receipt-retry";
    const body = envelope({ ...humanChannelMessage(), text: secretBody }, eventId);
    expect((await post(api.baseUrl, body, sign(body))).status).toBe(200);
    const first = await completedReceipt(eventId, "follow");
    expect(first.stages).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: "verification", outcome: "verified" }),
      expect.objectContaining({ stage: "subscription_match", outcome: "matched" }),
      expect.objectContaining({ stage: "dispatch", outcome: "enqueued" }),
    ]));
    expect((await post(api.baseUrl, body, { ...sign(body), "x-slack-retry-num": "1", "x-slack-retry-reason": "http_timeout" })).status).toBe(200);
    await expect.poll(async () => JSON.stringify(await receipts(eventId)), { timeout: 5_000 }).toContain('"outcome":"duplicate"');
    const rows = await receipts(eventId);
    expect(rows).toHaveLength(2);
    expect(rows.every(row => row.eventId === first.eventId)).toBe(true);
    expect(rows.map(row => row.metadata)).toEqual(expect.arrayContaining([expect.objectContaining({ retryNum: "1", retryReason: "http_timeout" })]));
    expect(await eventCount(api, eventId)).toBe(1);
    expect(await deliveryCount(api, eventId)).toBe(1);
    expect(JSON.stringify(rows)).not.toContain(secretBody);
  });

  it.each([
    { label: "own bot", event: { ...botFormMessage(), bot_id: "BVALET" } },
    { label: "own bot profile", event: { ...botFormMessage(), bot_id: undefined, bot_profile: { id: "BVALET" } } },
    { label: "edit", event: { ...humanChannelMessage(), subtype: "message_changed" } },
  ])("records verified $label classification rejection without source text", async ({ event }) => {
    api = await bootTestApi({ plugins: [slackPlugin] });
    await seedRunningTransport(api);
    const eventId = "Ev-classification";
    const body = envelope({ ...event, text: secretBody }, eventId);
    expect((await post(api.baseUrl, body, sign(body))).status).toBe(200);
    const receipt = await completedReceipt(eventId, "follow");
    expect(receipt.stages).toEqual(expect.arrayContaining([expect.objectContaining({ stage: "classification", outcome: "rejected" })]));
    expect(receipt.metadata).toEqual(expect.objectContaining({ rawType: "message" }));
    expect(await eventCount(api, eventId)).toBe(0);
  });

  it("records a missing installation bot identity as classification failure", async () => {
    api = await bootTestApi({ plugins: [slackPlugin] });
    await api.providers.engineCredentials.save({ type: "org", id: "local-org" }, "slack", {
      type: "bot_token", accessToken: "xoxb-test-token", metadata: { webhookSecret: SECRET, teamId: TEAM_ID, botUserId: "U0BOT" },
    });
    await api.providers.channelHost.start();
    const body = envelope({ ...botFormMessage(), text: secretBody }, "Ev-missing-bot-id");
    expect((await post(api.baseUrl, body, sign(body))).status).toBe(200);
    const receipt = await completedReceipt("Ev-missing-bot-id", "follow");
    expect(receipt.stages).toEqual(expect.arrayContaining([expect.objectContaining({ stage: "classification", outcome: "rejected" })]));
    expect(JSON.stringify(receipt.stages)).toMatch(/bot identity/i);
  });

  it("records foreign-workspace receipt without running any consumer", async () => {
    api = await bootTestApi({ plugins: [slackPlugin] });
    await seedRunningTransport(api);
    const channel = vi.spyOn(api.providers.channelHost, "handleUpdate");
    const ingest = vi.spyOn(ingestModule, "ingestEvent");
    const follow = vi.spyOn(followRouter, "handleFollowedMessage");
    const body = envelope({ ...humanChannelMessage(), text: secretBody }, "Ev-foreign", "T_OTHER");
    expect((await post(api.baseUrl, body, sign(body))).status).toBe(200);
    await expect.poll(async () => JSON.stringify(await api!.providers.db.select().from(eventReceipts)), { timeout: 5_000 }).toContain('"stage":"workspace"');
    const [receipt] = await api.providers.db.select().from(eventReceipts);
    expect(receipt.externalId).toBeNull();
    expect(JSON.stringify(receipt)).not.toContain(secretBody);
    expect(receipt.stages).toEqual(expect.arrayContaining([expect.objectContaining({ stage: "workspace", outcome: "rejected" })]));
    expect(channel).not.toHaveBeenCalled();
    expect(ingest).not.toHaveBeenCalled();
    expect(follow).not.toHaveBeenCalled();
  });

  it("does not attribute unverified body metadata to an authenticated receipt", async () => {
    api = await bootTestApi({ plugins: [slackPlugin] });
    await seedRunningTransport(api);
    const body = envelope({ ...humanChannelMessage(), text: secretBody }, "Ev-forged");
    expect((await post(api.baseUrl, body, sign(body, "wrong-secret"))).status).toBe(401);
    const rows = await api.providers.db.select().from(eventReceipts);
    expect(JSON.stringify(rows)).not.toContain("Ev-forged");
    expect(JSON.stringify(rows)).not.toContain(secretBody);
    expect(await eventCount(api, "Ev-forged")).toBe(0);
  });

  it("preserves signature rejection when legacy diagnostic persistence fails", async () => {
    api = await bootTestApi({ plugins: [slackPlugin] });
    await seedRunningTransport(api);
    vi.spyOn(signalDiagnostics, "writeDropLog").mockRejectedValue(new Error("diagnostic store unavailable"));
    const body = envelope(dmMessage(), "Ev-invalid-diagnostic-down");
    expect((await post(api.baseUrl, body, sign(body, "wrong-secret"))).status).toBe(401);
    expect(await api.providers.db.select().from(eventReceipts)).toHaveLength(0);
  });

  it("does not mislabel diagnostic write failure as ingestion failure", async () => {
    api = await bootTestApi({ plugins: [slackPlugin] });
    await seedRunningTransport(api);
    vi.spyOn(signalDiagnostics, "writeDropLog").mockRejectedValue(new Error("diagnostic store unavailable"));
    const body = envelope({ ...botFormMessage(), bot_id: "BVALET", text: secretBody }, "Ev-classified-diagnostic-down");
    expect((await post(api.baseUrl, body, sign(body))).status).toBe(200);
    const receipt = await completedReceipt("Ev-classified-diagnostic-down", "follow");
    expect(receipt.stages).toEqual(expect.arrayContaining([expect.objectContaining({ stage: "classification", outcome: "rejected" })]));
    expect(receipt.stages).not.toEqual(expect.arrayContaining([expect.objectContaining({ stage: "ingestion", outcome: "failed" })]));
  });

  it.each(["channel", "ingestion", "follow"] as const)("isolates %s consumer errors and stores no exception contents", async (failingConsumer) => {
    api = await bootTestApi({ plugins: [slackPlugin] });
    await seedRunningTransport(api);
    await seedSubscription(api, ["slack.message"]);
    const failure = new Error(secretBody);
    const channel = vi.spyOn(api.providers.channelHost, "handleUpdate");
    const ingest = vi.spyOn(ingestModule, "ingestEvent");
    const follow = vi.spyOn(followRouter, "handleFollowedMessage");
    if (failingConsumer === "channel") channel.mockRejectedValueOnce(failure);
    if (failingConsumer === "ingestion") ingest.mockRejectedValueOnce(failure);
    if (failingConsumer === "follow") follow.mockRejectedValueOnce(failure);
    const body = envelope({ ...dmMessage(), text: secretBody }, "Ev-consumer-fail");
    expect((await post(api.baseUrl, body, sign(body))).status).toBe(200);
    const receipt = await completedReceipt("Ev-consumer-fail", "follow");
    expect(channel).toHaveBeenCalled();
    expect(ingest).toHaveBeenCalled();
    expect(follow).toHaveBeenCalled();
    expect(receipt.stages).toEqual(expect.arrayContaining([expect.objectContaining({ stage: failingConsumer, outcome: "failed" })]));
    expect(await eventCount(api, "Ev-consumer-fail")).toBe(failingConsumer === "ingestion" ? 0 : 1);
  });
});
