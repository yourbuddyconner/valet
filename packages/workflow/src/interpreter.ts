/**
 * The checkpointed interpreter core (Phase 5 plan decision 8) —
 * `driveUntilPark(runId, attempt, deps)`.
 *
 * The HOST owns claim/lease/heartbeat (Task 8's `LocalRunHost`); this
 * function receives the already-claimed `attempt` and drives the run's
 * wave loop until it reaches a terminal state (two-phase settle) or has
 * nothing left runnable (park). It never claims, heartbeats, or releases
 * — a caller handing it a stale attempt will see every store write it
 * attempts fail with `WorkflowFenceError` (propagated as a throw; the
 * host's next claim re-drives from checkpoints, so no correctness is
 * lost).
 *
 * Loop body, each pass reloading from the store (so signals/settlements
 * that land mid-drive are picked up without a stale in-memory copy):
 *   1. load run + definition snapshot + checkpoints + unconsumed signals
 *   2. a `cancel` signal present → abort in-flight submission waits,
 *      two-phase settle `cancelled`
 *   3. else propagate skips to a fixed point, then compute the runnable
 *      set (decision 9's edge/skip semantics)
 *   4. nothing runnable, everything terminal → two-phase settle
 *      (`completed`/`failed`, dominated by any node's `failed` status
 *      unless that node declares `onError: "continue"`)
 *   5. nothing runnable, not everything terminal → `parkRun`, return
 *   6. else execute the runnable nodes (deterministic definition order);
 *      a `stop` node's `terminate` signal short-circuits to two-phase
 *      settle once the current wave finishes; parked nodes' wait
 *      conditions accumulate and `parkRun` once the wave has no more
 *      newly-runnable work; otherwise loop again
 */

import { markSpanError, withSpan } from '@valet/engine';
import type { Span } from '@opentelemetry/api';

import {
  evaluateExpression,
  parseExpression,
  TemplateEvalError,
  TemplateParseError,
  withMissRecorder,
  type TemplateContext,
} from './dag/expression.js';
import { auditNodeTemplates } from './dag/node-templates.js';
import { createMissRecorder, type TemplatePathDiagnostic } from './dag/path-diagnostics.js';
import type { WorkflowNode } from './dag/nodes.js';
import type { WorkflowDefinition, WorkflowEdge } from './dag/shape.js';
import type { WorkflowEngineDeps } from './engine-deps.js';
import {
  createDefaultNodeExecutors,
  llmUsageSpanAttributes,
  type NodeExecuteResult,
  type NodeExecutorArgs,
  type NodeExecutorRegistry,
  type OnApprovalGrant,
  type OnApprovalPending,
  type OnGateResolved,
} from './nodes/index.js';
import type { NodeCheckpoint, RunParkState, RunWaitCondition, WorkflowRun, WorkflowStore } from './store.js';

/**
 * What the host learns when a run reaches a terminal outcome (batch-fanout
 * design decision 4). Every field comes from the run row the settle path
 * already reads, so reporting costs no extra store call. A handler that
 * needs node-level detail reads the checkpoints itself — the same division
 * `onApprovalPending` uses.
 */
export interface RunSettledInfo {
  runId: string;
  workflowId: string;
  outcome: 'completed' | 'failed' | 'cancelled';
  /** Principal ownership of the run. Absent when `createRun` recorded no owner. */
  owner?: { ownerType: string; ownerId: string };
  /** Set on a sub-workflow run: the parent run and the `workflow` node parked on it. */
  parentRunId?: string;
  parentNodeId?: string;
  parentIteration?: number;
  /** The settle write's timestamp, read back from the run row. */
  settledAt: number;
}

/**
 * Settle report hook, fired once per settle finalization (batch-fanout
 * design decision 4).
 *
 * Two obligations on the handler. It MUST NOT throw: the run is already
 * `settled` when this fires, so nothing reclaims it and a throw only loses
 * the park state `driveUntilPark` was about to return. It MUST be
 * idempotent: `settleRun` is idempotent, and a run reclaimed while
 * `terminalizing` re-runs the whole finalization, so one run can report
 * more than once. `packages/api` wires both obligations the same way it
 * wires `onApprovalPending` — a `try`/`catch` around a deterministic
 * `dedupeKey`.
 *
 * Delivery is AT MOST once, never exactly once. The report follows
 * `settleRun`, and `listRunnable` never returns a `settled` run, so a
 * process that dies between the two loses the report and nothing reclaims
 * the run to retry it. Use this hook for best-effort work (attention,
 * metrics). A consumer that must not miss a settle reads the run row.
 */
export type OnRunSettled = (info: RunSettledInfo) => Promise<void> | void;

/**
 * Template paths that did not resolve during one drive segment.
 *
 * A run reaches this hook whether or not the misses failed anything: under
 * the default `policy.onUnresolvedPath: "empty"` the nodes completed, with
 * an empty value where the author expected data. That is exactly the case
 * nothing else reports, so the host should persist these against the run
 * and show them next to the run's nodes.
 */
export interface TemplateDiagnosticsReport {
  runId: string;
  workflowId: string;
  /** The attempt that observed them. */
  attempt: number;
  /** Deduplicated by (node, field, path). Never empty. */
  diagnostics: TemplatePathDiagnostic[];
  /** True when `policy.onUnresolvedPath: "fail"` made these fail their nodes. */
  enforced: boolean;
}

