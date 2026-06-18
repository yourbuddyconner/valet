import type { D1Database } from '@cloudflare/workers-types';
import { eq, and, or } from 'drizzle-orm';
import type { AppDb } from '../drizzle.js';
import { triggers, workflows } from '../schema/index.js';

// ─── Pure Helpers ────────────────────────────────────────────────────────────

export type TriggerConfig =
  | {
      type: 'webhook';
      path: string;
      method?: string;
      secret?: string;
      headers?: Record<string, string>;
      // Per-trigger rate limit override (requests per 60s window).
      // Defaults to WEBHOOK_RATE_LIMIT_DEFAULT when unset.
      rateLimit?: number;
    }
  | {
      type: 'schedule';
      cron: string;
      timezone?: string;
      target?: 'workflow' | 'orchestrator';
      prompt?: string;
      // Static trigger payload for each scheduled workflow run. Validated
      // against the workflow trigger node's dataSchema before execution.
      triggerData?: Record<string, unknown>;
    }
  | { type: 'manual' };

// Default webhook rate limit (requests per 60s window per trigger).
// Schedule + manual triggers are exempt; webhook triggers carry an
// optional override in config.rateLimit.
export const WEBHOOK_RATE_LIMIT_DEFAULT = 60;

export function scheduleTarget(config: TriggerConfig): 'workflow' | 'orchestrator' {
  if (config.type !== 'schedule') return 'workflow';
  return config.target === 'orchestrator' ? 'orchestrator' : 'workflow';
}

export function requiresWorkflow(config: TriggerConfig): boolean {
  return config.type !== 'schedule' || scheduleTarget(config) === 'workflow';
}

export function deriveRepoFullName(repoUrl?: string, sourceRepoFullName?: string): string | undefined {
  const explicit = sourceRepoFullName?.trim();
  if (explicit) return explicit;

  const rawUrl = repoUrl?.trim();
  if (!rawUrl) return undefined;

  const match = rawUrl.match(/github\.com[/:]([^/]+\/[^/.]+)/i);
  return match?.[1] || undefined;
}

// ─── Data Access (Drizzle) ──────────────────────────────────────────────────

export async function createTrigger(
  db: AppDb,
  params: {
    id: string;
    userId: string;
    workflowId: string | null;
    name: string;
    enabled: boolean;
    type: string;
    config: string;
    variableMapping: string | null;
    now: string;
    // Server-generated webhook token (webhook triggers only). Shown to
    // the caller once at create time; never re-exposed via GET/PATCH.
    webhookToken?: string | null;
  }
) {
  await db.insert(triggers).values({
    id: params.id,
    userId: params.userId,
    workflowId: params.workflowId,
    name: params.name,
    enabled: params.enabled,
    type: params.type,
    config: params.config,
    variableMapping: params.variableMapping,
    createdAt: params.now,
    updatedAt: params.now,
    webhookToken: params.webhookToken ?? null,
  });
}

/**
 * Generate a 32-char hex token suitable for use as a webhook auth
 * token. Backed by crypto.randomUUID() so it works in Workers.
 */
export function generateWebhookToken(): string {
  return crypto.randomUUID().replaceAll('-', '');
}

export async function getTriggerForUpdate(db: AppDb, userId: string, triggerId: string) {
  const row = await db
    .select({
      type: triggers.type,
      config: triggers.config,
      workflowId: triggers.workflowId,
      webhookToken: triggers.webhookToken,
    })
    .from(triggers)
    .where(and(eq(triggers.id, triggerId), eq(triggers.userId, userId)))
    .get();

  if (!row) return null;
  // Return with snake_case keys to match original raw-SQL shape. type +
  // webhook_token are required by the PATCH route to detect transitions
  // INTO/OUT of webhook and mint/clear the auth token accordingly.
  return {
    type: row.type,
    config: row.config,
    workflow_id: row.workflowId,
    webhook_token: row.webhookToken,
  } as { type: string; config: string; workflow_id: string | null; webhook_token: string | null };
}

