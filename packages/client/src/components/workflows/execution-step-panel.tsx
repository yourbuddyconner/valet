import type { WorkflowStep } from '@/api/workflows';

interface Props {
  step?: WorkflowStep;
}

export function ExecutionStepPanel({ step }: Props) {
  if (!step) {
    return <div className="text-sm text-neutral-500">No active step.</div>;
  }
  return (
    <div className="border border-border rounded-lg p-3 bg-surface-2">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-[10px] font-bold tracking-wider bg-accent text-white px-1.5 py-0.5 rounded">
          {step.type.toUpperCase()}
        </span>
        <span className="text-sm font-semibold text-foreground">{step.name || step.id}</span>
      </div>
      <div className="text-xs text-neutral-600 dark:text-neutral-400 space-y-0.5">
        {step.command && (
          <div>
            Command: <code className="bg-surface-3 text-foreground px-1 py-0.5 rounded">{step.command}</code>
          </div>
        )}
        {step.content && <div>Prompt: "{step.content}"</div>}
        {step.tool && (
          <div>
            Tool: <code className="bg-surface-3 text-foreground px-1 py-0.5 rounded">{step.tool}</code>
          </div>
        )}
      </div>
    </div>
  );
}