/**
 * Template-diagnostics sink, fired once per wave that produced findings.
 *
 * Best-effort and non-blocking by contract: the interpreter swallows a
 * throw, because losing a diagnostic must never abandon a drive lease. The
 * handler must be idempotent — a reclaimed attempt re-drives the same wave
 * and reports the same findings again.
 */
export type OnTemplateDiagnostics = (report: TemplateDiagnosticsReport) => Promise<void> | void;

export interface InterpreterDeps {
  store: WorkflowStore;
  engine: WorkflowEngineDeps;
  clock: () => number;
  executors?: NodeExecutorRegistry;
  onApprovalPending?: OnApprovalPending;
  onApprovalGrant?: OnApprovalGrant;
  onGateResolved?: OnGateResolved;
  /** Fired once per settle finalization — see `OnRunSettled`. */
  onRunSettled?: OnRunSettled;
  /** Fired for each wave that read a template path which did not resolve — see `OnTemplateDiagnostics`. */
  onTemplateDiagnostics?: OnTemplateDiagnostics;
  /**
   * Host-only extension point (Phase 5 plan decision 20): invoked
   * synchronously right after `store.beginTerminalize` succeeds, before
   * terminal cleanup and `store.settleRun`. The interpreter itself never
   * sets this — it exists so `LocalRunHost`'s `crashAt: 'terminalizing'`
   * test hook can simulate a process crash at exactly this seam (reserving
   * the outcome, then dying before finalizing) without the interpreter
   * knowing anything about process lifecycle. Not invoked on the
   * `resumeTerminalize` path (a reclaimed `terminalizing` run's outcome was
   * already reserved by the crashed attempt — re-firing the hook here would
   * simulate a crash that never actually happens twice).
   */
  onBeginTerminalize?: () => void | Promise<void>;
}

/**
 * The interpreter always drives the definition's own nodes at iteration 0
 * — a `foreach` body's checkpoints are ALSO written at iteration 0 (item 0
 * lands there), keyed by the body's own node id, which never appears in
 * `definition.nodes`. `loadCheckpoints` filters to definition-node ids so
 * this wave loop, the failure-dominance scans, and `buildTemplateContext`
 * never see body rows; the `foreach` executor reads its own body
 * checkpoints directly via `store.getCheckpoints` and is unaffected by
 * this filter.
 */
const ITERATION = 0;

/**
 * Tracing seam (same contract as the engine's): spans go through
 * `@valet/engine`'s `withSpan`, which is a no-op until a host registers an
 * OTel SDK. One `workflow.drive` span covers a full drive segment (claim →
 * park/settle); each executed node nests a `workflow.node.{type}` child.
 * Because the node span is the active context when a submission node calls
 * `engine.prompt`, the engine's admission-traceparent stamp links the
 * spawned session's turn back to this workflow node automatically.
 */
export async function driveUntilPark(runId: string, attempt: number, deps: InterpreterDeps): Promise<RunParkState> {
  return await withSpan(
    'workflow.drive',
    { 'valet.workflow.run.id': runId, 'valet.workflow.run.attempt': attempt },
    async (span) => {
      const park = await driveLoop(runId, attempt, deps, span);
      span.setAttribute('valet.workflow.run.status', park.status);
      if (park.outcome !== undefined) span.setAttribute('valet.workflow.run.outcome', park.outcome);
      const waitingKinds = [...new Set(park.waitingOn.map((w) => w.kind))];
      if (waitingKinds.length > 0) span.setAttribute('valet.workflow.run.waiting', waitingKinds);
      return park;
    },
  );
}

