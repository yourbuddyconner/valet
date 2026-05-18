import { Play, Pencil } from 'lucide-react';
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
  return (
    <div className="px-6 py-4 bg-surface-0 border-b border-border">
      <div className="text-xs text-neutral-500 tracking-wider mb-1">AUTOMATION / WORKFLOWS</div>
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-semibold text-foreground">{workflow.name}</h1>
            <Badge variant={workflow.enabled ? 'success' : 'secondary'}>
              {workflow.enabled ? 'Enabled' : 'Disabled'}
            </Badge>
          </div>
          {workflow.description && (
            <div className="text-sm text-neutral-600 dark:text-neutral-400 mt-1.5">{workflow.description}</div>
          )}
          <div className="text-xs text-neutral-500 mt-1.5">
            slug:{' '}
            <code className="bg-surface-2 text-foreground px-1 py-0.5 rounded">{workflow.slug ?? '—'}</code> · v
            {workflow.version} · updated {new Date(workflow.updatedAt).toLocaleString()}
          </div>
        </div>
        <div className="flex gap-2">
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
    </div>
  );
}
