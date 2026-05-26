import { ToolCardShell, ToolCardSection, ToolCodeBlock } from '@/components/chat/tool-cards/tool-card-shell';
import { StepIcon } from './icons';
import type { WorkflowStepCardProps } from './index';

/**
 * Default renderer for any step type without a dedicated card.
 * Also surfaces rows from executions persisted before Phase B output enrichment.
 */
export function FallbackCard({ step, open, onOpenChange, stepType }: WorkflowStepCardProps) {
  const summary = `${step.stepId} · ${stepType}`;
  const status = mapStatus(step.status);
  const output = step.output != null
    ? typeof step.output === 'string' ? step.output : JSON.stringify(step.output, null, 2)
    : null;

  return (
    <ToolCardShell
      icon={<StepIcon kind="fallback" />}
      label={stepType}
      status={status}
      summary={summary}
      open={open}
      onOpenChange={onOpenChange}
      id={`step-${step.stepId}-${step.iterationPath}`}
      defaultExpanded={status === 'error'}
    >
      {output && (
        <ToolCardSection label="output">
          <ToolCodeBlock>{output}</ToolCodeBlock>
        </ToolCardSection>
      )}
      {step.error && (
        <ToolCardSection label="error">
          <ToolCodeBlock>{step.error}</ToolCodeBlock>
        </ToolCardSection>
      )}
    </ToolCardShell>
  );
}

function mapStatus(status: string): 'pending' | 'running' | 'completed' | 'error' {
  if (status === 'completed') return 'completed';
  if (status === 'failed' || status === 'cancelled') return 'error';
  if (status === 'running' || status === 'waiting_approval') return 'running';
  return 'pending';
}
