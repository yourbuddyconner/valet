import { createContext, useContext, useState, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import type { ToolCallStatus } from './types';
import { ChevronIcon } from './icons';

interface ToolCardShellProps {
  /** Tool icon element */
  icon: ReactNode;
  /** Display label for the tool */
  label: string;
  /** Current execution status */
  status: ToolCallStatus;
  /** One-line summary shown in collapsed state */
  summary?: ReactNode;
  /** Expanded content */
  children?: ReactNode;
  /** Whether the card starts expanded */
  defaultExpanded?: boolean;
  /** Status accent color override */
  accentClass?: string;
  /** Force an expand affordance even before heavy content is loaded */
  expandable?: boolean;
  /** Optional callback for custom expansion behavior */
  onToggle?: () => void;
}

export const ToolCardExpansionIntentContext = createContext<boolean | null>(null);

const STATUS_COLORS: Record<ToolCallStatus, string> = {
  pending: 'text-neutral-400 dark:text-neutral-500',
  running: 'text-accent',
  completed: 'text-emerald-600 dark:text-emerald-400',
  error: 'text-red-500 dark:text-red-400',
};

const STATUS_BG: Record<ToolCallStatus, string> = {
  pending: 'border-neutral-200 dark:border-neutral-700/80',
  running: 'border-accent/20 dark:border-accent/15',
  completed: 'border-neutral-200 dark:border-neutral-700/80',
  error: 'border-red-200 dark:border-red-900/40',
};

export function ToolCardShell({
  icon,
  label,
  status,
  summary,
  children,
  defaultExpanded = false,
  expandable,
  onToggle,
}: ToolCardShellProps) {
  const expansionIntent = useContext(ToolCardExpansionIntentContext);
  const [expanded, setExpanded] = useState(expansionIntent ?? defaultExpanded);
  const isActive = status === 'pending' || status === 'running';
  const hasContent = !!children;
  const isExpandable = expandable ?? hasContent;

  return (
    <div
      className={cn(
        'mt-1.5 w-fit max-w-[min(100%,70vw)] overflow-hidden rounded-md border bg-surface-0 dark:bg-surface-0',
        'transition-colors duration-150',
        STATUS_BG[status],
      )}
    >
      {/* Header — always visible */}
      <button
        type="button"
        onClick={() => {
          if (!isExpandable) return;
          if (hasContent) {
            setExpanded(!expanded);
          }
          onToggle?.();
        }}
        disabled={!isExpandable}
        className={cn(
          'flex w-full items-center gap-2 px-2.5 py-1.5 text-left',
          'transition-colors duration-100',
          isExpandable && 'hover:bg-neutral-50 dark:hover:bg-white/[0.02]',
          !isExpandable && 'cursor-default',
        )}
      >
        {/* Expand chevron */}
        {isExpandable ? (
          <ChevronIcon
            className={cn(
              'h-3 w-3 shrink-0 text-neutral-400 transition-transform duration-150 dark:text-neutral-500',
              hasContent && expanded && 'rotate-90',
            )}
          />
        ) : (
          <span className="w-3 shrink-0" />
        )}

        {/* Status indicator */}
        <StatusDot status={status} />

        {/* Tool icon */}
        <span className={cn('h-3.5 w-3.5 shrink-0', STATUS_COLORS[status])}>
          {icon}
        </span>

        {/* Tool name */}
        <span className="shrink-0 font-mono text-[11px] font-semibold text-neutral-700 dark:text-neutral-300">
          {label}
        </span>

        {/* Summary */}
        {summary && (
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-neutral-400 dark:text-neutral-500">
            {summary}
          </span>
        )}

        {/* Status label */}
        <span
          className={cn(
            'ml-auto shrink-0 font-mono text-[10px] tabular-nums',
            STATUS_COLORS[status],
          )}
        >
          {isActive ? (
            <span className="inline-flex items-center gap-1">
              <RunningDots />
            </span>
          ) : (
            status
          )}
        </span>
      </button>

      {/* Expanded content */}
      {expanded && children && (
        <div className="border-t border-neutral-100 dark:border-neutral-800">
          {children}
        </div>
      )}
    </div>
  );
}

function StatusDot({ status }: { status: ToolCallStatus }) {
  if (status === 'pending' || status === 'running') {
    return (
      <span className="relative flex h-1.5 w-1.5 shrink-0">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent/50" />
        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-accent" />
      </span>
    );
  }

  if (status === 'completed') {
    return (
      <svg className="h-3 w-3 shrink-0 text-emerald-600 dark:text-emerald-400" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="3.5 8.5 6.5 11.5 12.5 5" />
      </svg>
    );
  }

  if (status === 'error') {
    return (
      <svg className="h-3 w-3 shrink-0 text-red-500 dark:text-red-400" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <line x1="4" y1="4" x2="12" y2="12" />
        <line x1="12" y1="4" x2="4" y2="12" />
      </svg>
    );
  }

  return null;
}

function RunningDots() {
  return (
    <span className="inline-flex gap-[2px]">
      <span className="h-[3px] w-[3px] animate-pulse-dot rounded-full bg-current" style={{ animationDelay: '0ms' }} />
      <span className="h-[3px] w-[3px] animate-pulse-dot rounded-full bg-current" style={{ animationDelay: '200ms' }} />
      <span className="h-[3px] w-[3px] animate-pulse-dot rounded-full bg-current" style={{ animationDelay: '400ms' }} />
    </span>
  );
}

/** Reusable content section for inside expanded cards */
export function ToolCardSection({
  label,
  children,
  className,
}: {
  label?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('px-2.5 py-2', className)}>
      {label && (
        <div className="mb-1 font-mono text-[9px] font-medium uppercase tracking-wider text-neutral-400 dark:text-neutral-500">
          {label}
        </div>
      )}
      {children}
    </div>
  );
}

/** Code block content for results */
export function ToolCodeBlock({
  children,
  maxHeight = '200px',
  className,
}: {
  children: string;
  maxHeight?: string;
  className?: string;
}) {
  return (
    <pre
      className={cn(
        'overflow-auto font-mono text-[11px] leading-[1.6] text-neutral-600 dark:text-neutral-400',
        className,
      )}
      style={{ maxHeight }}
    >
      {children}
    </pre>
  );
}