async function driveLoop(runId: string, attempt: number, deps: InterpreterDeps, span: Span): Promise<RunParkState> {
  const {
    store,
    engine,
    clock,
    onApprovalPending,
    onApprovalGrant,
    onGateResolved,
    onBeginTerminalize,
  } = deps;
  const executors = deps.executors ?? createDefaultNodeExecutors();

  // `valet.workflow.id` is fixed for a run's whole lifetime (written once by
  // `createRun`), so it only needs setting once — as soon as the first
  // successful `store.getRun` makes it knowable — not on every pass of the
  // loop below (the loop itself must still re-fetch `run` every pass; see
  // its own comment). This flag guards that single `setAttribute` call.
  // If `store.getRun` throws or returns `null` on every pass (the run
  // genuinely doesn't exist, or a store-level fault), the span never gets
  // `valet.workflow.id` — there is no way to know it without a successful
  // fetch. This is an accepted gap: `valet.workflow.run.id`/`.attempt`,
  // set at span creation before any store call, remain available to
  // correlate the error.
  let workflowIdKnown = false;

  /** Every template finding this drive segment has seen, for the span attributes. */
  const driveDiagnostics: TemplatePathDiagnostic[] = [];

  while (true) {
    const run = await store.getRun(runId);
    if (!run) throw new Error(`workflow run not found: ${runId}`);
    if (!workflowIdKnown) {
      span.setAttribute('valet.workflow.id', run.params.workflowId);
      workflowIdKnown = true;
    }

    // A reclaimed `terminalizing` run (crash between `beginTerminalize` and
    // `settleRun`) MUST resume settlement directly, never re-enter the wave
    // loop: the outcome is already reserved, and recomputing the runnable
    // set here would re-execute nodes the terminalization preempted (e.g. a
    // sibling branch that hadn't run yet when the `stop` node terminated
    // the run). The store contract (`store.ts` `claimRun` doc) guarantees
    // the status stays `terminalizing` across reclaim precisely so this
    // branch is reachable.
    if (run.status === 'terminalizing') {
      return await resumeTerminalize(deps, run);
    }

    // The store snapshots exactly what was passed to `createRun` at run
    // start (Task 2's contract); narrowing the JSON-value column back to
    // the type the workflow layer itself wrote is not a "bridging a
    // third-party lib" case, but it's the one place the store's `unknown`
    // boundary meets a type this package owns end-to-end.
    const definition = run.definition as WorkflowDefinition;
    const cpAll = await loadCheckpoints(store, runId, definition);
    const signals = await store.listSignals(runId, { unconsumed: true });

    const cancelSignal = signals.find((s) => s.signalType === 'cancel');
    if (cancelSignal) {
      return await cancelRun(run, attempt, deps);
    }

    const graph = compile(definition);
    const templateContext = buildTemplateContext(definition, cpAll, graph);

    const skippedAny = await propagateSkips(store, run, definition, graph, cpAll, attempt, clock);
    if (skippedAny) continue; // re-derive the runnable set with the new skips visible

    const runnable = computeRunnable(definition, graph, cpAll, templateContext);

    if (runnable.length === 0) {
      const allTerminal = definition.nodes.every((n) => isSettled(cpAll, n.id));
      if (allTerminal) {
        const anyFailed = hasDominatingFailure(cpAll, graph);
        return await twoPhaseSettle(deps, run.runId, attempt, anyFailed ? 'failed' : 'completed');
      }
      return await parkAndReturn(store, run, attempt, run.waitingOn, run.wakeAt);
    }

    const waitingOn: RunWaitCondition[] = [];
    let terminate: 'completed' | 'failed' | undefined;
    // Failure dominance (mirrors main's runtime.ts): if any node in this
    // run — this wave or an earlier one — has a `failed` checkpoint, a
    // terminate settles `failed` regardless of the terminating stop node's
    // own outcome. Nodes with `onError: "continue"` are exempt.
    let sawFailure = hasDominatingFailure(cpAll, graph);

    // Audit every runnable node's templates against the context it is
    // about to render with. Two products come out of one pass: the
    // findings the host reports (always), and — under
    // `policy.onUnresolvedPath: "fail"` — the set of nodes that must not
    // run at all. Auditing BEFORE the wave is what makes strict mode
    // meaningful: a node that has already sent a prompt or called an
    // action cannot be un-run, and its checkpoint is already terminal.
    const strict = definition.policy?.onUnresolvedPath === 'fail';
    const findings: TemplatePathDiagnostic[] = [];
    const blocked = new Map<string, TemplatePathDiagnostic[]>();
    for (const node of runnable) {
      const audit = auditNodeTemplates(node, templateContext);
      if (audit.length === 0) continue;
      findings.push(...audit);
      if (!strict) continue;
      const enforceable = audit.filter((d) => d.enforceable);
      if (enforceable.length > 0) blocked.set(node.id, enforceable);
    }

    const blockedOutcomes = new Map<string, NodeExecuteResult>();
    for (const [nodeId, diagnostics] of blocked) {
      blockedOutcomes.set(nodeId, await failUnresolvedPaths(store, run, nodeId, attempt, clock, diagnostics));
    }

    // Execute the wave's runnable nodes concurrently, bounded (batch-fanout
    // design decision 2). Same-wave nodes never feed each other — the
    // template context and runnable set were computed before the wave, and
    // each executor writes only its own checkpoint row — so concurrency
    // changes wall-clock, not semantics. Outcomes are aggregated in
    // definition order below, preserving the sequential loop's
    // deterministic terminate selection.
    //
    // Each node renders against its OWN copy of the context, carrying a
    // recorder that reports the paths it read and did not resolve. That is
    // how a `foreach` body's misses surface: the body renders with the
    // foreach node's context plus per-iteration aliases, which the audit
    // above cannot see.
    const toExecute = runnable.filter((node) => !blocked.has(node.id));
    const recorded = new Map<string, TemplatePathDiagnostic[]>();
    const executed = await executeWave(toExecute, executors, (node) => {
      const { recorder, diagnostics } = createMissRecorder(node.id);
      recorded.set(node.id, diagnostics);
      return {
        run,
        attempt,
        iteration: ITERATION,
        templateContext: withMissRecorder(templateContext, recorder),
        existingCheckpoint: cpAll.get(node.id),
        store,
        clock,
        engine,
        onApprovalPending,
        onApprovalGrant,
        onGateResolved,
      };
    });

    const outcomeById = new Map<string, NodeExecuteResult>();
    for (let i = 0; i < toExecute.length; i++) outcomeById.set(toExecute[i].id, executed[i]);
    for (const [nodeId, outcome] of blockedOutcomes) outcomeById.set(nodeId, outcome);

    await reportDiagnostics(
      deps,
      run,
      attempt,
      span,
      mergeDiagnostics(findings, recorded),
      strict,
      driveDiagnostics,
    );

    for (const node of runnable) {
      // Every runnable node either executed or was blocked by the audit
      // above, so this lookup always finds an outcome.
      const outcome = outcomeById.get(node.id);
      if (outcome === undefined) continue;

      if (outcome.status === 'failed' && !graph.tolerateFailure.has(node.id)) sawFailure = true;

      if (outcome.status === 'parked') {
        if (outcome.waitingOn.length === 0) {
          // A contract violation: `parked` must always carry at least one
          // wait condition, or the wave loop would spin forever with no
          // way to know what it's waiting on.
          throw new Error(
            `node "${node.id}" (type "${node.type}") returned status "parked" with an empty waitingOn — contract violation`,
          );
        }
        waitingOn.push(...outcome.waitingOn);
        continue;
      }
      if ((outcome.status === 'completed' || outcome.status === 'failed') && outcome.terminate) {
        terminate = outcome.terminate;
      }
    }

    if (terminate) {
      const finalOutcome = sawFailure ? 'failed' : terminate;
      return await terminateSettle(deps, run.runId, attempt, waitingOn, finalOutcome);
    }
    if (waitingOn.length > 0) {
      const wakeAt = earliestTimerWake(waitingOn);
      return await parkAndReturn(store, run, attempt, waitingOn, wakeAt);
    }

    // Otherwise loop again: this wave's completions may unblock more nodes.
    // Livelock guard: a well-behaved wave that ran ≥1 node either produces
    // a new terminal checkpoint (progress the next pass's runnable/skip
    // computation can build on) or reports a wait condition above. A
    // future executor that returns `completed` without writing its
    // checkpoint (or otherwise fails to move a node off `intent`/absent)
    // would otherwise spin this loop forever.
    const cpAfterWave = await loadCheckpoints(store, runId, definition);
    const madeProgress = runnable.some((node) => {
      const cp = cpAfterWave.get(node.id);
      return cp !== undefined && cp.status !== 'intent';
    });
    if (!madeProgress) {
      throw new Error(
        `workflow livelock: wave executed ${runnable.length} runnable node(s) (${runnable
          .map((n) => n.id)
          .join(', ')}) but produced no new terminal checkpoint and no waitingOn`,
      );
    }
  }
}

