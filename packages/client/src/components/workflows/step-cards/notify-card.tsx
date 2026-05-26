import { ToolCardShell, ToolCardSection, ToolCodeBlock } from '@/components/chat/tool-cards/tool-card-shell';
import { StepIcon } from './icons';
import type { WorkflowStepCardProps } from './index';

interface NotifyOutput {
  type?: string;
  target?: string;
  delivered?: boolean;
  error?: string | null;
}

export function NotifyCard({ step, open, onOpenChange }: WorkflowStepCardProps) {
  const output = step.output as NotifyOutput | null;
  const status = mapStatus(step.status);
  const target = output?.target ?? 'orchestrator';
  const state = output?.delivered ? 'delivered' : output?.error ? 'failed' : 'pending';

  return (
    <ToolCardShell
      icon={<StepIcon kind="notify" />}
      label="notify"
      status={status}
      summary={`${step.stepId} · ${target} · ${state}`}
      open={open}
      onOpenChange={onOpenChange}
      id={`step-${step.stepId}-${step.iterationPath}`}
      defaultExpanded={status === 'error'}
    >
      <ToolCardSection label="target">
        <p className="font-mono text-[11px] text-neutral-700 dark:text-neutral-300">{target}</p>
      </ToolCardSection>
      {output?.error && (
        <ToolCardSection label="error">
          <ToolCodeBlock>{output.error}</ToolCodeBlock>
        </ToolCardSection>
      )}
      {step.error && !output?.error && (
        <ToolCardSection label="step error">
          <ToolCodeBlock>{step.error}</ToolCodeBlock>
        </ToolCardSection>
      )}
    </ToolCardShell>
  );
}

function mapStatus(status: string): 'pending' | 'running' | 'completed' | 'error' {
  if (status === 'completed') return 'completed';
  if (status === 'failed' || status === 'cancelled') return 'error';
  if (status === 'running') return 'running';
  return 'pending';
}
