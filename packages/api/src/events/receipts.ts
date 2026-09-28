import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";
import { eventReceipts } from "../schema/index.js";
import type { EventReceiptWire, ReceiptStage, ReceiptSubscriptionDecision } from "../wire/types.js";

export const RECEIPT_RETENTION_DAYS = 7;
const metadataKeys = new Set(["channelId", "workspaceId", "actorId", "botId", "appId", "rawType", "rawSubtype", "messageTs", "threadTs", "retryNum", "retryReason", "botIdentityAvailable", "botUserIdentityAvailable", "payloadBytes", "configuredTriggerCount"]);
const outcomes = new Set(["matched", "filter_excluded", "authorization_denied", "disabled", "key_mismatch"]);
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const bounded = (value: unknown, max = 256): string => typeof value === "string" ? value.slice(0, max) : "";
export function sanitizeReceiptMetadata(value: unknown): Record<string, string | number | boolean> {
  return Object.fromEntries(Object.entries(record(value)).filter(([key, v]) => metadataKeys.has(key) && (typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v)))).map(([k, v]) => [k, typeof v === "string" ? v.slice(0, 256) : v])) as Record<string, string | number | boolean>;
}
export function sanitizeReceiptStages(value: unknown): ReceiptStage[] {
  return (Array.isArray(value) ? value : []).slice(-20).map(record).map(v => ({ stage: bounded(v.stage, 64), outcome: bounded(v.outcome, 64), detail: bounded(v.detail, 512), at: typeof v.at === "number" && Number.isFinite(v.at) ? v.at : 0 }));
}
export function sanitizeReceiptSubscriptions(value: unknown): ReceiptSubscriptionDecision[] {
  return (Array.isArray(value) ? value : []).slice(0, 50).map(record).filter(v => outcomes.has(String(v.outcome))).map(v => ({
    id: bounded(v.id), ...(typeof v.name === "string" ? { name: bounded(v.name) } : {}), ownerType: bounded(v.ownerType, 16), ownerId: bounded(v.ownerId), target: bounded(v.target, 64),
    ...(typeof v.targetId === "string" ? { targetId: bounded(v.targetId) } : {}),
    outcome: v.outcome as ReceiptSubscriptionDecision["outcome"],
    ...(Array.isArray(v.failedFilters) ? { failedFilters: v.failedFilters.slice(0, 20).map(record).map(f => ({ field: bounded(f.field, 128), op: bounded(f.op, 32) })) } : {}),
  }));
}
export function receiptWire(row: typeof eventReceipts.$inferSelect): EventReceiptWire {
  return { id: row.id, service: bounded(row.service), externalId: row.externalId === null ? null : bounded(row.externalId), metadata: sanitizeReceiptMetadata(row.metadata), stages: sanitizeReceiptStages(row.stages), subscriptions: sanitizeReceiptSubscriptions(row.subscriptions), eventKey: row.eventKey === null ? null : bounded(row.eventKey), eventId: row.eventId === null ? null : bounded(row.eventId), createdAt: row.createdAt, updatedAt: row.updatedAt };
}
export async function createEventReceipt(db: AppDb, input: { orgId: string; service: string; externalId?: string; metadata?: Record<string, unknown> }): Promise<string | undefined> {
  try {
    const id = randomUUID(), now = Date.now();
    await db.insert(eventReceipts).values({ id, orgId: input.orgId, service: bounded(input.service), externalId: input.externalId === undefined ? null : bounded(input.externalId), metadata: sanitizeReceiptMetadata(input.metadata), stages: [], subscriptions: [], createdAt: now, updatedAt: now });
    // Both scans are index-bounded: excess records are drained in batches of at most
    // 1000 per receipt. The API also enforces the age window during cleanup backlogs.
    try {
      await db.execute(sql`DELETE FROM event_receipts WHERE org_id = ${input.orgId} AND id IN (
        SELECT id FROM (
          (SELECT id FROM event_receipts WHERE org_id = ${input.orgId} AND created_at < ${now - 7 * 86400000} ORDER BY created_at, id LIMIT 1000)
          UNION
          (SELECT id FROM event_receipts WHERE org_id = ${input.orgId} ORDER BY created_at DESC, id DESC OFFSET 10000 LIMIT 1000)
        ) candidates LIMIT 1000
      )`);
    } catch { console.warn("[event-receipts] cleanup unavailable"); }
    return id;
  } catch { console.warn("[event-receipts] write unavailable"); return undefined; }
}
export async function appendReceiptStage(db: AppDb, receiptId: string | undefined, stage: { stage: string; outcome: string; detail: string }, patch?: { eventKey?: string; eventId?: string; subscriptions?: ReceiptSubscriptionDecision[] }): Promise<void> {
  if (!receiptId) return;
  try {
    const now = Date.now(), stages = JSON.stringify(sanitizeReceiptStages([{ ...stage, at: now }]));
    await db.update(eventReceipts).set({
      // One row update serializes concurrent appenders without losing stages.
      stages: sql`(SELECT COALESCE(jsonb_agg(item ORDER BY ord), '[]'::jsonb) FROM jsonb_array_elements(${eventReceipts.stages} || ${stages}::jsonb) WITH ORDINALITY AS entries(item, ord) WHERE ord > jsonb_array_length(${eventReceipts.stages} || ${stages}::jsonb) - 20)`,
      updatedAt: now,
      ...(patch?.eventKey !== undefined ? { eventKey: bounded(patch.eventKey) } : {}),
      ...(patch?.eventId !== undefined ? { eventId: bounded(patch.eventId) } : {}),
      ...(patch?.subscriptions !== undefined ? { subscriptions: sanitizeReceiptSubscriptions(patch.subscriptions) } : {}),
    }).where(eq(eventReceipts.id, receiptId));
  } catch { console.warn("[event-receipts] write unavailable"); }
}
