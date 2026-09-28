/**
 * Node executor contract + registry (Phase 5 plan decisions 8, 10).
 *
 * An executor owns the full checkpoint lifecycle for its node: it writes
 * its own `intent` checkpoint (via `store.putIntent`) before doing
 * anything externally visible, then either completes it
 * (`store.completeCheckpoint`, terminal `completed`/`failed`/`skipped`) or
 * — for effectful nodes (`wait`, `approval`, `session`) — leaves the intent
 * in place and returns `parked` with the `RunWaitCondition`(s) it is now
 * blocked on. All writes are fenced by `attempt`; a `WorkflowFenceError`
 * from the store means this executor's attempt has been superseded and it
 * must stop (the interpreter propagates the throw, aborting the current
 * `driveUntilPark` call — the next claim re-drives from checkpoints).
 *
 * `trigger`/`set`/`if`/`stop` never park: they are pure, synchronous, and
 * complete in one call. `wait`/`approval` (Task 5) park behind a timer or a
 * signal-wait, respectively, resuming deterministically from checkpoint
 * `effects` rather than re-reading the clock. `session` (Task 7) plugs into
 * the same `NodeExecutor` interface and this same registry — no
 * interpreter changes required when it lands.
 */

import type { DagNodeType, WorkflowNode } from '../dag/nodes.js';
import type { TemplateContext } from '../dag/expression.js';
import type { WorkflowEngineDeps } from '../engine-deps.js';
import type { NodeCheckpoint, RunWaitCondition, WorkflowRun, WorkflowStore } from '../store.js';

/** What a workflow-approval-raising node calls when it first parks on an approval. */
export type OnApprovalPending = (info: {
  runId: string;
  nodeId: string;
  /** 'approval' = explicit approval node (prompt REQUIRED there by
   * convention); 'policy_gate' = tool node gated by policy. Absent reads
   * as 'approval' for backward compatibility. */
  kind?: 'approval' | 'policy_gate';
  prompt?: string;           // was required; now optional (policy gates have none)
  summary?: string;
  details?: unknown;
  service?: string;          // policy gates only
  action?: string;
  params?: unknown;
  iteration?: number;        // set only when > 0
}) => Promise<void> | void;

/** Host audit seam: the tool executor reports gate settlements the HTTP
 * route cannot see (timeout; denial consumed by the executor). Best-effort
 * — a throw must not abort the node. */
export type OnGateResolved = (info: {
  runId: string;
  nodeId: string;
  iteration: number;
  invocationId: string;
  outcome: 'denied' | 'timeout';
  resolvedBy: string;
}) => Promise<void> | void;

/**
 * Host seam (action-policies plan, Task 3): when an approval is resolved with
 * a "grant the rest of this run" choice, the executor calls this with the
 * exact `(service, actionId)` pairs the approver authorized. The host
 * (`packages/api`) writes one exec-scoped runtime grant per entry so
 * subsequent `tool` nodes hitting those actions run grant-clean instead of
 * re-failing `require_approval`. Portable — the workflow package never
 * touches the policy db itself. Best-effort: a throw must not abort the
 * approved node (the host implementation swallows/logs its own errors).
 */
export type OnApprovalGrant = (info: {
  runId: string;
  resolvedBy: string;
  grants: Array<{ service: string; actionId: string }>;
}) => Promise<void> | void;

