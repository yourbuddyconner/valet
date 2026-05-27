import { ToolCardShell, ToolCardSection, ToolCodeBlock } from '@/components/chat/tool-cards/tool-card-shell';
import { StepIcon } from './icons';
import { WorkflowStepCard } from './index';
import type { TimelineNode, WorkflowStepCardProps } from './index';

interface ConditionalInput {
  condition?: string;
  if?: string;
}

export function ConditionalCard({ step, children = [], open, onOpenChange, workflowDef }: WorkflowStepCardProps) {
  const input = step.input as ConditionalInput | null;
  const condition = input?.condition ?? input?.if ?? '(no condition)';
  const branchTaken = inferBranch(step.stepId, children);
  const status = mapStatus(step.status);

  return (
    <ToolCardShell
      icon={<StepIcon kind="conditional" />}
      label="conditional"
      status={status}
      summary={`${step.stepId} · → ${branchTaken ?? 'skipped'}`}
      open={open}
      onOpenChange={onOpenChange}
      id={`step-${step.stepId}-${step.iterationPath}`}
      defaultExpanded={status === 'error'}
    >
      <ToolCardSection label="condition">
        <code className="font-mono text-[11px] text-neutral-700 dark:text-neutral-300">{condition}</code>
      </ToolCardSection>
      {step.error && (
        <ToolCardSection label="error">
          <ToolCodeBlock>{step.error}</ToolCodeBlock>
        </ToolCardSection>
      )}
      {branchTaken && children.length > 0 && (
        <ToolCardSection label={`taken branch · ${branchTaken}`}>
          <div className="space-y-1 pl-2 border-l border-neutral-200 dark:border-neutral-800">
            {children.map((c) => (
              <WorkflowStepCard
                key={`${c.step.stepId}#${c.step.iterationPath}`}
                step={c.step}
                children={c.children}
                workflowDef={workflowDef}
              />
            ))}
          </div>
        </ToolCardSection>
      )}
    </ToolCardShell>
  );
}

function inferBranch(stepId: string, children: TimelineNode[]): 'then' | 'else' | null {
  for (const c of children) {
    if (c.step.iterationPath.includes(`${stepId}:then`)) return 'then';
    if (c.step.iterationPath.includes(`${stepId}:else`)) return 'else';
  }
  return null;
}

function mapStatus(status: string): 'pending' | 'running' | 'completed' | 'error' {
  if (status === 'completed') return 'completed';
  if (status === 'failed' || status === 'cancelled') return 'error';
  if (status === 'running') return 'running';
  return 'pending';
}
