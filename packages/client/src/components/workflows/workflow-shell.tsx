import type { ReactNode } from 'react';

interface WorkflowShellProps {
  header: ReactNode;
  main: ReactNode;
  // null = no sidebar. The caller owns visibility so it can render its own
  // "Show sidebar" / "Show details" button inside `main`.
  sidebar: ReactNode | null;
  // Optional action bar pinned to the bottom of the sidebar on lg+ screens,
  // and to the bottom of the layout below the main pane on narrow screens.
  footer?: ReactNode;
  // Inline error/info banner above the footer (or above the sidebar bottom on
  // small screens). Kept separate so callers can swap it independently.
  errorBanner?: ReactNode;
}

/**
 * Shared layout shell for the workflow detail and the new/edit pages.
 *
 * Layout: a vertical flex container with the caller-provided header on top,
 * and a horizontal split below — main on the left, an optional 380px sidebar
 * on the right (stacked below on mobile). Footer + errorBanner are rendered
 * inside the sidebar column so they stick to its bottom.
 */
export function WorkflowShell({ header, main, sidebar, footer, errorBanner }: WorkflowShellProps) {
  return (
    <div className="flex flex-col h-full bg-surface-0">
      {header}
      <div className="flex-1 min-h-0 flex flex-col lg:flex-row overflow-auto lg:overflow-hidden">
        <div className="flex-1 min-w-0 p-4 lg:overflow-hidden lg:flex lg:flex-col min-h-0 relative">
          {main}
        </div>
        {sidebar !== null && (
          <aside className="w-full lg:w-[380px] flex flex-col bg-surface-1 lg:border-l border-t lg:border-t-0 border-border min-h-0 relative">
            <div className="flex-1 min-h-0 overflow-hidden flex flex-col">{sidebar}</div>
            {errorBanner && (
              <div className="bg-red-500/10 border-t border-red-500/30 text-red-600 dark:text-red-400 text-xs px-3 py-2 font-mono">
                {errorBanner}
              </div>
            )}
            {footer && <div className="border-t border-border p-3 flex gap-2">{footer}</div>}
          </aside>
        )}
      </div>
    </div>
  );
}