// ─── Cancel + settle ─────────────────────────────────────────────────────────

async function cancelRun(run: WorkflowRun, attempt: number, deps: InterpreterDeps): Promise<RunParkState> {
  const { store, engine, clock } = deps;
  for (const wait of run.waitingOn) {
    if (wait.kind === 'submission') {
      await engine.abort(wait.sessionId, wait.threadId, wait.queueItemId);
    }
    if (wait.kind === 'run') {
      await cancelChildRun(store, wait.runId, clock);
    }
  }
  return await twoPhaseSettle(deps, run.runId, attempt, 'cancelled');
}

/** Cancel propagation to a sub-workflow run: same durable signal + wake the host's own `terminate()` writes. */
async function cancelChildRun(store: WorkflowStore, childRunId: string, clock: () => number): Promise<void> {
  await store.insertSignal({
    runId: childRunId,
    signalId: 'cancel',
    signalType: 'cancel',
    createdAt: clock(),
  });
  await store.requestWake(childRunId);
}

/**
 * Resume settlement for a run reclaimed while `terminalizing`: the outcome
 * was already reserved by the crashed attempt's `beginTerminalize` call, so
 * this only re-runs terminal cleanup (no-op this task) and finalizes via
 * `settleRun`, which is idempotent. Never touches checkpoints or recomputes
 * the runnable set.
 */
async function resumeTerminalize(deps: InterpreterDeps, run: WorkflowRun): Promise<RunParkState> {
  if (run.outcome === undefined) {
    throw new Error(`workflow run ${run.runId} is terminalizing with no reserved outcome`);
  }
  // Terminal cleanup hook: no-op this task. See `twoPhaseSettle`.
  return await finalizeSettle(deps, run.runId, run.outcome);
}

/**
 * Settle a run that terminated via a `stop` node's `terminate` signal.
 * Mirrors `cancelRun`: any submission wait accumulated by sibling
 * executors in the same wave (parked while the terminating node also ran)
 * must be aborted so the dispatched work doesn't keep running after the
 * workflow has settled.
 */
async function terminateSettle(
  deps: InterpreterDeps,
  runId: string,
  attempt: number,
  waitingOn: RunWaitCondition[],
  outcome: 'completed' | 'failed',
): Promise<RunParkState> {
  const { store, engine, clock } = deps;
  for (const wait of waitingOn) {
    if (wait.kind === 'submission') {
      await engine.abort(wait.sessionId, wait.threadId, wait.queueItemId);
    }
    if (wait.kind === 'run') {
      await cancelChildRun(store, wait.runId, clock);
    }
  }
  return await twoPhaseSettle(deps, runId, attempt, outcome);
}

async function twoPhaseSettle(
  deps: InterpreterDeps,
  runId: string,
  attempt: number,
  outcome: 'completed' | 'failed' | 'cancelled',
): Promise<RunParkState> {
  const { store, onBeginTerminalize } = deps;
  await store.beginTerminalize(runId, attempt, outcome);
  // Decision 20's crash-point hook: `LocalRunHost` wires this to simulate a
  // process crash right after the outcome is reserved but before terminal
  // cleanup/finalization run. A throw here (the test-injected `exit`) must
  // propagate out of `driveUntilPark` uncaught by this function — the run
  // is left `terminalizing`, exactly like a real crash.
  await onBeginTerminalize?.();
  // Terminal cleanup hook: no-op this task. Later tasks (spawned-session
  // teardown, trace finalization) run here, between reserving the
  // outcome and finalizing it.
  return await finalizeSettle(deps, runId, outcome);
}

/**
 * The single exit from a settled run, shared by `twoPhaseSettle` and the
 * `resumeTerminalize` reclaim path: finalize the reserved outcome, wake a
 * sub-workflow run's parent, then report the settle to the host.
 *
 * One `store.getRun` serves all three consumers — the parent linkage, the
 * report payload, and the returned park state — where the two helpers this
 * replaced each made their own round trip.
 *
 * Order is load-bearing.
 *   1. `settleRun` first: nothing may observe a settle the store has not
 *      committed.
 *   2. The parent wake next (batch-fanout design decision 1): a
 *      sub-workflow run's settlement is its parent's wake signal, so the
 *      parked `workflow` node re-drives promptly. Best-effort — the host's
 *      lost-wake sweep independently wakes parents whose `run` wait names a
 *      settled child.
 *   3. `onRunSettled` last (decision 4), so a slow or throwing host handler
 *      can never strand a parked parent.
 */
