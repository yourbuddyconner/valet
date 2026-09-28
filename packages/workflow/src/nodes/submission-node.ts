/**
 * Shared machinery behind the `session` and `orchestrator` executors
 * (node-completion plan decision 5). Both nodes dispatch one external
 * "submission" (a session prompt, or an orchestrator followup), optionally
 * park behind it, and — on settlement — map the outcome onto the node
 * checkpoint with the same bounded, one-shot schema-repair round trip.
 * `session.ts` and `thread.ts` differ only in *how* a submission is
 * dispatched (create-session-and-prompt vs. resolve-orchestrator-and-
 * prompt-as-followup) and in the shape of their `completed` results — this
 * module owns everything else: effects read-back, intent-before-dispatch
 * ordering, receipt persistence, `wait.mode: 'none'` short-circuit, the
 * park shape, the `isSettled` re-park guard, and outcome mapping including
 * the repair round.
 *
 * Determinism / at-most-once dispatch: identical to `session.ts`'s
 * original contract (see its lifecycle notes, still accurate) — the caller
 * supplies a `dispatchId` derived from ids already durable in the
 * checkpoint PK, and a `dispatch`/`dispatchRepair` pair that MUST be
 * idempotent by that id (the engine contract `engine-deps.ts` documents
 * for `prompt`/`promptOrchestrator`). A crash between "submission sent" and
 * "receipt persisted" re-enters this module, which re-issues the same
 * dispatch and relies on the callee returning the *original* receipt.
 */

import type { SubmissionResult } from '@valet/engine';
import { ValidationError } from '@valet/engine';

import type { WorkflowPromptReceipt, WorkflowEngineDeps } from '../engine-deps.js';
import type { NodeCheckpoint, WorkflowRun, WorkflowStore } from '../store.js';

/** What a submission dispatch (initial or resumed) yields: the session it landed on plus the prompt receipt. */
export interface SubmissionDispatch {
  sessionId: string;
  receipt: WorkflowPromptReceipt;
}

/** The minimal, node-type-agnostic slice of `NodeExecutorArgs` this module needs — deliberately not `NodeExecutorArgs<TNode>` so callers don't have to satisfy its full generic shape. */
export interface SubmissionNodeContext {
  run: WorkflowRun;
  nodeId: string;
  attempt: number;
  iteration: number;
  store: WorkflowStore;
  clock: () => number;
  engine: WorkflowEngineDeps;
  existingCheckpoint?: NodeCheckpoint;
}

export interface SubmissionNodeHooks<TDispatched, TSettled> {
  /** Short label for error messages ("session" | "thread"). */
  nodeKind: string;
  /** `workflow:{runId}:{nodeId}[:{iteration}]` — the primary submission's dispatchId (repairs append `:repair`). */
  dispatchId: string;
  /** Effects to persist on the very first intent write, before any dispatch happens (e.g. `{ sessionId }` when the caller mints its own id up front; `{}` when the dispatch itself resolves the session). */
  initialEffects: Record<string, unknown>;
  waitMode: 'none' | 'until_idle' | undefined;
  outputSchema: Record<string, unknown> | undefined;
  /** Issues (or, on re-entry with an identical `dispatchId`, re-issues idempotently) the primary submission. */
  dispatch(dispatchId: string): Promise<SubmissionDispatch>;
  /** Issues the ONE bounded repair submission against the already-dispatched session. */
  dispatchRepair(repairDispatchId: string, repairPrompt: string, sessionId: string): Promise<WorkflowPromptReceipt>;
  buildDispatchedResult(dispatch: SubmissionDispatch): TDispatched;
  buildSettledResult(sessionId: string, result: SubmissionResult, receipt: WorkflowPromptReceipt): TSettled;
}

interface SubmissionEffects {
  sessionId?: string;
  receipt?: WorkflowPromptReceipt;
  repairAttempted: boolean;
}

export async function executeSubmissionNode<TDispatched, TSettled>(
  ctx: SubmissionNodeContext,
  hooks: SubmissionNodeHooks<TDispatched, TSettled>,
): Promise<
  | { status: 'completed'; result: TDispatched | TSettled }
  | { status: 'failed'; error: string }
  | { status: 'parked'; waitingOn: [{ kind: 'submission'; nodeId: string; sessionId: string; threadId: string; queueItemId: string }] }
