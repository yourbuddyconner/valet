/**
 * Build the template/expression context exposed to node executors.
 *
 * Single source of truth for the projection from runtime state down to
 * the `{ trigger, nodes }` shape that the expression evaluator
 * and template renderer consume. Every executor and the edge `when`
 * predicate use this.
 */

import type { WorkflowDagState, WorkflowNodeOutput } from '@valet/shared';

export interface TemplateContext {
  trigger: unknown;
  nodes: Record<string, { data: unknown }>;
  /** Foreach iteration aliases (item, index by default) are merged in by the foreach executor. */
  [alias: string]: unknown;
}

export function buildTemplateContext(
  state: WorkflowDagState,
  aliases?: Record<string, unknown>,
): TemplateContext {
  return {
    trigger: state.trigger,
    nodes: pickNodeData(state.nodes),
    ...(aliases ?? {}),
  };
}

function pickNodeData(nodes: Record<string, WorkflowNodeOutput>): Record<string, { data: unknown }> {
  const out: Record<string, { data: unknown }> = {};
  for (const [id, output] of Object.entries(nodes)) {
    out[id] = { data: output.data };
  }
  return out;
}