export interface NodeExecutorArgs<TNode extends WorkflowNode = WorkflowNode> {
  run: WorkflowRun;
  node: TNode;
  /** The claimed attempt driving this run; every store write this executor makes must carry it. */
  attempt: number;
  /**
   * 0 for every top-level node (the interpreter always drives the
   * definition's own nodes at iteration 0). Non-zero only when a `foreach`
   * executor (Task 6) invokes a registry executor directly for one of its
   * body's iterations — the checkpoint PK already carries it. Every
   * executor must thread this value into its own checkpoint writes (never
   * hardcode 0) and, for id-bearing executors (`session`; later `llm`/
   * `orchestrator`/`tool`), append `:{iteration}` to dispatchIds/
   * invocationIds/session ids when `iteration > 0` — see `iterationSuffix`.
   */
  iteration: number;
  /**
   * Set by a `foreach` executor when invoking a body executor for one
   * iteration — e.g. `{ item: items[i], index: i }` (names configurable via
   * `itemAlias`/`indexAlias`). Never set for top-level nodes. Merge into
   * `templateContext` via `resolveTemplateContext` before rendering
   * templates or evaluating conditions — `TemplateContext` already declares
   * an open index signature for exactly this purpose.
   */
  aliases?: Record<string, unknown>;
  /**
   * `{ trigger, nodes }` — `nodes.<id>.output` is each completed node's
   * checkpoint result. A node that failed under `onError: "continue"`
   * carries `nodes.<id>.error` instead of an output (batch-fanout design
   * decision 3); a node that failed under the default policy is absent.
   */
  templateContext: TemplateContext;
  /** This node's checkpoint row from the current drive pass, if one already exists (resumption). */
  existingCheckpoint?: NodeCheckpoint;
  store: WorkflowStore;
  clock: () => number;
  engine: WorkflowEngineDeps;
  onApprovalPending?: OnApprovalPending;
  onApprovalGrant?: OnApprovalGrant;
  onGateResolved?: OnGateResolved;
}

/**
 * `templateContext` with `aliases` merged in (a no-op when `aliases` is
 * unset, the top-level-node case). Executors that render templates or
 * evaluate `if` conditions should use this instead of `args.templateContext`
 * directly, so a `foreach` body picks up its iteration's `item`/`index` (or
 * whatever `itemAlias`/`indexAlias` name) without every executor
 * special-casing aliases itself.
 */
export function resolveTemplateContext<TNode extends WorkflowNode>(args: NodeExecutorArgs<TNode>): TemplateContext {
  if (!args.aliases) return args.templateContext;
  return { ...args.templateContext, ...args.aliases };
}

/** `:{iteration}` for a non-zero iteration, `''` at iteration 0 — the id-suffix convention decision 7 fixes for dispatchIds/invocationIds/session ids. */
export function iterationSuffix(iteration: number): string {
  return iteration > 0 ? `:${iteration}` : '';
}

export type NodeExecuteResult =
  | { status: 'completed'; result: unknown; terminate?: 'completed' | 'failed' }
  | { status: 'skipped'; result?: unknown }
  | { status: 'failed'; error: string; terminate?: 'completed' | 'failed' }
  | { status: 'parked'; waitingOn: RunWaitCondition[] };

export interface NodeExecutor<TNode extends WorkflowNode = WorkflowNode> {
  execute(args: NodeExecutorArgs<TNode>): Promise<NodeExecuteResult>;
}

export type NodeExecutorRegistry = {
  [K in DagNodeType]?: NodeExecutor<Extract<WorkflowNode, { type: K }>>;
};

export { executeTrigger } from './trigger.js';
export { executeSet } from './set.js';
export { executeIf } from './if.js';
export { executeStop } from './stop.js';
export { executeWait } from './wait.js';
export { executeApproval } from './approval.js';
export { executeSession } from './session.js';
export { executeLlm, llmUsageSpanAttributes } from './llm.js';
export { executeTool } from './tool.js';
export { executeThread } from './thread.js';
export { executeForeach } from './foreach.js';
export { executeWorkflowCall, deriveChildRunId } from './workflow-call.js';

import { executeTrigger } from './trigger.js';
import { executeSet } from './set.js';
import { executeIf } from './if.js';
import { executeStop } from './stop.js';
import { executeWait } from './wait.js';
import { executeApproval } from './approval.js';
import { executeSession } from './session.js';
import { executeLlm } from './llm.js';
import { executeTool } from './tool.js';
import { executeThread } from './thread.js';
import { executeForeach } from './foreach.js';
import { executeWorkflowCall } from './workflow-call.js';

/** The pure executors plus `wait`/`approval`/`session`/`llm`/`tool`/`orchestrator`/`foreach` (Tasks 5, 7, 3, 4, 5, 6). */
export function createDefaultNodeExecutors(): NodeExecutorRegistry {
  return {
    trigger: { execute: executeTrigger },
    set: { execute: executeSet },
    if: { execute: executeIf },
    stop: { execute: executeStop },
    wait: { execute: executeWait },
    approval: { execute: executeApproval },
    session: { execute: executeSession },
    llm: { execute: executeLlm },
    tool: { execute: executeTool },
    thread: { execute: executeThread },
    foreach: { execute: executeForeach },
    workflow: { execute: executeWorkflowCall },
  };
}
