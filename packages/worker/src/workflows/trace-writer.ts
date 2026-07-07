/**
 * D1-backed implementation of the runtime's TraceWriter interface.
 *
 * Each call inserts one row into workflow_execution_nodes. Input and
 * error fields are bounded previews (8KB input / 4KB error), while
 * node outputs are persisted in full because they are often the
 * workflow artifact that downstream debugging depends on.
 *
 * Retention is set per execution mode:
 *   production → 30 days
 *   test       → 7 days
 *
 * The daily cron sweep (workflows/trace-retention.ts) deletes rows
 * past `expires_at`.
 */

import type { Env } from '../env.js';
import { getDb } from '../lib/drizzle.js';
import { workflowExecutionNodes } from '../lib/schema/workflow-execution-nodes.js';
import { workflowSpawnedSessions } from '../lib/schema/workflow-spawned-sessions.js';
import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import type { TraceTransition, TraceWriter } from './types.js';

const INPUT_PREVIEW_LIMIT = 8 * 1024;
const ERROR_LIMIT = 4 * 1024;

const PRODUCTION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const TEST_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface CreateTraceWriterOptions {
  env: Env;
  mode: 'production' | 'test';
}

/**
 * Build a TraceWriter that persists transitions into D1. Each writer
 * is per-execution; the `mode` argument controls retention.
 */
export function createD1TraceWriter(options: CreateTraceWriterOptions): TraceWriter {
  const retentionMs = options.mode === 'test' ? TEST_RETENTION_MS : PRODUCTION_RETENTION_MS;

  return {
    async recordTransition(row: TraceTransition): Promise<void> {
      const db = getDb(options.env.DB);
      const expiresAt = new Date(Date.now() + retentionMs).toISOString();
      // Deterministic id keyed by (executionId, nodeId, status, attempt).
      // Each transition is unique by these dimensions; using a stable
      // id means step.do retries can't double-insert the same trace
      // row. INSERT OR REPLACE handles the collision benignly.
      const attempt = row.retryAttempts ?? 0;
      // Encode the foreach iteration in the id so per-iteration trace
      // rows of the same body node don't collide on PK. Top-level nodes
      // omit the suffix to preserve the existing id format.
      const iterSuffix = typeof row.iterationIndex === 'number' ? `:i:${row.iterationIndex}` : '';
      const id = `${row.executionId}:${row.nodeId}${iterSuffix}:${row.status}:${attempt}`;

      const inputPreview = 'inputPreview' in row ? row.inputPreview : undefined;
      const inputJson = serializeWithTruncation(inputPreview, INPUT_PREVIEW_LIMIT);

      const output = 'output' in row ? row.output : undefined;
      const outputJson = serializeWithoutTruncation(output);

      const errorText = 'error' in row ? truncateString(row.error, ERROR_LIMIT) : null;
      const reasonText = 'reason' in row ? row.reason ?? null : null;

      // ON CONFLICT (id) DO UPDATE so a step.do retry that re-fires
      // recordTransition for the same (executionId, nodeId, status,
      // attempt) tuple is a benign overwrite rather than a duplicate.
      await db.insert(workflowExecutionNodes).values({
        id,
        executionId: row.executionId,
        nodeId: row.nodeId,
        nodeType: row.nodeType,
        status: row.status,
        inputPreview: inputJson?.text ?? null,
        inputTruncated: inputJson?.truncated ?? false,
        output: outputJson?.text ?? null,
        outputTruncated: outputJson?.truncated ?? false,
        error: errorText,
        reason: reasonText,
        retryAttempts: row.retryAttempts ?? 0,
        approvalId: row.approvalId ?? null,
        invocationId: row.invocationId ?? null,
        startedAt: 'startedAt' in row ? row.startedAt ?? null : null,
        completedAt: 'completedAt' in row ? row.completedAt ?? null : null,
        durationMs: 'durationMs' in row ? row.durationMs ?? null : null,
        expiresAt,
      }).onConflictDoUpdate({
        target: workflowExecutionNodes.id,
        set: {
          status: row.status,
          inputPreview: inputJson?.text ?? null,
          inputTruncated: inputJson?.truncated ?? false,
          output: outputJson?.text ?? null,
          outputTruncated: outputJson?.truncated ?? false,
          error: errorText,
          reason: reasonText,
          completedAt: 'completedAt' in row ? row.completedAt ?? null : null,
          durationMs: 'durationMs' in row ? row.durationMs ?? null : null,
          // COALESCE preserves correlation ids across status updates:
          // the executor surfaces invocationId/approvalId on the
          // completed/failed transition AFTER the running row was
          // inserted with NULLs. A naive `set` clause would clobber
          // a previously-set value with NULL on a later attempt.
          approvalId: sql`COALESCE(${workflowExecutionNodes.approvalId}, ${row.approvalId ?? null})`,
          invocationId: sql`COALESCE(${workflowExecutionNodes.invocationId}, ${row.invocationId ?? null})`,
          // MAX(retryAttempts) so a retry that succeeded never reports
          // a smaller attempt number than a previous failed attempt.
          retryAttempts: sql`MAX(${workflowExecutionNodes.retryAttempts}, ${row.retryAttempts ?? 0})`,
          // Refresh the retention deadline so the latest write
          // resets the expires-at clock.
          expiresAt,
        },
      }).run();
    },
  };
}

