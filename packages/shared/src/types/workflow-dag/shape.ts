/**
 * Top-level shape of a workflow definition and its non-node primitives.
 * Per-node-type interfaces live in `./nodes/<type>.ts`.
 */

import type { WorkflowNode } from './nodes/index.js';

export interface WorkflowDefinition {
  version: 'dag/v1';
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  policy?: WorkflowPolicy;
  ui?: WorkflowEditorState;
}

export interface WorkflowInputDefinition {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  required?: boolean;
  default?: unknown;
  description?: string;
  enum?: unknown[];
}

export interface WorkflowPolicy {
  maxNodes?: number;
  maxConcurrentNodes?: number;
  maxWaitDurationMs?: number;
  maxForeachItems?: number;
  maxForeachConcurrency?: number;
}

export interface WorkflowEditorState {
  nodes: Record<string, {
    position: { x: number; y: number };
    collapsed?: boolean;
  }>;
  viewport?: { x: number; y: number; zoom: number };
}

export interface WorkflowEdge {
  from: string;
  to: string;
  fromOutput?: 'true' | 'false';
  when?: string;
}

// ─── Runtime payloads ────────────────────────────────────────────────────────

export interface WorkflowTriggerPayload {
  type: 'manual' | 'schedule' | 'webhook';
  triggerId?: string;
  timestamp: string;
  data: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

export interface WorkflowDagState {
  trigger: WorkflowTriggerPayload;
  nodes: Record<string, WorkflowNodeOutput>;
  skipped: Record<string, { reason: string }>;
  /** Optional: edge-eval errors captured by the runtime so downstream
   * skip rows can surface the underlying cause instead of a generic
   * "no inbound edge satisfied" string. */
  edgeErrors?: Record<string, string>;
  /** Cumulative foreach iteration count across the entire execution.
   * Per spec the 5001st iteration aborts the workflow. */
  foreachIterationCount?: number;
}

export interface WorkflowNodeOutput {
  status: 'completed' | 'skipped' | 'failed';
  data?: unknown;
  error?: string;
  startedAt: string;
  completedAt: string;
  metadata?: Record<string, unknown>;
}

// ─── Validation errors ──────────────────────────────────────────────────────

export interface WorkflowValidationError {
  scope: 'workflow' | 'node' | 'edge' | 'field' | 'input';
  nodeId?: string;
  edgeId?: string;
  inputName?: string;
  path?: string;
  code: string;
  message: string;
}
