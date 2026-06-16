/**
 * Workflow DAG interpreter runtime.
 *
 * Implements the wave loop from spec §"DAG Execution Model". Each node
 * runs inside a deterministic `step.do` so Cloudflare Workflows can
 * hibernate and replay correctly. All persistence (trace rows + node
 * outputs) flows through cached step boundaries — the `run()` function
 * is replayed from the top on every wake, so anything written outside
 * a step.do callback would duplicate on every resume.
 *
 * Node outputs are JSON-only: every value crosses a step.do boundary
 * and round-trips through JSON. Dates become ISO strings, BigInts
 * throw, undefined object fields are dropped. Executors should produce
 * plain JSON-compatible data; Phase 4+ will document this in the
 * executor contract.
 */

import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import type {
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowNode,
  WorkflowDagState,
  WorkflowNodeOutput,
} from '@valet/shared';
import type { Env } from '../env.js';
import {
  parseExpression,
  evaluateExpression,
  TemplateEvalError,
  TemplateParseError,
} from '../lib/workflow-dag/expression.js';
import { buildTemplateContext } from './context.js';
import {
  noopTraceWriter,
  CancelledError,
  NO_RETRY,
  type WorkflowRunParams,
  type WorkflowRunResult,
  type TraceWriter,
  type NodeExecutorArgs,
  type TraceTransition,
} from './types.js';
import { executeApproval } from './nodes/approval.js';
import { executeForeach } from './nodes/foreach.js';
import { executeIf } from './nodes/if.js';
import { executeLlm } from './nodes/llm.js';
import { executeOrchestrator } from './nodes/orchestrator.js';
import { executeSession } from './nodes/session.js';
import { executeSet } from './nodes/set.js';
import { executeStop, StopFailure, type StopOutput } from './nodes/stop.js';
import { executeTool } from './nodes/tool.js';
import { executeWait } from './nodes/wait.js';
import { readExecutionCancelState, setExecutionStatus } from './execution-status.js';

// ─── Entry point ────────────────────────────────────────────────────────────

export async function runWorkflowDag(
  env: Env,
  event: Readonly<WorkflowEvent<WorkflowRunParams>>,
  step: WorkflowStep,
  options: { traceWriter?: TraceWriter } = {},
): Promise<WorkflowRunResult> {
  return runDag(env, event.payload, step, options.traceWriter ?? noopTraceWriter);
}

/**
 * Exported separately so tests can drive the runtime without going
 * through the WorkflowEntrypoint wrapper.
 */
