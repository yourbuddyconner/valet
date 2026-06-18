/**
 * Internal types for the workflow DAG interpreter runtime.
 *
 * These are not user-facing — they're the shapes the interpreter passes
 * between its own pieces (the entrypoint, the wave loop, the per-node
 * executors).
 */

import type { WorkflowStep } from 'cloudflare:workers';
import type {
  WorkflowDefinition,
  WorkflowTriggerPayload,
  WorkflowNode,
  WorkflowNodeOutput,
  WorkflowDagState,
} from '@valet/shared';
import type { Env } from '../env.js';

/**
 * Parameters passed via `WORKFLOW_INTERPRETER.create({ id, params })` from
 * the trigger paths. The interpreter reads everything it needs from here:
 * the trigger payload and the dag/v1 definition snapshot (also
 * persisted on `workflow_executions.definition_snapshot` for the audit
 * trail).
 */
export interface WorkflowRunParams {
  executionId: string;
  workflowId: string;
  userId: string;
  trigger: WorkflowTriggerPayload;
  definition: WorkflowDefinition;
  /** "production" or "test" — drives trace retention and audit tagging. */
  mode?: 'production' | 'test';
}

/**
 * Per-node trace row writer. Backed by the D1 implementation in
 * `trace-writer.ts` against `workflow_execution_nodes`; tests inject a
 * no-op default.
 */
export interface TraceWriter {
  recordTransition(row: TraceTransition): Promise<void>;
}

/**
 * One transition row for a single node in a single workflow execution.
 * Discriminated on `status` so the type system enforces which fields are
 * meaningful per transition (running has no output/error; completed has
 * no error; skipped/failed never have output, etc.).
 */
export type TraceTransition =
  | TraceTransitionRunning
  | TraceTransitionWaiting
  | TraceTransitionCompleted
  | TraceTransitionFailed
  | TraceTransitionSkipped;

interface TraceTransitionBase {
  executionId: string;
  nodeId: string;
  nodeType: string;
  retryAttempts?: number;
  approvalId?: string;
  invocationId?: string;
  /**
   * Foreach iteration index when this transition is for a body node
   * inside a foreach. The trace-writer folds this into the row's
   * primary key so iteration N's waiting/terminal row doesn't
   * overwrite iteration N+1's (same nodeId + status + attempt would
   * otherwise collide). Undefined for top-level nodes.
   */
  iterationIndex?: number;
}

export interface TraceTransitionRunning extends TraceTransitionBase {
  status: 'running';
  startedAt: string;
  inputPreview?: unknown;
}

export interface TraceTransitionWaiting extends TraceTransitionBase {
  status: 'waiting_approval' | 'waiting_time';
  startedAt: string;
}

export interface TraceTransitionCompleted extends TraceTransitionBase {
  status: 'completed';
  startedAt: string;
  completedAt: string;
  durationMs: number;
  output?: unknown;
}

export interface TraceTransitionFailed extends TraceTransitionBase {
  status: 'failed';
  startedAt: string;
  completedAt: string;
  durationMs: number;
  error: string;
}

export interface TraceTransitionSkipped extends TraceTransitionBase {
  status: 'skipped';
  startedAt: string;
  completedAt: string;
  reason: string;
}

/** No-op writer used by tests that don't care about trace rows. Production
 *  paths use the D1-backed writer in trace-writer.ts. */
export const noopTraceWriter: TraceWriter = {
  async recordTransition() { /* no-op */ },
};

/**
 * Per-node executor. Each node type has one. Returns the node's `data`
 * payload (placed at `state.nodes[nodeId].data`). Throws on failure;
 * the runtime catches and records the failure as the node's status.
 */
export type NodeExecutor<N extends WorkflowNode = WorkflowNode> = (
  args: NodeExecutorArgs<N>,
) => Promise<unknown>;

export interface CorrelationIds {
  invocationId?: string;
  approvalId?: string;
}

