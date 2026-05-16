export type WorkflowStepEventKind =
  | 'step.started'
  | 'step.completed'
  | 'step.failed'
  | 'step.skipped'
  | 'approval.required'
  | 'approval.approved'
  | 'approval.denied';

export interface WorkflowStepEvent {
  kind: WorkflowStepEventKind;
  stepId: string;
  attempt: number;
  timestamp: string;
  input?: unknown;
  output?: unknown;
  error?: string;
  durationMs?: number;
}

export interface WorkflowStepEventMessage {
  type: 'workflow-step-event';
  executionId: string;
  event: WorkflowStepEvent;
}