export async function runDag(
  env: Env,
  params: WorkflowRunParams,
  step: WorkflowStep,
  traceWriter: TraceWriter,
): Promise<WorkflowRunResult> {
  const def = params.definition;
  const compiled = compile(def);
  const state: WorkflowDagState = {
    trigger: params.trigger,
    inputs: params.inputs,
    nodes: {},
    skipped: {},
  };

  const stopOutputs: Record<string, StopOutput> = {};
  const settled = new Set<string>();
  const failures: Array<{ nodeId: string; message: string }> = [];
  // Set to true when any node terminates via CancelledError. Drives the
  // terminal status decision: a clean run with cancellations and no
  // genuine failures resolves to 'cancelled', not 'completed'.
  let hadCancelled = false;

  // Persist 'pending → running' before the wave loop starts.
  // The cancel path (workflows/cancel-cleanup.ts) compare-and-swaps on
  // status; we restrict allowedPrior to 'pending' so a concurrent cancel
  // sets the row to 'cancelling' and this no-ops. CRITICAL: if the CAS
  // didn't land, the cancel API already moved the row past 'pending'
  // (most likely to 'cancelling'). We MUST exit before the wave loop —
  // otherwise side-effectful nodes (tools, sessions, orchestrator
  // prompts) would run for a cancelled execution. The runtime returns
  // a 'cancelled' result; the cancel API's terminate() is the durable
  // teardown either way.
  const entered = await setExecutionStatus({
    env, step,
    executionId: params.executionId,
    status: 'running',
    stepKey: 'enter:running',
    allowedPrior: ['pending'],
  });
  if (!entered) {
    return {
      status: 'cancelled',
      state,
    };
  }

  // Wave loop. We do NOT short-circuit on first failure — independent
  // sibling branches keep running, and downstream nodes of a failed
  // parent are marked skipped via the normal edge-unsatisfied path.
  //
  // `waveIter` makes the per-iteration cancel probe's step.do key
  // unique. Each iteration probes the execution row before dispatching
  // anything: if cancel raced us mid-flight (status='cancelling' or
  // 'cancelled'), we stop dispatching new nodes. In-flight steps from
  // the previous batch can't be interrupted from here — CF's
  // instance.terminate() is the durable stop for those — but we won't
  // start fresh side-effects (tool calls, session prompts, etc.).
  let waveIter = 0;
  while (true) {
    const cancelState = await readExecutionCancelState(
      env, step, params.executionId, `wave:${waveIter}`,
    );
    waveIter++;
    if (cancelState.cancelled) {
      hadCancelled = true;
      break;
    }
    const runnable = pickRunnable(def, compiled, settled, state);
    if (runnable.length === 0) {
      // No nodes ready: try to mark anything terminal-but-unreachable as
      // skipped, then re-check. If still nothing runnable, we're done.
      const skippedThisPass = markUnreachableSkipped(def, compiled, settled, state, params, step, traceWriter);
      // markUnreachableSkipped is synchronous bookkeeping that schedules
      // trace writes via step.do (awaited below).
      await Promise.allSettled(skippedThisPass);
      const more = pickRunnable(def, compiled, settled, state);
      if (more.length === 0) break;
      continue;
    }

    const maxConcurrent = def.policy?.maxConcurrentNodes ?? 20;
    const batch = runnable.slice(0, maxConcurrent);

    const results = await Promise.allSettled(batch.map((node) =>
      executeNodeStep(node, params, state, env, step, traceWriter, stopOutputs)));

    for (let i = 0; i < batch.length; i++) {
      const node = batch[i]!;
      const r = results[i]!;
      settled.add(node.id);
      if (r.status === 'fulfilled') {
        state.nodes[node.id] = r.value;
      } else {
        const reason = r.reason;
        if (reason instanceof StopFailure) {
          stopOutputs[node.id] = reason.stopOutput;
          // StopFailure is thrown from inside executeStop (a non-step-
          // driven executor) before executeNodeStep gets to cache
          // started/completed-at. Pull both from a step.do for replay
          // stability of the envelope written to state.nodes.
          const startedAt = await stepDoIso(step, `node:${node.id}:started-at`);
          const completedAt = await stepDoIso(step, `node:${node.id}:completed-at`);
          state.nodes[node.id] = makeOutput('failed', reason.stopOutput.output, reason.stopOutput.message ?? 'stopped with failure', startedAt, completedAt);
          failures.push({ nodeId: node.id, message: reason.stopOutput.message ?? 'stopped with failure' });
        } else if (reason instanceof NodeStepFailure && reason.cause instanceof CancelledError) {
          // System-initiated cancel propagated through the executor.
          // The trace row was already written by executeNodeStep as
          // status='skipped' reason='cancelled'. Reflect the same
          // intent in the state envelope and DO NOT push to failures
          // — a cancellation is not a workflow-author bug.
          state.nodes[node.id] = makeOutput('skipped', undefined, 'cancelled', reason.startedAt, reason.completedAt);
          hadCancelled = true;
        } else if (reason instanceof NodeStepFailure) {
          state.nodes[node.id] = makeOutput('failed', undefined, reason.message, reason.startedAt, reason.completedAt);
          failures.push({ nodeId: node.id, message: reason.message });
        } else {
          // Should not reach: every executeNodeStep failure path wraps
          // in NodeStepFailure. Guard anyway with cached timestamps so
          // replay is still stable.
          const message = reason instanceof Error ? reason.message : String(reason);
          const startedAt = await stepDoIso(step, `node:${node.id}:fallback-started-at`);
          const completedAt = await stepDoIso(step, `node:${node.id}:fallback-completed-at`);
          state.nodes[node.id] = makeOutput('failed', undefined, message, startedAt, completedAt);
          failures.push({ nodeId: node.id, message });
        }
      }
    }
  }

  // Failure dominates cancellation: a genuine error during the run is
  // still a 'failed' execution even if other nodes were cancelled.
  // Otherwise: any cancellation → 'cancelled'; clean run → 'completed'.
  const finalStatus: 'completed' | 'failed' | 'cancelled' = failures.length > 0
    ? 'failed'
    : hadCancelled
      ? 'cancelled'
      : 'completed';
  // Persist terminal status + outputs + first-failure error. The cancel
  // path may have already set status='cancelled' or 'cancelling';
  // allowedPrior excludes those so this no-ops in that case.
  //
  // outputs is keyed `{ [stopNodeId]: { outcome, output?, message? } }`
  // — ONLY the stop-node outputs are persisted. Dumping the full
  // per-node state.nodes envelope would (a) inflate the row past D1
  // cell limits on large runs and (b) leak two different shapes for
  // the same column depending on whether a stop fired. Workflows that
  // finish without a stop get `outputs: {}` — the per-node trace
  // table is the source of truth for granular results.
  await setExecutionStatus({
    env, step,
    executionId: params.executionId,
    status: finalStatus,
    // Stable stepKey: 'terminal' (not 'terminal:${finalStatus}'). The
    // status itself is implied by the row state + allowedPrior CAS; a
    // stepKey that varies with finalStatus would mean different replays
    // could land on different step.do cache slots if any step-driven
    // node produced non-deterministic output. The CAS guard provides
    // idempotency regardless.
    stepKey: 'terminal',
    // 'cancelled' final status is allowed to transition from
    // 'cancelling' too (a concurrent cancel API call may have already
    // moved the row before the wave loop noticed). 'completed' and
    // 'failed' only land from 'running' — if the row is in waiting_*
    // or cancelling, a competing cancel won the race and we should not
    // overwrite that intent.
    allowedPrior: finalStatus === 'cancelled' ? ['running', 'cancelling'] : ['running'],
    outputs: stopOutputs,
    ...(failures.length > 0 ? { error: failures[0]!.message } : {}),
  });

  return {
    status: finalStatus,
    state,
    stopOutputs: Object.keys(stopOutputs).length > 0 ? stopOutputs : undefined,
    failures: failures.length > 0 ? failures : undefined,
  };
}