async function finalizeSettle(
  deps: InterpreterDeps,
  runId: string,
  outcome: 'completed' | 'failed' | 'cancelled',
): Promise<RunParkState> {
  return settleAndNotify(deps.store, deps.onRunSettled, runId, outcome);
}

/**
 * The settle sequence above, exported for the host's poisoned-run cap
 * (local-host.ts): a run whose drive throws deterministically on every
 * reclaim must exit through the SAME door as a normal settle — store
 * commit, parent wake, host report, in that order — or its parent parks
 * forever and the UI never learns the run died.
 */
export async function settleAndNotify(
  store: WorkflowStore,
  onRunSettled: OnRunSettled | undefined,
  runId: string,
  outcome: 'completed' | 'failed' | 'cancelled',
): Promise<RunParkState> {
  await store.settleRun(runId, outcome);

  const run = await store.getRun(runId);
  if (!run) throw new Error(`workflow run vanished mid-drive: ${runId}`);

  const { parentRunId, parentNodeId, parentIteration } = run.params;
  if (parentRunId !== undefined) await store.requestWake(parentRunId);

  await onRunSettled?.({
    runId: run.runId,
    workflowId: run.params.workflowId,
    outcome,
    owner: run.owner,
    parentRunId,
    parentNodeId,
    parentIteration,
    settledAt: run.updatedAt,
  });

  return parkStateOf(run);
}

async function parkAndReturn(
  store: WorkflowStore,
  run: WorkflowRun,
  attempt: number,
  waitingOn: RunWaitCondition[],
  wakeAt: number | undefined,
): Promise<RunParkState> {
  await store.parkRun(run.runId, attempt, waitingOn, wakeAt);
  return await mustGetParkState(store, run.runId);
}

async function mustGetParkState(store: WorkflowStore, runId: string): Promise<RunParkState> {
  const run = await store.getRun(runId);
  if (!run) throw new Error(`workflow run vanished mid-drive: ${runId}`);
  return parkStateOf(run);
}

/** The `RunParkState` view of a run row — the park/ownership fields only. */
function parkStateOf(run: WorkflowRun): RunParkState {
  return {
    runId: run.runId,
    status: run.status,
    outcome: run.outcome,
    waitingOn: run.waitingOn,
    ownerId: run.ownerId,
    leaseExpiresAt: run.leaseExpiresAt,
    updatedAt: run.updatedAt,
  };
}

function earliestTimerWake(waitingOn: RunWaitCondition[]): number | undefined {
  let min: number | undefined;
  for (const wait of waitingOn) {
    if (wait.kind !== 'timer') continue;
    min = min === undefined ? wait.wakeAt : Math.min(min, wait.wakeAt);
  }
  return min;
}

// ─── Wave execution ──────────────────────────────────────────────────────────

/** Concurrent executors per wave. Bounds fan-in load, not correctness. */
const WAVE_CONCURRENCY = 5;

/**
 * Runs every node's executor with bounded concurrency and returns their
 * outcomes indexed like `runnable`. An executor throw (fence error,
 * contract violation) propagates — after every in-flight executor has
 * settled, so no write from this wave is left mid-air when the drive
 * aborts.
 */
async function executeWave(
  runnable: WorkflowNode[],
  executors: NodeExecutorRegistry,
  argsFor: (node: WorkflowNode) => Omit<NodeExecutorArgs, 'node'>,
): Promise<NodeExecuteResult[]> {
  const outcomes: NodeExecuteResult[] = new Array<NodeExecuteResult>(runnable.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(WAVE_CONCURRENCY, runnable.length) }, async () => {
    while (true) {
      const idx = next++;
      if (idx >= runnable.length) return;
      const node = runnable[idx];
      outcomes[idx] = await invokeExecutorTraced(node, executors, argsFor(node));
    }
  });
  const settled = await Promise.allSettled(workers);
  const rejected = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected');
  if (rejected) throw rejected.reason;
  return outcomes;
}

// ─── Template diagnostics ────────────────────────────────────────────────────

/**
 * Fail a node whose templates read paths that do not resolve, under
 * `policy.onUnresolvedPath: "fail"`.
 *
 * Writes the same intent-then-terminal pair an executor would, so the node
 * has an ordinary `failed` checkpoint: failure dominance, `onError:
 * "continue"`, and the run list all keep working without knowing why it
 * failed. The node's own executor never runs, so nothing was sent with a
 * hole in it.
 */
async function failUnresolvedPaths(
  store: WorkflowStore,
  run: WorkflowRun,
  nodeId: string,
  attempt: number,
  clock: () => number,
  diagnostics: TemplatePathDiagnostic[],
): Promise<NodeExecuteResult> {
  const error =
    `unresolved template path(s); this workflow sets policy.onUnresolvedPath to "fail":\n` +
    diagnostics.map((d) => `- ${d.message}`).join('\n');
  await store.putIntent({
    runId: run.runId,
    nodeId,
    iteration: ITERATION,
    status: 'intent',
    attempt,
    createdAt: clock(),
  });
  const terminal: NodeCheckpoint = {
    runId: run.runId,
    nodeId,
    iteration: ITERATION,
    status: 'failed',
    error,
    attempt,
    createdAt: clock(),
  };
  await store.completeCheckpoint(run.runId, nodeId, ITERATION, attempt, terminal);
  return { status: 'failed', error };
}

