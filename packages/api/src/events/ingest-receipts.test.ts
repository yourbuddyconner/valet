import type { NormalizedEvent } from "@valet/engine";
import slackPlugin from "@valet/plugin-slack/plugin";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eventDeliveries, eventReceipts, eventDropLog, events, eventSubscriptions } from "../schema/index.js";
import { freshTestPgDb, type TestPgDb } from "../test-helpers/pg-test-db.js";
import { __resetIngestDropThrottle, ingestEvent } from "./ingest.js";

const ORG = "receipt-test-org";
const SECRET_BODY = "private-message-body-must-not-enter-receipt";
function message(dedupeKey: string): NormalizedEvent {
  return {
    key: "slack.message", dedupeKey, occurredAt: new Date().toISOString(),
    refs: { channel: "C_PRIVATE" }, summary: SECRET_BODY,
    payload: { type: "message", user: "U_PRIVATE", channel: "C_PRIVATE", text: SECRET_BODY },
  };
}

describe("generic ingest receipt diagnostics", () => {
  let db: TestPgDb;
  beforeEach(async () => {
    db = await freshTestPgDb();
    __resetIngestDropThrottle();
  });
  async function subscribe(enabled = true, filtered = false) {
    await db.appDb.insert(eventSubscriptions).values({
      id: "receipt-sub", orgId: ORG, ownerType: "user", ownerId: "owner", createdBy: "owner",
      name: "Subscription", eventKeys: ["slack.message"],
      filters: filtered ? [{ field: "channel", op: "eq", value: "C_ELSEWHERE" }] : [],
      target: { kind: "orchestrator" }, enabled, createdAt: 1, updatedAt: 1,
    });
  }
  function ingest(dedupeKey: string) {
    return ingestEvent({ db: db.appDb, plugins: [slackPlugin] }, { orgId: ORG, service: "slack", event: message(dedupeKey) });
  }

  it.each([
    { scenario: "no named subscription", enabled: undefined, filtered: false, outcome: "no_subscription", decision: undefined },
    { scenario: "disabled subscription", enabled: false, filtered: false, outcome: "no_subscription", decision: "disabled" },
    { scenario: "filter exclusion", enabled: true, filtered: true, outcome: "filtered", decision: "filter_excluded" },
  ])("records $scenario without retaining message contents", async ({ enabled, filtered, outcome, decision }) => {
    if (enabled !== undefined) await subscribe(enabled, filtered);
    expect(await ingest("skip-me")).toMatchObject({ skipped: true, deliveries: 0 });
    const [receipt] = await db.appDb.select().from(eventReceipts);
    expect(receipt).toBeDefined();
    expect(receipt.stages).toEqual(expect.arrayContaining([expect.objectContaining({ stage: "subscription_match", outcome })]));
    if (decision) expect(receipt.subscriptions).toEqual(expect.arrayContaining([expect.objectContaining({ id: "receipt-sub", outcome: decision })]));
    expect(JSON.stringify(receipt)).not.toContain(SECRET_BODY);
    expect(JSON.stringify(receipt)).not.toContain("C_PRIVATE");
    expect(await db.appDb.select().from(events)).toHaveLength(0);
  });

  it("records two same-key filter misses independently despite the legacy diagnostic throttle", async () => {
    await subscribe(true, true);
    await ingest("first-filter-miss");
    await ingest("second-filter-miss");
    const receipts = await db.appDb.select().from(eventReceipts);
    expect(receipts).toHaveLength(2);
    expect(new Set(receipts.map(receipt => receipt.id)).size).toBe(2);
    for (const receipt of receipts) {
      expect(receipt.stages).toEqual(expect.arrayContaining([expect.objectContaining({ stage: "subscription_match", outcome: "filtered" })]));
      expect(JSON.stringify(receipt)).not.toContain(SECRET_BODY);
    }
    expect(await db.appDb.select().from(eventDropLog)).toHaveLength(1);
  });

  it("links retry receipts to the same canonical event without duplicate deliveries", async () => {
    await subscribe();
    const first = await ingest("same-provider-id");
    const retry = await ingest("same-provider-id");
    expect(first).toMatchObject({ duplicate: false, deliveries: 1 });
    expect(retry).toMatchObject({ duplicate: true, deliveries: 0 });
    const receipts = await db.appDb.select().from(eventReceipts);
    expect(receipts).toHaveLength(2);
    expect(receipts.map(receipt => receipt.eventId)).toEqual([first.eventId, first.eventId]);
    expect(receipts.flatMap(receipt => receipt.stages)).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: "persistence", outcome: "duplicate" }),
    ]));
    expect(await db.appDb.select().from(eventDeliveries)).toHaveLength(1);
  });

  it("does not hide an actual persistence error behind receipt diagnostics", async () => {
    await subscribe();
    const transaction = vi.spyOn(db.appDb, "transaction").mockRejectedValueOnce(new Error(SECRET_BODY));
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(ingest("persistence-failed")).rejects.toThrow(SECRET_BODY);
      const [receipt] = await db.appDb.select().from(eventReceipts);
      expect(receipt.stages).toEqual(expect.arrayContaining([expect.objectContaining({ stage: "ingestion", outcome: "failed" })]));
      expect(JSON.stringify(receipt)).not.toContain(SECRET_BODY);
      expect(await db.appDb.select().from(events)).toHaveLength(0);
    } finally {
      transaction.mockRestore();
      errors.mockRestore();
    }
  });

  it("never links a dedupe collision to another organization's event", async () => {
    await subscribe();
    const first = await ingest("cross-org-provider-id");
    const [sub] = await db.appDb.select().from(eventSubscriptions);
    await db.appDb.insert(eventSubscriptions).values({ ...sub, id: "other-sub", orgId: "other-org" });
    const result = await ingestEvent({ db: db.appDb, plugins: [slackPlugin] }, { orgId: "other-org", service: "slack", event: message("cross-org-provider-id") });
    expect(result.duplicate).toBe(true);
    const rows = await db.appDb.select().from(eventReceipts);
    const receipt = rows.find(row => row.orgId === "other-org");
    expect(receipt?.eventId).toBeNull();
    expect(JSON.stringify(receipt)).not.toContain(first.eventId);
  });

  it("keeps accepting events when the receipt store is unavailable", async () => {
    await subscribe();
    await db.pgdb.query("DROP TABLE event_receipts");
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const result = await ingest("receipt-store-down");
      expect(result).toMatchObject({ duplicate: false, deliveries: 1 });
      expect(await db.appDb.select().from(events)).toHaveLength(1);
      expect(await db.appDb.select().from(eventDeliveries)).toHaveLength(1);
    } finally {
      errors.mockRestore();
    }
  });
});
