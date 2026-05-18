import type { StepRuntimeStatus } from './workflow-diagram/types';

/**
 * Brand-aligned status visuals for execution states. Keep the palette narrow:
 * accent for in-progress, semantic colors only for terminal states. The CSS-variable
 * driven Tailwind tokens (surface-*, accent, border, foreground) give us automatic
 * dark-mode support.
 */
export const STATUS_RING: Record<StepRuntimeStatus, string> = {
  pending: 'ring-1 ring-border ring-inset',
  running: 'ring-2 ring-accent/70 ring-offset-2 ring-offset-surface-1 animate-pulse-dot',
  completed: 'ring-1 ring-emerald-500/60 ring-inset',
  failed: 'ring-2 ring-red-500/80 ring-inset',
  skipped: 'ring-1 ring-border ring-inset opacity-50',
  waiting_approval: 'ring-2 ring-amber-500/70 ring-inset',
  cancelled: 'ring-1 ring-border ring-inset opacity-50',
};

export const STATUS_DOT_COLOR: Record<StepRuntimeStatus, string> = {
  pending: 'bg-neutral-400',
  running: 'bg-accent',
  completed: 'bg-emerald-500',
  failed: 'bg-red-500',
  skipped: 'bg-neutral-400',
  waiting_approval: 'bg-amber-500',
  cancelled: 'bg-neutral-400',
};

export const STATUS_TEXT_COLOR: Record<StepRuntimeStatus, string> = {
  pending: 'text-neutral-500',
  running: 'text-accent',
  completed: 'text-emerald-600 dark:text-emerald-400',
  failed: 'text-red-600 dark:text-red-400',
  skipped: 'text-neutral-500',
  waiting_approval: 'text-amber-600 dark:text-amber-400',
  cancelled: 'text-neutral-500',
};
