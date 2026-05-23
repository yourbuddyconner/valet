import { useEffect, useRef } from 'react';
import type { WorkflowStep } from '@/api/workflows';
import { StepTypeIcon } from '../../step-icons';
import { cn } from '@/lib/cn';

const STEP_TYPES: ReadonlyArray<{
  type: WorkflowStep['type'];
  label: string;
  description: string;
}> = [
  { type: 'agent_prompt', label: 'Agent prompt', description: 'Ask an agent to do something' },
  { type: 'notify', label: 'Notify', description: 'Send a message to a channel' },
  { type: 'tool', label: 'Tool', description: 'Call a single tool' },
  { type: 'bash', label: 'Bash', description: 'Run a shell command' },
  { type: 'conditional', label: 'If / else', description: 'Branch on a condition' },
  { type: 'parallel', label: 'Parallel', description: 'Run children at the same time' },
  { type: 'loop', label: 'For each', description: 'Iterate over a list' },
  { type: 'approval', label: 'Approval', description: 'Pause until a human approves' },
];

interface Props {
  onPick: (type: WorkflowStep['type']) => void;
  onClose: () => void;
  // Header label shown above the list; e.g. "Insert step", "Add to then".
  title?: string;
}

/**
 * A small floating menu of the 8 step types. Designed to be positioned
 * absolutely by the caller relative to the trigger button. Matches the
 * dropdown-menu look (surface-0/-1 bg, border, shadow-panel).
 */
export function StepTypePopover({ onPick, onClose, title }: Props) {
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Close on outside click / Escape so the popover stays modal-but-light.
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (!rootRef.current) return;
      if (e.target instanceof Node && !rootRef.current.contains(e.target)) {
        onClose();
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    // requestAnimationFrame so the triggering click that opened the popover
    // doesn't immediately close it.
    const id = requestAnimationFrame(() => {
      document.addEventListener('mousedown', handleClick);
      document.addEventListener('keydown', handleKey);
    });
    return () => {
      cancelAnimationFrame(id);
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [onClose]);

  return (
    <div
      ref={rootRef}
      role="menu"
      // Stops the click from bubbling into React Flow (which treats blank-area
      // clicks as a pane click / deselection).
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      className="z-50 w-[240px] rounded-md border border-border bg-surface-0 dark:bg-surface-1 p-1 shadow-panel"
    >
      {title && (
        <div className="px-2 pt-1.5 pb-1 text-[10px] uppercase tracking-wider text-neutral-500 font-mono">
          {title}
        </div>
      )}
      <div className="flex flex-col">
        {STEP_TYPES.map((t) => (
          <button
            key={t.type}
            role="menuitem"
            onClick={(e) => {
              e.stopPropagation();
              onPick(t.type);
            }}
            className={cn(
              'flex items-start gap-2 px-2 py-1.5 rounded-sm text-left text-sm',
              'hover:bg-surface-2 focus:bg-surface-2 focus:outline-none transition-colors',
            )}
          >
            <span className="w-5 h-5 rounded bg-surface-2 border border-border flex items-center justify-center text-neutral-500 shrink-0 mt-0.5">
              <StepTypeIcon type={t.type} className="w-3 h-3" />
            </span>
            <span className="flex flex-col min-w-0">
              <span className="text-[13px] font-medium text-foreground leading-tight">
                {t.label}
              </span>
              <span className="text-[10px] text-neutral-500 truncate">{t.description}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
