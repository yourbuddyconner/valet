import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import type { WorkflowNodeData, StepRuntimeStatus } from '../types';
import type { WorkflowStep } from '@/api/workflows';
import { cn } from '@/lib/cn';

const TYPE_LABEL: Record<WorkflowStep['type'], string> = {
  bash: 'BASH',
  tool: 'TOOL',
  agent_message: 'SEND MSG',
  agent_prompt: 'AGENT PROMPT',
  notify: 'NOTIFY',
  conditional: 'CONDITIONAL',
  parallel: 'PARALLEL',
  loop: 'LOOP',
  approval: 'APPROVAL',
};

const TYPE_BADGE_CLASSES: Record<WorkflowStep['type'], string> = {
  bash: 'bg-neutral-900 text-white',
  tool: 'bg-neutral-700 text-white',
  agent_message: 'bg-indigo-600 text-white',
  agent_prompt: 'bg-purple-600 text-white',
  notify: 'bg-teal-700 text-white',
  conditional: 'bg-amber-600 text-white',
  parallel: 'bg-fuchsia-600 text-white',
  loop: 'bg-teal-600 text-white',
  approval: 'bg-orange-600 text-white',
};

const STATUS_BORDER: Record<StepRuntimeStatus, string> = {
  pending: 'border-dashed border-neutral-300',
  running: 'border-2 border-blue-500 ring-4 ring-blue-200',
  completed: 'border-2 border-emerald-600',
  failed: 'border-2 border-red-600',
  skipped: 'border border-neutral-300 opacity-50',
  waiting_approval: 'border-2 border-orange-500 ring-4 ring-orange-200',
  cancelled: 'border border-neutral-300 opacity-50',
};

const STATUS_BADGE: Record<StepRuntimeStatus, { sym: string; cls: string }> = {
  pending: { sym: '○', cls: 'bg-neutral-300 text-neutral-700' },
  running: { sym: '●', cls: 'bg-blue-500 text-white' },
  completed: { sym: '✓', cls: 'bg-emerald-600 text-white' },
  failed: { sym: '✗', cls: 'bg-red-600 text-white' },
  skipped: { sym: '⊘', cls: 'bg-neutral-300 text-neutral-700' },
  waiting_approval: { sym: '⏸', cls: 'bg-orange-500 text-white' },
  cancelled: { sym: '⊘', cls: 'bg-neutral-400 text-white' },
};

function summaryText(step: WorkflowStep): string {
  switch (step.type) {
    case 'bash':
      return step.command ?? '';
    case 'tool':
      return step.tool ? `tool: ${step.tool}` : '';
    case 'agent_message':
      return step.content ?? step.goal ?? step.prompt ?? '';
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

export function StepNode({ data }: NodeProps<Node<WorkflowNodeData>>) {
  const { step, mode, status, error, selected } = data;
  const summary = summaryText(step);

  return (
    <div
      className={cn(
        'relative bg-white rounded-xl shadow-sm w-[260px] px-3 py-2.5',
        status ? STATUS_BORDER[status] : 'border border-neutral-300',
        mode === 'edit' && 'cursor-pointer hover:shadow-md transition-shadow',
        selected && 'ring-2 ring-indigo-500 ring-offset-1',
      )}
      title={error}
    >
      <Handle type="target" position={Position.Top} />
      {status && (
        <div
          aria-label={status}
          className={cn(
            'absolute -top-2 -right-2 w-5 h-5 rounded-full flex items-center justify-center text-xs',
            STATUS_BADGE[status].cls,
          )}
        >
          {STATUS_BADGE[status].sym}
        </div>
      )}
      <div className="flex items-center gap-2 mb-0.5">
        <span
          className={cn(
            'text-[10px] font-bold tracking-wider px-1.5 py-0.5 rounded',
            TYPE_BADGE_CLASSES[step.type],
          )}
        >
          {TYPE_LABEL[step.type]}
        </span>
        <span className="text-sm font-semibold text-neutral-900 truncate">
          {step.name ?? step.id}
        </span>
      </div>
      {summary && (
        <div className="text-xs text-neutral-600 truncate font-mono">{summary}</div>
      )}
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
