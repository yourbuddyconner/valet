import type { WorkflowData, WorkflowStep } from '@/api/workflows';

export type DiagramMode = 'edit' | 'view' | 'runtime';

export type StepRuntimeStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'waiting_approval'
  | 'cancelled';

export interface WorkflowDiagramProps {
  workflow: WorkflowData;
  mode: DiagramMode;
  /** mode="runtime" only — per-stepId status */
  runtimeStatus?: Record<string, StepRuntimeStatus>;
  /** mode="runtime" only — step currently executing (for highlight) */
  currentStepId?: string;
  /** mode="runtime" only — error string per stepId for tooltip */
  stepErrors?: Record<string, string>;
  /** mode="edit" — invoked when a node is clicked to open scoped edit */
  onNodeClick?: (stepId: string) => void;
}

/** Internal node data shared across all custom node types. */
export interface WorkflowNodeData {
  step: WorkflowStep;
  mode: DiagramMode;
  status?: StepRuntimeStatus;
  isCurrent?: boolean;
  error?: string;
  onNodeClick?: (stepId: string) => void;
}

/** Synthetic START / END / MERGE nodes — not real workflow steps. */
export interface SyntheticNodeData {
  kind: 'start' | 'end' | 'merge';
  label?: string;
}