/**
 * Cron entry — delete rows past their expires_at. Safe to call from
 * the scheduled handler on any tick (no-ops when nothing expired).
 */
export async function sweepExpiredTraceRows(env: Env, options: { limit?: number; chunkSize?: number } = {}): Promise<{ deleted: number }> {
  const db = getDb(env.DB);
  const limit = options.limit ?? 5000;
  // D1's SQLite has SQLITE_LIMIT_VARIABLE_NUMBER ~100-1000 depending
  // on configuration. Chunk inArray() deletes well under that ceiling.
  const chunkSize = options.chunkSize ?? 100;
  const now = new Date().toISOString();

  // Select expired IDs (capped at `limit`) then delete by id so the
  // batch is bounded — an unbounded DELETE on a million-row backlog
  // would blow D1's statement budget.
  const expired = await db.select({ id: workflowExecutionNodes.id })
    .from(workflowExecutionNodes)
    .where(lt(workflowExecutionNodes.expiresAt, now))
    .limit(limit)
    .all();
  if (expired.length === 0) return { deleted: 0 };

  let deleted = 0;
  for (let i = 0; i < expired.length; i += chunkSize) {
    const ids = expired.slice(i, i + chunkSize).map((r) => r.id);
    await db.delete(workflowExecutionNodes)
      .where(inArray(workflowExecutionNodes.id, ids))
      .run();
    deleted += ids.length;
  }
  return { deleted };
}

/**
 * Cron entry — prune workflow_spawned_sessions rows past expires_at
 * after the terminal-session retry window has elapsed. This does not
 * terminate sessions; sweepTerminalSpawnedSessions owns retries.
 */
export async function sweepExpiredSpawnedSessions(env: Env, options: { limit?: number; chunkSize?: number } = {}): Promise<{ deleted: number }> {
  const db = getDb(env.DB);
  const limit = options.limit ?? 5000;
  const chunkSize = options.chunkSize ?? 100;
  const now = new Date().toISOString();

  const expired = await db.select({
    executionId: workflowSpawnedSessions.executionId,
    nodeId: workflowSpawnedSessions.nodeId,
    sessionId: workflowSpawnedSessions.sessionId,
  })
    .from(workflowSpawnedSessions)
    .where(lt(workflowSpawnedSessions.expiresAt, now))
    .limit(limit)
    .all();
  if (expired.length === 0) return { deleted: 0 };

  let deleted = 0;
  for (let i = 0; i < expired.length; i += chunkSize) {
    const chunk = expired.slice(i, i + chunkSize);
    // No composite-key inArray; iterate per-row since chunks are small.
    for (const row of chunk) {
      await db.delete(workflowSpawnedSessions)
        .where(and(
          eq(workflowSpawnedSessions.executionId, row.executionId),
          eq(workflowSpawnedSessions.nodeId, row.nodeId),
          eq(workflowSpawnedSessions.sessionId, row.sessionId),
        ))
        .run();
      deleted += 1;
    }
  }
  return { deleted };
}

// ─── Truncation helpers ─────────────────────────────────────────────────────

interface SerializedField {
  text: string;
  truncated: boolean;
}

function serializeWithTruncation(value: unknown, limit: number): SerializedField | null {
  if (value === undefined || value === null) return null;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text.length <= limit) return { text, truncated: false };
  return { text: text.slice(0, limit), truncated: true };
}

function serializeWithoutTruncation(value: unknown): SerializedField | null {
  if (value === undefined || value === null) return null;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return { text, truncated: false };
}

function truncateString(s: string | undefined | null, limit: number): string | null {
  if (s === undefined || s === null) return null;
  return s.length <= limit ? s : s.slice(0, limit);
}
