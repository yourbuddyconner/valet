import { useRef, useState } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { Plus, Trash2 } from 'lucide-react';
import type { WorkflowNodeData } from '../types';
import type { WorkflowStep } from '@/api/workflows';
import { cn } from '@/lib/cn';
import { StepTypeIcon } from '../../step-icons';
import { STATUS_RING, STATUS_DOT_COLOR, STATUS_TEXT_COLOR } from '../../state-tokens';
import { StepTypePopover } from './step-type-popover';

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

const CONTAINER_TYPES = new Set<WorkflowStep['type']>(['conditional', 'parallel', 'loop']);

type OpenPopover = null | { kind: 'after' } | { kind: 'into'; slot: 'then' | 'else' | 'steps' };

export function StepNode({ data }: NodeProps<Node<WorkflowNodeData>>) {
  const { step, mode, status, error, selected, onInsertAfter, onInsertInto, onDelete } = data;
  const summary = summaryText(step);
  const showFooter = Boolean(status) || Boolean(step.outputVariable);
  const isAi = AI_TYPES.has(step.type);
  const isContainer = CONTAINER_TYPES.has(step.type);
  const editable = mode === 'edit';

  const [open, setOpen] = useState<OpenPopover>(null);
  // Tracks whichever button (+ pill or an "add child") triggered the popover so
  // the popover can position itself against it via portal.
  const anchorRef = useRef<HTMLButtonElement | null>(null);

  return (
    <div className="relative group">
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

        {/* Container "Add child" affordance lives inside the node so it visually
            scopes to the container box — distinct from the insert-after pill. */}
        {editable && isContainer && onInsertInto && (
          <div className="relative border-t border-border bg-surface-2/40 px-3 py-1.5 flex gap-1.5 flex-wrap">
            {step.type === 'conditional' ? (
              <>
                <AddChildButton
                  label="+ then"
                  onClick={(e) => {
                    anchorRef.current = e.currentTarget;
                    setOpen({ kind: 'into', slot: 'then' });
                  }}
                />
                <AddChildButton
                  label="+ else"
                  onClick={(e) => {
                    anchorRef.current = e.currentTarget;
                    setOpen({ kind: 'into', slot: 'else' });
                  }}
                />
              </>
            ) : (
              <AddChildButton
                label="+ child"
                onClick={(e) => {
                  anchorRef.current = e.currentTarget;
                  setOpen({ kind: 'into', slot: 'steps' });
                }}
              />
            )}
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

        {/* Delete affordance — only on hover/focus in edit mode. */}
        {editable && onDelete && (
          <button
            type="button"
            aria-label={`Delete ${step.name ?? step.id}`}
            onClick={(e) => {
              e.stopPropagation();
              onDelete(step.id);
            }}
            className={cn(
              'absolute top-1.5 right-1.5 w-5 h-5 rounded-full bg-surface-2 border border-border',
              'flex items-center justify-center text-neutral-500',
              'opacity-0 group-hover:opacity-100 focus:opacity-100',
              'hover:bg-red-500/10 hover:text-red-600 hover:border-red-500/40 transition',
            )}
          >
            <Trash2 className="w-3 h-3" strokeWidth={1.5} />
          </button>
        )}
      </div>

      {/* Insert-after "+" pill — positioned below the node, centered. */}
      {editable && onInsertAfter && (
        <div className="absolute left-1/2 -translate-x-1/2 -bottom-4 z-10">
          <button
            type="button"
            aria-label="Insert step after"
            onClick={(e) => {
              e.stopPropagation();
              anchorRef.current = e.currentTarget;
              setOpen({ kind: 'after' });
            }}
            className={cn(
              'w-6 h-6 rounded-full bg-surface-0 border border-border-strong',
              'flex items-center justify-center text-neutral-500',
              'opacity-0 group-hover:opacity-100 focus:opacity-100',
              'hover:bg-accent hover:text-white hover:border-accent transition shadow-panel',
            )}
          >
            <Plus className="w-3.5 h-3.5" strokeWidth={2} />
          </button>
        </div>
      )}

      {open?.kind === 'after' && onInsertAfter && (
        <StepTypePopover
          anchorRef={anchorRef}
          title="Insert step"
          onClose={() => setOpen(null)}
          onPick={(type) => {
            setOpen(null);
            onInsertAfter(step.id, type);
          }}
        />
      )}

      {open?.kind === 'into' && onInsertInto && (
        <StepTypePopover
          anchorRef={anchorRef}
          title={`Add to ${open.slot}`}
          onClose={() => setOpen(null)}
          onPick={(type) => {
            const slot = open.slot;
            setOpen(null);
            onInsertInto(step.id, slot, type);
          }}
        />
      )}
    </div>
  );
}

function AddChildButton({
  label,
  onClick,
}: {
  label: string;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick(e);
      }}
      className={cn(
        'text-[10px] uppercase tracking-wider font-mono px-2 py-0.5 rounded',
        'bg-surface-0 border border-border text-neutral-500',
        'hover:bg-accent hover:text-white hover:border-accent transition',
      )}
    >
      {label}
    </button>
  );
}
