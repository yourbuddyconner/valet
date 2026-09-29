import { beforeEach, describe, expect, it } from "vitest";
import type { PluginActionContext } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { eventDropLog, eventReceipts, orgMembers, orgs, users } from "../schema/index.js";
import { eventsActionPlugin } from "./actions.js";

const ORG = "event-problems-org";

function context(userId: string, overrides: Partial<PluginActionContext> = {}): PluginActionContext {
  return { userId, orgId: ORG, actionId: "events.list_problems", service: "events", ...overrides } as PluginActionContext;
}

function resultProblems(result: { data?: unknown }): Array<Record<string, unknown>> {
  if (!result.data || typeof result.data !== "object" || !("problems" in result.data)) return [];
  const problems = result.data.problems;
  return Array.isArray(problems) ? problems.filter((problem): problem is Record<string, unknown> => typeof problem === "object" && problem !== null) : [];
}

describe("eventsActionPlugin", () => {
  let db: AppDb;

  beforeEach(async () => {
    ({ appDb: db } = await freshTestPgDb());
    await db.insert(orgs).values({ id: ORG, name: "Event problems", createdAt: Date.now() });
    await db.insert(users).values([
      { id: "admin", email: "admin@example.test", name: "Admin", role: "admin" },
      { id: "member", email: "member@example.test", name: "Member", role: "member" },
    ]);
    await db.insert(orgMembers).values([
      { orgId: ORG, userId: "admin", role: "admin" },
      { orgId: ORG, userId: "member", role: "member" },
    ]);
  });

  function list() {
    const found = eventsActionPlugin(db).actions.find((entry) => entry.id === "events.list_problems");
    if (!found) throw new Error("events.list_problems is not registered");
    return found;
  }

  it("returns a Slack bot-message near-miss with normalized and raw event identities", async () => {
    await db.insert(eventDropLog).values({
      id: "leg17", orgId: ORG, reason: "filter_excluded", eventKey: "slack.message",
      eventMetadata: { channel: "C_FORM", text: "Submitted intake", botId: "B_FORM", rawEventType: "message", rawSubtype: "bot_message" },
      detail: "slack.message accepts only human messages", createdAt: Date.now(),
    });

    const result = await list().execute(
      { event_key: "slack.message", channel: "C_FORM", text: "Submitted intake", bot_id: "B_FORM" },
      context("admin", { owner: { type: "user", id: "admin" } }),
    );
    expect(result.success).toBe(true);
    expect(resultProblems(result)).toEqual([expect.objectContaining({
      receivedAt: expect.any(Number),
      normalizedEventKey: "slack.message",
      matchOutcome: "excluded_by_filter",
      reason: "filter_excluded",
      payloadMetadata: expect.objectContaining({ rawSubtype: "bot_message", rawEventType: "message", channel: "C_FORM", botId: "B_FORM" }),
    })]);
  });

  it("applies member redaction and excludes admin-only interaction diagnostics", async () => {
    await db.insert(eventDropLog).values([
      { id: "filter", orgId: ORG, reason: "filter_excluded", eventKey: "slack.message", eventMetadata: { channel: "C1", text: "private", botId: "B1" }, detail: "filtered", createdAt: 2_000 },
      { id: "interaction", orgId: ORG, reason: "slack_interaction_unmatched", detail: "form details", createdAt: 1_000 },
    ]);

    const member = await list().execute({}, context("member"));
    expect(member.success).toBe(true);
    expect(resultProblems(member)).toEqual([expect.objectContaining({ id: "filter", payloadMetadata: { channel: "C1" } })]);
    const restricted = await list().execute({ text: "private" }, context("member"));
    expect(restricted).toMatchObject({ success: false, error: expect.stringMatching(/organization admin/) });
  });

  it("redacts administrator-only metadata in a team-owned transcript", async () => {
    await db.insert(eventDropLog).values({
      id: "team-secret", orgId: ORG, reason: "filter_excluded", eventKey: "slack.message",
      eventMetadata: { channel: "C1", text: "secret payroll message", botId: "B_SECRET" },
      detail: "filtered", createdAt: Date.now(),
    });
    const teamContext = context("admin", {
      actor: { id: "admin" },
      owner: { type: "team", id: "finance-team" },
    });

    const result = await list().execute({}, teamContext);
    expect(result.success).toBe(true);
    expect(resultProblems(result)).toEqual([expect.objectContaining({
      payloadMetadata: { channel: "C1" },
    })]);
    expect(JSON.stringify(result)).not.toContain("secret payroll message");
    expect(JSON.stringify(result)).not.toContain("B_SECRET");
    expect(await list().execute({ text: "secret payroll message" }, teamContext)).toMatchObject({
      success: false,
      error: expect.stringMatching(/private session/),
    });
  });

  it("redacts administrator-only metadata in a channel-originated user transcript", async () => {
    await db.insert(eventDropLog).values([
      {
        id: "channel-secret", orgId: ORG, reason: "filter_excluded", eventKey: "slack.message",
        eventMetadata: { channel: "C1", text: "secret payroll message", botId: "B_SECRET", rawEventType: "message" },
        detail: "filtered", createdAt: 2_000,
      },
      {
        id: "channel-interaction", orgId: ORG, reason: "slack_interaction_unmatched",
        detail: "form details", createdAt: 1_000,
      },
    ]);
    const channelContext = context("admin", {
      actor: { id: "admin" },
      owner: { type: "user", id: "admin" },
      origin: { channelType: "slack", threadKey: "slack:C1:1.2" },
    });

    const result = await list().execute({}, channelContext);
    expect(result.success).toBe(true);
    expect(resultProblems(result)).toEqual([expect.objectContaining({
      id: "channel-secret",
      payloadMetadata: { channel: "C1", rawEventType: "message" },
    })]);
    expect(JSON.stringify(result)).not.toContain("secret payroll message");
    expect(JSON.stringify(result)).not.toContain("B_SECRET");
    expect(await list().execute({ text: "secret payroll message" }, channelContext)).toMatchObject({
      success: false,
      error: expect.stringMatching(/private session/),
    });
    expect(await list().execute({ bot_id: "B_SECRET" }, channelContext)).toMatchObject({
      success: false,
      error: expect.stringMatching(/private session/),
    });
  });

  it("fails closed for organization-owned and owner-absent transcripts", async () => {
    await db.insert(eventDropLog).values([
      {
        id: "shared-secret", orgId: ORG, reason: "filter_excluded", eventKey: "slack.message",
        eventMetadata: { channel: "C1", text: "secret payroll message", botId: "B_SECRET" },
        detail: "filtered", createdAt: 2_000,
      },
      {
        id: "shared-interaction", orgId: ORG, reason: "slack_interaction_unmatched",
        detail: "form details", createdAt: 1_000,
      },
    ]);
    const contexts = [
      context("admin", { actor: { id: "admin" }, owner: { type: "org", id: ORG } }),
      context("admin", { actor: { id: "admin" } }),
    ];

    for (const sharedContext of contexts) {
      const result = await list().execute({}, sharedContext);
      expect(result.success).toBe(true);
      expect(resultProblems(result)).toEqual([expect.objectContaining({
        id: "shared-secret",
        payloadMetadata: { channel: "C1" },
      })]);
      expect(JSON.stringify(result)).not.toContain("secret payroll message");
      expect(JSON.stringify(result)).not.toContain("B_SECRET");
      expect(await list().execute({ bot_id: "B_SECRET" }, sharedContext)).toMatchObject({
        success: false,
        error: expect.stringMatching(/private session/),
      });
    }
  });

  it("reports no match outcome for non-event diagnostics", async () => {
    await db.insert(eventDropLog).values({
      id: "unbound", orgId: ORG, reason: "unbound_channel", detail: "Channel is not bound", createdAt: Date.now(),
    });

    const result = await list().execute({}, context("admin", { owner: { type: "user", id: "admin" } }));
    expect(result.success).toBe(true);
    expect(resultProblems(result)).toEqual([expect.objectContaining({
      id: "unbound",
      matchOutcome: null,
    })]);
  });

  it("scopes records to the caller organization and respects time and limit filters", async () => {
    await db.insert(eventDropLog).values([
      { id: "old", orgId: ORG, reason: "filter_excluded", eventKey: "slack.message", detail: "old", createdAt: 1_000 },
      { id: "first", orgId: ORG, reason: "filter_excluded", eventKey: "slack.message", detail: "first", createdAt: 2_000 },
      { id: "second", orgId: ORG, reason: "filter_excluded", eventKey: "slack.message", detail: "second", createdAt: 3_000 },
      { id: "foreign", orgId: "other-org", reason: "filter_excluded", eventKey: "slack.message", detail: "foreign", createdAt: 4_000 },
    ]);

    const result = await list().execute({ event_key: "slack.message", since: 1_500, until: 3_000, limit: 1 }, context("admin"));
    expect(result.success).toBe(true);
    expect(resultProblems(result).map((problem) => problem.id)).toEqual(["second"]);
  });

  it("filters metadata in SQL before applying the default limit", async () => {
    const rows = Array.from({ length: 26 }, (_, index) => ({
      id: `newer-${index}`,
      orgId: ORG,
      reason: "filter_excluded",
      eventKey: "slack.message",
      eventMetadata: { channel: "C_OTHER" },
      detail: "other channel",
      createdAt: 10_000 - index,
    }));
    rows.push({
      id: "older-match",
      orgId: ORG,
      reason: "filter_excluded",
      eventKey: "slack.message",
      eventMetadata: { channel: "C_FORM" },
      detail: "form channel",
      createdAt: 1_000,
    });
    await db.insert(eventDropLog).values(rows);

    const result = await list().execute({ channel: "C_FORM" }, context("admin"));
    expect(result.success).toBe(true);
    expect(resultProblems(result).map((problem) => problem.id)).toEqual(["older-match"]);
  });

  it("rejects unsafe timestamp filters before binding them to PostgreSQL", async () => {
    const tooLarge = await list().execute({ since: 1e100 }, context("admin"));
    expect(tooLarge).toMatchObject({ success: false, error: expect.stringMatching(/safe epoch-millisecond/) });

    const outOfRange = await list().execute({ until: Number.MAX_SAFE_INTEGER + 1 }, context("admin"));
    expect(outOfRange).toMatchObject({ success: false, error: expect.stringMatching(/safe epoch-millisecond/) });
  });

  it("refuses a context whose user is not an organization member", async () => {
    const result = await list().execute({}, context("not-a-member"));
    expect(result).toMatchObject({ success: false, error: "You are not a member of this organization." });
  });
  it("keeps receipt access out of member and shared transcripts", async () => {
    const logs = eventsActionPlugin(db).actions.find(entry => entry.id === "events.list_event_logs")!;
    for (const ctx of [
      context("member", { owner: { type: "user", id: "member" } }),
      context("admin", { owner: { type: "team", id: "team" } }),
      context("admin", { owner: { type: "user", id: "admin" }, sharedTranscript: true }),
      context("admin"),
    ]) {
      expect(await logs.execute({}, ctx)).toMatchObject({ success: false });
    }
  });

  it("scopes receipt logs by organization and retention and sanitizes metadata", async () => {
    const now = Date.now();
    await db.insert(eventReceipts).values([
      { id: "visible", orgId: ORG, service: "slack", createdAt: now, updatedAt: now, metadata: { channelId: "C1", secret: "must-not-return" } },
      { id: "other-org", orgId: "different-org", service: "slack", createdAt: now, updatedAt: now },
      { id: "expired", orgId: ORG, service: "slack", createdAt: now - 8 * 86400000, updatedAt: now },
    ]);
    const logs = eventsActionPlugin(db).actions.find(entry => entry.id === "events.list_event_logs")!;
    const result = await logs.execute({}, context("admin", { owner: { type: "user", id: "admin" } }));
    expect(result).toMatchObject({ success: true, data: { receipts: [{ id: "visible", metadata: { channelId: "C1" } }], hasMore: false } });
    expect(JSON.stringify(result)).not.toContain("must-not-return");
    expect(JSON.stringify(result)).not.toContain("other-org");
    expect(JSON.stringify(result)).not.toContain("expired");
  });

});
