import { and, eq, inArray } from 'drizzle-orm';
import type { Env } from '../env.js';
import { getDb } from '../lib/drizzle.js';
import { workflowSpawnedSessions } from '../lib/schema/workflow-spawned-sessions.js';
import { workflowExecutions } from '../lib/schema/workflows.js';
import { terminateSessionUnchecked } from '../services/sessions.js';

export type WorkflowSpawnedSessionTerminationReason =
  | 'workflow_completed'
  | 'workflow_failed'
  | 'workflow_cancelled';

export interface TerminateWorkflowSpawnedSessionsInput {
  executionId: string;
  reason: WorkflowSpawnedSessionTerminationReason;
}

export interface TerminateWorkflowSpawnedSessionsResult {
  attempted: number;
  terminated: number;
  failed: Array<{ sessionId: string; error: string }>;
}

type TerminalWorkflowStatus = 'completed' | 'failed' | 'cancelled';

export function workflowSessionTerminationReason(status: TerminalWorkflowStatus): WorkflowSpawnedSessionTerminationReason {
  switch (status) {
    case 'completed': return 'workflow_completed';
    case 'failed': return 'workflow_failed';
    case 'cancelled': return 'workflow_cancelled';
  }
}

/**
 * Terminates sessions spawned by workflow `session` nodes for one
 * execution and removes only the rows that were successfully handled.
 * Leaving failed rows in place gives the scheduled terminal-session
 * sweep a durable retry list.
 */
export async function terminateWorkflowSpawnedSessions(
  env: Env,
  input: TerminateWorkflowSpawnedSessionsInput,
): Promise<TerminateWorkflowSpawnedSessionsResult> {
  if (!env.DB) return { attempted: 0, terminated: 0, failed: [] };

  const db = getDb(env.DB);
  const spawnedRows = await db.select({ sessionId: workflowSpawnedSessions.sessionId })
    .from(workflowSpawnedSessions)
    .where(eq(workflowSpawnedSessions.executionId, input.executionId))
    .all();

  let terminated = 0;
  const failed: TerminateWorkflowSpawnedSessionsResult['failed'] = [];

  for (const row of spawnedRows) {
    try {
      await terminateSessionUnchecked(env, row.sessionId, input.reason);
      await db.delete(workflowSpawnedSessions)
        .where(and(
          eq(workflowSpawnedSessions.executionId, input.executionId),
          eq(workflowSpawnedSessions.sessionId, row.sessionId),
        ))
        .run();
      terminated += 1;
    } catch (err) {
      failed.push({
        sessionId: row.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { attempted: spawnedRows.length, terminated, failed };
}

export interface SweepTerminalSpawnedSessionsResult extends TerminateWorkflowSpawnedSessionsResult {
  executions: number;
}

/**
 * Retry cleanup for sessions that belong to already-terminal workflow
 * executions. This covers completed/failed executions whose immediate
 * best-effort cleanup failed after the execution row was finalized.
 */
export async function sweepTerminalSpawnedSessions(
  env: Env,
  options: { limit?: number } = {},
): Promise<SweepTerminalSpawnedSessionsResult> {
  if (!env.DB) return { executions: 0, attempted: 0, terminated: 0, failed: [] };

  const db = getDb(env.DB);
  const rows = await db.select({
    executionId: workflowSpawnedSessions.executionId,
    executionStatus: workflowExecutions.status,
  })
    .from(workflowSpawnedSessions)
    .innerJoin(workflowExecutions, eq(workflowSpawnedSessions.executionId, workflowExecutions.id))
    .where(inArray(workflowExecutions.status, ['completed', 'failed', 'cancelled']))
    .limit(options.limit ?? 500)
    .all();

  const executions = new Map<string, TerminalWorkflowStatus>();
  for (const row of rows) {
    if (isTerminalWorkflowStatus(row.executionStatus)) {
      executions.set(row.executionId, row.executionStatus);
    }
  }

  let attempted = 0;
  let terminated = 0;
  const failed: SweepTerminalSpawnedSessionsResult['failed'] = [];

  for (const [executionId, status] of executions) {
    const result = await terminateWorkflowSpawnedSessions(env, {
      executionId,
      reason: workflowSessionTerminationReason(status),
    });
    attempted += result.attempted;
    terminated += result.terminated;
    failed.push(...result.failed);
  }

  return { executions: executions.size, attempted, terminated, failed };
}

function isTerminalWorkflowStatus(status: string): status is TerminalWorkflowStatus {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}
