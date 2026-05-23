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
  /** mode="edit" — set of step ids currently selected (visual highlight). */
  selectedStepIds?: ReadonlySet<string>;
  /** mode="edit" — invoked when a node is clicked to open scoped edit */
  onNodeClick?: (stepId: string, opts: { modifier: boolean }) => void;
  /** mode="edit" — user picked a step type from the "+" after a step. */
  onInsertAfter?: (targetStepId: string, type: import('@/api/workflows').WorkflowStep['type']) => void;
  /** mode="edit" — user picked a step type from a container's "Add child" button. */
  onInsertInto?: (
    containerId: string,
    slot: 'then' | 'else' | 'steps',
    type: import('@/api/workflows').WorkflowStep['type'],
  ) => void;
  /** mode="edit" — user clicked the delete affordance on a step. */
  onDelete?: (stepId: string) => void;
}

/** Internal node data shared across all custom node types. */
export interface WorkflowNodeData {
  step: WorkflowStep;
  mode: DiagramMode;
  status?: StepRuntimeStatus;
  isCurrent?: boolean;
  error?: string;
  selected?: boolean;
  onNodeClick?: (stepId: string, opts: { modifier: boolean }) => void;
  // Edit-mode callbacks; only meaningful when mode === 'edit'.
  onInsertAfter?: (targetStepId: string, type: WorkflowStep['type']) => void;
  onInsertInto?: (
    containerId: string,
    slot: 'then' | 'else' | 'steps',
    type: WorkflowStep['type'],
  ) => void;
  onDelete?: (stepId: string) => void;
  // Index signature required by @xyflow/react Node<T> constraint.
  [key: string]: unknown;
}

/** Synthetic START / END / MERGE nodes — not real workflow steps. */
export interface SyntheticNodeData {
  kind: 'start' | 'end' | 'merge';
  label?: string;
  // Index signature required by @xyflow/react Node<T> constraint.
  [key: string]: unknown;
}
