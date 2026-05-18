import { Play, Pencil, ChevronLeft } from 'lucide-react';
import { useNavigate } from '@tanstack/react-router';
import type { Workflow } from '@/api/workflows';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

interface Props {
  workflow: Workflow;
  onEdit?: () => void;
  onRun?: () => void;
  onToggleEnabled?: () => void;
  onDelete?: () => void;
}

export function WorkflowDetailHeader({ workflow, onEdit, onRun, onToggleEnabled, onDelete }: Props) {
  const nav = useNavigate();
  return (
    <div className="px-4 py-2.5 bg-surface-0 border-b border-border">
      {/* Row 1: back + title + enabled chip | actions */}
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
          <h1 className="text-base font-semibold text-foreground truncate">{workflow.name}</h1>
          <Badge variant={workflow.enabled ? 'success' : 'secondary'}>
            {workflow.enabled ? 'Enabled' : 'Disabled'}
          </Badge>
        </div>
        <div className="flex gap-2 shrink-0">
          {onRun && (
            <Button variant="primary" size="sm" onClick={onRun}>
              <Play className="w-3.5 h-3.5 mr-1" />
              Run now
            </Button>
          )}
          {onEdit && (
            <Button variant="secondary" size="sm" onClick={onEdit}>
              <Pencil className="w-3.5 h-3.5 mr-1" />
              Edit
            </Button>
          )}
          {onToggleEnabled && (
            <Button variant="secondary" size="sm" onClick={onToggleEnabled}>
              {workflow.enabled ? 'Disable' : 'Enable'}
            </Button>
          )}
          {onDelete && (
            <Button variant="destructive" size="sm" onClick={onDelete}>
              Delete
            </Button>
          )}
        </div>
      </div>
      {/* Row 2: description | slug + version */}
      <div className="flex items-center justify-between gap-4 h-6 mt-0.5">
        <div className="text-[11px] text-neutral-500 truncate min-w-0">
          {workflow.description ?? ''}
        </div>
        <div className="text-[11px] text-neutral-500 shrink-0">
          slug:{' '}
          <code className="bg-surface-2 text-foreground px-1 py-0.5 rounded">
            {workflow.slug ?? '—'}
          </code>{' '}
          · v{workflow.version}
        </div>
      </div>
    </div>
  );
}
