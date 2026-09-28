/**
 * Top-level shape of a workflow definition and its non-node primitives.
 * Node type interfaces live in `./nodes.ts`.
 *
 * Lifted from `main`'s `packages/shared/src/types/workflow-dag/shape.ts`.
 * Phase 5 dropped the editor-only `ui`/`WorkflowEditorState` field (no
 * visual editor that phase); the node-completion-plan re-adds it
 * (decision 2) — the interpreter and validator both tolerate it
 * structurally without interpreting its contents.
 */

import type { WorkflowNode } from './nodes.js';

export interface WorkflowDefinition {
  version: 'dag/v1';
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  /** Explicit orchestrator routing. Omitted definitions use the owner's default assistant. */
  policy?: WorkflowPolicy;
  ui?: WorkflowEditorState;
}

export interface WorkflowEditorState {
  nodes: Record<
    string,
    {
      position: { x: number; y: number };
    }
  >;
  viewport?: { x: number; y: number; zoom: number };
  /** Model to use when the editor adds a new llm or session node. */
  defaultModel?: string;
}

/**
 * One declared trigger input.
 *
 * `label`, `placeholder` and `hidden` are presentation only. They let a
 * definition declare each input ONCE, here, and let the run form derive its
 * fields from the same declaration — without them a template must repeat
 * its input list somewhere else, and the two copies drift. `hidden` marks a
 * field that belongs to the invocation contract but is never typed by a
 * person, such as a value a webhook maps in.
 */
export interface WorkflowInputDefinition {
  /** `integer` is an accepted alias for `number` — every other schema
   * surface in the product is JSON Schema, where `integer` is idiomatic,
   * so authors keep writing it. Consumers that branch on the type must
   * call `normalizeInputType` first (`trigger-input.ts`). */
  type: 'string' | 'number' | 'boolean' | 'object' | 'array' | 'integer';
  required?: boolean;
  default?: unknown;
  description?: string;
  enum?: unknown[];
  /** Field name shown on the run form. Falls back to the schema key. */
  label?: string;
  /** Example value shown in the empty field. */
  placeholder?: string;
  /** True keeps the field out of the run form. */
  hidden?: boolean;
}

export interface WorkflowPolicy {
  maxNodes?: number;
  maxConcurrentNodes?: number;
  maxWaitDurationMs?: number;
  maxForeachItems?: number;
  maxForeachConcurrency?: number;
  /**
   * What an unresolved `{{ ... }}` path does to the node that wrote it.
   *
   *   - `empty` (the default) renders the path as an empty value and
   *     records a diagnostic. This is how every definition written before
   *     this option behaves.
   *   - `fail` fails the node BEFORE it runs, so a prompt with a hole in
   *     it is never sent and an action with a null parameter is never
   *     called. The failure names the path, the field, and the correction.
   *
   * `fail` does not apply to `if` conditions or edge `when` predicates.
   * Those ask whether data is there, so an absent path is a legitimate
   * answer rather than a mistake. They still produce diagnostics.
   */
  onUnresolvedPath?: 'empty' | 'fail';
}

export interface WorkflowEdge {
  from: string;
  to: string;
  fromOutput?: 'true' | 'false';
  when?: string;
}

// ─── Runtime payloads ────────────────────────────────────────────────────────

export interface WorkflowTriggerPayload {
  type: 'manual' | 'schedule' | 'webhook' | 'event' | 'workflow';
  triggerId?: string;
  timestamp: string;
  data: Record<string, unknown>;
  metadata: Record<string, unknown>;
}
