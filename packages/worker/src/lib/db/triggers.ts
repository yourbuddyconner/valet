import type { D1Database } from '@cloudflare/workers-types';
import { eq, and, or } from 'drizzle-orm';
import type { AppDb } from '../drizzle.js';
import { triggers, workflows } from '../schema/index.js';

// ─── Pure Helpers ────────────────────────────────────────────────────────────

export interface GitHubTriggerFilter {
  branch?: string | string[];
  labels?: string[];
  actions?: string[];
}

export type TriggerConfig =
  | { type: 'webhook'; path: string; method?: string; secret?: string; headers?: Record<string, string> }
  | {
      type: 'schedule';
      cron: string;
      timezone?: string;
      target?: 'workflow' | 'orchestrator';
      prompt?: string;
      // Default variable values for workflow-target schedule fires; ignored for orchestrator target.
      variables?: Record<string, unknown>;
    }
  | { type: 'manual' }
  | { type: 'github'; repos: string[]; events: string[]; filter?: GitHubTriggerFilter };

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
  });
}

export async function getTriggerForUpdate(db: AppDb, userId: string, triggerId: string) {
  const row = await db
    .select({
      config: triggers.config,
      workflowId: triggers.workflowId,
    })
    .from(triggers)
    .where(and(eq(triggers.id, triggerId), eq(triggers.userId, userId)))
    .get();

  if (!row) return null;
  // Return with snake_case keys to match original raw-SQL shape
  return { config: row.config, workflow_id: row.workflowId } as { config: string; workflow_id: string | null };
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

export async function updateTriggerLastRun(db: AppDb, triggerId: string, now: string) {
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

export async function checkWebhookPathUniqueness(
  db: D1Database,
  userId: string,
  path: string,
  excludeId?: string
) {
  if (excludeId) {
    return db.prepare(`
      SELECT id FROM triggers
      WHERE user_id = ?
      AND type = 'webhook'
      AND json_extract(config, '$.path') = ?
      AND id != ?
    `).bind(userId, path, excludeId).first();
  }

  return db.prepare(`
    SELECT id FROM triggers
    WHERE user_id = ?
    AND type = 'webhook'
    AND json_extract(config, '$.path') = ?
  `).bind(userId, path).first();
}

export async function updateTrigger(
  db: D1Database,
  triggerId: string,
  setClauses: string[],
  values: unknown[]
) {
  await db.prepare(`
    UPDATE triggers SET ${setClauses.join(', ')} WHERE id = ?
  `).bind(...values).run();
}

export async function getTriggerForRun(db: D1Database, userId: string, triggerId: string) {
  return db.prepare(`
    SELECT t.*, w.id as wf_id, w.name as workflow_name, w.version as workflow_version, w.data as workflow_data
    FROM triggers t
    LEFT JOIN workflows w ON t.workflow_id = w.id
    WHERE t.id = ? AND t.user_id = ?
  `).bind(triggerId, userId).first<{
    id: string;
    type: 'webhook' | 'schedule' | 'manual' | 'github';
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

export async function getActiveScheduleTriggers(db: D1Database): Promise<{
  trigger_id: string;
  user_id: string;
  workflow_id: string | null;
  config: string;
  workflow_enabled: number | null;
  workflow_name: string | null;
  workflow_version: string | null;
  workflow_data: string | null;
}[]> {
  const result = await db.prepare(`
    SELECT
      t.id as trigger_id,
      t.user_id,
      t.workflow_id,
      t.config,
      w.enabled as workflow_enabled,
      w.name as workflow_name,
      w.version as workflow_version,
      w.data as workflow_data
    FROM triggers t
    LEFT JOIN workflows w ON t.workflow_id = w.id
    WHERE t.type = 'schedule'
      AND t.enabled = 1
  `).all();
  return (result.results || []) as any;
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