/**
 * One list from the pre-wave audit and the executors' own recorders.
 *
 * The audit sees a node's fields; a recorder sees whatever the node
 * actually rendered, including a `foreach` body's templates. They overlap
 * on ordinary nodes, so a path already reported with its field name wins —
 * the field is the part an author needs to find the text to edit.
 */
function mergeDiagnostics(
  audited: TemplatePathDiagnostic[],
  recorded: Map<string, TemplatePathDiagnostic[]>,
): TemplatePathDiagnostic[] {
  const merged = [...audited];
  const seen = new Set(audited.map((d) => `${d.nodeId}|${d.path}`));
  for (const diagnostics of recorded.values()) {
    for (const diagnostic of diagnostics) {
      const key = `${diagnostic.nodeId}|${diagnostic.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(diagnostic);
    }
  }
  return merged;
}

/**
 * Put the wave's findings where someone can read them: on the drive span
 * for anyone reading traces, and through `onTemplateDiagnostics` for the
 * host that persists them against the run.
 *
 * The span attributes are cumulative for the whole drive, so a later wave
 * never overwrites an earlier wave's finding with a shorter list.
 */
async function reportDiagnostics(
  deps: InterpreterDeps,
  run: WorkflowRun,
  attempt: number,
  span: Span,
  diagnostics: TemplatePathDiagnostic[],
  enforced: boolean,
  driveTotal: TemplatePathDiagnostic[],
): Promise<void> {
  if (diagnostics.length === 0) return;
  driveTotal.push(...diagnostics);
  span.setAttribute('valet.workflow.template.unresolved', driveTotal.length);
  span.setAttribute(
    'valet.workflow.template.unresolved_paths',
    [...new Set(driveTotal.map((d) => `${d.nodeId}.${d.field ?? '*'}:${d.path}`))],
  );
  if (deps.onTemplateDiagnostics === undefined) return;
  try {
    await deps.onTemplateDiagnostics({
      runId: run.runId,
      workflowId: run.params.workflowId,
      attempt,
      diagnostics,
      enforced,
    });
  } catch {
    // Best-effort by contract: a reporting failure must not abandon the
    // drive's lease. The findings stay on the span either way.
  }
}

// ─── Executor dispatch ───────────────────────────────────────────────────────

/**
 * Wraps one executor invocation in a `workflow.node.{type}` span. The span
 * records the node's terminal disposition for this wave (`completed` /
 * `failed` / `parked`); a `failed` outcome marks the span ERROR with the
 * executor's error message. Executor throws (fence errors, contract
 * violations) propagate — `withSpan` records them as ERROR and rethrows.
 *
 * A completed `llm` node also gets its usage/cost attached as span
 * attributes, so per-node cost is visible in traces without a DB join.
 * Usage on a *failed* llm node (a repair round that billed a real call
 * before validation failed it) isn't mirrored here — it's persisted in
 * the node's checkpoint `effects` for cost reconciliation, but the
 * `NodeExecuteResult` the trace wrapper sees on failure carries no usage
 * (see `llm.ts`'s `fail()`), and giving the shared, node-type-agnostic
 * result type an llm-specific field isn't worth it for that one path.
 */
async function invokeExecutorTraced(
  node: WorkflowNode,
  executors: NodeExecutorRegistry,
  argsBase: Omit<NodeExecutorArgs, 'node'>,
): Promise<NodeExecuteResult> {
  return await withSpan(
    `workflow.node.${node.type}`,
    {
      'valet.workflow.id': argsBase.run.params.workflowId,
      'valet.workflow.run.id': argsBase.run.runId,
      'valet.workflow.run.attempt': argsBase.attempt,
      'valet.workflow.node.id': node.id,
      'valet.workflow.node.type': node.type,
      'valet.workflow.node.iteration': argsBase.iteration,
    },
    async (span) => {
      const outcome = await invokeExecutor(node, executors, argsBase);
      span.setAttribute('valet.workflow.node.status', outcome.status);
      if (outcome.status === 'failed') markSpanError(span, outcome.error);
      if (node.type === 'llm' && outcome.status === 'completed') {
        const usageAttrs = llmUsageSpanAttributes(outcome.result);
        if (usageAttrs) {
          for (const [key, value] of Object.entries(usageAttrs)) span.setAttribute(key, value);
        }
      }
      return outcome;
    },
  );
}

/**
 * Switches on `node.type` so each branch narrows `node` via the
 * discriminated union and looks up the matching registry slot with a
 * matching-generic executor — no `as` cast bridges `WorkflowNode` back to
 * a specific node interface.
 */
async function invokeExecutor(
  node: WorkflowNode,
  executors: NodeExecutorRegistry,
  argsBase: Omit<NodeExecutorArgs, 'node'>,
): Promise<NodeExecuteResult> {
  switch (node.type) {
    case 'trigger':
      return requireExecutor(executors.trigger, node).execute({ ...argsBase, node });
    case 'set':
      return requireExecutor(executors.set, node).execute({ ...argsBase, node });
    case 'if':
      return requireExecutor(executors.if, node).execute({ ...argsBase, node });
    case 'wait':
      return requireExecutor(executors.wait, node).execute({ ...argsBase, node });
    case 'approval':
      return requireExecutor(executors.approval, node).execute({ ...argsBase, node });
    case 'session':
      return requireExecutor(executors.session, node).execute({ ...argsBase, node });
    case 'stop':
      return requireExecutor(executors.stop, node).execute({ ...argsBase, node });
    case 'foreach':
      return requireExecutor(executors.foreach, node).execute({ ...argsBase, node });
    case 'llm':
      return requireExecutor(executors.llm, node).execute({ ...argsBase, node });
    case 'thread':
      return requireExecutor(executors.thread, node).execute({ ...argsBase, node });
    case 'tool':
      return requireExecutor(executors.tool, node).execute({ ...argsBase, node });
    case 'workflow':
      return requireExecutor(executors.workflow, node).execute({ ...argsBase, node });
  }
}

function requireExecutor<T>(executor: T | undefined, node: WorkflowNode): T {
  if (!executor) {
    throw new Error(`no executor registered for node type "${node.type}" (node "${node.id}")`);
  }
  return executor;
}

// ─── Checkpoint indexing ─────────────────────────────────────────────────────

/**
 * Loads the run's iteration-0 checkpoints, scoped to node ids that appear
 * in `definition.nodes`. A `foreach` body's checkpoints also land at
 * iteration 0 (item 0), keyed by the body's own node id — filtering to
 * definition-node ids here keeps that body state out of every downstream
 * consumer (failure-dominance scans, `buildTemplateContext`, the runnable
 * computation) in one place, rather than requiring each consumer to
 * re-derive the same filter.
 */
async function loadCheckpoints(
  store: WorkflowStore,
  runId: string,
  definition: WorkflowDefinition,
): Promise<Map<string, NodeCheckpoint>> {
  const definitionNodeIds = new Set(definition.nodes.map((n) => n.id));
  const checkpoints = await store.getCheckpoints(runId);
  const byNode = new Map<string, NodeCheckpoint>();
  for (const cp of checkpoints) {
    if (cp.iteration !== ITERATION) continue;
    if (!definitionNodeIds.has(cp.nodeId)) continue;
    byNode.set(cp.nodeId, cp);
  }
  return byNode;
}

/** Has a terminal (completed/failed/skipped) checkpoint — excluded from both skip-propagation and runnable candidacy. */
function isSettled(cpAll: Map<string, NodeCheckpoint>, nodeId: string): boolean {
  const cp = cpAll.get(nodeId);
  return cp !== undefined && cp.status !== 'intent';
}

// ─── Graph compilation + edge semantics (decision 9) ────────────────────────

interface CompiledGraph {
  incomingByNode: Map<string, WorkflowEdge[]>;
  nodeById: Map<string, WorkflowNode>;
  /** Ids of nodes that declare `onError: "continue"` (batch-fanout design decision 3). */
  tolerateFailure: Set<string>;
}

function compile(definition: WorkflowDefinition): CompiledGraph {
  const incomingByNode = new Map<string, WorkflowEdge[]>();
  const nodeById = new Map<string, WorkflowNode>();
  const tolerateFailure = new Set<string>();
  for (const node of definition.nodes) {
    incomingByNode.set(node.id, []);
    nodeById.set(node.id, node);
    if (toleratesFailure(node)) tolerateFailure.add(node.id);
  }
  for (const edge of definition.edges) {
    incomingByNode.get(edge.to)?.push(edge);
  }
  return { incomingByNode, nodeById, tolerateFailure };
}

/** The switch narrows the union — only `llm`/`tool`/`workflow` carry `onError`. */
function toleratesFailure(node: WorkflowNode): boolean {
  switch (node.type) {
    case 'llm':
    case 'tool':
    case 'workflow':
      return node.onError === 'continue';
    default:
      return false;
  }
}

/**
 * Does any node's failure decide the run's outcome? A node with
 * `onError: "continue"` is excluded: its failure is recorded on its own
 * checkpoint, but the run settles on what the rest of the graph did.
 */
function hasDominatingFailure(cpAll: Map<string, NodeCheckpoint>, graph: CompiledGraph): boolean {
  for (const [nodeId, cp] of cpAll) {
    if (cp.status === 'failed' && !graph.tolerateFailure.has(nodeId)) return true;
  }
  return false;
}

/** An edge is resolved when its source has a terminal checkpoint (completed/failed/skipped). */
function edgeResolved(edge: WorkflowEdge, cpAll: Map<string, NodeCheckpoint>): boolean {
  return isSettled(cpAll, edge.from);
}

/**
 * An edge is active when its source `completed` AND (no `fromOutput` or it
 * matches the source's boolean output) AND (no `when` or it evaluates
 * truthy). A `skipped` source never activates an outgoing edge, and
 * neither does a `failed` one unless the node declares
 * `onError: "continue"` (batch-fanout design decision 3).
 */
function edgeActive(
  edge: WorkflowEdge,
  graph: CompiledGraph,
  cpAll: Map<string, NodeCheckpoint>,
  templateContext: TemplateContext,
): boolean {
  const source = cpAll.get(edge.from);
  if (!source) return false;
  const tolerated = source.status === 'failed' && graph.tolerateFailure.has(edge.from);
  if (source.status !== 'completed' && !tolerated) return false;

  if (edge.fromOutput !== undefined) {
    // `fromOutput` only leaves `if`/`approval` nodes, and neither carries
    // `onError` — so a tolerated source cannot legitimately reach here.
    // A failed node has no boolean output to match either way.
    if (tolerated) return false;
    const sourceType = graph.nodeById.get(edge.from)?.type;
    const actual = booleanOutputOf(source.result, sourceType);
    if (actual === undefined) return false;
    return actual === (edge.fromOutput === 'true');
  }

  if (edge.when !== undefined) {
    try {
      const ast = parseExpression(edge.when);
      return truthy(evaluateExpression(ast, templateContext));
    } catch (err) {
      if (err instanceof TemplateParseError || err instanceof TemplateEvalError) return false;
      throw err;
    }
  }

  return true;
}

/** `if` → { result: boolean }; `approval` → { approved: boolean };
 * `tool` (policy gates) → boolean-true on any completed result EXCEPT the
 * deny-skip marker { policyDenied: true }. */
function booleanOutputOf(result: unknown, sourceType?: WorkflowNode['type']): boolean | undefined {
  if (result && typeof result === 'object') {
    const r = result as Record<string, unknown>;
    if (typeof r.result === 'boolean') return r.result;
    if (typeof r.approved === 'boolean') return r.approved;
    if (sourceType === 'tool') return r.policyDenied !== true;
  }
  if (sourceType === 'tool') return true; // completed with a non-object result
  return undefined;
}

function truthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === 0 || v === '') return false;
  return true;
}

/**
 * Skip nodes whose incoming edges are all resolved but none active.
 * Returns whether anything was skipped (the caller re-derives the
 * runnable set, since a skip can unblock further skip propagation or
 * runnable nodes downstream).
 */
async function propagateSkips(
  store: WorkflowStore,
  run: WorkflowRun,
  definition: WorkflowDefinition,
  graph: CompiledGraph,
  cpAll: Map<string, NodeCheckpoint>,
  attempt: number,
  clock: () => number,
): Promise<boolean> {
  let skippedAny = false;
  // Skipped nodes never add a `completed` entry, so the template context
  // is stable across this pass and can be computed once up front.
  const templateContext = buildTemplateContext(definition, cpAll, graph);
  for (const node of definition.nodes) {
    if (cpAll.has(node.id)) continue; // started (intent or terminal) — never a skip candidate
    const incoming = graph.incomingByNode.get(node.id) ?? [];
    if (incoming.length === 0) continue; // runnable, not skippable
    if (!incoming.every((e) => edgeResolved(e, cpAll))) continue;
    if (incoming.some((e) => edgeActive(e, graph, cpAll, templateContext))) continue;

    await store.putIntent({
      runId: run.runId,
      nodeId: node.id,
      iteration: ITERATION,
      status: 'intent',
      attempt,
      createdAt: clock(),
    });
    const skipped: NodeCheckpoint = {
      runId: run.runId,
      nodeId: node.id,
      iteration: ITERATION,
      status: 'skipped',
      attempt,
      createdAt: clock(),
    };
    await store.completeCheckpoint(run.runId, node.id, ITERATION, attempt, skipped);
    cpAll.set(node.id, skipped);
    skippedAny = true;
  }
  return skippedAny;
}

function computeRunnable(
  definition: WorkflowDefinition,
  graph: CompiledGraph,
  cpAll: Map<string, NodeCheckpoint>,
  templateContext: TemplateContext,
): WorkflowNode[] {
  const runnable: WorkflowNode[] = [];
  for (const node of definition.nodes) {
    if (isSettled(cpAll, node.id)) continue; // terminal — done, not runnable
    const incoming = graph.incomingByNode.get(node.id) ?? [];
    if (incoming.length === 0) {
      runnable.push(node);
      continue;
    }
    if (!incoming.every((e) => edgeResolved(e, cpAll))) continue;
    if (incoming.some((e) => edgeActive(e, graph, cpAll, templateContext))) runnable.push(node);
  }
  return runnable;
}

// ─── Template context (decision 4: `{ trigger, nodes }`, `nodes.<id>.result`) ─

/**
 * A node that failed under `onError: "continue"` contributes
 * `nodes.<id>.error` instead of an output (batch-fanout design decision
 * 3), so a downstream node reached over the tolerated failure can report
 * what broke.
 *
 * Only tolerated failures get an entry. A node that failed under the
 * default policy stays absent, exactly as before decision 3: `exists(nodes
 * .<id>)` and `{{nodes.<id>}}` keep their old values in every definition
 * that does not opt in, and the new surface never appears in a run whose
 * author did not ask for it. Skipped and intent nodes contribute nothing
 * under either policy.
 *
 * A completed node exposes its value under BOTH `result` and `output`.
 * `result` is the documented form — it names the same checkpoint field
 * agents see in `get_node_result`. `output` is the original key, kept so
 * existing definitions keep resolving. Both read the same value.
 */
function buildTemplateContext(
  definition: WorkflowDefinition,
  cpAll: Map<string, NodeCheckpoint>,
  graph: CompiledGraph,
): TemplateContext {
  const nodes: Record<string, { result?: unknown; output?: unknown; error?: string }> = {};
  for (const [nodeId, cp] of cpAll) {
    if (cp.status === 'completed') nodes[nodeId] = { result: cp.result, output: cp.result };
    // Every executor sets `error` on a failed checkpoint. The fallback only
    // keeps `exists(nodes.<id>.error)` honest if one ever does not.
    else if (cp.status === 'failed' && graph.tolerateFailure.has(nodeId)) {
      nodes[nodeId] = { error: cp.error ?? 'node failed' };
    }
  }
  const triggerNode = definition.nodes.find((n) => n.type === 'trigger');
  const trigger = triggerNode ? nodes[triggerNode.id]?.output : undefined;
  return { trigger, nodes };
}