// ─── Compilation ────────────────────────────────────────────────────────────

interface CompiledGraph {
  nodesById: Map<string, WorkflowNode>;
  incomingByNode: Map<string, WorkflowEdge[]>;
  outgoingByNode: Map<string, WorkflowEdge[]>;
}

function compile(def: WorkflowDefinition): CompiledGraph {
  const nodesById = new Map<string, WorkflowNode>();
  for (const node of def.nodes) nodesById.set(node.id, node);

  const incomingByNode = new Map<string, WorkflowEdge[]>();
  const outgoingByNode = new Map<string, WorkflowEdge[]>();
  for (const node of def.nodes) {
    incomingByNode.set(node.id, []);
    outgoingByNode.set(node.id, []);
  }
  for (const edge of def.edges) {
    incomingByNode.get(edge.to)?.push(edge);
    outgoingByNode.get(edge.from)?.push(edge);
  }

  return { nodesById, incomingByNode, outgoingByNode };
}

// ─── Wave loop helpers ──────────────────────────────────────────────────────

function pickRunnable(
  def: WorkflowDefinition,
  compiled: CompiledGraph,
  settled: Set<string>,
  state: WorkflowDagState,
): WorkflowNode[] {
  const out: WorkflowNode[] = [];
  for (const node of def.nodes) {
    if (settled.has(node.id)) continue;
    if (shouldRun(node, compiled, settled, state)) {
      out.push(node);
    }
  }
  return out;
}

