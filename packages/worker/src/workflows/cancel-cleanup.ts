/**
 * Idempotent cancellation cleanup helper. Invoked synchronously by the
 * cancel API endpoint after `instance.terminate()` returns, and by the
 * cron safety sweep for any row stuck in `cancelling` for more than
 * 5 minutes.
 *
 * Pipeline:
 *   1. Move every pending workflow_approvals row for this execution
 *      to status='cancelled'.
 *   2. Terminate any sessions spawned by session nodes
 *      (best-effort via workflow_spawned_sessions; logged on failure).
 *   3. Drive non-terminal action_invocations rows to 'failed' so the
 *      audit chain reflects the cancel.
 *   4. Write 'skipped' trace rows in workflow_execution_nodes for
 *      nodes that weren't already terminal.
 *   5. Transition the execution row to 'cancelled' and set
 *      `cleanup_completed_at` — gated on every step above succeeding.
 *
 * Re-running on an already-cleaned (status='cancelled' AND
 * cleanup_completed_at non-null) row is a no-op.
 */

import { and, eq, inArray, lt, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Env } from '../env.js';
import { getDb } from '../lib/drizzle.js';
import { workflowExecutions } from '../lib/schema/workflows.js';
import { workflowExecutionNodes } from '../lib/schema/workflow-execution-nodes.js';
import {
  cancelPendingWorkflowApprovalsForExecution,
  listPendingWorkflowApprovalsForExecution,
  listStuckWorkflowApprovalsForResume,
} from '../lib/db/actions.js';
import { actionInvocations } from '../lib/schema/actions.js';
import {
  ACTIVE_EXECUTION_STATUSES,
  CLEANUP_CAS_PRIOR_STATUSES,
} from '../lib/db/constants.js';
import { terminateWorkflowSpawnedSessions } from './spawned-session-cleanup.js';

export interface RunCancellationCleanupInput {
  executionId: string;
  cancelledBy?: string;
}

