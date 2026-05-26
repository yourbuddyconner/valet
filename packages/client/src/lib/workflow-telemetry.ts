/**
 * Lightweight counter wrapper for workflow UI events. In production this
 * should ship to a real metrics sink; for now it counts in memory and logs
 * to console.debug. Snapshot is exposed for ad-hoc debugging.
 *
 * Spec: docs/specs/2026-05-23-workflow-ui-design.md (Telemetry section).
 */

const counters: Record<string, number> = {};

export const WORKFLOW_TELEMETRY = {
  STEP_INSTANCE_COLLISION: 'workflow_ui.step_instance_collision',
  ORPHAN_STEP_ROW: 'workflow_ui.orphan_step_row',
  WORKFLOW_MESSAGE_NO_STEP: 'workflow_ui.workflow_message_no_step',
  AGENT_PROMPT_RESPONSE_MISSING: 'workflow_ui.agent_prompt_response_missing',
  FALLBACK_RENDERER_USED: 'workflow_ui.fallback_renderer_used',
  MIGRATION_IRREGULARITY: 'workflow_ui.migration_irregularity',
} as const;

export type WorkflowTelemetryCounter = (typeof WORKFLOW_TELEMETRY)[keyof typeof WORKFLOW_TELEMETRY];

export function bump(counter: WorkflowTelemetryCounter, ctx?: Record<string, unknown>): void {
  counters[counter] = (counters[counter] ?? 0) + 1;
  if (typeof console !== 'undefined') {
    console.debug(`[workflow-telemetry] ${counter}`, counters[counter], ctx);
  }
}

export function snapshot(): Record<string, number> {
  return { ...counters };
}