export async function deleteTrigger(db: AppDb, triggerId: string, userId: string) {
  return db
    .delete(triggers)
    .where(and(eq(triggers.id, triggerId), eq(triggers.userId, userId)));
}

export async function enableTrigger(db: AppDb, triggerId: string, userId: string, now: string) {
  return db
    .update(triggers)
    .set({ enabled: true, updatedAt: now })
    .where(and(eq(triggers.id, triggerId), eq(triggers.userId, userId)));
}

export async function disableTrigger(db: AppDb, triggerId: string, userId: string, now: string) {
  return db
    .update(triggers)
    .set({ enabled: false, updatedAt: now })
    .where(and(eq(triggers.id, triggerId), eq(triggers.userId, userId)));
}

/**
 * System-context only: updates a trigger's last_run_at after it has
 * already been resolved through a user-scoped read. Does NOT take
 * userId — callers must have already verified ownership. The name
 * is explicit so future call sites don't accidentally use it
 * directly from a route handler.
 */
export async function updateTriggerLastRunUnchecked(db: AppDb, triggerId: string, now: string) {
  await db
    .update(triggers)
    .set({ lastRunAt: now })
    .where(eq(triggers.id, triggerId));
}

export async function updateTriggerFull(
  db: AppDb,
  triggerId: string,
  userId: string,
  params: {
    workflowId: string | null;
    name: string;
    enabled: boolean;
    type: string;
    config: string;
    variableMapping: string | null;
    now: string;
  },
): Promise<void> {
  await db
    .update(triggers)
    .set({
      workflowId: params.workflowId,
      name: params.name,
      enabled: params.enabled,
      type: params.type,
      config: params.config,
      variableMapping: params.variableMapping,
      updatedAt: params.now,
    })
    .where(and(eq(triggers.id, triggerId), eq(triggers.userId, userId)));
}

// ─── Data Access (Raw SQL) ──────────────────────────────────────────────────

export async function listTriggers(db: D1Database, userId: string) {
  return db.prepare(`
    SELECT t.*, w.name as workflow_name
    FROM triggers t
    LEFT JOIN workflows w ON t.workflow_id = w.id
    WHERE t.user_id = ?
    ORDER BY t.created_at DESC
  `).bind(userId).all();
}

export async function getTrigger(db: D1Database, userId: string, triggerId: string) {
  return db.prepare(`
    SELECT t.*, w.name as workflow_name
    FROM triggers t
    LEFT JOIN workflows w ON t.workflow_id = w.id
    WHERE t.id = ? AND t.user_id = ?
  `).bind(triggerId, userId).first();
}

export async function findTriggerByName(
  db: D1Database,
  userId: string,
  name: string,
): Promise<Record<string, unknown> | null> {
  return db.prepare(`
    SELECT t.*, w.name as workflow_name
    FROM triggers t
    LEFT JOIN workflows w ON t.workflow_id = w.id
    WHERE t.user_id = ? AND LOWER(t.name) = LOWER(?)
  `).bind(userId, name).first<Record<string, unknown>>();
}

export async function upsertTriggerByName(
  db: AppDb,
  envDB: D1Database,
  userId: string,
  params: {
    name: string;
    type: string;
    config: string;
    enabled: boolean;
    workflowId: string | null;
    variableMapping: string | null;
    now: string;
  },
): Promise<{ triggerId: string; created: boolean }> {
  const existing = await findTriggerByName(envDB, userId, params.name);

  if (existing && typeof existing.id === 'string') {
    await updateTriggerFull(db, existing.id, userId, params);
    return { triggerId: existing.id, created: false };
  }

  const id = crypto.randomUUID();
  await createTrigger(db, {
    id,
    userId,
    workflowId: params.workflowId,
    name: params.name,
    enabled: params.enabled,
    type: params.type,
    config: params.config,
    variableMapping: params.variableMapping,
    now: params.now,
  });
  return { triggerId: id, created: true };
}

