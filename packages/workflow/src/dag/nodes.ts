/**
 * dag/v1 node interfaces — the eleven node types supported by the workflow
 * run host (`trigger`, `set`, `if`, `wait`, `approval`, `session`, `stop`,
 * `foreach`, `llm`, `orchestrator`, `tool`).
 *
 * Lifted from `main`'s `packages/shared/src/types/workflow-dag/nodes/*.ts`
 * per Phase 5 decision 2 / node-completion-plan decision 1: `NodeDocs`
 * objects and `createDefault*` factories (editor concerns) are dropped,
 * keeping only the interfaces.
 *
 * `SessionNode` is trimmed per decision 3 to start-mode only: `workspace`,
 * `personaId`, `repairModel`, `resultMode`, `repo`, and prompt-mode are all
 * dropped (deferred; repo/persona need Phase 6 platform pieces).
 *
 * `LlmNode`, `ThreadNode`, `ToolNode`, `ForeachNode` are trimmed per
 * the node-completion-plan decision 1:
 *   - `LlmNode.model` is REQUIRED (main allowed omitting it and throwing at
 *     runtime; v2 rejects that at validation instead).
 *   - `ThreadNode` drops `forceNewThread`/`repairModel`/`resultMode`/
 *     `wait.timeout` (same trims as `SessionNode`).
 *   - `ToolNode` drops `onPolicyDeny`/`retries` (Phase 6 re-adds with
 *     policy).
 *   - `ForeachNode`'s body union drops `StopNode` (v2-specific — stopping a
 *     run from inside a loop iteration interacts badly with the wave
 *     model) and never included `IfNode`/`ApprovalNode`/`ForeachNode`.
 */

import type { WorkflowInputDefinition } from './shape.js';

export interface TriggerNode {
  id: string;
  type: 'trigger';
  dataSchema?: Record<string, WorkflowInputDefinition>;
}

export interface SetNode {
  id: string;
  type: 'set';
  values: unknown;
}

export interface IfCondition {
  left: string;
  dataType: 'string' | 'number' | 'date' | 'boolean' | 'array' | 'object';
  operation: string;
  right?: unknown;
}

export interface IfNode {
  id: string;
  type: 'if';
  combinator?: 'and' | 'or';
  conditions: IfCondition[];
}

export interface WaitNode {
  id: string;
  type: 'wait';
  mode: 'duration';
  duration: string;
}

export interface ApprovalNode {
  id: string;
  type: 'approval';
  prompt: string;
  summary?: string;
  details?: unknown;
  timeout?: string;
  onDeny?: 'fail' | 'skip';
}

// Session node — start-mode only this phase (decision 3).
export interface SessionNode {
  id: string;
  type: 'session';
  mode: 'start';
  prompt: string;
  title?: string;
  model?: string;
  outputSchema?: Record<string, unknown>;
  wait?: {
    mode: 'none' | 'until_idle';
    timeout?: string;
  };
}

export interface StopNode {
  id: string;
  type: 'stop';
  outcome?: 'success' | 'failure';
  output?: unknown;
  message?: string;
}

/**
 * What one node's failure does to the rest of the run (batch-fanout design
 * decision 3). `fail`, the default, keeps the original behaviour: the
 * failure starves every node downstream and settles the run `failed`.
 * `continue` records the same failed checkpoint but activates the node's
 * outgoing edges and drops the node from failure dominance, so a tail
 * notify node still runs and reads `nodes.<id>.error`.
 *
 * A `foreach` body uses `ForeachNode.onItemError` instead — a body has no
 * outgoing edges, so this policy would have nothing to activate.
 */
export type NodeErrorPolicy = 'fail' | 'continue';

export interface LlmNode {
  id: string;
  type: 'llm';
  model: string;
  system?: string;
  prompt: string;
  outputSchema?: Record<string, unknown>;
  temperature?: number;
  maxOutputTokens?: number;
  /** Omit for `fail`. See `NodeErrorPolicy`. */
  onError?: NodeErrorPolicy;
}