> {
  const { run, nodeId, attempt, iteration, store, clock, engine, existingCheckpoint } = ctx;
  const effects = readSubmissionEffects(existingCheckpoint);

  if (effects.receipt === undefined) {
    // First entry, or resumed after a crash before the receipt was
    // persisted. Write the intent before any externally-visible call (only
    // needed once — a resumed entry already has an intent row).
    if (existingCheckpoint === undefined) {
      await store.putIntent({
        runId: run.runId,
        nodeId,
        iteration,
        status: 'intent',
        attempt,
        createdAt: clock(),
        effects: hooks.initialEffects,
      });
    }

    // A `ValidationError` from admission (e.g. an unknown `node.model` spec —
    // the engine now validates the per-item model pin at submit) is a
    // workflow DEFINITION error and deterministic: rethrowing would poison
    // the drive (abandon lease → re-drive → same throw, until the poisoned-
    // run cap fails the WHOLE run with no per-node error). Settle THIS node
    // `failed` instead. Infrastructure throws (fence errors, store failures)
    // keep propagating for the drive's retry semantics.
    let dispatch: SubmissionDispatch;
    try {
      dispatch = await hooks.dispatch(hooks.dispatchId);
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
      const error = err.message;
      await store.completeCheckpoint(run.runId, nodeId, iteration, attempt, {
        runId: run.runId,
        nodeId,
        iteration,
        status: 'failed',
        error,
        effects: hooks.initialEffects,
        attempt,
        createdAt: clock(),
      });
      return { status: 'failed', error };
    }

    await store.putIntent({
      runId: run.runId,
      nodeId,
      iteration,
      status: 'intent',
      attempt,
      createdAt: clock(),
      effects: effectsToRecord({ sessionId: dispatch.sessionId, receipt: dispatch.receipt, repairAttempted: false }),
    });

    if (hooks.waitMode === 'none') {
      const result = hooks.buildDispatchedResult(dispatch);
      await store.completeCheckpoint(run.runId, nodeId, iteration, attempt, {
        runId: run.runId,
        nodeId,
        iteration,
        status: 'completed',
        result,
        effects: effectsToRecord({ sessionId: dispatch.sessionId, receipt: dispatch.receipt, repairAttempted: false }),
        attempt,
        createdAt: clock(),
      });
      return { status: 'completed', result };
    }

    return {
      status: 'parked',
      waitingOn: [
        {
          kind: 'submission',
          nodeId,
          sessionId: dispatch.sessionId,
          threadId: dispatch.receipt.threadId,
          queueItemId: dispatch.receipt.queueItemId,
        },
      ],
    };
  }

  const sessionId = requireSessionId(effects, hooks.nodeKind, nodeId);
  const receipt = effects.receipt;
  const settled = await engine.isSettled(sessionId, receipt.queueItemId);
  if (!settled) {
    return {
      status: 'parked',
      waitingOn: [{ kind: 'submission', nodeId, sessionId, threadId: receipt.threadId, queueItemId: receipt.queueItemId }],
    };
  }

  // `outputSchema` (a JSON Schema object) is passed straight through as a
  // `TSchema`: `typebox`'s `TSchema` is declared as an empty interface
  // (`export interface TSchema {}`), so any JSON-Schema-shaped object is
  // already structurally assignable to it — no `as` bridge is needed here.
  const result = await engine.awaitResult(
    sessionId,
    receipt.threadId,
    receipt.queueItemId,
    hooks.outputSchema !== undefined ? { resultSchema: hooks.outputSchema } : undefined,
  );

  return await handleOutcome(ctx, hooks, sessionId, receipt, effects.repairAttempted, result);
}

async function handleOutcome<TDispatched, TSettled>(
  ctx: SubmissionNodeContext,
  hooks: SubmissionNodeHooks<TDispatched, TSettled>,
  sessionId: string,
  receipt: WorkflowPromptReceipt,
  repairAttempted: boolean,
  result: SubmissionResult,
): Promise<
  | { status: 'completed'; result: TDispatched | TSettled }
  | { status: 'failed'; error: string }
  | { status: 'parked'; waitingOn: [{ kind: 'submission'; nodeId: string; sessionId: string; threadId: string; queueItemId: string }] }