export async function getWorkflowForTrigger(db: AppDb, userId: string, workflowIdOrSlug: string) {
  return db
    .select({ id: workflows.id })
    .from(workflows)
    .where(and(or(eq(workflows.id, workflowIdOrSlug), eq(workflows.slug, workflowIdOrSlug)), eq(workflows.userId, userId)))
    .get();
}

/**
 * Webhook paths are GLOBALLY unique across tenants, not per-user.
 * The /webhooks/:path lookup (lib/db/webhooks.ts) has no user_id
 * filter and would resolve non-deterministically when two tenants
 * register the same path — so the registration check must enforce
 * uniqueness across ALL users. `excludeId` still lets PATCH skip the
 * row being edited.
 */
export async function checkWebhookPathUniqueness(
  db: D1Database,
  path: string,
  excludeId?: string
) {
  if (excludeId) {
    return db.prepare(`
      SELECT id FROM triggers
      WHERE type = 'webhook'
      AND json_extract(config, '$.path') = ?
      AND id != ?
    `).bind(path, excludeId).first();
  }

  return db.prepare(`
    SELECT id FROM triggers
    WHERE type = 'webhook'
    AND json_extract(config, '$.path') = ?
  `).bind(path).first();
}

export async function updateTrigger(
  db: D1Database,
  triggerId: string,
  userId: string,
  setClauses: string[],
  values: unknown[],
) {
  // Defense in depth — same rationale as updateWorkflow: WHERE user_id
  // refuses the write rather than silently overwriting another user's
  // trigger when a future caller forgets the route-level user-scope.
  await db.prepare(`
    UPDATE triggers SET ${setClauses.join(', ')} WHERE id = ? AND user_id = ?
  `).bind(...values, userId).run();
}

export async function getTriggerForRun(db: D1Database, userId: string, triggerId: string) {
  return db.prepare(`
    SELECT t.*, w.id as wf_id, w.name as workflow_name, w.version as workflow_version, w.data as workflow_data
    FROM triggers t
    LEFT JOIN workflows w ON t.workflow_id = w.id
    WHERE t.id = ? AND t.user_id = ?
  `).bind(triggerId, userId).first<{
    id: string;
    type: 'webhook' | 'schedule' | 'manual';
    config: string;
    wf_id: string | null;
    workflow_name: string | null;
    workflow_version: string | null;
    workflow_data: string | null;
    variable_mapping: string | null;
  }>();
}

export async function getWorkflowForManualRun(db: D1Database, userId: string, workflowIdOrSlug: string) {
  return db.prepare(`
    SELECT id, name, version, data FROM workflows WHERE (id = ? OR slug = ?) AND user_id = ?
  `).bind(workflowIdOrSlug, workflowIdOrSlug, userId).first<{
    id: string;
    name: string;
    version: string | null;
    data: string;
  }>();
}

// ─── Cron Dispatch Helpers ──────────────────────────────────────────────────

interface ActiveScheduleTriggerRow {
  trigger_id: string;
  user_id: string;
  workflow_id: string | null;
  config: string;
  last_run_at: string | null;
  workflow_enabled: number | null;
  workflow_name: string | null;
  workflow_version: string | null;
  workflow_data: string | null;
  published_version_id: string | null;
}

export async function getActiveScheduleTriggers(db: D1Database): Promise<ActiveScheduleTriggerRow[]> {
  // Filter at the SQL layer to:
  //   - skip workflow-targeted triggers whose workflow has no published
  //     version (the runtime would reject these anyway; filtering here
  //     prevents wasted dispatch attempts + concurrency-cap pollution)
  //   - keep orchestrator-targeted schedule triggers (workflow_id NULL)
  const result = await db.prepare(`
    SELECT
      t.id as trigger_id,
      t.user_id,
      t.workflow_id,
      t.config,
      t.last_run_at,
      w.enabled as workflow_enabled,
      w.name as workflow_name,
      w.version as workflow_version,
      w.data as workflow_data,
      w.published_version_id as published_version_id
    FROM triggers t
    LEFT JOIN workflows w ON t.workflow_id = w.id
    WHERE t.type = 'schedule'
      AND t.enabled = 1
      AND (
        t.workflow_id IS NULL
        OR (w.enabled = 1 AND w.published_version_id IS NOT NULL)
      )
  `).all<ActiveScheduleTriggerRow>();
  return result.results;
}