export interface NodeExecutorArgs<N extends WorkflowNode = WorkflowNode> {
  node: N;
  state: WorkflowDagState;
  params: WorkflowRunParams;
  /** Worker env — LLM keys, DO stubs, R2, D1. Set/stop don't use it; Phase 3+ does. */
  env: Env;
  /** WorkflowStep — for nested step.do retries, sleep on wait, waitForEvent on approvals. */
  step: WorkflowStep;
  /**
   * Template-context aliases merged in by enclosing constructs. The
   * `foreach` executor injects `{ <itemAlias>: <item>, <indexAlias>:
   * <index> }` here when invoking its body.
   */
  aliases?: Record<string, unknown>;
  /**
   * Side channel for executors to surface correlation ids (tool's
   * action_invocations id, approval's workflow_approvals id) that the
   * runtime then attaches to the trace transition row. Executors
   * mutate this object — runtime reads after the executor returns or
   * throws. Trace rows preserve the ids across status updates via
   * COALESCE in trace-writer's ON CONFLICT clause.
   */
  correlations?: CorrelationIds;
  /**
   * Optional callback for executors that suspend on step.sleep /
   * step.waitForEvent to write a `waiting_*` trace row before the
   * suspend point. The runtime wires this through stepDoTrace so the
   * write is cached and survives hibernate/replay. Without this,
   * the execution detail UI sees the node parked in 'running' for
   * the entire wait window. Wait nodes pass status='waiting_time';
   * approval nodes and tool-with-pending-approval pass
   * 'waiting_approval'.
   *
   * Executors omit executionId (the runtime injects it); foreach
   * wrappers may override iterationIndex to scope the trace row to a
   * specific iteration.
   */
  recordWaiting?: (transition: Omit<TraceTransitionWaiting, 'executionId'>) => Promise<void>;
}

/** Convenience type for the runtime's final return value. */
export interface WorkflowRunResult {
  status: 'completed' | 'failed' | 'cancelled';
  state: WorkflowDagState;
  /** Aggregate of any `stop` nodes that completed with output, keyed by node id. */
  stopOutputs?: Record<string, { outcome: 'success' | 'failure'; output?: unknown; message?: string }>;
  /** Every node that failed during the run, in batch-completion order. */
  failures?: Array<{ nodeId: string; message: string }>;
}

/**
 * Compute the foreach iteration suffix from aliases. Returns ":i:N" when
 * the executor is running inside a foreach body, otherwise an empty
 * string. Every step-driven executor APPENDS this to every step.do /
 * step.waitForEvent / step.sleep name so iterations don't share CF cache
 * keys (iteration 0's return would otherwise replay for all items).
 */
export function iterationSuffix(aliases?: Record<string, unknown>): string {
  const idx = aliases?.__iterationIndex;
  return typeof idx === 'number' ? `:i:${idx}` : '';
}

/**
 * Minimum-retry policy for step.do callbacks that perform a
 * non-idempotent external side effect (action execute, DO fetch,
 * createSession, prompt dispatch). CF Workflows requires retries.limit
 * ≥ 1; this is the floor. Without this, CF defaults to 5 retries and
 * non-idempotent actions duplicate on transient failure.
 */
export const NO_RETRY = { limit: 1, delay: '1 second' } as const;

/**
 * Thrown by executors when a system-initiated cancel arrives mid-node
 * (e.g., requestApproval returns result='cancelled'). The runtime
 * recognises this and writes the trace row with reason='cancelled'
 * rather than 'failed' so the audit chain reflects intent.
 */
export class CancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CancelledError';
  }
}

/** Helper for asserting a node's runtime output shape. */
export function makeNodeOutput(
  status: WorkflowNodeOutput['status'],
  data: unknown,
  startedAt: string,
  completedAt: string,
  error?: string,
  metadata?: Record<string, unknown>,
): WorkflowNodeOutput {
  return { status, data, error, startedAt, completedAt, metadata };
}