// Thread node — trimmed per decision 1 (same trims as SessionNode).
export interface ThreadNode {
  id: string;
  type: 'thread';
  prompt: string;
  outputSchema?: Record<string, unknown>;
  wait?: {
    mode: 'none' | 'until_idle';
  };
}

/**
 * Which identity a `tool` node acts as:
 *
 *   - `app`  — the integration's own installed-application identity (the
 *     GitHub App installation, a Slack bot token). The host MUST fail the
 *     node when it cannot resolve that identity. It must never fall back to
 *     a person's credential.
 *   - `user` — the credential of the user who owns the workflow.
 *   - `auto` — the host's default precedence. Same as omitting the field.
 *
 * The vocabulary is portable, but the resolution is not: each host decides
 * what `app` means for a given service. `@valet/workflow` only carries the
 * selection.
 */
export type ToolCredentialMode = 'auto' | 'app' | 'user';

// Tool node — trimmed per decision 1: drops onPolicyDeny/retries (Phase 6
// re-adds these with policy).
export interface ToolNode {
  id: string;
  type: 'tool';
  service: string;
  action: string;
  params: Record<string, unknown>;
  summary?: string;
  /**
   * Identity the action acts as. Omit it to keep the host's default
   * precedence — every definition written before this field existed reads
   * as `auto`.
   *
   * `params` are template-rendered before the host resolves this, so a
   * definition can derive the target of an `app` credential from the trigger
   * payload. A host MUST therefore resolve the application identity only
   * within the run owner's own tenant. Prefer a literal target over a
   * template when the workflow runs unattended.
   */
  credential?: ToolCredentialMode;
  /** What a denied (or timed-out) policy gate does. 'fail' (default) fails
   * the node; 'skip' completes it with { approved: false, policyDenied:
   * true, resolvedBy } so fromOutput:'false' edges activate. */
  onDeny?: 'fail' | 'skip';
  /** Duration (e.g. "24h"). A gate unresolved past it is a denial with
   * resolvedBy 'timeout'. Omit = wait forever. */
  approvalTimeout?: string;
  /** Omit for `fail`. See `NodeErrorPolicy`. */
  onError?: NodeErrorPolicy;
}

/**
 * Sub-workflow call (batch-fanout design decision 1). Starts a child run
 * of the referenced definition and parks until it settles. The child run
 * records `parentRunId`/`parentNodeId`/`parentIteration` in its params, so
 * each batch item is a real run with its own per-node status. Nesting
 * depth is 1: a definition that runs AS a child may not contain `workflow`
 * nodes (rejected at dispatch, and at validation when the reference
 * resolves).
 */
export interface WorkflowCallNode {
  id: string;
  type: 'workflow';
  /** The called workflow's id. Must belong to the same owner as the calling run. */
  workflowId: string;
  /** Template-rendered, becomes the child trigger payload's `data`. */
  input?: unknown;
  /** Omit for `fail`. See `NodeErrorPolicy`. */
  onError?: NodeErrorPolicy;
}

/**
 * Body of a foreach is restricted — no nested foreach, no if/approval
 * (control flow lives at the DAG level), no stop (stopping a run from
 * inside a loop iteration interacts badly with the wave model). The
 * runtime executes one body per item. A `workflow` body starts one child
 * run per item (the per-item sub-DAG shape).
 */
export type ForeachBodyNode = LlmNode | ToolNode | SetNode | ThreadNode | SessionNode | WorkflowCallNode;

export interface ForeachNode {
  id: string;
  type: 'foreach';
  items: string;
  body: ForeachBodyNode;
  maxItems?: number;
  concurrency?: number;
  itemAlias?: string;
  indexAlias?: string;
  onItemError?: 'fail' | 'skip' | 'collect';
}

// ─── Discriminated union ─────────────────────────────────────────────────────

export type WorkflowNode =
  | TriggerNode
  | SetNode
  | IfNode
  | WaitNode
  | ApprovalNode
  | SessionNode
  | StopNode
  | ForeachNode
  | LlmNode
  | ThreadNode
  | ToolNode
  | WorkflowCallNode;

export type DagNodeType = WorkflowNode['type'];