export async function runCancellationCleanup(env: Env, input: RunCancellationCleanupInput): Promise<void> {
  const db = getDb(env.DB);

  // Read current state. The completion gate is `cleanup_completed_at`,
  // NOT `status === 'cancelled'`: the runtime can race the cancel API
  // and flip the row to 'cancelled' (allowed-prior includes
  // 'cancelling', see workflows/runtime.ts terminal CAS) BEFORE the
  // cancel API has run cleanup. If we returned early on status alone,
  // that race would leave pending approvals, spawned sessions, action
  // invocations, and trace rows un-cleaned forever.
  const execution = await db.select().from(workflowExecutions).where(eq(workflowExecutions.id, input.executionId)).get();
  if (!execution) return;
  if (execution.cleanupCompletedAt) return;
  if (execution.status === 'completed' || execution.status === 'failed') {
    // Non-cancel terminal — nothing to clean.
    return;
  }

  // Track per-step success. The final CAS to 'cancelled' only fires
  // when EVERY flag is true; otherwise the row stays in 'cancelling'
  // and the cron sweep retries.
  let approvalsOk = false;
  let sessionsOk = false;
  let invocationsOk = false;
  let tracesOk = false;

  // Step 1: cancel pending approval rows. Idempotent — no-op if 0 pending.
  try {
    await cancelPendingWorkflowApprovalsForExecution(db, input.executionId);
    approvalsOk = true;
  } catch (err) {
    console.warn(`[cancel-cleanup] cancel-approvals failed for ${input.executionId}: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Step 2: abort spawned sessions. workflow_spawned_sessions is the
  // authoritative lookup (no trace-parsing). Successfully terminated
  // rows are deleted immediately; failed rows stay behind for retry.
  try {
    const result = await terminateWorkflowSpawnedSessions(env, {
      executionId: input.executionId,
      reason: 'workflow_cancelled',
    });
    if (result.failed.length > 0) {
      console.warn(`[cancel-cleanup] spawned-session cleanup incomplete for ${input.executionId}: ${result.failed.length}/${result.attempted} failed`);
    }
    sessionsOk = result.failed.length === 0;
  } catch (err) {
    console.warn(`[cancel-cleanup] spawned-session abort failed for ${input.executionId}: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Step 2.5: drive every non-terminal action_invocations row for this
  // execution to a terminal status. Without this, a tool node that was
  // mid-execute when CF terminate() abandoned its step.do leaves the
  // invocation row in 'pending' or 'approved' forever.
  //
  // The action_invocations CHECK enum (migration 0018) does NOT include
  // 'cancelled' — its terminal statuses are executed / failed / denied
  // / expired. We write 'failed' with error='workflow_cancelled' so the
  // cancellation reason survives in the audit row.
  try {
    await db.update(actionInvocations)
      .set({
        status: 'failed',
        resolvedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        error: 'workflow_cancelled',
      })
      .where(and(
        eq(actionInvocations.workflowExecutionId, input.executionId),
        inArray(actionInvocations.status, ['pending', 'approved']),
      ))
      .run();
    invocationsOk = true;
  } catch (err) {
    console.warn(`[cancel-cleanup] mark-invocations-cancelled failed for ${input.executionId}: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Step 3: write skipped-cancelled trace rows for any node without a
  // terminal trace row. In-flight nodes get reason='cancelled_in_flight';
  // never-ran nodes get reason='cancelled'. Deterministic invocationId/
  // approvalId attached so the audit-chain link survives even when
  // cancel-cleanup is the only writer. onConflictDoUpdate with COALESCE
  // lets a later runtime write fill any remaining gaps without clobbering
  // values cancel-cleanup already wrote.
  try {
    const execRow = await db.select({
      definitionSnapshot: workflowExecutions.definitionSnapshot,
      mode: workflowExecutions.mode,
    }).from(workflowExecutions).where(eq(workflowExecutions.id, input.executionId)).get();
    if (execRow?.definitionSnapshot) {
      const def = JSON.parse(execRow.definitionSnapshot) as { nodes?: Array<{ id: string; type: string }> };
      const nodes = Array.isArray(def.nodes) ? def.nodes : [];
      const existingAny = await db.select({
        nodeId: workflowExecutionNodes.nodeId,
        status: workflowExecutionNodes.status,
      }).from(workflowExecutionNodes)
        .where(and(
          eq(workflowExecutionNodes.executionId, input.executionId),
          inArray(workflowExecutionNodes.status, ['running', 'waiting_approval', 'waiting_time', 'completed', 'failed', 'skipped']),
        )).all();
      const terminalIds = new Set<string>();
      const inFlightIds = new Set<string>();
      for (const r of existingAny) {
        if (r.status === 'completed' || r.status === 'failed' || r.status === 'skipped') {
          terminalIds.add(r.nodeId);
        } else {
          inFlightIds.add(r.nodeId);
        }
      }
      const now = new Date().toISOString();
      const retentionMs = execRow.mode === 'test' ? 7 * 86400_000 : 30 * 86400_000;
      const expiresAt = new Date(Date.now() + retentionMs).toISOString();
      for (const node of nodes) {
        if (terminalIds.has(node.id)) continue;
        const isInFlight = inFlightIds.has(node.id);
        const traceId = `${input.executionId}:${node.id}:skipped:0`;
        // Derive correlation ids by node type so the trace row carries
        // the link even when cancel-cleanup writes first. Skip
        // iteration-suffix derivation here — for non-foreach nodes the
        // top-level invocationId/approvalId is the right one; for
        // foreach-child nodes the runtime trace writer (executor catch
        // path) sets iteration-scoped ids and COALESCE preserves them.
        const invocationId = node.type === 'tool' ? `workflow:${input.executionId}:${node.id}` : null;
        const approvalId = node.type === 'approval' ? `approval:${input.executionId}:${node.id}` : null;
        await db.insert(workflowExecutionNodes).values({
          id: traceId,
          executionId: input.executionId,
          nodeId: node.id,
          nodeType: node.type,
          status: 'skipped',
          reason: isInFlight ? 'cancelled_in_flight' : 'cancelled',
          startedAt: now,
          completedAt: now,
          expiresAt,
          invocationId,
          approvalId,
        }).onConflictDoUpdate({
          target: workflowExecutionNodes.id,
          set: {
            // Preserve a previously-set richer status/reason from the
            // runtime; only fill the cancel reason if absent.
            reason: sql`COALESCE(${workflowExecutionNodes.reason}, ${isInFlight ? 'cancelled_in_flight' : 'cancelled'})`,
            // COALESCE invocationId/approvalId so the runtime can still
            // fill in iteration-scoped ids after the cleanup write.
            invocationId: sql`COALESCE(${workflowExecutionNodes.invocationId}, ${invocationId})`,
            approvalId: sql`COALESCE(${workflowExecutionNodes.approvalId}, ${approvalId})`,
          },
        }).run();
      }
      tracesOk = true;
    } else {
      // Missing snapshot is unusual but not a failure — no traces to write.
      tracesOk = true;
    }
  } catch (err) {
    console.warn(`[cancel-cleanup] skip-trace writes failed for ${input.executionId}: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Step 4 + 5: transition to cancelled. GATE on every step succeeding.
  // If any flag is false, leave the row in 'cancelling' so the cron
  // sweep retries the full pipeline. Without this gate, a partial
  // failure foreclosed recovery — the early-exit on status='cancelled'
  // bailed before re-attempting.
  if (!approvalsOk || !sessionsOk || !invocationsOk || !tracesOk) {
    console.warn(`[cancel-cleanup] partial failure for ${input.executionId} — leaving row in 'cancelling' for cron retry. approvals=${approvalsOk} sessions=${sessionsOk} invocations=${invocationsOk} traces=${tracesOk}`);
    return;
  }

  const nowIso = new Date().toISOString();
  // CAS includes 'cancelled' as an allowed prior so the recovery case
  // (runtime flipped to 'cancelled' before cleanup finished) can fill
  // in cleanup_completed_at without rolling status backward. The
  // isNull(cleanup_completed_at) guard makes this idempotent — a
  // racing concurrent runner cannot double-write cleanup_completed_at.
  await db.update(workflowExecutions)
    .set({
      status: 'cancelled',
      cancelledAt: execution.cancelledAt ?? nowIso,
      cancelledBy: input.cancelledBy ?? execution.cancelledBy ?? null,
      completedAt: execution.completedAt ?? nowIso,
      cleanupCompletedAt: nowIso,
    })
    .where(and(
      eq(workflowExecutions.id, input.executionId),
      isNull(workflowExecutions.cleanupCompletedAt),
      inArray(workflowExecutions.status, [...CLEANUP_CAS_PRIOR_STATUSES, 'cancelled']),
    ))
    .run();
}

/**
 * Cron sweep entry point. Finds rows stuck in `cancelling` longer than
 * the threshold and re-runs cleanup against each. Idempotent on the
 * cleanup helper.
 */
export async function sweepStuckCancellations(env: Env, options: { staleMs?: number; limit?: number } = {}): Promise<{ swept: number }> {
  const db = getDb(env.DB);
  const staleMs = options.staleMs ?? 5 * 60_000;
  const limit = options.limit ?? 100;
  const cutoff = new Date(Date.now() - staleMs).toISOString();

  // Two stuck shapes the sweep handles:
  //   1. status='cancelling' — the first cancel attempt's terminate()
  //      or cleanup didn't complete. The CF Workflow may still be
  //      running, so this branch MUST re-attempt
  //      tryDispatchCancelAndTerminate before running cleanup. Marking
  //      cleanup complete without terminate would leave the runtime
  //      alive while we said we'd cancelled it.
  //   2. status='cancelled' with cleanup_completed_at NULL — the runtime
  //      raced the cancel API and self-finalized (allowedPrior includes
  //      'cancelling'). The instance is already gone; cleanup is all
  //      that's missing.
  //
  // Filtering on cleanup_completed_at IS NULL also makes the sweep
  // self-idempotent — a row that has already been cleaned won't get
  // re-swept.
  const stuck = await db.select({
    id: workflowExecutions.id,
    status: workflowExecutions.status,
    cancelledBy: workflowExecutions.cancelledBy,
  })
    .from(workflowExecutions)
    .where(and(
      inArray(workflowExecutions.status, ['cancelling', 'cancelled']),
      isNull(workflowExecutions.cleanupCompletedAt),
      isNotNull(workflowExecutions.cancelledAt),
      lt(workflowExecutions.cancelledAt, cutoff),
    ))
    .limit(limit)
    .all();

  let swept = 0;
  for (const row of stuck) {
    try {
      if (row.status === 'cancelling') {
        const terminated = await tryDispatchCancelAndTerminate(env, db, row.id, row.cancelledBy ?? undefined);
        if (!terminated) {
          // Leave the row in 'cancelling' for the next sweep. Don't
          // run cleanup — we'd lie about the CF Workflow being gone.
          continue;
        }
      }
      await runCancellationCleanup(env, { executionId: row.id });
      swept++;
    } catch (err) {
      console.warn(`[cancel-cleanup] sweep failed for execution ${row.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { swept };
}

/**
 * Cron sweep: retry sendEvent for approvals that resolved (approved or
 * denied) but whose workflow_executions row is still waiting_approval.
 * This handles the case where the resolve API committed the DB update
 * but sendEvent failed (instance gone, transient network blip), so the
 * runtime never received the resume signal and the workflow would
 * otherwise sit in waiting_approval until the 24h timeout.
 *
 * Idempotent: sendEvent on an already-resumed instance is a benign
 * no-op. We resend the SAME event type/payload so the runtime can
 * accept it the same way it would have on first delivery.
 */
export async function sweepStuckApprovals(env: Env, options: { staleMs?: number; maxAgeMs?: number; limit?: number } = {}): Promise<{ retried: number }> {
  const db = getDb(env.DB);
  // Conservative defaults: wait 5min after resolve before retrying
  // (CF wake latency can exceed a minute) and only retry approvals
  // resolved within the last 1h. Beyond that, the runtime's own 24h
  // approval timeout will finalize naturally — no point firing
  // sendEvent for hours.
  const staleMs = options.staleMs ?? 5 * 60_000;
  const maxAgeMs = options.maxAgeMs ?? 60 * 60_000;
  const limit = options.limit ?? 50;
  const now = Date.now();
  const cutoff = new Date(now - staleMs).toISOString();
  const ageFloor = new Date(now - maxAgeMs).toISOString();

  // Approvals resolved between [ageFloor, cutoff] whose linked
  // execution is still ACTIVE (any non-terminal status). We deliberately
  // do NOT restrict to executions.status='waiting_approval' because of
  // the parallel-siblings race: when N approvals park concurrently,
  // each sibling flips the row to 'running' in its finally-block when
  // it resumes, so a stuck sibling (sendEvent dropped) leaves the row
  // in 'running' rather than 'waiting_approval'. Filtering on
  // 'waiting_approval' would silently hide that case. Active-status
  // filter still skips completed/failed/cancelled executions where the
  // workflow instance is gone and sendEvent would be useless.
  // Filter further to active executions in code (the helper's primary
  // filter is the time window; execution-status filter happens here).
  const candidates = await listStuckWorkflowApprovalsForResume(db, {
    cutoffIso: cutoff,
    ageFloorIso: ageFloor,
    limit: limit * 4, // overscan; some will be from terminal executions
  });

  const activeExecIds = await db.select({ id: workflowExecutions.id })
    .from(workflowExecutions)
    .where(inArray(workflowExecutions.status, [...ACTIVE_EXECUTION_STATUSES]))
    .all();
  const activeSet = new Set(activeExecIds.map((r) => r.id));

  let retried = 0;
  for (const row of candidates) {
    if (retried >= limit) break;
    if (!row.workflowExecutionId || !activeSet.has(row.workflowExecutionId)) continue;
    if (!row.nodeId) continue;
    const iterSuffix = typeof row.iterationIndex === 'number' ? `_i_${row.iterationIndex}` : '';
    const eventType = `approval_${row.nodeId}${iterSuffix}`;
    try {
      const instance = await env.WORKFLOW_INTERPRETER.get(row.workflowExecutionId);
      await instance.sendEvent({
        type: eventType,
        payload: { result: row.status as 'approved' | 'denied', userId: row.resolvedBy ?? 'system' },
      });
      retried++;
    } catch (err) {
      console.warn(`[approval-resume-sweep] sendEvent failed for invocation ${row.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { retried };
}

/**
 * Cancel entrypoint. Called by the cancel API endpoint:
 *   1. Mark row as cancelling.
 *   2. Call instance.terminate().
 *   3. Run cleanup synchronously.
 * Any failure between steps leaves the row in `cancelling` for the
 * cron sweep to recover.
 */
export async function cancelExecution(
  env: Env,
  input: { executionId: string; cancelledBy: string; expectedWorkflowId?: string },
): Promise<{ status: 'cancelling' | 'cancelled' | 'not_found' | 'already_terminal' }> {
  const db = getDb(env.DB);
  const execution = await db.select().from(workflowExecutions).where(eq(workflowExecutions.id, input.executionId)).get();
  if (!execution) return { status: 'not_found' };
  // Cross-tenant guard: reject when the URL's workflowId doesn't match
  // the execution's actual workflow. Otherwise an editor on workflow A
  // could cancel any execution by guessing its id.
  if (input.expectedWorkflowId !== undefined && execution.workflowId !== input.expectedWorkflowId) {
    return { status: 'not_found' };
  }
  if (execution.status === 'completed' || execution.status === 'failed') {
    return { status: 'already_terminal' };
  }
  // 'cancelled' is only fully terminal once cleanup has finished. If the
  // runtime raced the cancel API to write status='cancelled' but
  // cleanup_completed_at is still null, an explicit retry should run
  // cleanup synchronously instead of deferring to the cron sweep — the
  // caller asked us to cancel and we should honor that within the
  // request.
  if (execution.status === 'cancelled' && execution.cleanupCompletedAt) {
    return { status: 'already_terminal' };
  }

  // Retry path for 'cancelled' without cleanup_completed_at:
  // the runtime self-finalized (allowedPrior=['running','cancelling'] in
  // the terminal CAS) but cleanup never ran. Skip terminate() — the
  // instance is already gone — and just run cleanup.
  if (execution.status === 'cancelled') {
    return runCleanupAndReport(env, input.executionId);
  }

  // Retry path for 'cancelling': the first cancel attempt CAS'd to
  // 'cancelling' but its synchronous pipeline (sendEvent → terminate →
  // runCancellationCleanup) didn't reach the final CAS. Re-attempt the
  // termination dance BEFORE running cleanup — otherwise we could mark
  // cleanup complete while the Cloudflare Workflow instance is still
  // running. Don't re-touch cancelledBy/cancelledAt so the first
  // canceller's audit identity is preserved.
  if (execution.status === 'cancelling') {
    const terminated = await tryDispatchCancelAndTerminate(env, db, input.executionId, input.cancelledBy);
    if (!terminated) {
      return { status: 'cancelling' };
    }
    return runCleanupAndReport(env, input.executionId);
  }

  // Mark cancelling with a compare-and-swap: the WHERE clause requires
  // the row to still be in a non-terminal, non-cancelling state. If a
  // parallel cancel or a natural completion changed the status between
  // the SELECT above and this UPDATE, result.meta.changes === 0 and we
  // re-fetch to report whatever's authoritative now.
  await db.update(workflowExecutions)
    .set({
      status: 'cancelling',
      cancelledAt: new Date().toISOString(),
      cancelledBy: input.cancelledBy,
    })
    .where(and(
      eq(workflowExecutions.id, input.executionId),
      inArray(workflowExecutions.status, [...ACTIVE_EXECUTION_STATUSES]),
    ))
    .run();
  // Verify the CAS landed via re-fetch — drizzle's `.run()` exposes
  // `changes` differently across D1 vs better-sqlite3, so re-reading the
  // row is the portable way to detect a no-op. Read cleanup_completed_at
  // too so we don't lie about a cancelled-but-uncleaned row.
  const postUpdate = await db.select({
    status: workflowExecutions.status,
    cleanupCompletedAt: workflowExecutions.cleanupCompletedAt,
  }).from(workflowExecutions).where(eq(workflowExecutions.id, input.executionId)).get();
  if (!postUpdate) return { status: 'not_found' };
  if (postUpdate.status !== 'cancelling') {
    // Another actor (the runtime racing the cancel, or a concurrent
    // cancel API call) won the CAS race.
    if (postUpdate.status === 'cancelled') {
      if (postUpdate.cleanupCompletedAt) return { status: 'cancelled' };
      // Cleanup hasn't finished. The runtime already terminated itself,
      // so we don't need terminate() — just run cleanup.
      return runCleanupAndReport(env, input.executionId);
    }
    return { status: 'already_terminal' };
  }

  const terminated = await tryDispatchCancelAndTerminate(env, db, input.executionId, input.cancelledBy);
  if (!terminated) {
    return { status: 'cancelling' };
  }

  return runCleanupAndReport(env, input.executionId, input.cancelledBy);
}

/**
 * Defensive cancel + terminate dance for a running Cloudflare Workflow
 * instance. Dispatches a `cancelled` event for every pending approval
 * (best-effort) before calling `instance.terminate()`. Returns true on
 * success; false if terminate() threw — the caller leaves the row in
 * `cancelling` for the cron sweep to retry.
 */
async function tryDispatchCancelAndTerminate(
  env: Env,
  db: ReturnType<typeof getDb>,
  executionId: string,
  cancelledBy: string | undefined,
): Promise<boolean> {
  try {
    const instance = await env.WORKFLOW_INTERPRETER.get(executionId);

    // CF's terminate() throws if the instance is errored / terminated /
    // complete (per
    // https://developers.cloudflare.com/workflows/build/workers-api/).
    // A retry where the first attempt's terminate() succeeded but
    // cleanup crashed would loop forever if we just called terminate()
    // blindly — every retry would throw "already terminated" and the
    // sweep would never advance to cleanup. Check status first; treat a
    // terminal instance as success so the caller proceeds to cleanup.
    let alreadyTerminal = false;
    try {
      const status = await instance.status();
      // The InstanceStatus return shape exposes a nested `status` field.
      const s = (status as { status?: string } | string | null | undefined);
      const statusName = typeof s === 'string' ? s : s?.status;
      if (statusName === 'terminated' || statusName === 'errored' || statusName === 'complete') {
        alreadyTerminal = true;
      }
    } catch (err) {
      // status() shouldn't throw for an existing instance, but if it
      // does we fall through and attempt terminate() the old way —
      // the outer catch handles a real failure.
      console.warn(`[cancel-cleanup] status() failed for ${executionId}: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (alreadyTerminal) {
      return true;
    }

    // Dispatch a `cancelled` event for every pending approval before
    // terminate. CF's terminate() abandons step.waitForEvent waits, but
    // we proactively break the wait so the workflow unblocks even if
    // auto-abandon doesn't fire.
    //
    // result='cancelled' (not 'denied') so the executor's approval
    // handler treats it as a hard-cancel (throws CancelledError)
    // instead of running the onDeny path — otherwise an onDeny='skip'
    // approval would let downstream nodes (Slack sends, tool calls)
    // run as if the user had explicitly denied the request.
    const pending = await listPendingWorkflowApprovalsForExecution(db, executionId);
    for (const row of pending) {
      if (!row.nodeId) continue;
      const iterSuffix = typeof row.iterationIndex === 'number' ? `_i_${row.iterationIndex}` : '';
      const eventType = `approval_${row.nodeId}${iterSuffix}`;
      try {
        await instance.sendEvent({
          type: eventType,
          payload: { result: 'cancelled', userId: cancelledBy ?? 'system' },
        });
      } catch {
        // Best-effort; terminate() below is the durable cleanup.
      }
    }

    await instance.terminate();
    return true;
  } catch (err) {
    console.warn(`[cancel-cleanup] terminate() failed for ${executionId}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/**
 * Run cleanup, then re-read the row and report the outcome. A partial-
 * failure pipeline leaves the row in 'cancelling' (cleanup gates on
 * every flag); the cron sweep retries. Don't lie to the caller.
 */
async function runCleanupAndReport(
  env: Env,
  executionId: string,
  cancelledBy?: string,
): Promise<{ status: 'cancelling' | 'cancelled' }> {
  await runCancellationCleanup(env, {
    executionId,
    ...(cancelledBy ? { cancelledBy } : {}),
  });
  const db = getDb(env.DB);
  const final = await db.select({
    status: workflowExecutions.status,
    cleanupCompletedAt: workflowExecutions.cleanupCompletedAt,
  }).from(workflowExecutions).where(eq(workflowExecutions.id, executionId)).get();
  if (final?.status === 'cancelled' && final.cleanupCompletedAt) {
    return { status: 'cancelled' };
  }
  return { status: 'cancelling' };
}
