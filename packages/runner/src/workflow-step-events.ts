export type WorkflowStepEventKind =
  | 'step.started'
  | 'step.completed'
  | 'step.failed'
  | 'step.skipped'
  | 'step.cancelled'
  | 'approval.required'
  | 'approval.approved'
  | 'approval.denied';

export interface WorkflowStepEvent {
  kind: WorkflowStepEventKind;
  stepId: string;
  attempt: number;
  /** Per-instance path identity. Empty for top-level steps. */
  iterationPath?: string;
  timestamp: string;
  input?: unknown;
  output?: unknown;
  error?: string;
  durationMs?: number;
}
