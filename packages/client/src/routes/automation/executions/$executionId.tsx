import { createFileRoute } from '@tanstack/react-router';
import { useMemo } from 'react';
import {
  useExecution,
  useExecutionSteps,
  useApproveExecution,
  useCancelExecution,
} from '@/api/executions';
import { useWorkflow } from '@/api/workflows';
import { WorkflowDiagram } from '@/components/workflows/workflow-diagram';
import type { StepRuntimeStatus } from '@/components/workflows/workflow-diagram/types';
import { ExecutionHeader } from '@/components/workflows/execution-header';
import { ExecutionStepTracePanel } from '@/components/workflows/execution-step-trace';
import { ExecutionStepPanel } from '@/components/workflows/execution-step-panel';
import { ExecutionVariablesPanel } from '@/components/workflows/execution-variables-panel';
import { useExecutionStepEvents } from '@/hooks/use-execution-step-events';
import type { WorkflowStep } from '@/api/workflows';

export const Route = createFileRoute('/automation/executions/$executionId')({
  component: ExecutionDetailPage,
});

function ExecutionDetailPage() {
  const { executionId } = Route.useParams();
  const { data: execData, isLoading, error } = useExecution(executionId);
  const { data: stepsData } = useExecutionSteps(executionId);
  const execution = execData?.execution;
  const { data: workflowData } = useWorkflow(execution?.workflowId ?? '');
  const workflow = workflowData?.workflow?.data;

  const approve = useApproveExecution();
  const cancel = useCancelExecution();

  useExecutionStepEvents(execution?.sessionId ?? null, executionId);

  const { runtimeStatus, currentStepId, stepErrors } = useMemo(() => {
    const map: Record<string, StepRuntimeStatus> = {};
    const errors: Record<string, string> = {};
    let current: string | undefined;
    for (const s of stepsData?.steps ?? []) {
      // s.status comes from the API as a string; narrow to the diagram's closed union.
      const st = s.status as StepRuntimeStatus;
      map[s.stepId] = st;
      if (st === 'running') current = s.stepId;
      if (s.error) errors[s.stepId] = s.error;
    }
    return { runtimeStatus: map, currentStepId: current, stepErrors: errors };
  }, [stepsData]);

  const currentStep = useMemo(() => {
    if (!currentStepId || !workflow) return undefined;
    return findStep(workflow.steps, currentStepId);
  }, [currentStepId, workflow]);

  if (isLoading) {
    return <div className="p-6 text-sm text-neutral-500">Loading…</div>;
  }
  if (error || !execution) {
    return (
      <div className="p-6">
        <div className="text-xs text-neutral-500 tracking-wider mb-1">AUTOMATION / EXECUTIONS</div>
        <h1 className="text-xl font-semibold text-neutral-900">Execution not found</h1>
        <p className="text-sm text-neutral-600 mt-2">
          This execution may have been deleted, or the link may be incorrect.
        </p>
      </div>
    );
  }

  const resumeToken = execution.resumeToken;

  return (
    <div className="flex flex-col h-full">
      <ExecutionHeader
        execution={execution}
        onCancel={() => cancel.mutate({ executionId, data: { reason: 'Cancelled by user' } })}
        onApprove={
          resumeToken
            ? () => approve.mutate({ executionId, data: { approve: true, resumeToken } })
            : undefined
        }
        onDeny={
          resumeToken
            ? () => approve.mutate({ executionId, data: { approve: false, resumeToken } })
            : undefined
        }
      />
      <div className="grid grid-cols-[1.5fr_1fr] gap-0 flex-1 min-h-0">
        <div className="p-6 bg-neutral-50 border-r border-neutral-200">
          <div className="text-[11px] tracking-wider text-neutral-500 mb-2">PROGRESS</div>
          <div className="h-[480px]">
            {workflow ? (
              <WorkflowDiagram
                workflow={workflow}
                mode="runtime"
                runtimeStatus={runtimeStatus}
                currentStepId={currentStepId}
                stepErrors={stepErrors}
              />
            ) : (
              <div className="text-sm text-neutral-500">Loading workflow…</div>
            )}
          </div>
        </div>
        <div className="p-6 bg-white space-y-6 overflow-y-auto">
          <div>
            <div className="text-[11px] tracking-wider text-neutral-500 mb-2">CURRENT STEP</div>
            <ExecutionStepPanel step={currentStep} />
          </div>
          <div>
            <div className="text-[11px] tracking-wider text-neutral-500 mb-2">STEP TRACE</div>
            <ExecutionStepTracePanel
              steps={stepsData?.steps ?? []}
              startedAt={execution.startedAt}
            />
          </div>
          <div>
            <div className="text-[11px] tracking-wider text-neutral-500 mb-2">STEP OUTPUTS</div>
            <ExecutionVariablesPanel outputs={execution.outputs} />
          </div>
        </div>
      </div>
    </div>
  );
}

function findStep(steps: WorkflowStep[], id: string): WorkflowStep | undefined {
  for (const s of steps) {
    if (s.id === id) return s;
    const nested = s.then ?? s.else ?? s.steps ?? [];
    const inner = findStep(nested, id);
    if (inner) return inner;
  }
  return undefined;
}
