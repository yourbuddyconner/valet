import { ToolCardShell, ToolCardSection, ToolCodeBlock } from '@/components/chat/tool-cards/tool-card-shell';
import { StepIcon } from './icons';
import type { WorkflowStepCardProps } from './index';

interface BashInput {
  command?: string;
  arguments?: { command?: string };
}
interface BashOutput {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  command?: string;
}

export function BashCard({ step, open, onOpenChange }: WorkflowStepCardProps) {
  const input = step.input as BashInput | null;
  const output = step.output as BashOutput | null;
  const command =
    typeof input?.command === 'string'
      ? input.command
      : typeof input?.arguments?.command === 'string'
        ? input.arguments.command
        : (typeof output?.command === 'string' ? output.command : '');
  const exit = output?.exitCode ?? null;
  const status = mapStatus(step.status, exit);
  const summaryCommand = command.length > 60 ? command.slice(0, 60) + '…' : command;
  const summary = `${step.stepId}${command ? ` · ${summaryCommand}` : ''}${exit !== null ? ` → exit ${exit}` : ''}`;

  return (
    <ToolCardShell
      icon={<StepIcon kind="bash" />}
      label="bash"
      status={status}
      summary={summary}
      open={open}
      onOpenChange={onOpenChange}
      id={`step-${step.stepId}-${step.iterationPath}`}
      defaultExpanded={status === 'error'}
    >
      {command && (
        <ToolCardSection label="command">
          <ToolCodeBlock>{command}</ToolCodeBlock>
        </ToolCardSection>
      )}
      {output?.stdout && (
        <ToolCardSection label="stdout">
          <ToolCodeBlock>{output.stdout}</ToolCodeBlock>
        </ToolCardSection>
      )}
      {output?.stderr && (
        <ToolCardSection label="stderr">
          <ToolCodeBlock>{output.stderr}</ToolCodeBlock>
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

function mapStatus(status: string, exit: number | null): 'pending' | 'running' | 'completed' | 'error' {
  if (status === 'failed' || status === 'cancelled') return 'error';
  if (status === 'completed') return exit !== null && exit !== 0 ? 'error' : 'completed';
  if (status === 'running') return 'running';
  return 'pending';
}