export async function insertScheduleTick(
  db: D1Database,
  triggerId: string,
  tickBucket: string,
): Promise<boolean> {
  const result = await db.prepare(`
    INSERT INTO workflow_schedule_ticks (id, trigger_id, tick_bucket)
    VALUES (?, ?, ?)
    ON CONFLICT(trigger_id, tick_bucket) DO NOTHING
  `).bind(crypto.randomUUID(), triggerId, tickBucket).run();
  return (result.meta?.changes ?? 0) > 0;
}

/**
 * Release a previously-claimed schedule tick. Best-effort: callers
 * invoke this when dispatch fails after the tick was inserted so the
 * catch-up pass can retry the same bucket. A delete failure here is
 * accepted (the bucket stays burned, which is safer than risking a
 * duplicate dispatch).
 */
export async function releaseScheduleTick(
  db: D1Database,
  triggerId: string,
  tickBucket: string,
): Promise<void> {
  try {
    await db.prepare(
      'DELETE FROM workflow_schedule_ticks WHERE trigger_id = ? AND tick_bucket = ?'
    ).bind(triggerId, tickBucket).run();
  } catch (err) {
    console.warn(
      `[schedule-tick] release failed for trigger=${triggerId} bucket=${tickBucket}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ─── Webhook auth + rate limit (0020) ───────────────────────────────────────

/**
 * Look up a webhook trigger by id (NOT path). Used by the new
 * /api/triggers/:triggerId/webhook route. Returns the joined workflow
 * columns the handler needs to build an execution.
 */
export async function getWebhookTriggerById(db: D1Database, triggerId: string) {
  return db.prepare(`
    SELECT t.*, w.id as workflow_id, w.name as workflow_name, w.user_id, w.version, w.data
    FROM triggers t
    JOIN workflows w ON t.workflow_id = w.id
    WHERE t.id = ?
      AND t.type = 'webhook'
      AND t.enabled = 1
      AND w.enabled = 1
  `).bind(triggerId).first<{
    id: string;
    workflow_id: string;
    workflow_name: string;
    user_id: string;
    version: string | null;
    data: string;
    config: string;
    variable_mapping: string | null;
    webhook_token: string | null;
  }>();
}

/**
 * Increment the per-trigger rate counter for the current minute bucket
 * and return the new count. Each request adds 1; the handler compares
 * the returned count against the trigger's limit and rejects with 429
 * if exceeded.
 *
 * windowStartTs is a unix seconds timestamp truncated to a minute
 * boundary so all requests in the same minute share a bucket.
 *
 * Two round-trips (UPSERT then SELECT) — D1's behavior around RETURNING
 * has been inconsistent across releases so we read the new count back
 * explicitly to match the pattern used elsewhere (see threads.ts).
 */
export async function bumpWebhookRateCount(
  db: D1Database,
  triggerId: string,
  windowStartTs: number,
): Promise<number> {
  await db.prepare(`
    INSERT INTO trigger_webhook_rate (trigger_id, window_start_ts, count)
    VALUES (?, ?, 1)
    ON CONFLICT(trigger_id, window_start_ts)
    DO UPDATE SET count = count + 1
  `).bind(triggerId, windowStartTs).run();
  const row = await db.prepare(`
    SELECT count FROM trigger_webhook_rate
    WHERE trigger_id = ? AND window_start_ts = ?
  `).bind(triggerId, windowStartTs).first<{ count: number }>();
  return row?.count ?? 1;
}
