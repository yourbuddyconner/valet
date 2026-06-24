/**
 * Per-node-type modules. Each module owns the interface, docs, and default
 * factory for one node type. This file aggregates them into the
 * discriminated union and the NODE_DOCS / NODE_DEFAULTS registries.
 */

import type { NodeDocs } from '../docs.js';

import {
  type TriggerNode,
  createDefaultTriggerNode,
  triggerNodeDocs,
} from './trigger.js';
import {
  type LlmNode,
  createDefaultLlmNode,
  llmNodeDocs,
} from './llm.js';
import {
  type ToolNode,
  createDefaultToolNode,
  toolNodeDocs,
} from './tool.js';
import {
  type IfNode,
  type IfCondition,
  createDefaultIfNode,
  ifNodeDocs,
} from './if.js';
import {
  type ForeachNode,
  type ForeachBodyNode,
  createDefaultForeachNode,
  foreachNodeDocs,
} from './foreach.js';
import {
  type ApprovalNode,
  createDefaultApprovalNode,
  approvalNodeDocs,
} from './approval.js';
import {
  type WaitNode,
  createDefaultWaitNode,
  waitNodeDocs,
} from './wait.js';
import {
  type SetNode,
  createDefaultSetNode,
  setNodeDocs,
} from './set.js';
import {
  type StopNode,
  createDefaultStopNode,
  stopNodeDocs,
} from './stop.js';
import {
  type OrchestratorNode,
  createDefaultOrchestratorNode,
  orchestratorNodeDocs,
} from './orchestrator.js';
import {
  type SessionNode,
  type StartSessionNode,
  type PromptSessionNode,
  createDefaultSessionNode,
  sessionNodeDocs,
} from './session.js';

// Re-export per-type interfaces so consumers can still `import { LlmNode }
// from '@valet/shared'`.
export type {
  TriggerNode,
  LlmNode,
  ToolNode,
  IfNode,
  IfCondition,
  ForeachNode,
  ForeachBodyNode,
  ApprovalNode,
  WaitNode,
  SetNode,
  StopNode,
  OrchestratorNode,
  SessionNode,
  StartSessionNode,
  PromptSessionNode,
};

// ─── Discriminated union ─────────────────────────────────────────────────────

export type WorkflowNode =
  | TriggerNode
  | LlmNode
  | IfNode
  | ForeachNode
  | ApprovalNode
  | WaitNode
  | SetNode
  | StopNode
  | ToolNode
  | OrchestratorNode
  | SessionNode;

export type DagNodeType = WorkflowNode['type'];
export type AddableDagNodeType = Exclude<DagNodeType, 'trigger'>;

// ─── Docs registry ───────────────────────────────────────────────────────────
//
// Record<DagNodeType, NodeDocs> — adding a new node type without an entry
// is a TypeScript error, which is the point.

export const NODE_DOCS: Record<DagNodeType, NodeDocs> = {
  trigger: triggerNodeDocs,
  llm: llmNodeDocs,
  tool: toolNodeDocs,
  if: ifNodeDocs,
  foreach: foreachNodeDocs,
  approval: approvalNodeDocs,
  wait: waitNodeDocs,
  set: setNodeDocs,
  stop: stopNodeDocs,
  orchestrator: orchestratorNodeDocs,
  session: sessionNodeDocs,
};

// ─── Default factories ───────────────────────────────────────────────────────

const NODE_DEFAULT_FACTORIES: { [K in DagNodeType]: (id: string) => Extract<WorkflowNode, { type: K }> } = {
  trigger: createDefaultTriggerNode,
  llm: createDefaultLlmNode,
  tool: createDefaultToolNode,
  if: createDefaultIfNode,
  foreach: createDefaultForeachNode,
  approval: createDefaultApprovalNode,
  wait: createDefaultWaitNode,
  set: createDefaultSetNode,
  stop: createDefaultStopNode,
  orchestrator: createDefaultOrchestratorNode,
  // SessionNode is itself a union; the factory returns the StartSessionNode
  // branch so cast through the wider WorkflowNode 'session' member.
  session: createDefaultSessionNode as (id: string) => Extract<WorkflowNode, { type: 'session' }>,
};

export function createDefaultWorkflowNode<K extends DagNodeType>(
  type: K,
  id: string,
): Extract<WorkflowNode, { type: K }> {
  return NODE_DEFAULT_FACTORIES[type](id);
}
