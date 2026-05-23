import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
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
  // The element this popover should anchor to. Position is computed from
  // anchor.getBoundingClientRect(); auto-flips above when there isn't enough
  // room below.
  anchorRef: RefObject<HTMLElement | null>;
  onPick: (type: WorkflowStep['type']) => void;
  onClose: () => void;
  // Header label shown above the list; e.g. "Insert step", "Add to then".
  title?: string;
}

const POPOVER_WIDTH = 240;
const VIEWPORT_MARGIN = 8;

/**
 * Step-type chooser rendered through a portal at document.body so it escapes
 * any ancestor with overflow-hidden (the WorkflowShell, the diagram, etc).
 * Auto-flips above the anchor when it would overflow the viewport below.
 */
export function StepTypePopover({ anchorRef, onPick, onClose, title }: Props) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number; placement: 'top' | 'bottom' } | null>(
    null,
  );

  // Compute position from the anchor before paint so we never flash at 0,0.
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const node = rootRef.current;
    if (!anchor || !node) return;
    const anchorRect = anchor.getBoundingClientRect();
    const popoverHeight = node.offsetHeight;
    const spaceBelow = window.innerHeight - anchorRect.bottom;
    const spaceAbove = anchorRect.top;
    const placement: 'top' | 'bottom' =
      spaceBelow < popoverHeight + VIEWPORT_MARGIN && spaceAbove > spaceBelow ? 'top' : 'bottom';

    const top =
      placement === 'bottom' ? anchorRect.bottom + 8 : anchorRect.top - popoverHeight - 8;
    // Center horizontally on the anchor, clamped to viewport with margin.
    const anchorCenter = anchorRect.left + anchorRect.width / 2;
    const rawLeft = anchorCenter - POPOVER_WIDTH / 2;
    const left = Math.min(
      Math.max(rawLeft, VIEWPORT_MARGIN),
      window.innerWidth - POPOVER_WIDTH - VIEWPORT_MARGIN,
    );
    setPos({ top, left, placement });
  }, [anchorRef]);

  // Close on outside click / Escape so the popover stays modal-but-light.
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (!rootRef.current) return;
      const target = e.target;
      if (!(target instanceof Node)) return;
      // Clicks on the anchor itself are forwarded to the trigger's own onClick;
      // ignore them so we don't fight the toggle.
      if (anchorRef.current?.contains(target)) return;
      if (!rootRef.current.contains(target)) onClose();
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
  }, [onClose, anchorRef]);

  return createPortal(
    <div
      ref={rootRef}
      role="menu"
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      style={{
        position: 'fixed',
        top: pos?.top ?? -9999,
        left: pos?.left ?? -9999,
        width: POPOVER_WIDTH,
        // Hidden until positioned to prevent the brief offscreen flash.
        visibility: pos ? 'visible' : 'hidden',
      }}
      className="z-50 rounded-md border border-border bg-surface-0 dark:bg-surface-1 p-1 shadow-panel"
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
    </div>,
    document.body,
  );
}
