import { ToolCardShell, ToolCardSection } from '@/components/chat/tool-cards/tool-card-shell';
import { StepIcon } from './icons';
import type { WorkflowStepCardProps } from './index';

interface ApprovalOutput {
  prompt?: string;
  decision?: 'approved' | 'denied' | 'timed_out';
  decidedAt?: string;
}

export function ApprovalCard({ step, open, onOpenChange }: WorkflowStepCardProps) {
  const output = step.output as ApprovalOutput | null;
  const decision = output?.decision;
  const status = mapStatus(step.status, decision);
  const summary = decision
    ? `${step.stepId} · ${decision}`
    : `${step.stepId} · awaiting approval`;

  return (
    <ToolCardShell
      icon={<StepIcon kind="approval" />}
      label="approval"
      status={status}
      summary={summary}
      open={open}
      onOpenChange={onOpenChange}
      id={`step-${step.stepId}-${step.iterationPath}`}
      defaultExpanded={status === 'error' || status === 'running'}
    >
      {output?.prompt && (
        <ToolCardSection label="prompt">
          <p className="font-mono text-[11px] text-neutral-700 dark:text-neutral-300 whitespace-pre-wrap">
            {output.prompt}
          </p>
        </ToolCardSection>
      )}
      <ToolCardSection label="decision">
        <p className="font-mono text-[11px] text-neutral-700 dark:text-neutral-300">
          {decision ?? 'pending'}
          {output?.decidedAt && <span className="text-neutral-500"> · {output.decidedAt}</span>}
        </p>
      </ToolCardSection>
    </ToolCardShell>
  );
}

function mapStatus(
  status: string,
  decision: ApprovalOutput['decision'],
): 'pending' | 'running' | 'completed' | 'error' {
  if (status === 'waiting_approval') return 'running';
  if (decision === 'denied' || decision === 'timed_out') return 'error';
  if (status === 'completed') return 'completed';
  if (status === 'failed' || status === 'cancelled') return 'error';
  return 'pending';
}
