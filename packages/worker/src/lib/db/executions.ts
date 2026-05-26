import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import { eq, and, sql, inArray } from 'drizzle-orm';
import type { AppDb } from '../drizzle.js';
import { workflowExecutions, workflowExecutionSteps } from '../schema/index.js';

// ─── Pure Helpers ────────────────────────────────────────────────────────────

export function parseNullableJson(raw: string | null): unknown | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function buildWorkflowStepOrderMap(workflowSnapshotRaw: string | null): Map<string, number> {
  if (!workflowSnapshotRaw) return new Map();

  let parsed: unknown;
  try {
    parsed = JSON.parse(workflowSnapshotRaw);
  } catch {
    return new Map();
  }

  const order = new Map<string, number>();
  let index = 0;

  const visitStepList = (rawSteps: unknown): void => {
    if (!Array.isArray(rawSteps)) return;

    for (const entry of rawSteps) {
      if (!isRecord(entry)) continue;

      const stepId = typeof entry.id === 'string' ? entry.id : '';
      if (stepId && !order.has(stepId)) {
        order.set(stepId, index);
        index += 1;
      }

      visitStepList(entry.then);
      visitStepList(entry.else);
      visitStepList(entry.steps);
    }
  };

  if (isRecord(parsed)) {
    visitStepList(parsed.steps);
  } else if (Array.isArray(parsed)) {
    visitStepList(parsed);
  }

  return order;
}

export function rankStepOrderIndex(value: number | null): number {
  return value ?? Number.MAX_SAFE_INTEGER;
}

// ─── Data Access ─────────────────────────────────────────────────────────────

export async function listExecutions(
  db: D1Database,
  userId: string,
  opts: { limit?: number; offset?: number; status?: string; workflowId?: string; includeTest?: boolean } = {}
) {
  // Dynamic WHERE + LEFT JOIN — keep as raw SQL
  let query = `
    SELECT e.*, w.name as workflow_name
    FROM workflow_executions e
    LEFT JOIN workflows w ON e.workflow_id = w.id
    WHERE e.user_id = ?
  `;
  const params: unknown[] = [userId];

  if (opts.status) {
    query += ' AND e.status = ?';
    params.push(opts.status);
  }

  if (opts.workflowId) {
    query += ' AND e.workflow_id = ?';
    params.push(opts.workflowId);
  }

  // Exclude ephemeral test/dry runs from the default list view.
  if (!opts.includeTest) {
    query += " AND e.trigger_type != 'test'";
  }

  query += ' ORDER BY e.started_at DESC LIMIT ? OFFSET ?';
  params.push(opts.limit ?? 50);
  params.push(opts.offset ?? 0);

  return db.prepare(query).bind(...params).all();
}

export async function getExecution(db: D1Database, executionId: string, userId: string) {
  // Multi-table LEFT JOIN — keep as raw SQL
  return db.prepare(`
    SELECT e.*, w.name as workflow_name, t.name as trigger_name
    FROM workflow_executions e
    LEFT JOIN workflows w ON e.workflow_id = w.id
    LEFT JOIN triggers t ON e.trigger_id = t.id
    WHERE e.id = ? AND e.user_id = ?
  `).bind(executionId, userId).first();
}

export async function getExecutionWithWorkflowName(
  db: D1Database,
  executionId: string,
) {
  // trigger_type / trigger_name / workflow_snapshot are read by the result handler
  // to decide whether to auto-notify the orchestrator on failure.
  return db.prepare(`
    SELECT e.id, e.user_id, e.workflow_id, e.session_id,
           e.trigger_type, e.workflow_snapshot,
           w.name AS workflow_name,
           t.name AS trigger_name
    FROM workflow_executions e
    LEFT JOIN workflows w ON w.id = e.workflow_id
    LEFT JOIN triggers t ON t.id = e.trigger_id
    WHERE e.id = ?
    LIMIT 1
  `).bind(executionId).first<{
    id: string;
    user_id: string;
    workflow_id: string | null;
    session_id: string | null;
    trigger_type: string | null;
    trigger_name: string | null;
    workflow_snapshot: string | null;
    workflow_name: string | null;
  }>();
}

