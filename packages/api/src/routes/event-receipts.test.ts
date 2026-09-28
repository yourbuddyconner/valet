import { afterEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { eventReceipts } from "../schema/index.js";
import { appendReceiptStage, createEventReceipt, sanitizeReceiptSubscriptions } from "../events/receipts.js";
import type { ListEventReceiptsResponse, CreateTeamResponse, CreateTeamApiKeyResponse } from "../wire/types.js";
let api: TestApi | undefined;
afterEach(async () => { await api?.cleanup(); api = undefined; });
describe("event receipts", () => {
  it("bounds subscription explanations and never retains filter values", () => {
    const rows = sanitizeReceiptSubscriptions(Array.from({ length: 60 }, (_, i) => ({ id: String(i), ownerType: "team", ownerId: "t", target: "workflow", targetId: "w", outcome: "filter_excluded", token: "secret", failedFilters: Array.from({ length: 30 }, () => ({ field: "channel", op: "eq", value: "secret" })) })));
    expect(rows).toHaveLength(50);
    expect(rows[0]?.failedFilters).toHaveLength(20);
    expect(rows[0]?.targetId).toBe("w");
    expect(JSON.stringify(rows)).not.toContain("secret");
  });

  it("redacts metadata, bounds atomic concurrent stage appends and filters subscription fields", async () => {
    api = await bootTestApi(); const db = api.providers.db;
    const id = await createEventReceipt(db, { orgId: "local-org", service: "slack", externalId: "retry", metadata: { channelId: "C1", text: "secret", token: "secret", workspaceId: { secret: true } } });
    expect(id).toBeTruthy();
    await Promise.all(Array.from({ length: 25 }, (_, i) => appendReceiptStage(db, id, { stage: "classification", outcome: `outcome${i}`, detail: "d".repeat(1000) })));
    const row = (await db.select().from(eventReceipts).where(eq(eventReceipts.id, id!)))[0]!;
    expect(row.metadata).toEqual({ channelId: "C1" });
    expect(row.stages).toHaveLength(20);
    const response = await fetch(`${api.baseUrl}/api/events/receipts`);
    expect(response.status).toBe(200);
    const data = await response.json() as ListEventReceiptsResponse;
    expect(data.receipts[0]!.stages.every(s => s.detail.length === 512)).toBe(true);
    expect(new Set(data.receipts[0]!.stages.map(s => s.outcome)).size).toBe(20);
    const second = await createEventReceipt(db, { orgId: "local-org", service: "slack", externalId: "retry" });
    expect(second).not.toBe(id);
  });
  it("requires admin and fences organization, search and cursor; sanitizes old records on read", async () => {
    api = await bootTestApi(); const db = api.providers.db, now = Date.now();
    await db.insert(eventReceipts).values(Array.from({ length: 4 }, (_, i) => ({ id: `r${i}`, orgId: i === 3 ? "foreign" : "local-org", service: "slack", externalId: "E1", metadata: { channelId: "C1", text: "secret" }, stages: [{ stage: "filter", outcome: "excluded", detail: "safe", at: now, token: "secret" }], createdAt: now, updatedAt: now })));
    const url = `${api.baseUrl}/api/events/receipts`;
    expect((await fetch(url, { headers: { "x-valet-test-user-id": "test-member" } })).status).toBe(403);
    const first = await (await fetch(`${url}?limit=2&q=C1`)).json() as ListEventReceiptsResponse;
    expect(first.receipts.map(r => r.id)).toEqual(["r2", "r1"]);
    expect(first.lastReceiptAt).toBe(now);
    expect(JSON.stringify(first)).not.toContain("secret");
    const second = await (await fetch(`${url}?q=C1&cursor=${first.nextCursor}`)).json() as ListEventReceiptsResponse;
    expect(second.receipts.map(r => r.id)).toEqual(["r0"]);
    expect(second.nextCursor).toBeNull();
    expect((await fetch(`${url}?q=other&cursor=${first.nextCursor}`)).status).toBe(400);
    expect((await fetch(`${url}?cursor=bad`)).status).toBe(400);
    expect((await fetch(`${url}?limit=0`)).status).toBe(400);
    expect((await (await fetch(`${url}?q=secret`)).json() as ListEventReceiptsResponse).receipts).toEqual([]);
    expect((await (await fetch(`${url}?q=excluded`)).json() as ListEventReceiptsResponse).receipts).toHaveLength(3);
  });
  it("cleans stale and excess receipts in bounded batches without touching other organizations", async () => {
    api = await bootTestApi(); const db = api.providers.db;
    await db.execute(sql`INSERT INTO event_receipts(id,org_id,service,created_at,updated_at) SELECT 'old-' || i, 'local-org', 'slack', 1, 1 FROM generate_series(1,1100) i`);
    await db.insert(eventReceipts).values({ id: "other", orgId: "other-org", service: "slack", createdAt: 1, updatedAt: 1 });
    await createEventReceipt(db, { orgId: "local-org", service: "slack" });
    expect((await db.select({ id: eventReceipts.id }).from(eventReceipts).where(eq(eventReceipts.orgId, "local-org")))).toHaveLength(101);
    expect((await (await fetch(`${api.baseUrl}/api/events/receipts`)).json() as ListEventReceiptsResponse).receipts).toHaveLength(1);
    await createEventReceipt(db, { orgId: "local-org", service: "slack" });
    expect(await db.select().from(eventReceipts).where(eq(eventReceipts.id, "other"))).toHaveLength(1);
    const now = Date.now();
    await db.execute(sql`INSERT INTO event_receipts(id,org_id,service,created_at,updated_at) SELECT 'new-' || i, 'local-org', 'slack', ${now}, ${now} FROM generate_series(1,10005) i`);
    await createEventReceipt(db, { orgId: "local-org", service: "slack" });
    const count = await db.select({ count: sql<number>`count(*)::int` }).from(eventReceipts).where(eq(eventReceipts.orgId, "local-org"));
    expect(count[0]?.count).toBe(10000);
  });
  it("rejects team API keys even when their issuing user is an admin", async () => {
    api = await bootTestApi({ auth: true });
    const signup = await fetch(`${api.baseUrl}/api/auth/sign-up/email`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "receipt@nowhere.test", name: "Admin", password: "correct-horse-battery" }) });
    const cookie = signup.headers.get("set-cookie")?.match(/better-auth\.session_token=[^;]+/)?.[0];
    if (!cookie) throw new Error("Missing session cookie");
    const team = await (await fetch(`${api.baseUrl}/api/teams`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "Receipt team" }) })).json() as CreateTeamResponse;
    const key = await (await fetch(`${api.baseUrl}/api/teams/${team.team.id}/api-keys`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "CI" }) })).json() as CreateTeamApiKeyResponse;
    expect((await fetch(`${api.baseUrl}/api/events/receipts`, { headers: { "x-api-key": key.key } })).status).toBe(403);
  });
  it("fails open when receipt storage is unavailable", async () => {
    api = await bootTestApi(); const db = api.providers.db;
    await db.execute(sql`DROP TABLE event_receipts`);
    expect(await createEventReceipt(db, { orgId: "local-org", service: "slack" })).toBeUndefined();
    await expect(appendReceiptStage(db, "missing", { stage: "test", outcome: "failed", detail: "safe" })).resolves.toBeUndefined();
    await expect(appendReceiptStage(db, undefined, { stage: "test", outcome: "failed", detail: "safe" })).resolves.toBeUndefined();
  });
});
