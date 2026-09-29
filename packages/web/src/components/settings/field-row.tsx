import type { ReactNode } from "react";

/**
 * One labeled control within a `Section`'s hairline stack: label (+ optional
 * hint) on the left, the control on the right. Stacks to a single column
 * below `sm` so long labels/controls don't collide on narrow viewports.
 */
export function FieldRow({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="grid grid-cols-1 gap-2 py-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,24rem)] sm:items-start sm:gap-6">
      <div className="min-w-0 sm:pt-2">
        <div className="text-sm font-medium text-ink">{label}</div>
        {hint && <p className="mt-0.5 max-w-xs text-xs leading-5 text-muted">{hint}</p>}
        {error && <p className="mt-0.5 text-xs text-danger-500">{error}</p>}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