function shouldRun(
  node: WorkflowNode,
  compiled: CompiledGraph,
  settled: Set<string>,
  state: WorkflowDagState,
): boolean {
  const incoming = compiled.incomingByNode.get(node.id) ?? [];
  if (incoming.length === 0) return true;
  for (const edge of incoming) {
    if (!settled.has(edge.from)) return false;
  }
  return incoming.some((edge) => edgeSatisfied(edge, state));
}

function edgeSatisfied(edge: WorkflowEdge, state: WorkflowDagState): boolean {
  const parent = state.nodes[edge.from];
  if (!parent || parent.status !== 'completed') return false;

  if (edge.fromOutput !== undefined) {
    const data = parent.data as { result?: boolean } | undefined;
    const want = edge.fromOutput === 'true';
    return data?.result === want;
  }

  if (edge.when !== undefined) {
    // A `when` parse / eval error means either the definition skipped
    // validation or the runtime data shape diverged from the author's
    // expectations. Catch here and treat as unsatisfied so the workflow
    // doesn't crash from inside the wave-loop helper (which runs
    // outside the per-node try/catch). The error is stashed on state
    // so markUnreachableSkipped can surface it in the trace row's
    // reason — otherwise a downstream node is silently skipped with
    // no visibility into why.
    try {
      const ast = parseExpression(edge.when);
      const result = evaluateExpression(ast, buildTemplateContext(state));
      return truthy(result);
    } catch (err) {
      if (err instanceof TemplateParseError || err instanceof TemplateEvalError) {
        const msg = `edge ${edge.from}→${edge.to} when="${edge.when}" failed: ${err.message}`;
        console.error(`[workflow-dag] ${msg}`);
        // Capture only the FIRST error per downstream node. Concatenating
        // on every replay would grow unbounded for workflows that
        // hibernate many times — trace truncation is at the row, but
        // the in-memory state object stays in this process.
        if (!state.edgeErrors) state.edgeErrors = {};
        if (state.edgeErrors[edge.to] === undefined) {
          state.edgeErrors[edge.to] = msg;
        }
        return false;
      }
      throw err;
    }
  }

  return true;
}

function truthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === 0 || v === '') return false;
  return true;
}

/**
 * Mark nodes whose inbound edges are all unsatisfied (with terminal
 * parents) as skipped. Asserts the defensive invariant: every incoming
 * edge's parent must already be settled before we skip the child.
 * Returns the trace-write promises so the caller can await them.
 */
function markUnreachableSkipped(
  def: WorkflowDefinition,
  compiled: CompiledGraph,
  settled: Set<string>,
  state: WorkflowDagState,
  params: WorkflowRunParams,
  step: WorkflowStep,
  traceWriter: TraceWriter,
): Array<Promise<void>> {
  const pending: Array<Promise<void>> = [];
  for (const node of def.nodes) {
    if (settled.has(node.id)) continue;
    const incoming = compiled.incomingByNode.get(node.id) ?? [];
    const allParentsSettled = incoming.length === 0 || incoming.every((edge) => settled.has(edge.from));
    if (!allParentsSettled) continue;
    const anySatisfied = incoming.some((edge) => edgeSatisfied(edge, state));
    if (anySatisfied) continue;
    // Defensive: if a future bug leaves a node here with un-settled
    // parents, throwing is preferable to a spurious skip.
    if (!allParentsSettled) {
      throw new Error(`internal: cannot skip node "${node.id}" with un-settled parents`);
    }
    const edgeError = state.edgeErrors?.[node.id];
    const reason = edgeError ?? 'no inbound edge satisfied';
    state.skipped[node.id] = { reason };
    settled.add(node.id);
    pending.push(writeSkippedTrace(node, params, step, traceWriter, reason));
  }
  return pending;
}