export async function getExecutionForAuth(db: AppDb, executionId: string) {
  return db
    .select({
      id: workflowExecutions.id,
      user_id: workflowExecutions.userId,
      workflow_snapshot: workflowExecutions.workflowSnapshot,
    })
    .from(workflowExecutions)
    .where(eq(workflowExecutions.id, executionId))
    .get();
}

export async function getExecutionSteps(db: D1Database, executionId: string) {
  // rowid — keep as raw SQL
  return db.prepare(`
    SELECT rowid AS insertion_order,
           id, execution_id, step_id, attempt, iteration_path, status, input_json, output_json, error, started_at, completed_at, created_at
    FROM workflow_execution_steps
    WHERE execution_id = ?
    ORDER BY
      attempt ASC,
      insertion_order ASC
  `).bind(executionId).all();
}

export async function getExecutionOwnerAndStatus(db: AppDb, executionId: string) {
  return db
    .select({ user_id: workflowExecutions.userId, status: workflowExecutions.status })
    .from(workflowExecutions)
    .where(eq(workflowExecutions.id, executionId))
    .get();
}

export async function completeExecution(
  db: AppDb,
  executionId: string,
  params: {
    status: string;
    outputs: string | null;
    steps: string | null;
    error: string | null;
    completedAt: string;
  }
) {
  await db
    .update(workflowExecutions)
    .set({
      status: params.status,
      outputs: params.outputs,
      steps: params.steps,
      error: params.error,
      completedAt: params.completedAt,
    })
    .where(eq(workflowExecutions.id, executionId));
}

export async function upsertExecutionStep(
  db: D1Database,
  executionId: string,
  step: {
    stepId: string;
    attempt: number;
    // Required — '' for top-level, e.g. 'L1:i0' for first iteration of loop L1.
    // Defaulting was a footgun: any missed caller would silently collapse loop
    // iterations into a single row. See docs/specs/2026-05-23-workflow-ui-design.md.
    iterationPath: string;
    status: string;
    input: string | null;
    output: string | null;
    error: string | null;
    startedAt: string | null;
    completedAt: string | null;
  }
) {
  // ON CONFLICT with COALESCE — keep as raw SQL
  await db.prepare(`
    INSERT INTO workflow_execution_steps
      (id, execution_id, step_id, attempt, iteration_path, status, input_json, output_json, error, started_at, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(execution_id, step_id, attempt, iteration_path) DO UPDATE SET
      status = excluded.status,
      input_json = COALESCE(excluded.input_json, workflow_execution_steps.input_json),
      output_json = COALESCE(excluded.output_json, workflow_execution_steps.output_json),
      error = COALESCE(excluded.error, workflow_execution_steps.error),
      started_at = COALESCE(excluded.started_at, workflow_execution_steps.started_at),
      completed_at = COALESCE(excluded.completed_at, workflow_execution_steps.completed_at)
  `).bind(
    crypto.randomUUID(),
    executionId,
    step.stepId,
    step.attempt,
    step.iterationPath,
    step.status,
    step.input,
    step.output,
    step.error,
    step.startedAt,
    step.completedAt,
  ).run();
}

export async function updateExecutionStatus(db: AppDb, executionId: string, status: string) {
  await db
    .update(workflowExecutions)
    .set({ status })
    .where(eq(workflowExecutions.id, executionId));
}

