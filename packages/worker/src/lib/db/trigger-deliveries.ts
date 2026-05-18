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

// 8KB cap for payload previews — large enough to debug, small enough that a
// flood of webhooks doesn't blow up the row size.
const MAX_PAYLOAD_PREVIEW_BYTES = 8192;

export function truncatePayloadPreview(payload: unknown): string | null {
  if (payload === undefined || payload === null) return null;
  try {
    const json = typeof payload === 'string' ? payload : JSON.stringify(payload);
    return json.slice(0, MAX_PAYLOAD_PREVIEW_BYTES);
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
