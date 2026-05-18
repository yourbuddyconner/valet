import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import type { WorkflowNodeData } from '../types';
import type { WorkflowStep } from '@/api/workflows';
import { cn } from '@/lib/cn';
import { StepTypeIcon } from '../../step-icons';
import { STATUS_RING, STATUS_DOT_COLOR, STATUS_TEXT_COLOR } from '../../state-tokens';

function summaryText(step: WorkflowStep): string {
  switch (step.type) {
    case 'bash':
      return step.command ?? '';
    case 'tool':
      return step.tool ? `tool: ${step.tool}` : '';
    case 'agent_prompt':
      return step.prompt ?? step.content ?? step.goal ?? '';
    case 'notify':
      return step.content ?? '';
    case 'conditional':
      return typeof step.condition === 'string' ? step.condition : 'condition';
    case 'approval':
      return step.prompt ?? 'Approval required';
    case 'loop':
      return step.over ? `foreach ${step.over}` : 'loop';
    case 'parallel':
      return 'parallel';
    default:
      return '';
  }
}

// AI-driven step types get a quiet accent wash so they're visually distinct from
// mechanical (bash/tool) and control-flow (conditional/parallel/loop) steps.
const AI_TYPES = new Set<WorkflowStep['type']>(['agent_prompt', 'notify']);

export function StepNode({ data }: NodeProps<Node<WorkflowNodeData>>) {
  const { step, mode, status, error, selected } = data;
  const summary = summaryText(step);
  const showFooter = Boolean(status) || Boolean(step.outputVariable);
  const isAi = AI_TYPES.has(step.type);

  return (
    <div
      // Outline (not ring) is used for selection so it composes cleanly with the
      // status ring — outline lives outside the box model and ring-offset, giving
      // a clear visual hierarchy of "selection wraps around status".
      className={cn(
        'relative bg-surface-1 border border-border rounded-xl shadow-panel w-[268px] overflow-hidden animate-stagger-in',
        status && STATUS_RING[status],
        mode === 'edit' && 'cursor-pointer hover:border-border-strong hover:shadow-lg transition',
        selected && 'outline outline-2 outline-offset-2 outline-accent',
        isAi &&
          "before:absolute before:inset-0 before:pointer-events-none before:bg-accent/[0.04] before:rounded-xl",
      )}
      title={error}
    >
      <Handle type="target" position={Position.Top} />

      {/* Header: icon tile + step name. The icon is the type indicator — no badge. */}
      <div className="relative flex items-center gap-2 px-3 py-2">
        <div className="w-6 h-6 rounded-md bg-surface-2 border border-border flex items-center justify-center text-neutral-500 shrink-0">
          <StepTypeIcon type={step.type} className="w-3.5 h-3.5" />
        </div>
        <span className="text-[13px] font-semibold text-foreground tracking-tight truncate">
          {step.name ?? step.id}
        </span>
      </div>

      {summary && (
        <div className="relative px-3 pb-2 text-[11px] text-neutral-500 dark:text-neutral-500 font-mono truncate">
          {summary}
        </div>
      )}

      {showFooter && (
        <div className="relative flex items-center justify-between gap-2 px-3 py-1.5 border-t border-border bg-surface-2/40">
          <div className="flex items-center gap-1.5 min-w-0">
            {status && (
              <>
                <span
                  className={cn(
                    'w-1.5 h-1.5 rounded-full shrink-0',
                    STATUS_DOT_COLOR[status],
                    status === 'running' && 'animate-pulse-dot',
                  )}
                />
                <span
                  className={cn(
                    'text-[10px] uppercase tracking-wider font-mono truncate',
                    STATUS_TEXT_COLOR[status],
                  )}
                >
                  {status.replace('_', ' ')}
                </span>
              </>
            )}
          </div>
          {step.outputVariable && (
            <span className="text-[10px] font-mono text-neutral-500 truncate max-w-[140px]">
              → {step.outputVariable}
            </span>
          )}
        </div>
      )}

      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