async function writeSkippedTrace(
  node: WorkflowNode,
  params: WorkflowRunParams,
  step: WorkflowStep,
  traceWriter: TraceWriter,
  reason: string,
): Promise<void> {
  const at = await stepDoIso(step, `node:${node.id}:skipped-at`);
  await stepDoTrace(step, `trace:${node.id}:skipped`, traceWriter, {
    executionId: params.executionId,
    nodeId: node.id,
    nodeType: node.type,
    status: 'skipped',
    startedAt: at,
    completedAt: at,
    reason,
  });
}

// ─── Per-node execution ─────────────────────────────────────────────────────

// Nodes whose executors drive their own step.sleep / step.waitForEvent
// / step.do (per-iteration) primitives. Per spec §"DAG Execution Model"
// L357-365, these primitives are alternatives to step.do, not nestable
// inside one. We skip the outer step.do wrapper for these node types
// and let the executor's internal step primitives provide replay
// caching.
/**
 * Wraps a node-executor failure with the replay-stable startedAt and
 * completedAt captured inside step.do, so the outer wave loop can
 * rebuild a complete WorkflowNodeOutput envelope without a second
 * clock read.
 */
class NodeStepFailure extends Error {
  constructor(
    public readonly cause: unknown,
    public readonly startedAt: string,
    public readonly completedAt: string,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'NodeStepFailure';
  }
}

export function isStepDrivenNode(node: WorkflowNode): boolean {
  return STEP_DRIVEN_NODE_TYPES.has(node.type);
}

const STEP_DRIVEN_NODE_TYPES = new Set<WorkflowNode['type']>([
  'wait',
  'approval',
  'foreach',
  'session',
  'orchestrator',
  // tool is step-driven so its own internal step.do calls (invocation
  // row, action execution, credential resolution) drive replay caching
  // at the right granularity. Wrapping the executor in an outer
  // step.do AND letting it call inner step.do would nest (CF rejects).
  'tool',
]);

// NO_RETRY lives in types.ts as the canonical source. Side-effectful
// executors import it directly; the runtime wires it into the outer
// step.do wrap for non-step-driven nodes that perform external calls
// (currently llm — set/if/stop are pure).

