import { ChevronLeft } from 'lucide-react';
import type { ReactNode } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Badge } from '@/components/ui/badge';

interface Props {
  title: string;
  // Optional pill rendered next to the title (e.g. "Enabled", "Draft").
  badge?: { label: string; variant?: 'success' | 'secondary' | 'default' };
  // Right-side action buttons.
  actions?: ReactNode;
  // Optional secondary row (e.g. description + slug/version).
  description?: ReactNode;
  meta?: ReactNode;
}

/**
 * Compact two-row header shared by the workflow detail and new/edit pages.
 *
 * Row 1: back chevron, title, optional badge, action buttons (right).
 * Row 2: description (left), meta (right) — both optional.
 */
export function CompactWorkflowHeader({ title, badge, actions, description, meta }: Props) {
  const nav = useNavigate();
  return (
    <div className="px-4 py-2.5 bg-surface-0 border-b border-border">
      <div className="flex items-center justify-between gap-4 h-7">
        <div className="flex items-center gap-2 min-w-0">
          <button
            type="button"
            onClick={() => nav({ to: '/automation/workflows' })}
            className="inline-flex items-center justify-center w-5 h-5 rounded text-neutral-500 hover:text-foreground hover:bg-surface-2"
            aria-label="Back to workflows"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <h1 className="text-base font-semibold text-foreground truncate">{title}</h1>
          {badge && <Badge variant={badge.variant ?? 'secondary'}>{badge.label}</Badge>}
        </div>
        {actions && <div className="flex gap-2 shrink-0">{actions}</div>}
      </div>
      {(description || meta) && (
        <div className="flex items-center justify-between gap-4 h-6 mt-0.5">
          <div className="text-[11px] text-neutral-500 truncate min-w-0">{description}</div>
          <div className="text-[11px] text-neutral-500 shrink-0">{meta}</div>
        </div>
      )}
    </div>
  );
}
