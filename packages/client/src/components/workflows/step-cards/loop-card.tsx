import { useMemo, useState } from 'react';
import { ToolCardShell, ToolCardSection, ToolCodeBlock } from '@/components/chat/tool-cards/tool-card-shell';
import { StepIcon } from './icons';
import { WorkflowStepCard } from './index';
import type { TimelineNode, WorkflowStepCardProps } from './index';

export function LoopCard({ step, children = [], open, onOpenChange, workflowDef }: WorkflowStepCardProps) {
  const iterations = useMemo(() => groupByIteration(step.stepId, children), [step.stepId, children]);
  const iterNumbers = Object.keys(iterations).map(Number).sort((a, b) => a - b);
  // Default to the "all" tab (when there's more than one iteration) so every
  // iteration's steps are visible without clicking through tabs. Single-
  // iteration loops just show that one.
  const [activeIter, setActiveIter] = useState<number | 'all'>(
    iterNumbers.length > 1 ? 'all' : (iterNumbers[0] ?? 0),
  );
  const status = mapStatus(step.status);

  const renderedChildren =
    activeIter === 'all'
      ? iterNumbers.flatMap((n) => iterations[n] ?? [])
      : iterations[activeIter as number] ?? [];

  return (
    <ToolCardShell
      icon={<StepIcon kind="loop" />}
      label="loop"
      status={status}
      summary={`${step.stepId} · ${iterNumbers.length} iteration${iterNumbers.length === 1 ? '' : 's'}`}
      open={open}
      onOpenChange={onOpenChange}
      id={`step-${step.stepId}-${step.iterationPath}`}
      defaultExpanded={status === 'error'}
    >
      {step.error && (
        <ToolCardSection label="error">
          <ToolCodeBlock>{step.error}</ToolCodeBlock>
        </ToolCardSection>
      )}
      {iterNumbers.length > 0 && (
        <div
          role="tablist"
          aria-label={`Iterations for ${step.stepId}`}
          className="flex flex-wrap gap-1 px-2.5 py-2 border-b border-neutral-100 dark:border-neutral-800"
        >
          {iterNumbers.map((n) => (
            <button
              key={n}
              role="tab"
              type="button"
              aria-selected={activeIter === n}
              onClick={() => setActiveIter(n)}
              className={`font-mono text-[10px] rounded px-1.5 py-0.5 ${
                activeIter === n
                  ? 'bg-accent text-accent-foreground'
                  : 'text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-900'
              }`}
            >
              iter {n + 1}
            </button>
          ))}
          {iterNumbers.length > 1 && (
            <button
              role="tab"
              type="button"
              aria-selected={activeIter === 'all'}
              onClick={() => setActiveIter('all')}
              className={`font-mono text-[10px] rounded px-1.5 py-0.5 ${
                activeIter === 'all'
                  ? 'bg-accent text-accent-foreground'
                  : 'text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-900'
              }`}
            >
              all
            </button>
          )}
        </div>
      )}
      {renderedChildren.length > 0 && (
        <ToolCardSection>
          <div className="space-y-1 pl-2 border-l border-neutral-200 dark:border-neutral-800">
            {renderedChildren.map((c) => (
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

function groupByIteration(
  containerStepId: string,
  children: TimelineNode[],
): Record<number, TimelineNode[]> {
  const out: Record<number, TimelineNode[]> = {};
  for (const c of children) {
    const match = c.step.iterationPath.match(new RegExp(`${escapeRegex(containerStepId)}:i(\\d+)`));
    if (!match) continue;
    const i = Number(match[1]);
    (out[i] ??= []).push(c);
  }
  return out;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function mapStatus(status: string): 'pending' | 'running' | 'completed' | 'error' {
  if (status === 'completed') return 'completed';
  if (status === 'failed' || status === 'cancelled') return 'error';
  if (status === 'running') return 'running';
  return 'pending';
}