async function executeNodeStep(
  node: WorkflowNode,
  params: WorkflowRunParams,
  state: WorkflowDagState,
  env: Env,
  step: WorkflowStep,
  traceWriter: TraceWriter,
  _stopOutputs: Record<string, StopOutput>,
): Promise<WorkflowNodeOutput> {
  const stepName = `node:${node.id}`;
  // Wrap clock reads in step.do so replays return the cached first-run
  // value. Without this, hibernation/wake recomputes the timestamp on
  // every replay and trace rows drift.
  const startedAt = await stepDoIso(step, `node:${node.id}:started-at`);
  // Side-channel where executors can surface invocationId/approvalId
  // so every trace transition for this node carries the correlation id.
  const correlations: { invocationId?: string; approvalId?: string } = {};

  // Trace transitions go through their own step.do so they're cached
  // by Cloudflare Workflows and don't duplicate on hibernation replay.
  // correlations is empty on the running transition; later transitions
  // (completed/failed) may include the invocation/approval id once the
  // executor surfaces it. trace-writer COALESCEs columns on conflict so
  // a later UPDATE doesn't clobber the running row's nulls in reverse.
  await stepDoTrace(step, `trace:${node.id}:running`, traceWriter, {
    executionId: params.executionId,
    nodeId: node.id,
    nodeType: node.type,
    status: 'running',
    startedAt,
  });

  // Callback executors invoke when they're about to suspend (step.sleep
  // for wait nodes, step.waitForEvent for approval / tool-with-policy).
  // Writes a `waiting_*` trace row through stepDoTrace so the execution
  // detail UI can show the node's actual state during the wait. The
  // step.do key includes the status + iteration suffix so concurrent
  // waiting transitions across foreach iterations don't collide.
  const recordWaiting: NodeExecutorArgs['recordWaiting'] = async (transition) => {
    const iterSuffix = typeof transition.iterationIndex === 'number'
      ? `:i:${transition.iterationIndex}` : '';
    await stepDoTrace(
      step,
      `trace:${transition.nodeId}${iterSuffix}:${transition.status}`,
      traceWriter,
      {
        executionId: params.executionId,
        ...transition,
        // Surface top-level correlation ids when the executor didn't
        // override them. The running row was written with NULLs and a
        // waiting-for-approval node wants the approvalId visible while
        // the approval is still pending (otherwise the trace can't be
        // linked back to the row).
        ...(transition.invocationId
          ? { invocationId: transition.invocationId }
          : correlations.invocationId
            ? { invocationId: correlations.invocationId }
            : {}),
        ...(transition.approvalId
          ? { approvalId: transition.approvalId }
          : correlations.approvalId
            ? { approvalId: correlations.approvalId }
            : {}),
      },
    );
  };

  const stepDriven = STEP_DRIVEN_NODE_TYPES.has(node.type);
  try {
    // step.do enforces a Serializable<T> constraint at the type level
    // that `unknown` doesn't satisfy. We serialize inside the step and
    // parse outside — matching Cloudflare's actual runtime behavior
    // (it serializes anyway). NB: Dates become ISO strings on
    // round-trip, undefined object fields are dropped, BigInt throws.
    //
    // For step-driven nodes (wait/approval/foreach/session/orchestrator)
    // we bypass the outer step.do and call the executor directly. The
    // executor's own step.sleep / step.waitForEvent / nested step.do
    // primitives provide replay caching at the right granularity.
    let data: unknown;
    if (stepDriven) {
      // step-driven executors own their own step.do / step.sleep /
      // step.waitForEvent calls so replay caching happens at the
      // right granularity for waits, approvals, and external side
      // effects. No outer step.do (CF rejects nested step.do).
      data = await dispatchNode(node, { node, state, params, env, step, correlations, recordWaiting });
    } else {
      // llm is the only side-effectful non-step-driven executor today.
      // Wrap with NO_RETRY so a transient model error doesn't fire a
      // 5x retry storm (the default CF policy) — duplicates billed
      // model calls and re-renders user-visible content.
      const stepConfig = node.type === 'llm' ? { retries: { ...NO_RETRY } } : undefined;
      const callback = async () => {
        const out = await dispatchNode(node, { node, state, params, env, step, correlations, recordWaiting });
        return JSON.stringify(out ?? null);
      };
      const json = stepConfig
        ? await step.do(stepName, stepConfig, callback)
        : await step.do(stepName, callback);
      data = JSON.parse(json) as unknown;
    }
    const completedAt = await stepDoIso(step, `node:${node.id}:completed-at`);
    const output = makeOutput('completed', data, undefined, startedAt, completedAt);
    await stepDoTrace(step, `trace:${node.id}:completed`, traceWriter, {
      executionId: params.executionId,
      nodeId: node.id,
      nodeType: node.type,
      status: 'completed',
      output: data,
      startedAt,
      completedAt,
      durationMs: timeDiffMs(startedAt, completedAt),
      ...(correlations.invocationId ? { invocationId: correlations.invocationId } : {}),
      ...(correlations.approvalId ? { approvalId: correlations.approvalId } : {}),
    });
    return output;
  } catch (err) {
    const completedAt = await stepDoIso(step, `node:${node.id}:failed-at`);
    const message = err instanceof Error ? err.message : String(err);
    // CancelledError is a system-cancel signal; write a skipped trace
    // with reason='cancelled' so the audit chain reflects intent
    // (not a workflow-author bug).
    if (err instanceof CancelledError) {
      await stepDoTrace(step, `trace:${node.id}:skipped`, traceWriter, {
        executionId: params.executionId,
        nodeId: node.id,
        nodeType: node.type,
        status: 'skipped',
        startedAt,
        completedAt,
        reason: 'cancelled',
        ...(correlations.invocationId ? { invocationId: correlations.invocationId } : {}),
        ...(correlations.approvalId ? { approvalId: correlations.approvalId } : {}),
      });
      throw new NodeStepFailure(err, startedAt, completedAt);
    }
    await stepDoTrace(step, `trace:${node.id}:failed`, traceWriter, {
      executionId: params.executionId,
      nodeId: node.id,
      nodeType: node.type,
      status: 'failed',
      error: message,
      startedAt,
      completedAt,
      durationMs: timeDiffMs(startedAt, completedAt),
      ...(correlations.invocationId ? { invocationId: correlations.invocationId } : {}),
      ...(correlations.approvalId ? { approvalId: correlations.approvalId } : {}),
    });
    // StopFailure is a special signal handled by the outer wave loop;
    // pass it through untouched so the stopOutputs map is populated.
    if (err instanceof StopFailure) throw err;
    throw new NodeStepFailure(err, startedAt, completedAt);
  }
}