export async function createExecution(
  db: D1Database,
  params: {
    id: string;
    // Nullable for test/dry runs (no persisted workflow row).
    workflowId: string | null;
    userId: string;
    triggerId: string | null;
    triggerType: string;
    triggerMetadata: string;
    variables: string;
    now: string;
    workflowVersion: string | null;
    workflowHash: string;
    workflowSnapshot: string;
    idempotencyKey: string;
    sessionId: string;
    initiatorType: string;
    initiatorUserId: string;
  }
) {
  await db.prepare(`
    INSERT INTO workflow_executions
      (id, workflow_id, user_id, trigger_id, status, trigger_type, trigger_metadata, variables, started_at,
       workflow_version, workflow_hash, workflow_snapshot, idempotency_key, session_id, initiator_type, initiator_user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    params.id,
    params.workflowId,
    params.userId,
    params.triggerId,
    'pending',
    params.triggerType,
    params.triggerMetadata,
    params.variables,
    params.now,
    params.workflowVersion,
    params.workflowHash,
    params.workflowSnapshot,
    params.idempotencyKey,
    params.sessionId,
    params.initiatorType,
    params.initiatorUserId
  ).run();
}

/**
 * D1 surfaces SQLite UNIQUE constraint violations as `Error` with a message
 * containing "UNIQUE constraint failed". We sniff the message rather than
 * depending on a typed error class because the wrangler runtime and the
 * deployed runtime emit slightly different shapes; the substring is stable.
 */
export function isUniqueConstraintError(err: unknown): boolean {
  if (err instanceof Error) {
    return err.message.includes('UNIQUE constraint failed')
      || err.message.includes('SQLITE_CONSTRAINT_UNIQUE');
  }
  if (typeof err === 'object' && err !== null && 'message' in err) {
    const msg = (err as { message: unknown }).message;
    if (typeof msg === 'string') {
      return msg.includes('UNIQUE constraint failed')
        || msg.includes('SQLITE_CONSTRAINT_UNIQUE');
    }
  }
  return false;
}

export async function checkIdempotencyKey(db: D1Database, workflowId: string, idempotencyKey: string) {
  return db.prepare(`
    SELECT id, status, session_id
    FROM workflow_executions
    WHERE workflow_id = ? AND idempotency_key = ?
    LIMIT 1
  `).bind(workflowId, idempotencyKey).first();
}

// ─── Concurrency (from workflow-runtime.ts) ──────────────────────────────────

export async function countActiveExecutions(db: AppDb, userId: string): Promise<number> {
  const row = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(workflowExecutions)
    .where(and(
      eq(workflowExecutions.userId, userId),
      inArray(workflowExecutions.status, ['pending', 'running', 'waiting_approval']),
    ))
    .get();
  return row?.count ?? 0;
}

export async function countActiveExecutionsGlobal(db: AppDb): Promise<number> {
  const row = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(workflowExecutions)
    .where(inArray(workflowExecutions.status, ['pending', 'running', 'waiting_approval']))
    .get();
  return row?.count ?? 0;
}

// ─── WorkflowExecutorDO / SessionAgentDO Helpers ─────────────────────────────

export interface ExecutionWithWorkflowRow {
  id: string;
  status: string;
  resume_token: string | null;
  runtime_state: string | null;
  session_id: string | null;
  workflow_hash: string | null;
  variables: string | null;
  // Persisted JSON map of `outputVariable` -> step output from the pre-pause
  // portion of the run. Surfaced to the engine on resume so post-approval
  // steps can interpolate values produced before the pause.
  outputs: string | null;
  trigger_metadata: string | null;
  attempt_count: number | null;
  idempotency_key: string | null;
  user_id: string;
  // Nullable: test/dry-run executions have no persisted workflow row; the snapshot
  // in `workflow_data` is sufficient for the executor.
  workflow_id: string | null;
  workflow_data: string | null;
}

export async function getExecutionWithWorkflow(
  db: D1Database,
  executionId: string,
): Promise<ExecutionWithWorkflowRow | null> {
  // COALESCE + LEFT JOIN — keep as raw SQL
  return db.prepare(`
    SELECT
      e.id,
      e.status,
      e.resume_token,
      e.runtime_state,
      e.session_id,
      e.workflow_hash,
      e.variables,
      e.outputs,
      e.trigger_metadata,
      e.attempt_count,
      e.idempotency_key,
      e.user_id,
      e.workflow_id,
      COALESCE(e.workflow_snapshot, w.data) AS workflow_data
    FROM workflow_executions e
    LEFT JOIN workflows w ON w.id = e.workflow_id
    WHERE e.id = ?
    LIMIT 1
  `).bind(executionId).first<ExecutionWithWorkflowRow>();
}

export async function updateExecutionRuntimeState(
  db: AppDb,
  executionId: string,
  runtimeState: string,
  status: string,
): Promise<void> {
  await db
    .update(workflowExecutions)
    .set({ runtimeState, status })
    .where(eq(workflowExecutions.id, executionId));
}

export async function resumeExecution(
  db: AppDb,
  executionId: string,
  runtimeState: string,
): Promise<void> {
  await db
    .update(workflowExecutions)
    .set({ status: 'running', resumeToken: null, runtimeState, error: null })
    .where(eq(workflowExecutions.id, executionId));
}

export async function cancelExecutionWithReason(
  db: AppDb,
  executionId: string,
  params: { runtimeState: string; reason: string; completedAt: string },
): Promise<void> {
  await db
    .update(workflowExecutions)
    .set({
      status: 'cancelled',
      resumeToken: null,
      runtimeState: params.runtimeState,
      error: params.reason,
      completedAt: params.completedAt,
    })
    .where(eq(workflowExecutions.id, executionId));
}

export async function completeExecutionFull(
  db: AppDb,
  executionId: string,
  params: {
    status: string;
    outputs?: string | null;
    steps?: string | null;
    error?: string | null;
    resumeToken?: string | null;
    completedAt?: string | null;
  },
): Promise<void> {
  await db
    .update(workflowExecutions)
    .set({
      status: params.status,
      outputs: params.outputs ?? null,
      steps: params.steps ?? null,
      error: params.error ?? null,
      resumeToken: params.resumeToken ?? null,
      completedAt: params.completedAt ?? null,
    })
    .where(eq(workflowExecutions.id, executionId));
}

// ─── Cron Reconciliation Helpers ────────────────────────────────────────────

export async function getTimedOutApprovals(
  db: D1Database,
  cutoff: string,
): Promise<{ id: string; user_id: string }[]> {
  // Join pending_approvals so we filter on the approval's own deadline (timeout_at)
  // rather than the execution's start time. Previously this used e.started_at,
  // which timed out long-running executions even if no approval was overdue.
  // DISTINCT because a single execution may have multiple historical approval
  // rows; we only want one (id, user_id) per execution to escalate.
  const result = await db.prepare(`
    SELECT DISTINCT e.id, e.user_id
    FROM workflow_executions e
    JOIN pending_approvals pa ON pa.execution_id = e.id
    WHERE e.status = 'waiting_approval'
      AND pa.status = 'pending'
      AND pa.timeout_at IS NOT NULL
      AND pa.timeout_at <= ?
  `).bind(cutoff).all<{ id: string; user_id: string }>();
  return result.results || [];
}

export async function finalizeExecution(
  db: AppDb,
  executionId: string,
  params: {
    status: string;
    error?: string | null;
    outputs?: string | null;
    steps?: string | null;
    resumeToken?: string | null;
    completedAt: string | null;
  },
): Promise<void> {
  await db
    .update(workflowExecutions)
    .set({
      status: params.status,
      error: params.error ?? null,
      outputs: params.outputs ?? null,
      steps: params.steps ?? null,
      resumeToken: params.resumeToken !== undefined ? params.resumeToken ?? null : undefined,
      completedAt: params.completedAt,
    })
    .where(eq(workflowExecutions.id, executionId));
}

export interface StuckRunningExecutionRow {
  id: string;
  userId: string;
  workflowId: string | null;
}

/**
 * Mark executions stuck in `running` for >2h as failed. Catches cases where
 * the result handler never fires (sandbox crashed mid-turn, runner WS dropped
 * after enqueue) and the existing session-status reconcile sweep doesn't
 * notice because the session is still technically alive. Returns the rows
 * that were swept so the caller can log/notify.
 */
export async function sweepStuckRunningExecutions(
  db: AppDb,
): Promise<StuckRunningExecutionRow[]> {
  const stuck = await db
    .select({
      id: workflowExecutions.id,
      userId: workflowExecutions.userId,
      workflowId: workflowExecutions.workflowId,
    })
    .from(workflowExecutions)
    .where(and(
      eq(workflowExecutions.status, 'running'),
      sql`${workflowExecutions.startedAt} < datetime('now', '-2 hours')`,
    ))
    .all();

  for (const row of stuck) {
    await db
      .update(workflowExecutions)
      .set({
        status: 'failed',
        error: 'Stuck running >2h, swept by cron',
        completedAt: sql`datetime('now')`,
      })
      .where(eq(workflowExecutions.id, row.id));
  }

  return stuck.map((row: { id: string; userId: string; workflowId: string | null }) => ({
    id: row.id,
    userId: row.userId,
    workflowId: row.workflowId,
  }));
}

export interface StaleWorkflowExecutionRow {
  id: string;
  user_id: string;
  status: string;
  runtime_state: string | null;
  session_id: string | null;
  workflow_id: string | null;
  workflow_name: string | null;
  session_status: string;
}

export async function getStaleWorkflowExecutions(
  db: D1Database,
): Promise<StaleWorkflowExecutionRow[]> {
  const result = await db.prepare(`
    SELECT
      e.id,
      e.user_id,
      e.status,
      e.runtime_state,
      e.session_id,
      e.workflow_id,
      w.name AS workflow_name,
      s.status AS session_status
    FROM workflow_executions e
    LEFT JOIN workflows w ON w.id = e.workflow_id
    JOIN sessions s ON s.id = e.session_id
    WHERE e.status IN ('pending', 'running', 'waiting_approval')
      AND COALESCE(s.purpose, 'interactive') = 'workflow'
      AND s.status IN ('terminated', 'error', 'hibernated')
  `).all<StaleWorkflowExecutionRow>();
  return result.results ?? [];
}

export interface StepTraceEntry {
  stepId: string;
  status: string;
  attempt?: number;
  startedAt?: string;
  completedAt?: string;
  input?: unknown;
  output?: unknown;
  error?: string;
}

function buildPersistStepStatement(
  db: D1Database,
  executionId: string,
  step: StepTraceEntry,
): D1PreparedStatement {
  const attempt = step.attempt && step.attempt > 0 ? step.attempt : 1;
  return db.prepare(`
    INSERT INTO workflow_execution_steps
      (id, execution_id, step_id, attempt, status, input_json, output_json, error, started_at, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(execution_id, step_id, attempt) DO UPDATE SET
      status = excluded.status,
      input_json = COALESCE(excluded.input_json, workflow_execution_steps.input_json),
      output_json = COALESCE(excluded.output_json, workflow_execution_steps.output_json),
      error = excluded.error,
      started_at = COALESCE(excluded.started_at, workflow_execution_steps.started_at),
      completed_at = COALESCE(excluded.completed_at, workflow_execution_steps.completed_at)
  `).bind(
    crypto.randomUUID(),
    executionId,
    step.stepId,
    attempt,
    step.status,
    step.input !== undefined ? JSON.stringify(step.input) : null,
    step.output !== undefined ? JSON.stringify(step.output) : null,
    step.error || null,
    step.startedAt || null,
    step.completedAt || null,
  );
}

export async function persistStepTrace(
  db: D1Database,
  executionId: string,
  steps: Array<StepTraceEntry>,
): Promise<void> {
  // Single batched round-trip — long traces previously paid N D1 round-trips.
  if (steps.length === 0) return;
  const stmts = steps.map((step) => buildPersistStepStatement(db, executionId, step));
  await db.batch(stmts);
}

/**
 * Alias kept for callers that want to be explicit about the batched semantics.
 * Implementation is identical to persistStepTrace.
 */
export async function persistStepTraceBulk(
  db: D1Database,
  executionId: string,
  steps: Array<StepTraceEntry>,
): Promise<void> {
  return persistStepTrace(db, executionId, steps);
}

// ─── Retention ──────────────────────────────────────────────────────────────

/**
 * Deletes terminal workflow executions older than `olderThanDays`.
 *
 * Batched in chunks of 1000 because D1 enforces row-change limits per statement
 * and unbounded DELETEs can time out on busy workspaces. The `id IN (SELECT ...
 * LIMIT 1000)` pattern keeps each delete bounded so the loop converges.
 *
 * Note: `workflow_execution_steps.execution_id` is `ON DELETE CASCADE`, so
 * child step rows are removed automatically — no separate orphan sweep is
 * needed.
 */
export async function pruneOldExecutions(
  db: D1Database,
  olderThanDays = 90,
): Promise<number> {
  let totalDeleted = 0;
  let deleted: number;
  do {
    const result = await db.prepare(
      `DELETE FROM workflow_executions
       WHERE id IN (
         SELECT id FROM workflow_executions
         WHERE status IN ('completed', 'failed', 'cancelled')
           AND completed_at IS NOT NULL
           AND completed_at < datetime('now', '-' || ? || ' days')
         LIMIT 1000
       )`,
    ).bind(olderThanDays).run();
    deleted = result.meta.changes ?? 0;
    totalDeleted += deleted;
  } while (deleted >= 1000);
  return totalDeleted;
}