> {
  const { run, nodeId, attempt, iteration, store, clock } = ctx;

  if (result.outcome !== 'completed') {
    const error = result.error ?? `${hooks.nodeKind} node "${nodeId}" submission outcome: ${result.outcome}`;
    await store.completeCheckpoint(run.runId, nodeId, iteration, attempt, {
      runId: run.runId,
      nodeId,
      iteration,
      status: 'failed',
      error,
      effects: effectsToRecord({ sessionId, receipt, repairAttempted }),
      attempt,
      createdAt: clock(),
    });
    return { status: 'failed', error };
  }

  if (hooks.outputSchema === undefined || result.output !== undefined) {
    const settledResult = hooks.buildSettledResult(sessionId, result, receipt);
    await store.completeCheckpoint(run.runId, nodeId, iteration, attempt, {
      runId: run.runId,
      nodeId,
      iteration,
      status: 'completed',
      result: settledResult,
      effects: effectsToRecord({ sessionId, receipt, repairAttempted }),
      attempt,
      createdAt: clock(),
    });
    return { status: 'completed', result: settledResult };
  }

  // completed, but outputSchema set and output missing: schema validation failed.
  if (repairAttempted) {
    const error = result.error ?? `${hooks.nodeKind} node "${nodeId}" result did not match outputSchema after repair`;
    await store.completeCheckpoint(run.runId, nodeId, iteration, attempt, {
      runId: run.runId,
      nodeId,
      iteration,
      status: 'failed',
      error,
      effects: effectsToRecord({ sessionId, receipt, repairAttempted }),
      attempt,
      createdAt: clock(),
    });
    return { status: 'failed', error };
  }

  // Exactly one repair attempt: re-prompt the same submission with the
  // schema + validation error, tracked via `repairAttempted` so a second
  // validation failure fails the node instead of repairing forever.
  const schema = hooks.outputSchema;
  const repairText = buildRepairPrompt(schema, result.error);
  // Same ValidationError containment as the primary dispatch: a definition
  // error settles the node, never poisons the drive.
  let repairReceipt: WorkflowPromptReceipt;
  try {
    repairReceipt = await hooks.dispatchRepair(`${hooks.dispatchId}:repair`, repairText, sessionId);
  } catch (err) {
    if (!(err instanceof ValidationError)) throw err;
    const error = err.message;
    await store.completeCheckpoint(run.runId, nodeId, iteration, attempt, {
      runId: run.runId,
      nodeId,
      iteration,
      status: 'failed',
      error,
      effects: effectsToRecord({ sessionId, receipt, repairAttempted }),
      attempt,
      createdAt: clock(),
    });
    return { status: 'failed', error };
  }
  await store.putIntent({
    runId: run.runId,
    nodeId,
    iteration,
    status: 'intent',
    attempt,
    createdAt: clock(),
    effects: effectsToRecord({ sessionId, receipt: repairReceipt, repairAttempted: true }),
  });
  return {
    status: 'parked',
    waitingOn: [
      { kind: 'submission', nodeId, sessionId, threadId: repairReceipt.threadId, queueItemId: repairReceipt.queueItemId },
    ],
  };
}

/** Shared repair-prompt text for both `session` and `orchestrator` — schema + validation error, requesting corrected JSON only. */
function buildRepairPrompt(schema: Record<string, unknown>, validationError: string | undefined): string {
  const errorText = validationError ?? 'result did not match the schema';
  return [
    'Your previous response did not match the required JSON schema.',
    '',
    'Schema:',
    JSON.stringify(schema),
    '',
    `Validation error: ${errorText}`,
    '',
    'Respond with ONLY the corrected JSON, matching the schema exactly.',
  ].join('\n');
}

function requireSessionId(effects: SubmissionEffects, nodeKind: string, nodeId: string): string {
  if (effects.sessionId === undefined) {
    throw new Error(`${nodeKind} node "${nodeId}" has a receipt but no sessionId in effects — contract violation`);
  }
  return effects.sessionId;
}

function readSubmissionEffects(existingCheckpoint: NodeCheckpoint | undefined): SubmissionEffects {
  const raw = existingCheckpoint?.effects;
  if (!raw) return { repairAttempted: false };
  return {
    sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : undefined,
    receipt: parseReceipt(raw.receipt),
    repairAttempted: raw.repairAttempted === true,
  };
}

function parseReceipt(value: unknown): WorkflowPromptReceipt | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.threadId !== 'string' || typeof v.queueItemId !== 'string') return undefined;
  return { threadId: v.threadId, queueItemId: v.queueItemId };
}

function effectsToRecord(effects: SubmissionEffects): Record<string, unknown> {
  const record: Record<string, unknown> = { repairAttempted: effects.repairAttempted };
  if (effects.sessionId !== undefined) record.sessionId = effects.sessionId;
  if (effects.receipt !== undefined) record.receipt = effects.receipt;
  return record;
}
