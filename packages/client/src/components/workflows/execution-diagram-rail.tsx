import { useCallback } from 'react';
import type { WorkflowData } from '@/api/workflows';
import type { StepRuntimeStatus } from './workflow-diagram/types';
import { WorkflowDiagram } from './workflow-diagram';

interface Props {
  workflow: WorkflowData;
  runtimeStatus: Record<string, StepRuntimeStatus>;
  currentStepId?: string;
  stepErrors: Record<string, string>;
  highlightedStepId: string | null;
  /** Called when the user clicks a node — host page may also update highlight. */
  onNodeClick?: (stepId: string) => void;
}

/**
 * Slim right-pane diagram in `mode="runtime"`. Clicking a node scrolls the
 * timeline to the matching card via the data-step-key selector emitted by
 * `ExecutionTimeline`.
 */
export function ExecutionDiagramRail({
  workflow,
  runtimeStatus,
  currentStepId,
  stepErrors,
  highlightedStepId,
  onNodeClick,
}: Props) {
  const handleClick = useCallback(
    (stepId: string) => {
      onNodeClick?.(stepId);
      const el = document.querySelector(`[data-step-key^="${stepId}#"]`);
      if (el instanceof HTMLElement) {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    },
    [onNodeClick],
  );

  return (
    <div className="w-[360px] shrink-0 border-l border-border bg-surface-1 overflow-hidden">
      <WorkflowDiagram
        workflow={workflow}
        mode="runtime"
        runtimeStatus={runtimeStatus}
        currentStepId={highlightedStepId ?? currentStepId}
        stepErrors={stepErrors}
        onNodeClick={handleClick}
      />
    </div>
  );
}