/**
 * Cache the trace write through step.do so it only happens once per
 * status transition regardless of how many times the workflow is
 * replayed.
 */
async function stepDoTrace(
  step: WorkflowStep,
  stepName: string,
  traceWriter: TraceWriter,
  transition: TraceTransition,
): Promise<void> {
  await step.do(stepName, async () => {
    await traceWriter.recordTransition(transition);
    return null;
  });
}

/**
 * Dispatch a single node to its executor. Foreach calls this directly
 * to run its body so it inherits the same per-type contract; top-level
 * nodes go through executeNodeStep which wraps this in trace + step.do.
 */
export async function dispatchNode(node: WorkflowNode, args: NodeExecutorArgs): Promise<unknown> {
  switch (node.type) {
    case 'set':
      return executeSet({ ...args, node });
    case 'stop':
      return executeStop({ ...args, node });
    case 'if':
      return executeIf({ ...args, node });
    case 'wait':
      return executeWait({ ...args, node });
    case 'llm':
      return executeLlm({ ...args, node });
    case 'foreach':
      return executeForeach({ ...args, node });
    case 'tool':
      return executeTool({ ...args, node });
    case 'orchestrator':
      return executeOrchestrator({ ...args, node });
    case 'session':
      return executeSession({ ...args, node });
    case 'approval':
      return executeApproval({ ...args, node });
    default: {
      // Unreachable when validation is correct; loud failure if a
      // definition slips past the validator with an unknown node type.
      const exhaustive: never = node;
      throw new Error(`Unknown node type: ${JSON.stringify((exhaustive as { type?: unknown }).type)}`);
    }
  }
}


// ─── Small helpers ──────────────────────────────────────────────────────────

/**
 * Capture a wall-clock ISO timestamp inside step.do so the value is
 * replay-stable. CF Workflows caches step.do results across hibernate/
 * wake; calling new Date().toISOString() outside step.do would return
 * a different value on every replay.
 */
async function stepDoIso(step: WorkflowStep, stepName: string): Promise<string> {
  return step.do(stepName, async () => new Date().toISOString());
}

function timeDiffMs(startedAt: string, completedAt: string): number {
  return new Date(completedAt).getTime() - new Date(startedAt).getTime();
}

function makeOutput(
  status: WorkflowNodeOutput['status'],
  data: unknown,
  error: string | undefined,
  startedAt: string,
  completedAt: string,
): WorkflowNodeOutput {
  return { status, data, error, startedAt, completedAt };
}
