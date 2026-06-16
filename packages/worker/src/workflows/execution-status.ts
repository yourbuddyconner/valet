/**
 * Persists workflow_executions row status transitions from inside a CF
 * Workflow. Every call goes through `step.do` so the write is cached
 * across replays — the cf runtime replays `run()` from the top on each
 * wake, and uncached writes would duplicate on every resume.
 *
 * Cancellation has its own path (workflows/cancel-cleanup.ts) that
 * compare-and-swaps on the current status. We do NOT want to overwrite a
 * `cancelling`/`cancelled` row back to `running`, so each transition
 * uses a guarded update that only applies when the row is in an
 * expected prior state.
 */

import type { WorkflowStep } from 'cloudflare:workers';
import { and, eq, inArray } from 'drizzle-orm';
import type { Env } from '../env.js';
import { getDb } from '../lib/drizzle.js';
import { workflowExecutions } from '../lib/schema/workflows.js';
import { ACTIVE_EXECUTION_STATUSES } from '../lib/db/constants.js';

export type ExecutionStatus =
  | 'running'
  | 'waiting_approval'
  | 'waiting_time'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface SetStatusInput {
  env: Env;
  step: WorkflowStep;
  executionId: string;
  status: ExecutionStatus;
  /** Deterministic step name suffix — must be unique per call site. */
  stepKey: string;
  /** Statuses we'll transition FROM. Used to no-op when cancelled.
   *  'cancelling' is allowed so the runtime can land 'cancelled' even if
   *  a concurrent cancel API call already moved the row past 'running'.
   */
  allowedPrior?: Array<typeof ACTIVE_EXECUTION_STATUSES[number] | 'cancelling'>;
  /** Set completed_at + final outputs when transitioning to a terminal state. */
  outputs?: unknown;
  error?: string;
}

/**
 * Returns true if the CAS landed (row was in an allowed prior status and
 * got updated), false if it no-op'd. Callers that need to fail-closed on
 * a parallel cancel (e.g. the pending→running entry into the wave loop)
 * should branch on this.
 *
 * When env.DB is unset (test stub), returns true unconditionally so the
 * wave loop runs without a real D1.
 */
export async function setExecutionStatus(input: SetStatusInput): Promise<boolean> {
  if (!input.env.DB) return true;
  const stepName = `execution-status:${input.executionId}:${input.stepKey}`;
  const allowedPrior = input.allowedPrior ?? [...ACTIVE_EXECUTION_STATUSES];
  // step.do caches the boolean so a replay sees the same first-attempt
  // outcome rather than re-issuing the UPDATE.
  return input.step.do(stepName, async (): Promise<boolean> => {
    const db = getDb(input.env.DB);
    const terminal = input.status === 'completed' || input.status === 'failed' || input.status === 'cancelled';
    const updates: Record<string, unknown> = { status: input.status };
    if (terminal) {
      updates.completedAt = new Date().toISOString();
      if (input.outputs !== undefined) updates.outputs = JSON.stringify(input.outputs);
      if (input.error !== undefined) updates.error = input.error;
    }
    await db.update(workflowExecutions)
      .set(updates)
      .where(and(
        eq(workflowExecutions.id, input.executionId),
        inArray(workflowExecutions.status, allowedPrior),
      ))
      .run();
    // D1's `.run()` doesn't report row counts portably across the
    // driver / better-sqlite3 boundary, so re-read instead to detect
    // a no-op CAS.
    const after = await db
      .select({ status: workflowExecutions.status })
      .from(workflowExecutions)
      .where(eq(workflowExecutions.id, input.executionId))
      .get();
    return after?.status === input.status;
  });
}

/**
 * Mid-loop cancel probe used by the wave loop between iterations.
 * Returns true if a parallel cancel API call (or the cron sweep) has
 * moved the row to `cancelling` or `cancelled` while the wave loop was
 * running. The result is cached behind step.do per iteration, so each
 * iteration's first observation of the row state is replay-stable.
 *
 * `iterStepKey` MUST be unique per iteration — pass the iteration
 * counter or another deterministic suffix.
 */
export async function readExecutionCancelState(
  env: Env,
  step: WorkflowStep,
  executionId: string,
  iterStepKey: string,
): Promise<{ cancelled: boolean; status: string | undefined }> {
  if (!env.DB) return { cancelled: false, status: undefined };
  return step.do(`execution-cancel-probe:${executionId}:${iterStepKey}`, async () => {
    const db = getDb(env.DB);
    const row = await db
      .select({ status: workflowExecutions.status })
      .from(workflowExecutions)
      .where(eq(workflowExecutions.id, executionId))
      .get();
    const status = row?.status;
    return { cancelled: status === 'cancelling' || status === 'cancelled', status };
  });
}
