import { useMemo } from 'react';
import { ToolCardShell, ToolCardSection } from '@/components/chat/tool-cards/tool-card-shell';
import { StepIcon } from './icons';
import { WorkflowStepCard } from './index';
import type { TimelineNode, WorkflowStepCardProps } from './index';

export function ParallelCard({ step, children = [], open, onOpenChange, workflowDef }: WorkflowStepCardProps) {
  const branches = useMemo(() => groupByBranch(step.stepId, children), [step.stepId, children]);
  const branchNumbers = Object.keys(branches).map(Number).sort((a, b) => a - b);
  const status = mapStatus(step.status);

  return (
    <ToolCardShell
      icon={<StepIcon kind="parallel" />}
      label="parallel"
      status={status}
      summary={`${step.stepId} · ${branchNumbers.length} branches`}
      open={open}
      onOpenChange={onOpenChange}
      id={`step-${step.stepId}-${step.iterationPath}`}
      defaultExpanded={status === 'error'}
    >
      {branchNumbers.map((b) => {
        const dur = computeBranchDuration(branches[b] ?? []);
        return (
          <ToolCardSection key={b} label={`branch ${b + 1}${dur != null ? ` · ${dur}ms` : ''}`}>
            <div className="space-y-1 pl-2 border-l border-neutral-200 dark:border-neutral-800">
              {(branches[b] ?? []).map((c) => (
                <WorkflowStepCard
                  key={`${c.step.stepId}#${c.step.iterationPath}`}
                  step={c.step}
                  children={c.children}
                  workflowDef={workflowDef}
                />
              ))}
            </div>
          </ToolCardSection>
        );
      })}
    </ToolCardShell>
  );
}

function groupByBranch(
  containerStepId: string,
  children: TimelineNode[],
): Record<number, TimelineNode[]> {
  const out: Record<number, TimelineNode[]> = {};
  for (const c of children) {
    const m = c.step.iterationPath.match(new RegExp(`${escapeRegex(containerStepId)}:b(\\d+)`));
    if (!m) continue;
    const b = Number(m[1]);
    (out[b] ??= []).push(c);
  }
  return out;
}

function computeBranchDuration(rows: TimelineNode[]): number | null {
  let start = Infinity;
  let end = 0;
  for (const r of rows) {
    if (r.step.startedAt) start = Math.min(start, new Date(r.step.startedAt).getTime());
    if (r.step.completedAt) end = Math.max(end, new Date(r.step.completedAt).getTime());
  }
  if (!isFinite(start) || end === 0) return null;
  return end - start;
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
