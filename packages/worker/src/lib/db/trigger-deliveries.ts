import { and, desc, eq, lt } from 'drizzle-orm';
import type { AppDb } from '../drizzle.js';
import { triggerDeliveries, triggers } from '../schema/index.js';

export type TriggerDeliveryOutcome =
  | 'matched'
  | 'no_match'
  | 'concurrency_cap'
  | 'workflow_deleted'
  | 'duplicate'
  | 'error';

export interface RecordTriggerDeliveryParams {
  triggerId: string;
  userId: string;
  eventType: string | null;
  deliveryId: string | null;
  outcome: TriggerDeliveryOutcome;
  executionId?: string | null;
  reason?: string | null;
  payloadPreview?: string | null;
}

// Matched deliveries are the ones users actually inspect to debug what their
// workflow saw; keep a generous 8KB slice. Non-matched outcomes (no_match,
// concurrency_cap, workflow_deleted, duplicate, error) are dominated by
// fan-out noise — every webhook fans out across every github trigger the
// user owns and records a no_match row per non-matching trigger — so cap
// those at 512B to keep row size (and D1 write amplification) bounded.
export const PAYLOAD_PREVIEW_MAX_MATCHED = 8192;
export const PAYLOAD_PREVIEW_MAX_NON_MATCHED = 512;

export function truncatePayloadPreview(
  payload: unknown,
  outcome: TriggerDeliveryOutcome,
): string | null {
  if (payload === undefined || payload === null) return null;
  try {
    const json = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const cap = outcome === 'matched' ? PAYLOAD_PREVIEW_MAX_MATCHED : PAYLOAD_PREVIEW_MAX_NON_MATCHED;
    return json.slice(0, cap);
  } catch {
    return null;
  }
}

export async function recordTriggerDelivery(
  db: AppDb,
  params: RecordTriggerDeliveryParams,
): Promise<void> {
  await db.insert(triggerDeliveries).values({
    id: crypto.randomUUID(),
    triggerId: params.triggerId,
    userId: params.userId,
    eventType: params.eventType,
    deliveryId: params.deliveryId,
    outcome: params.outcome,
    executionId: params.executionId ?? null,
    reason: params.reason ?? null,
    payloadPreview: params.payloadPreview ?? null,
  });
}

/**
 * Bulk-insert delivery rows in a single D1 batch. The github webhook
 * dispatcher fans out across every github trigger the user owns and would
 * otherwise issue one round-trip per no-match row; batching collapses that
 * to a single round-trip.
 */
export async function recordTriggerDeliveriesBulk(
  db: D1Database,
  rows: RecordTriggerDeliveryParams[],
): Promise<void> {
  if (rows.length === 0) return;
  const stmts = rows.map((row) =>
    db.prepare(
      `INSERT INTO trigger_deliveries
         (id, trigger_id, user_id, event_type, delivery_id, outcome, execution_id, reason, payload_preview)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      row.triggerId,
      row.userId,
      row.eventType,
      row.deliveryId,
      row.outcome,
      row.executionId ?? null,
      row.reason ?? null,
      row.payloadPreview ?? null,
    ),
  );
  await db.batch(stmts);
}

/**
 * Look up a single delivery row by trigger + delivery id. Used by the
 * test-fire endpoint to surface the outcome/executionId that the shared
 * dispatcher just recorded.
 */
export async function findDeliveryByDeliveryId(
  db: AppDb,
  triggerId: string,
  deliveryId: string,
): Promise<{
  outcome: TriggerDeliveryOutcome;
  executionId: string | null;
  reason: string | null;
} | null> {
  const row = await db
    .select({
      outcome: triggerDeliveries.outcome,
      executionId: triggerDeliveries.executionId,
      reason: triggerDeliveries.reason,
    })
    .from(triggerDeliveries)
    .where(and(eq(triggerDeliveries.triggerId, triggerId), eq(triggerDeliveries.deliveryId, deliveryId)))
    .orderBy(desc(triggerDeliveries.receivedAt))
    .limit(1)
    .get();
  if (!row) return null;
  return {
    outcome: row.outcome as TriggerDeliveryOutcome,
    executionId: row.executionId,
    reason: row.reason,
  };
}

export interface TriggerDeliveryRow {
  id: string;
  triggerId: string;
  eventType: string | null;
  deliveryId: string | null;
  outcome: TriggerDeliveryOutcome;
  executionId: string | null;
  reason: string | null;
  payloadPreview: string | null;
  receivedAt: string;
}

/**
 * List recent deliveries for a trigger. Authorization is enforced by joining
 * the parent trigger row to the requesting user — admins bypass via the
 * `bypassUserCheck` flag.
 */
export async function listTriggerDeliveries(
  db: AppDb,
  params: {
    triggerId: string;
    userId: string;
    bypassUserCheck?: boolean;
    limit: number;
    before?: string;
  },
): Promise<{ deliveries: TriggerDeliveryRow[]; hasMore: boolean }> {
  // Verify ownership unless caller is admin. Cheaper than joining on every page.
  const ownerRow = await db
    .select({ userId: triggers.userId })
    .from(triggers)
    .where(eq(triggers.id, params.triggerId))
    .get();

  if (!ownerRow) return { deliveries: [], hasMore: false };
  if (!params.bypassUserCheck && ownerRow.userId !== params.userId) {
    return { deliveries: [], hasMore: false };
  }

  const fetchLimit = params.limit + 1;
  const whereExpr = params.before
    ? and(eq(triggerDeliveries.triggerId, params.triggerId), lt(triggerDeliveries.receivedAt, params.before))
    : eq(triggerDeliveries.triggerId, params.triggerId);

  const rows = await db
    .select({
      id: triggerDeliveries.id,
      triggerId: triggerDeliveries.triggerId,
      eventType: triggerDeliveries.eventType,
      deliveryId: triggerDeliveries.deliveryId,
      outcome: triggerDeliveries.outcome,
      executionId: triggerDeliveries.executionId,
      reason: triggerDeliveries.reason,
      payloadPreview: triggerDeliveries.payloadPreview,
      receivedAt: triggerDeliveries.receivedAt,
    })
    .from(triggerDeliveries)
    .where(whereExpr)
    .orderBy(desc(triggerDeliveries.receivedAt))
    .limit(fetchLimit);

  const hasMore = rows.length > params.limit;
  const trimmed = hasMore ? rows.slice(0, params.limit) : rows;

  return {
    deliveries: trimmed.map((r) => ({
      id: r.id,
      triggerId: r.triggerId,
      eventType: r.eventType,
      deliveryId: r.deliveryId,
      // Stored as plain TEXT; we cast through the union here since the CHECK
      // constraint guarantees the value at write time.
      outcome: r.outcome as TriggerDeliveryOutcome,
      executionId: r.executionId,
      reason: r.reason,
      payloadPreview: r.payloadPreview,
      receivedAt: r.receivedAt,
    })),
    hasMore,
  };
}
