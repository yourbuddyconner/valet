import type { WorkflowStep } from '@/api/workflows';

interface Props {
  step?: WorkflowStep;
}

export function ExecutionStepPanel({ step }: Props) {
  if (!step) {
    return <div className="text-sm text-neutral-500">No active step.</div>;
  }
  return (
    <div className="border border-neutral-200 rounded-lg p-3 bg-neutral-50">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-[10px] font-bold tracking-wider bg-neutral-900 text-white px-1.5 py-0.5 rounded">
          {step.type.toUpperCase()}
        </span>
        <span className="text-sm font-semibold">{step.name || step.id}</span>
      </div>
      <div className="text-xs text-neutral-600 space-y-0.5">
        {step.command && (
          <div>
            Command: <code>{step.command}</code>
          </div>
        )}
        {step.content && <div>Prompt: "{step.content}"</div>}
        {step.tool && (
          <div>
            Tool: <code>{step.tool}</code>
          </div>
        )}
      </div>
    </div>
  );
}
